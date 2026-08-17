/**
 * Minting a short-lived, single-file read URL for the private Blob store.
 *
 * The store is private and enforces it at the store level — an unauthenticated
 * GET of an uploaded blob answers 403 (ROADMAP, confirmed in BK-03) — so admin
 * cannot link a file directly. `/api/admin/files/<id>/` looks the pathname up
 * from the row, asks the Blob control API for a delegation scoped to exactly
 * that pathname, signs a URL against it locally, and 302s there. The bytes flow
 * CDN → browser without passing through the function, which is why this is a
 * redirect and not a proxy: uploads run to 100 MB per file (locked) and a
 * function response body has platform limits a redirect never touches.
 *
 * PURE OVER INJECTED DEPS. Nothing here imports `@vercel/blob` or reads the
 * environment — the SDK functions and the store token arrive as arguments from
 * the route, so `scripts/verify-booking-files.ts` can drive every branch under
 * `tsx` with no network and no credentials. That is not a testing convenience:
 * the scope of the issued token is the whole security property of this feature,
 * and argument capture is the only way to make it a claim that can go red.
 *
 * TWO SDK FACTS, READ OFF THE INSTALLED SOURCE (@vercel/blob 2.6.1), NOT RECALL:
 *
 *   1. `issueSignedToken`'s `pathname` DEFAULTS TO A WHOLE-STORE `"*"` WILDCARD
 *      when omitted (`dist/create-folder-*.d.ts`: "When omitted, the API
 *      defaults to a whole-store `"*"` wildcard"). An omitted argument is
 *      therefore a read token for every customer's damage photos, not a
 *      narrower one. It is passed explicitly here and asserted by name in the
 *      verify script.
 *   2. `presignUrl` IS LOCAL — HMAC through `crypto.subtle`, with the blob host
 *      derived from the store id inside the delegation token. It needs no base
 *      URL and makes no request, which is why `appointment_files.url` (NULL
 *      until the upload-completed webhook fires, and it never fires on
 *      localhost) is irrelevant to this path. It also rejects when the
 *      pathname does not match the delegation's scope.
 */

import { BLOB_ISSUE_TIMEOUT_MS, FILE_LINK_TTL_MS } from './booking-config';
// Type-only, so nothing here binds a database client. Same reason
// `booking-admin-notify.ts` imports `getDb` this way.
import type { getDb } from './db';

type Sql = ReturnType<typeof getDb>;

/** The one field of an `appointment_files` row this module is allowed to read. */
export type SignableFile = { pathname: string };

/**
 * What the route should answer with. `unavailable` carries no detail on
 * purpose: the office cannot act on a Blob control-API error code, and the
 * cause is already in the function log.
 */
export type FileRedirect = { kind: 'redirect'; url: string } | { kind: 'unavailable' };

/** The `issueSignedToken` shape this module uses. A subset of the SDK's. */
export type IssuedToken = {
  delegationToken: string;
  clientSigningToken: string;
  validUntil: number;
};

export type IssueOptions = {
  token: string;
  pathname: string;
  operations: ['get'];
  validUntil: number;
  abortSignal: AbortSignal;
};

export type PresignOptions = {
  operation: 'get';
  pathname: string;
  access: 'private';
  validUntil: number;
};

export type FileRedirectDeps = {
  /** `issueSignedToken` from `@vercel/blob`. */
  issue: (options: IssueOptions) => Promise<IssuedToken>;
  /** `presignUrl` from `@vercel/blob`. */
  presign: (
    signedToken: Pick<IssuedToken, 'clientSigningToken' | 'delegationToken'>,
    options: PresignOptions,
  ) => Promise<{ presignedUrl: string }>;
  /**
   * The store's read-write token, ALWAYS PASSED EXPLICITLY.
   *
   * The SDK falls back to its own `process.env.BLOB_READ_WRITE_TOKEN` lookup
   * when this is omitted, and `astro dev` never populates `process.env` — Vite
   * fills only `import.meta.env`. That is the documented third-party-SDK trap
   * in the ROADMAP and the reason `/api/booking/upload-token/` 400s in local
   * dev. The route reads the value through `readEnv` and hands it here.
   */
  token: string;
  /** Injected clock. The same instant fixes both the delegation and the URL expiry. */
  now: Date;
};

/**
 * Turn one file row into a presigned, expiring, get-only URL.
 *
 * **Never throws.** Every rejection and every synchronous throw from either dep
 * becomes `'unavailable'`, which the route answers as a 502. A signed-URL
 * helper that can throw would turn a Blob outage into a 500 on an admin page
 * that is otherwise working.
 *
 * The delegation and the URL share one `validUntil`. `presignUrl` caps the URL
 * expiry at the delegation ceiling anyway, so passing the same number means the
 * link's real lifetime is `FILE_LINK_TTL_MS` and not something the SDK picked.
 */
export async function buildFileRedirect(
  row: SignableFile,
  deps: FileRedirectDeps,
): Promise<FileRedirect> {
  const validUntil = deps.now.getTime() + FILE_LINK_TTL_MS;

  try {
    const issued = await deps.issue({
      token: deps.token,
      // The row's pathname, verbatim. Omitting it would sign the whole store;
      // deriving it from anything the request carries would let the caller
      // choose whose photos to read.
      pathname: row.pathname,
      // Read-only. The store token this is minted from can write and delete.
      operations: ['get'],
      validUntil,
      // See BLOB_ISSUE_TIMEOUT_MS: without this the SDK's 10 retries outlive
      // the function and the office gets a platform 504 instead of our 502.
      abortSignal: AbortSignal.timeout(BLOB_ISSUE_TIMEOUT_MS),
    });

    const { presignedUrl } = await deps.presign(
      { clientSigningToken: issued.clientSigningToken, delegationToken: issued.delegationToken },
      {
        operation: 'get',
        pathname: row.pathname,
        access: 'private',
        validUntil,
      },
    );

    return { kind: 'redirect', url: presignedUrl };
  } catch (err) {
    console.error(`Could not sign a file link for ${row.pathname}:`, err);
    return { kind: 'unavailable' };
  }
}

/**
 * The pathname of a file that belongs to a booking, or null.
 *
 * `AND appointment_id IS NOT NULL` is the whole point and is why this is a
 * shared function rather than an inline query plus an `if` in the route.
 * Unclaimed rows are draft uploads: they may be mid-upload, they belong to no
 * appointment, they render nowhere in admin, and the orphan cron will delete
 * them. Serving one would hand out a URL for a file nobody has claimed.
 *
 * `scripts/verify-booking-admin-db.ts` drives THIS function against dev-branch
 * fixtures rather than a copy of the query, so dropping the claimed-only clause
 * from the production statement is what turns that script red. A script-side
 * copy would have stayed green for exactly the regression it was written to
 * catch.
 *
 * `upload_state` is deliberately not read. A claimed-but-pending row is a
 * legitimate state — the upload-completed webhook never fires against localhost
 * (ROADMAP) — and the CDN answers the truth about whether the bytes exist. The
 * detail page withholds the link for presentation reasons; the route does not
 * 404 on it.
 *
 * `deleted_at IS NULL` IS A DIFFERENT KIND OF CLAUSE FROM THE ONE ABOVE, and
 * the difference is why it is here rather than in the page (BK-40). Soft delete
 * leaves the bytes in the store on purpose, so the row is the ONLY thing
 * standing between a deleted file and a signed URL for it. Enforcing it only in
 * the template would mean a link the office had already opened — or one still
 * in their history — kept working after they deleted the file, which is not
 * what "deleted" means to the person who pressed the button.
 */
export async function claimedFilePathname(sql: Sql, id: number): Promise<string | null> {
  const rows = (await sql`
    SELECT pathname
    FROM appointment_files
    WHERE id = ${id}
      AND appointment_id IS NOT NULL
      AND deleted_at IS NULL
  `) as { pathname: string }[];
  return rows[0]?.pathname ?? null;
}
