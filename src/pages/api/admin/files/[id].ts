import type { APIRoute } from 'astro';

export const prerender = false;

import { issueSignedToken, presignUrl } from '@vercel/blob';

import { parseAppointmentId } from '../../../../lib/booking-admin-entry';
import { buildFileRedirect, claimedFilePathname } from '../../../../lib/booking-files';
import { getDb } from '../../../../lib/db';
import { readEnv } from '../../../../lib/env';

/**
 * The authenticated way to open an uploaded file.
 *
 * Behind `/api/admin/`, so `src/middleware.ts` has already required a session —
 * an unauthenticated request never reaches this function, it gets the
 * middleware's 401. Everything below assumes the caller is the office.
 *
 * THE REQUEST CONTRIBUTES ONE NUMBER. No pathname, no filename, no query
 * fallback: the id is looked up and the pathname comes off the row. The upload
 * side already treats client-supplied pathnames as hostile (`parseUploadPathname`),
 * and the read side must not reintroduce them from the other direction.
 *
 * The answer is a 302 to a presigned CDN URL rather than the bytes themselves —
 * see `booking-files.ts` for why a proxy is the wrong shape at 100 MB per file.
 * That redirect target is a capability for anything that has it, which is what
 * `Cache-Control: no-store` and the five-minute TTL are for.
 */
export const GET: APIRoute = async ({ params }) => {
  // Same parser as the appointment id: both are int4 SERIALs, both reject
  // leading zeros so one row does not get two URLs, and both keep a non-numeric
  // segment from reaching Postgres as a failed cast.
  const id = parseAppointmentId(params.id);
  if (id === null) return notFound();

  let pathname: string | null;
  try {
    // The claimed-only rule lives in this shared function, not in an `if` here.
    // An unclaimed row is a draft upload belonging to no booking.
    pathname = await claimedFilePathname(getDb(), id);
  } catch (err) {
    console.error(`Admin file ${id} could not be looked up:`, err);
    return unavailable();
  }
  if (pathname === null) return notFound();

  // Read here and passed explicitly, never left to the SDK's own process.env
  // lookup — that store is empty under `astro dev` (ROADMAP: third-party SDKs
  // read process.env, which Vite never populates). Unset is a configuration
  // failure, not a missing file, so it is a logged 502 and not a 404 — the same
  // posture the notify adapter takes on a missing Resend key.
  const token = readEnv('BLOB_READ_WRITE_TOKEN');
  if (!token) {
    console.error('BLOB_READ_WRITE_TOKEN is not configured — cannot sign file links.');
    return unavailable();
  }

  const result = await buildFileRedirect(
    { pathname },
    { issue: issueSignedToken, presign: presignUrl, token, now: new Date() },
  );
  if (result.kind === 'unavailable') return unavailable();

  return new Response(null, {
    status: 302,
    headers: {
      Location: result.url,
      // Stated positively rather than left to defaults. The Location is a
      // signed, credential-free URL: a shared cache storing this response would
      // hand one office member's link to the next request for that id.
      'Cache-Control': 'no-store',
    },
  });
};

/** A bad id, an unknown id, and an unclaimed row are one answer. */
function notFound(): Response {
  return new Response('Not found', { status: 404 });
}

/**
 * 502, not 500 and not a platform 504: the failure is upstream of us, and the
 * abort signal in `buildFileRedirect` is what keeps a Blob outage from
 * outliving the function.
 */
function unavailable(): Response {
  return new Response('That file link could not be created right now.', { status: 502 });
}
