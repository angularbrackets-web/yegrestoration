// End-to-end checks for the booking form's server conversation.
//
//   npm run build && npm run verify:booking:smoke
//
// Runs against the Neon DEV BRANCH only (DATABASE_URL_DEV). It creates a real
// appointment and uploads a real (160-byte) blob, so it must never see
// production. Both are removed before it exits.
//
// This covers what `verify:booking:form` structurally cannot: that the paths in
// booking-config.ts are the ones the platform actually routes, that a draft can
// be minted, that a client upload authorizes against the real Blob store, and
// that a commit lands one row with its file attached.
//
// The guard order below is load-bearing and is the same one BK-02 established:
// refuse without DATABASE_URL_DEV, assert it differs from production, SWAP
// DATABASE_URL, and only then start anything that reaches a database.
import { neon } from '@neondatabase/serverless';
import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv(file: string) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const [, key, raw] = m;
    let val = raw.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && val && !(key in process.env)) process.env[key] = val;
  }
}

loadEnv(resolve(root, '.env.local'));
loadEnv(resolve(root, '.env'));

const hostOf = (url: string) => url.replace(/.*@([^/]+)\/.*/, '$1');

// 1. Refuse without the dev branch.
const DEV_URL = process.env.DATABASE_URL_DEV;
if (!DEV_URL) {
  console.error('DATABASE_URL_DEV is not set. This script creates a real booking and must');
  console.error('never run against production. See docs/booking/tickets/BK-02.md step zero.');
  process.exit(1);
}

// 2. Assert it is not production — refusing when DATABASE_URL is ABSENT too,
//    because a safety check must not fail open exactly when it knows least.
const PROD_URL = process.env.DATABASE_URL ?? '';
if (!PROD_URL) {
  console.error('DATABASE_URL is not set, so DATABASE_URL_DEV cannot be proven different from');
  console.error('production. Refusing to run. Pull the production env first.');
  process.exit(1);
}
if (hostOf(PROD_URL) === hostOf(DEV_URL)) {
  console.error(`DATABASE_URL_DEV points at the production host (${hostOf(DEV_URL)}). Refusing.`);
  process.exit(1);
}

// 3. Swap, so the dev server the child process starts resolves to the branch.
//    readEnv() prefers a non-empty process.env over Vite's .env.local, which is
//    what makes this override survive into the running endpoint.
process.env.DATABASE_URL = DEV_URL;

// 4. Only now import anything that reads the environment or touches a database.
const {
  BOOKING_AVAILABILITY_ENDPOINT,
  BOOKING_CREATE_ENDPOINT,
  BOOKING_DRAFT_ENDPOINT,
  BOOKING_UPLOAD_ENDPOINT,
} = await import('../src/lib/booking-config');
const { assembleBookingPayload, emptyFormValues } = await import('../src/lib/booking-form');
const { buildUploadPathname } = await import('../src/lib/booking-uploads');
const { upload } = await import('@vercel/blob/client');
const { del } = await import('@vercel/blob');

const sql = neon(DEV_URL);
const PORT = 4333;
const BASE = `http://localhost:${PORT}`;
const NAME = 'BK-03 smoke';

console.log(`Booking smoke checks against ${hostOf(DEV_URL)} (dev branch)\n`);

let failures = 0;
function check(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    failures++;
  }
}

/**
 * Abort the run — but through the `finally` block, not around it.
 *
 * `process.exit()` here would skip cleanup entirely, and the paths that call
 * this are exactly the ones with something to clean up: a blackout row on the
 * shared dev branch, an uploaded blob and its row, and a dev server left
 * listening on the port (the stale-daemon hazard `startDevServer` guards
 * against). So it throws a sentinel the top level converts into an exit code.
 */
class Abort extends Error {}
function fatal(message: string): never {
  throw new Abort(message);
}

/** Absolute URL for an endpoint constant, trailing slash intact. */
const url = (endpoint: string) => new URL(endpoint, BASE).href;

// ---------------------------------------------------------------------------
console.log('Generated Vercel routes match the endpoint constants');
// ---------------------------------------------------------------------------
// Production truth, not dev behaviour: `trailingSlash: 'always'` makes Vercel
// generate `^/api/booking/create/$`, and the unslashed form 308-redirects
// before the function ever runs. The dev server does not reproduce that (it
// 404s instead), so this is the only place the real rule can be asserted.
{
  const configPath = resolve(root, '.vercel/output/config.json');
  if (!existsSync(configPath)) {
    // Before the try block, so nothing is running and nothing needs cleaning up.
    console.error('\n✗ .vercel/output/config.json is missing — run `npm run build` first.');
    process.exit(1);
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { routes?: { src?: string }[] };
  const patterns = new Set((config.routes ?? []).map((r) => r.src).filter(Boolean) as string[]);

  for (const endpoint of [
    BOOKING_AVAILABILITY_ENDPOINT,
    BOOKING_CREATE_ENDPOINT,
    BOOKING_DRAFT_ENDPOINT,
    BOOKING_UPLOAD_ENDPOINT,
  ]) {
    check(
      patterns.has(`^${endpoint}$`),
      `${endpoint} must match a generated Vercel route (^${endpoint}$)`,
    );
  }
  console.log('  all four constants are routed as written');
}

// ---------------------------------------------------------------------------
// Dev server lifecycle. `astro dev` daemonizes in Astro 7 — the spawn returns
// immediately and the server keeps running, so it is stopped explicitly.
// ---------------------------------------------------------------------------
/** Whether anything is listening on PORT. */
async function isListening(): Promise<boolean> {
  try {
    await fetch(url(BOOKING_AVAILABILITY_ENDPOINT), { cache: 'no-store', redirect: 'manual' });
    return true;
  } catch {
    return false;
  }
}

async function startDevServer() {
  // Stop first, and WAIT for the port to go quiet.
  //
  // `astro dev stop` returns before the daemon has exited, and `astro dev`
  // finding a live daemon reuses it rather than starting one with this
  // process's environment. Skipping this wait makes the whole script capable of
  // passing against a *stale server* — one started from an earlier run, with an
  // earlier DATABASE_URL and earlier code. That is not a slow test, it is a
  // test of the wrong thing, and it is exactly what the red-first pass caught.
  await stopDevServer();
  for (let i = 0; i < 30 && (await isListening()); i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (await isListening()) {
    fatal(`something is already serving ${BASE} and would not stop — refusing to test it`);
  }

  await new Promise<void>((done, fail) => {
    const child = spawn('npx', ['astro', 'dev', '--port', String(PORT)], {
      cwd: root,
      // BOOKING_NOTIFY_DISABLED, or this script mails the client.
      //
      // It commits a real booking on every run. The customer address is
      // smoke@example.com (RFC 2606, undeliverable), but BOOKING_INTERNAL_TO is
      // info@yegrestoration.ca — a real inbox. Today the run is inert only by
      // accident: `.env` has no RESEND_API_KEY and `.env.local` has it as "".
      // Put a real key in `.env` — which `.env.example` invites — and every
      // smoke run emails the client.
      //
      // Note what does NOT work: *removing* the key from this environment.
      // `readEnv` falls back to `import.meta.env`, which Vite populates from the
      // dotenv files INSIDE the spawned dev server, where this process cannot
      // reach. A positive signal in `process.env` does work, because `readEnv`
      // checks `process.env` first and a non-empty value wins — the same
      // mechanism as the DATABASE_URL swap at the top of this file.
      env: { ...process.env, BOOKING_NOTIFY_DISABLED: '1' },
      stdio: 'ignore',
    });
    child.on('error', fail);
    child.on('exit', () => done());
  });

  for (let i = 0; i < 60; i++) {
    if (await isListening()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  fatal(`dev server did not come up on ${BASE}`);
}

async function stopDevServer() {
  await new Promise<void>((done) => {
    const child = spawn('npx', ['astro', 'dev', 'stop'], { cwd: root, stdio: 'ignore' });
    child.on('error', () => done());
    child.on('exit', () => done());
  });
}

type Availability = {
  dates: { date: string; weekday: number; slots: { start: string; time: string; label: string }[] }[];
};

async function getAvailability(): Promise<{ status: number; body: Availability }> {
  const res = await fetch(url(BOOKING_AVAILABILITY_ENDPOINT), {
    redirect: 'manual',
    cache: 'no-store',
  });
  check(res.status < 300 || res.status >= 400, `availability must not redirect (got ${res.status})`);
  return { status: res.status, body: (await res.json()) as Availability };
}

let blackoutDay: string | null = null;
let createdId: number | null = null;
let uploadedPathname: string | null = null;
/**
 * Set as soon as a draft exists, not after a successful upload.
 * `upload-token.ts` writes the `appointment_files` row when it MINTS the token,
 * so a PUT that fails afterwards still leaves a row behind. Cleaning up only
 * what uploaded successfully leaks exactly the rows a failing run creates.
 */
let usedDraftId: string | null = null;
/** Set when `fatal()` aborted the run; reported after cleanup has finished. */
let aborted: string | null = null;

try {
  await startDevServer();

  // -------------------------------------------------------------------------
  console.log('\nThe dev server is talking to the dev branch');
  // -------------------------------------------------------------------------
  // Isolation proven before anything is written, not inferred from the env var.
  // If the running server were on production, a blackout inserted here would be
  // invisible to it and this check fails — BEFORE a real appointment exists.
  {
    const first = await getAvailability();
    check(first.status === 200, `availability must answer 200 (got ${first.status})`);
    const target = [...first.body.dates].reverse().find((d) => d.slots.length > 0);
    if (!target) fatal('no bookable slots in the window — cannot run the smoke test');

    blackoutDay = target.date;
    await sql`
      INSERT INTO blackout_dates (day, reason) VALUES (${blackoutDay}::date, ${NAME})
      ON CONFLICT (day) DO NOTHING
    `;

    const after = await getAvailability();
    const seen = after.body.dates.find((d) => d.date === blackoutDay);
    check(
      seen !== undefined && seen.slots.length === 0,
      `a blackout written to the dev branch must be visible to the server (${blackoutDay} still shows ${seen?.slots.length ?? '?'} slots) — the server may be on another database`,
    );
    if (failures > 0) fatal('refusing to create a booking: server/database isolation is unproven');

    await sql`DELETE FROM blackout_dates WHERE day = ${blackoutDay}::date AND reason = ${NAME}`;
    blackoutDay = null;
    console.log('  a dev-branch blackout is visible to the server, then removed');
  }

  // -------------------------------------------------------------------------
  console.log('\nDraft mint and client upload');
  // -------------------------------------------------------------------------
  // Every POST carries an Origin because a browser always does, and Astro's
  // origin check refuses a bodyless, content-type-less POST from anywhere else
  // (`core/app/origin-check.js:16-21`). Emulating the browser is the point of
  // this script; omitting the header would be testing a client we do not ship.
  const draftRes = await fetch(url(BOOKING_DRAFT_ENDPOINT), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    redirect: 'manual',
  });
  check(draftRes.status === 200, `draft mint must answer 200 (got ${draftRes.status})`);
  const draft = (await draftRes.json()) as { draftId?: string; draftToken?: string };
  check(typeof draft.draftId === 'string', 'the draft must carry a draftId');
  check(typeof draft.draftToken === 'string', 'the draft must carry a draftToken');
  if (!draft.draftId || !draft.draftToken) fatal('no draft — cannot continue');
  usedDraftId = draft.draftId;

  const bytes = readFileSync(resolve(root, 'scripts/fixtures/damage-photo.jpg'));
  const file = new File([new Uint8Array(bytes)], 'damage-photo.jpg', { type: 'image/jpeg' });
  const pathname = buildUploadPathname(draft.draftId, 'image/jpeg');

  // handleUploadUrl is absolute here only because there is no `location` in
  // Node for the SDK to resolve a relative path against; the browser pass is
  // what exercises the relative form. The trailing slash is preserved either way.
  // Recorded before the attempt: a failed upload still leaves a row and may
  // still have put bytes in the store.
  uploadedPathname = pathname;
  const blob = await upload(pathname, file, {
    access: 'private',
    handleUploadUrl: url(BOOKING_UPLOAD_ENDPOINT),
    contentType: 'image/jpeg',
    clientPayload: JSON.stringify({
      draftToken: draft.draftToken,
      size: file.size,
      originalName: 'damage-photo.jpg',
    }),
  });
  // `access: 'private'` is an argument we pass, not a fact — and the server
  // cannot enforce it (`onBeforeGenerateToken` has no say; it travels as a
  // client-set header). Printing the argument back would assert nothing, while
  // the whole privacy story for photographs of the inside of someone's damaged
  // home rests on it. So fetch the returned URL with no credentials and require
  // that it does NOT serve the file.
  const anon = await fetch(blob.url, { redirect: 'manual' });
  check(
    anon.status !== 200,
    `an unauthenticated GET of the blob URL must not return the file (got ${anon.status}) — the upload is public`,
  );

  const [fileRow] = (await sql`
    SELECT id, appointment_id, upload_state FROM appointment_files WHERE pathname = ${pathname}
  `) as { id: number; appointment_id: number | null; upload_state: string }[];
  check(fileRow !== undefined, 'the upload must have written an appointment_files row');
  check(fileRow?.appointment_id === null, 'the file must be unclaimed until the booking commits');
  console.log(
    `  uploaded, unauthenticated GET → ${anon.status}, row present (upload_state=${fileRow?.upload_state})`,
  );

  // -------------------------------------------------------------------------
  console.log('\nCommit');
  // -------------------------------------------------------------------------
  const fresh = await getAvailability();
  const day = [...fresh.body.dates].reverse().find((d) => d.slots.length > 0);
  if (!day) fatal('no bookable slots — cannot commit');
  const slot = day.slots[day.slots.length - 1];

  const payload = assembleBookingPayload(
    {
      ...emptyFormValues(),
      slotStart: slot.start,
      name: NAME,
      phone: '780-555-0134',
      email: 'smoke@example.com',
      service: 'water',
      address: '123 Smoke St',
      description: 'Automated smoke test.',
      smsConsent: true,
    },
    draft.draftToken,
  );

  const createRes = await fetch(url(BOOKING_CREATE_ENDPOINT), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify(payload),
    redirect: 'manual',
  });
  check(
    createRes.status < 300 || createRes.status >= 400,
    `commit must not redirect (got ${createRes.status})`,
  );
  const created = (await createRes.json()) as {
    id?: number;
    slotLabel?: string;
    filesAttached?: number;
    emailSent?: boolean;
    error?: string;
  };
  check(createRes.status === 201, `commit must answer 201 (got ${createRes.status}: ${created.error ?? ''})`);
  if (createRes.status !== 201 || typeof created.id !== 'number') {
    fatal('the booking was not created — nothing to assert against');
  }
  createdId = created.id;

  check(created.filesAttached === 1, `the response must report 1 attached file (got ${created.filesAttached})`);
  check(typeof created.slotLabel === 'string' && created.slotLabel.length > 0, 'a slot label must come back');

  // The notification path answered without sending, and without disturbing the
  // 201. This is the end-to-end half of BK-05's AC10: notifications are muted
  // here (see the spawn call), so `true` would mean the mute failed — which is
  // the assertion that stands between this script and the client's inbox.
  check(
    created.emailSent === false,
    `emailSent must be false when notifications are disabled (got ${String(created.emailSent)})`,
  );

  // The stamp statement, against the real schema through the real driver.
  //
  // Nothing else runs it: verify:booking:email injects a fake sender and never
  // touches SQL, and the commit above has notifications muted, so both outcomes
  // are 'skipped' and the route's own call is short-circuited. The specific
  // doubt is the two `CASE WHEN ${boolean}` parameters — the Neon HTTP driver
  // sends them untyped and Postgres infers from context, and "it should infer
  // boolean" is the kind of claim about a third-party client this ticket
  // refused to make about Resend. So execute it and read the columns back.
  {
    const { stampNotifications } = await import('../src/lib/booking-commit');
    const at = new Date();

    await stampNotifications(sql, createdId, { customer: true, internal: false }, at);
    let rows = (await sql`
      SELECT confirmation_sent_at, internal_notified_at FROM appointments WHERE id = ${createdId}
    `) as { confirmation_sent_at: Date | null; internal_notified_at: Date | null }[];
    check(rows[0]?.confirmation_sent_at !== null, 'a sent confirmation stamps confirmation_sent_at');
    check(rows[0]?.internal_notified_at === null, 'and leaves internal_notified_at alone');

    // The CASE arms matter: a second stamp must not clear what the first wrote.
    await stampNotifications(sql, createdId, { customer: false, internal: true }, at);
    rows = (await sql`
      SELECT confirmation_sent_at, internal_notified_at FROM appointments WHERE id = ${createdId}
    `) as { confirmation_sent_at: Date | null; internal_notified_at: Date | null }[];
    check(rows[0]?.confirmation_sent_at !== null, 'stamping the internal side preserves the customer stamp');
    check(rows[0]?.internal_notified_at !== null, 'and sets internal_notified_at');

    // The symmetric case. Without it the ELSE arm of internal_notified_at is
    // covered by nothing — breaking it to NULL left this block green until this
    // assertion existed, which is the whole point of the red-first rule.
    await stampNotifications(sql, createdId, { customer: true, internal: false }, at);
    rows = (await sql`
      SELECT confirmation_sent_at, internal_notified_at FROM appointments WHERE id = ${createdId}
    `) as { confirmation_sent_at: Date | null; internal_notified_at: Date | null }[];
    check(rows[0]?.internal_notified_at !== null, 'stamping the customer side preserves the internal stamp');

    console.log('  both stamp columns write through the driver without a type error');
  }

  // The mute rests entirely on readEnv preferring a non-empty process.env value
  // over import.meta.env. Assert that invariant directly rather than inferring
  // it: if the precedence in src/lib/env.ts is ever reversed, the check above
  // starts passing for the wrong reason on a machine with no key configured,
  // and starts mailing the client on one that has.
  {
    const { readEnv } = await import('../src/lib/env');
    process.env.BOOKING_NOTIFY_DISABLED = '1';
    check(
      readEnv('BOOKING_NOTIFY_DISABLED') === '1',
      'readEnv must prefer a non-empty process.env value — the mute depends on it',
    );
    delete process.env.BOOKING_NOTIFY_DISABLED;
  }

  // Scoped to this slot: the dev branch is a copy-on-write snapshot of
  // production plus BK-02's hammer rows, so it is nowhere near empty.
  const rows = (await sql`
    SELECT id, sms_consent_at, policy_number FROM appointments
    WHERE slot_start = ${slot.start} AND status <> 'cancelled'
  `) as { id: number; sms_consent_at: Date | null; policy_number: string | null }[];
  check(rows.length === 1, `exactly one appointment must exist for that slot (got ${rows.length})`);
  check(rows[0]?.id === createdId, "the row's id must be the one the endpoint returned");
  check(rows.length === 1 && rows[0].sms_consent_at !== null, 'consent given must be stamped');

  const claimed = (await sql`
    SELECT id, pathname FROM appointment_files WHERE appointment_id = ${createdId}
  `) as { id: number; pathname: string }[];
  check(claimed.length === 1, `exactly one file must be claimed (got ${claimed.length})`);
  check(claimed[0]?.pathname === pathname, 'the claimed file must be the one uploaded');
  console.log(`  booking ${createdId} created for ${created.slotLabel}, one file claimed`);

  // -------------------------------------------------------------------------
  console.log('\nRejections still reject over HTTP');
  // -------------------------------------------------------------------------
  {
    // The same slot again: the row now exists, so the precheck refuses it.
    const repeat = await fetch(url(BOOKING_CREATE_ENDPOINT), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: BASE },
      body: JSON.stringify(payload),
      redirect: 'manual',
    });
    const body = (await repeat.json()) as { code?: string };
    check(repeat.status === 409, `a taken slot must answer 409 (got ${repeat.status})`);
    check(body.code === 'slot_unavailable', `an uncontended repeat reads slot_unavailable (got ${body.code})`);

    const bad = await fetch(url(BOOKING_CREATE_ENDPOINT), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: BASE },
      body: JSON.stringify({ ...payload, name: '', phone: 'x' }),
      redirect: 'manual',
    });
    const badBody = (await bad.json()) as { fields?: { field: string }[] };
    check(bad.status === 422, `a bad payload must answer 422 (got ${bad.status})`);
    check(
      Array.isArray(badBody.fields) && badBody.fields.some((f) => f.field === 'name'),
      'the 422 must name the offending field',
    );
    console.log('  409 and 422 arrive with the codes the island maps on');
  }
} catch (err) {
  if (err instanceof Abort) aborted = err.message;
  else throw err;
} finally {
  // -------------------------------------------------------------------------
  // Cleanup. Every branch runs it: a leftover appointment holds a real slot on
  // the branch, and a leftover blob is billed storage.
  // -------------------------------------------------------------------------
  if (blackoutDay) {
    await sql`DELETE FROM blackout_dates WHERE day = ${blackoutDay}::date AND reason = ${NAME}`;
  }
  if (createdId !== null) {
    await sql`DELETE FROM appointment_files WHERE appointment_id = ${createdId}`;
    await sql`DELETE FROM appointments WHERE id = ${createdId}`;
  }
  if (usedDraftId) {
    // By draft, not just by the pathname that succeeded.
    await sql`DELETE FROM appointment_files WHERE draft_id = ${usedDraftId}::uuid`;
  }
  if (uploadedPathname) {
    await sql`DELETE FROM appointment_files WHERE pathname = ${uploadedPathname}`;
    // By pathname, not URL: onUploadCompleted never fires against localhost, so
    // `url` is still NULL on the row and there is no URL to delete by.
    try {
      await del(uploadedPathname);
    } catch (err) {
      console.error(`  ⚠ could not delete the test blob ${uploadedPathname}:`, err);
    }
  }
  await stopDevServer();
}

if (aborted) {
  console.error(`\n✗ ${aborted}`);
  process.exit(1);
}

if (failures > 0) {
  console.error(`\n✗ ${failures} check${failures === 1 ? '' : 's'} failed.`);
  process.exit(1);
}
console.log('\n✓ All booking smoke checks passed.');
