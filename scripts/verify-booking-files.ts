// Checks the one thing that makes the admin file proxy safe: the scope of the
// credential it mints.
//
//   npm run verify:booking:files
//
// Pure. No database, no network, no environment, no Blob credentials —
// `buildFileRedirect` takes the SDK's two functions and the store token as
// arguments, so every branch is reachable with fakes that record what they were
// asked for.
//
// WHY ARGUMENT CAPTURE RATHER THAN "IT RETURNED A URL". Per the installed SDK
// (@vercel/blob 2.6.1), `issueSignedToken`'s `pathname` defaults to a
// whole-store `"*"` wildcard when omitted. A regression that simply stopped
// passing it would keep working — every link would keep opening — while every
// issued token became a read credential for every customer's damage photos. The
// only observable difference is the argument, so the argument is what is
// asserted, and the fake records the pathname *key* rather than trusting the
// value it read.

import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { BLOB_ISSUE_TIMEOUT_MS, FILE_LINK_TTL_MS } from '../src/lib/booking-config';
import {
  buildFileRedirect,
  type FileRedirectDeps,
  type IssueOptions,
  type IssuedToken,
  type PresignOptions,
} from '../src/lib/booking-files';
import type { AppointmentFile } from '../src/lib/db';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    failures++;
  }
}

// A pathname with the shape the upload path actually produces, plus characters
// that a "helpful" sanitizer would rewrite. Signing a rewritten pathname is the
// same defect as signing the wrong one.
const PATHNAME = 'booking/9f1c8a20-3c4e-4f1a-9c1e-2b7d5a6e4f30/kitchen ceiling (1).heic';
/**
 * Shaped like a real one, and deliberately full of characters a round trip
 * would move: percent-escapes in the path, and `+` / `/` / `=` inside a
 * base64url-ish signature parameter. A tidy URL made the passthrough assertion
 * pass under `encodeURI(...)` — an inert assert, caught by the red pass and
 * fixed here rather than in the production code.
 */
const PRESIGNED =
  'https://afbl7lp2edv6nbiv.private.blob.vercel-storage.com/booking/9f1c8a20/kitchen%20ceiling%20(1).heic?vercel-blob-sig=aB3%2Fx%2Bd%3D&vercel-blob-exp=1786470600000';
const TOKEN = 'vercel_blob_rw_FAKESTORE_notarealtoken';
const NOW = new Date('2026-08-11T17:45:00.000Z');

const ISSUED: IssuedToken = {
  delegationToken: 'delegation.abc',
  clientSigningToken: 'signing.def',
  validUntil: NOW.getTime() + FILE_LINK_TTL_MS,
};

type Capture = {
  issueCalls: (IssueOptions & { keys: string[] })[];
  presignCalls: {
    signedToken: Pick<IssuedToken, 'clientSigningToken' | 'delegationToken'>;
    options: PresignOptions & { keys: string[] };
  }[];
};

/**
 * Deps whose fakes record every argument. `keys` is captured separately from
 * the values so "the pathname was passed at all" is a distinct assertion from
 * "the pathname was right" — an omitted key reads as `undefined`, which an
 * equality check against a defined pathname would also catch, but which the key
 * list names precisely.
 */
function seams(over: Partial<FileRedirectDeps> = {}): {
  deps: FileRedirectDeps;
  capture: Capture;
} {
  const capture: Capture = { issueCalls: [], presignCalls: [] };
  const deps: FileRedirectDeps = {
    issue: async (options) => {
      capture.issueCalls.push({ ...options, keys: Object.keys(options) });
      return ISSUED;
    },
    presign: async (signedToken, options) => {
      capture.presignCalls.push({ signedToken, options: { ...options, keys: Object.keys(options) } });
      return { presignedUrl: PRESIGNED };
    },
    token: TOKEN,
    now: NOW,
    ...over,
  };
  return { deps, capture };
}

// ---------------------------------------------------------------------------
console.log('\nThe issued token is scoped to one pathname, get-only, and expires (AC1)');
// ---------------------------------------------------------------------------
{
  const { deps, capture } = seams();
  const result = await buildFileRedirect({ pathname: PATHNAME }, deps);

  check(capture.issueCalls.length === 1, `issue is called exactly once, got ${capture.issueCalls.length}`);
  const issue = capture.issueCalls[0];

  // Risk area 1. The default is a whole-store wildcard, so an omitted key is a
  // credential for every customer's photos.
  check(
    issue?.keys.includes('pathname'),
    'issue is passed a pathname AT ALL — omitted, the API defaults to a whole-store "*"',
  );
  check(issue?.pathname === PATHNAME, `and it is the row's pathname verbatim, got "${issue?.pathname}"`);
  check(issue?.pathname !== '*', 'and is never the wildcard');

  check(
    Array.isArray(issue?.operations) && issue.operations.join(',') === 'get',
    `the delegation permits get and nothing else, got ${JSON.stringify(issue?.operations)}`,
  );
  check(
    issue?.validUntil === NOW.getTime() + FILE_LINK_TTL_MS,
    `it expires at now + FILE_LINK_TTL_MS, got ${issue?.validUntil} vs ${NOW.getTime() + FILE_LINK_TTL_MS}`,
  );

  // The documented third-party-SDK trap: the SDK's own process.env lookup is
  // empty under astro dev, so the token has to travel as an argument.
  check(issue?.keys.includes('token'), 'the store token is passed explicitly, not left to process.env');
  check(issue?.token === TOKEN, 'and it is the token the caller supplied');

  // Without this the SDK's ten retries outlive the platform function limit and
  // the office gets a 504 instead of this route's 502.
  check(issue?.abortSignal instanceof AbortSignal, 'the issue call carries an AbortSignal');
  check(issue?.abortSignal.aborted === false, 'which has not already fired when the call is made');

  // ---------------------------------------------------------------------------
  console.log('\nThe URL is signed for the same file and the same instant (AC1)');
  // ---------------------------------------------------------------------------
  check(capture.presignCalls.length === 1, `presign is called exactly once, got ${capture.presignCalls.length}`);
  const presign = capture.presignCalls[0];

  check(
    presign?.signedToken.delegationToken === ISSUED.delegationToken &&
      presign?.signedToken.clientSigningToken === ISSUED.clientSigningToken,
    'presign is handed the material issue returned, not a rebuilt copy',
  );
  check(presign?.options.operation === 'get', `presign asks for a get URL, got "${presign?.options.operation}"`);
  check(presign?.options.keys.includes('pathname'), 'presign is passed a pathname at all');
  check(
    presign?.options.pathname === issue?.pathname,
    'and it is the SAME pathname the delegation was scoped to — a mismatch is what presignUrl rejects on',
  );
  check(
    presign?.options.access === 'private',
    `the store is private, so the URL is signed as private, got "${presign?.options.access}"`,
  );
  check(
    presign?.options.validUntil === issue?.validUntil,
    'and the URL expires with the delegation rather than at a ceiling the SDK picked',
  );

  // ---------------------------------------------------------------------------
  console.log('\nThe presigned URL reaches the caller untouched (AC1)');
  // ---------------------------------------------------------------------------
  check(result.kind === 'redirect', `a working pair redirects, got "${result.kind}"`);
  check(
    result.kind === 'redirect' && result.url === PRESIGNED,
    'the URL is passed through verbatim — a re-encoded query string is an invalid signature',
  );
}

// ---------------------------------------------------------------------------
console.log('\nA short-lived link is a policy, not an accident (AC1)');
// ---------------------------------------------------------------------------
{
  // The TTL is the only bound on a credential that needs no cookie. Asserted as
  // a range rather than as equality, so this reports "the link outlives its
  // justification" rather than restating the constant back to itself.
  check(FILE_LINK_TTL_MS > 0, 'FILE_LINK_TTL_MS is positive — a past expiry is rejected by the SDK');
  check(
    FILE_LINK_TTL_MS <= 15 * 60_000,
    `an admin file link lasts minutes, not hours (got ${FILE_LINK_TTL_MS} ms)`,
  );
  check(
    Number.isInteger(FILE_LINK_TTL_MS),
    'and lands on an integer millisecond — issueSignedToken rejects a non-integer validUntil',
  );
  check(
    BLOB_ISSUE_TIMEOUT_MS > 0 && BLOB_ISSUE_TIMEOUT_MS <= 8000,
    `the issue call bails inside the platform function limit (got ${BLOB_ISSUE_TIMEOUT_MS} ms)`,
  );
}

// ---------------------------------------------------------------------------
console.log('\nEvery failure of either dep is "unavailable", never a throw (AC1)');
// ---------------------------------------------------------------------------
{
  // Four ways out, because a rejection and a synchronous throw take different
  // paths through an async function and only one of them is obvious. The route
  // turns each into a 502; anything escaping here would be a 500 on a working
  // admin page.
  const cases: [string, Partial<FileRedirectDeps>][] = [
    [
      'issue rejects (the Blob control API is down)',
      { issue: async () => Promise.reject(new Error('service_unavailable')) },
    ],
    [
      'issue throws synchronously (a bad token is a BlobError, not a rejection)',
      {
        issue: (() => {
          throw new Error('No blob credentials found.');
        }) as FileRedirectDeps['issue'],
      },
    ],
    ['presign rejects (pathname outside the delegation scope)', { presign: async () => Promise.reject(new Error('scope')) }],
    [
      'presign throws synchronously (crypto.subtle missing)',
      {
        presign: (() => {
          throw new Error('HMAC is not available');
        }) as FileRedirectDeps['presign'],
      },
    ],
  ];

  for (const [label, over] of cases) {
    const { deps } = seams(over);
    let result: Awaited<ReturnType<typeof buildFileRedirect>> | null = null;
    let threw: unknown = null;
    try {
      result = await buildFileRedirect({ pathname: PATHNAME }, deps);
    } catch (err) {
      threw = err;
    }
    check(threw === null, `${label}: buildFileRedirect does not throw (threw ${String(threw)})`);
    check(result?.kind === 'unavailable', `${label}: reports unavailable, got "${result?.kind}"`);
  }
}

// ---------------------------------------------------------------------------
console.log('\nThe abort signal actually fires, so a hung control API becomes a 502 (AC2)');
// ---------------------------------------------------------------------------
{
  // The SDK retries a failing control-API call ten times with backoff, so
  // "unavailable" is only reachable within the function's lifetime because the
  // signal ends the retry loop. This drives a fake that behaves the way the SDK
  // does — pending until its signal aborts, then rejecting — so what is being
  // checked is that a signal was passed, that it is on a timer, and that its
  // firing reaches the caller as `unavailable`.
  //
  // Watchdog first: without one, deleting the abortSignal from the production
  // call would hang this script forever instead of failing it, and a red that
  // never returns is not a red anyone can read.
  const started = Date.now();
  const { deps } = seams({
    issue: (options) =>
      new Promise((_resolve, reject) => {
        options.abortSignal.addEventListener('abort', () => reject(new Error('BlobRequestAborted')));
      }),
  });

  // The watchdog timer is deliberately NOT unref'd, and it is the only thing
  // holding the event loop open here: `AbortSignal.timeout` uses an unref'd
  // timer, so a run whose signal never fires would otherwise exit silently
  // ("unsettled top-level await") instead of reporting a failure.
  const WATCHDOG_MS = BLOB_ISSUE_TIMEOUT_MS * 2 + 1000;
  let watchdog: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    buildFileRedirect({ pathname: PATHNAME }, deps),
    new Promise<'watchdog'>((resolve) => {
      watchdog = setTimeout(() => resolve('watchdog'), WATCHDOG_MS);
    }),
  ]);
  clearTimeout(watchdog);

  check(
    outcome !== 'watchdog',
    `a pending Blob call is abandoned within ${WATCHDOG_MS} ms — it was not, so no working abort signal reached it`,
  );
  check(
    outcome !== 'watchdog' && outcome.kind === 'unavailable',
    `and the abort surfaces as unavailable, got "${outcome === 'watchdog' ? 'watchdog' : outcome.kind}"`,
  );
  const elapsed = Date.now() - started;
  check(
    elapsed < BLOB_ISSUE_TIMEOUT_MS * 1.5,
    `it bails on BLOB_ISSUE_TIMEOUT_MS rather than some longer timer (took ${elapsed} ms)`,
  );
}

// ---------------------------------------------------------------------------
console.log('\nNothing in the pure core reaches the SDK, the environment, or a DB (AC3)');
// ---------------------------------------------------------------------------
{
  // The seam only proves what it is handed. If `booking-files.ts` could
  // construct the SDK or read the token itself, the route could stop passing
  // either and every assertion above would still pass while production went
  // back to the astro-dev trap.
  // Comments stripped: this module's header documents the astro-dev
  // `process.env` trap by name, and naming a trap is not falling into it.
  const source = readFileSync(resolve(root, 'src/lib/booking-files.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  check(!source.includes('import.meta.env'), 'booking-files.ts reads no import.meta.env');
  check(!source.includes('process.env'), 'booking-files.ts reads no process.env');
  check(!source.includes('readEnv'), 'and does not read the token itself — it is a dep');
  check(
    !/^import\s+\{[^}]*\}\s+from\s+'@vercel\/blob'/m.test(source),
    'booking-files.ts imports no VALUE from @vercel/blob — both functions are injected',
  );
  check(
    source.includes("import type { getDb } from './db'"),
    'and takes its Sql type from db.ts without binding a client',
  );
}

// ---------------------------------------------------------------------------
console.log('\nThe route wires the seam the way production needs (AC2, AC3)');
// ---------------------------------------------------------------------------
{
  const file = 'src/pages/api/admin/files/[id].ts';
  const path = resolve(root, file);
  check(existsSync(path), `${file} exists`);
  if (existsSync(path)) {
    const source = readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');

    check(
      source.includes("readEnv('BLOB_READ_WRITE_TOKEN')"),
      `${file}: the store token is read through readEnv, not the SDK's process.env lookup`,
    );
    check(source.includes('token'), `${file}: and handed to buildFileRedirect as the token dep`);
    // The ROUTE decides, not the SDK. Found by the red pass: deleting this
    // guard leaves the 502 in place, because an undefined `token` makes the
    // SDK fall back to its own (empty) process.env lookup and throw, which
    // `buildFileRedirect` maps to the same answer. The behaviour is therefore
    // not enough to pin the guard — and the guard is what stops `astro dev`
    // from 502ing every file link while the token IS configured, since the
    // SDK's store is exactly the one Vite never populates.
    check(
      /if \(!token\)/.test(source),
      `${file}: an unset token is caught HERE, before the SDK is handed an undefined one`,
    );
    check(
      source.includes("'Cache-Control': 'no-store'"),
      `${file}: the 302 is marked no-store — a shared cache must not store a capability URL`,
    );
    check(
      source.includes('claimedFilePathname'),
      `${file}: the lookup goes through the shared claimed-only query`,
    );
    check(
      !/appointment_files/.test(source),
      `${file}: and does not carry a second copy of that query — a copy cannot go red`,
    );

    // Risk area 2, at the source level: the id is the only request input. A
    // pathname read off the URL or the query string would defeat every
    // assertion above, because the seam would faithfully sign whatever it got.
    for (const forbidden of ['searchParams', 'params.pathname', 'request.url', 'headers.get']) {
      check(
        !source.includes(forbidden),
        `${file}: reads no ${forbidden} — the numeric id is the entire request input`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// AC6, as a COMPILE-TIME tie rather than a runtime check.
//
// `size_bytes` is BIGINT and the driver hands it back as a string. The runtime
// half of this claim is pinned in `verify-booking-admin-db.ts` against a real
// row — but that assertion pins the DRIVER, not us, and cannot go red by
// editing this repo. This line can: narrowing `AppointmentFile['size_bytes']`
// back to `number | null` stops `npm run typecheck` dead, which is the gate
// that would otherwise let `size_bytes / 1024` compile into an `NaN`.
// Same device as `_shape` in verify-booking-admin.ts.
const _sizeIsAlsoAString: AppointmentFile['size_bytes'] = '5242880';
void _sizeIsAlsoAString;

// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n✗ ${failures} check${failures === 1 ? '' : 's'} failed\n`);
  process.exit(1);
}
console.log('\n✓ booking file-link checks passed\n');
