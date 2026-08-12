// The contact form's message path: what a valid submission is, what the office
// receives, and — the assertions that matter — which of the four outcomes the
// visitor is shown.
//
//   npm run verify:contact
//
// THE SPLIT, AND WHY EVERY ASSERT SAYS WHICH SIDE IT IS ON.
//
//   * LIB-LEVEL — `handleContactMessage` with injected deps. `deps.send` IS
//     the seam, so `BOOKING_NOTIFY_DISABLED` never enters and all four arms of
//     the truth table are reachable: a resolved `{ error }`, a throw, a missing
//     key, and success. This is where the decision logic is actually checked.
//   * ROUTE-LEVEL — the real `POST /api/contact/` imported dynamically, driven
//     against the Neon DEV BRANCH under `BOOKING_NOTIFY_DISABLED=1`. Under the
//     mute the route can only ever reach the `skipped` arm, which is exactly
//     why the arms above cannot live here. What this side is good for is what
//     the lib cannot see: the real INSERT (a NULL service against the real
//     post-004 schema), the parse/status mapping, and that nothing mails.
//
// That division is the plan-review blocker restated: decision logic in a route
// body is unobservable, because the mute silences injected seams too — the
// BK-08 lesson recorded at the top of `verify-booking-admin-db.ts`.
//
// THE DEV BRANCH ONLY. The route-level half INSERTs. It refuses to run without
// DATABASE_URL_DEV rather than falling back to production, and the guard ORDER
// is load-bearing: `getDb()` reads `process.env.DATABASE_URL` per call, so the
// variable is SWAPPED first and every value import happens after.
//
// Exits non-zero if any assertion fails.

import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import type { Message } from '../src/lib/booking-email';
import type { SendResult } from '../src/lib/booking-notify';
// Type-only, so it is erased before the module graph exists and cannot bind a
// connection ahead of the DATABASE_URL swap below.
import type { ContactMessage } from '../src/lib/contact-message';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv(file: string) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const [, key, rawValue] = m;
    let val = rawValue.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && val && !(key in process.env)) process.env[key] = val;
  }
}

loadEnv(resolve(root, '.env.local'));
loadEnv(resolve(root, '.env'));

const hostOf = (url: string) => url.replace(/.*@([^/]+)\/.*/, '$1');

const DEV_URL = process.env.DATABASE_URL_DEV;
if (!DEV_URL) {
  console.error('DATABASE_URL_DEV is not set. This script INSERTs into `leads`,');
  console.error('and it will not fall back to production. See BK-02 step zero in the ROADMAP.');
  process.exit(1);
}
if (process.env.DATABASE_URL && hostOf(DEV_URL) === hostOf(process.env.DATABASE_URL)) {
  console.error(`DATABASE_URL_DEV points at the production host (${hostOf(DEV_URL)}). Refusing.`);
  process.exit(1);
}

// Swap BEFORE importing anything that reaches getDb().
process.env.DATABASE_URL = DEV_URL;

// The lib half needs the mute OFF — with an injected `send` nothing can leave
// anyway, and leaving it on would collapse every arm into `skipped`. The route
// half sets it again before the first route call.
delete process.env.BOOKING_NOTIFY_DISABLED;

const { neon } = await import('@neondatabase/serverless');
const {
  buildContactEmail,
  contactSubject,
  handleContactMessage,
  parseContactSubmission,
} = await import('../src/lib/contact-message');
const { SERVICE_LABELS } = await import('../src/lib/db');

const sql = neon(DEV_URL);
console.log(`Target: ${hostOf(DEV_URL)} (dev branch)\n`);

let failures = 0;
function check(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    failures++;
  }
}

/** Every row this run creates is named so cleanup does not depend on ids alone. */
const MARKER = 'BK-10 verify';
const createdIds: number[] = [];

async function cleanup(): Promise<number> {
  const rows = (await sql`
    DELETE FROM leads
    WHERE id = ANY(${createdIds}::int[]) OR name LIKE ${`${MARKER}%`}
    RETURNING id
  `) as { id: number }[];
  return rows.length;
}

// Leftovers from an interrupted run would make the count assertions below read
// as failures of this run rather than of that one.
await cleanup().catch(() => 0);

// A finally block does not run on SIGINT/SIGTERM, which would strand rows.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    console.error(`\n${signal} received — cleaning up seeded rows first.`);
    await cleanup().catch(() => {});
    process.exit(130);
  });
}

const labelFor = (service: string) => SERVICE_LABELS[service] ?? service;

function message(over: Partial<ContactMessage> = {}): ContactMessage {
  return {
    name: `${MARKER} Dana`,
    phone: '7805550199',
    email: 'dana@example.com',
    service: 'mold',
    message: 'There is a smell in the basement. Is that worth a visit?',
    ...over,
  };
}

/** Records what the injected deps saw, so "it was called" is assertable. */
function spy(send: ((m: Message) => Promise<SendResult>) | null, insertThrows = false) {
  const inserted: ContactMessage[] = [];
  const delivered: Message[] = [];
  return {
    inserted,
    delivered,
    deps: {
      labelFor,
      insert: async (m: ContactMessage) => {
        inserted.push(m);
        if (insertThrows) throw new Error('connection terminated');
      },
      send: send
        ? async (m: Message) => {
            delivered.push(m);
            return send(m);
          }
        : null,
    },
  };
}

try {
  // =========================================================================
  console.log('LIB-LEVEL — the truth table (AC2)');
  // =========================================================================
  {
    // 1. Send ok → ok. The happy path, and the only one that may report success
    //    with mail actually gone.
    const s = spy(async () => ({ ok: true }));
    const outcome = await handleContactMessage(message(), s.deps);
    check(outcome.ok === true, `a successful send is ok, got ${JSON.stringify(outcome)}`);
    check(outcome.delivery === 'sent', `and reports 'sent', got ${outcome.delivery}`);
    check(s.inserted.length === 1, 'the row was recorded');
    check(s.delivered.length === 1, 'and exactly one message left');
  }

  {
    // 2. A RESOLVED error → failed. This is the arm the old route could not
    //    see: `try { await send() } catch` never fires, because the SDK
    //    resolves. Without this assertion a bounced key reads as success.
    const s = spy(async () => ({ ok: false, error: 'validation_error: API key is invalid' }));
    const outcome = await handleContactMessage(message(), s.deps);
    check(outcome.ok === false, `a resolved error is NOT ok, got ${JSON.stringify(outcome)}`);
    check(outcome.delivery === 'failed', `and reports 'failed', got ${outcome.delivery}`);
    check(s.inserted.length === 1, 'the row is still recorded — the message is not lost twice');
  }

  {
    // 3. A throwing sender → failed. Unreachable through the real client, which
    //    resolves; reachable through any future one, and through this fake.
    const s = spy(async () => {
      throw new Error('socket hang up');
    });
    const outcome = await handleContactMessage(message(), s.deps);
    check(outcome.ok === false, 'a throwing sender is NOT ok');
    check(outcome.delivery === 'failed', `and reports 'failed', got ${outcome.delivery}`);
  }

  {
    // 4. No key → failed, and BEFORE any send. `send: null` is how the route
    //    says "RESEND_API_KEY is unset"; the old route threw a bare Error here.
    const s = spy(null);
    const outcome = await handleContactMessage(message(), s.deps);
    check(outcome.ok === false, 'a missing key is NOT ok');
    check(outcome.delivery === 'failed', `and reports 'failed', got ${outcome.delivery}`);
    check(s.delivered.length === 0, 'and nothing was attempted');
    check(s.inserted.length === 1, 'while the row was still recorded — it is recoverable in admin');
  }

  {
    // 5. Send ok + a FAILED insert → still ok. The inversion this ticket is
    //    built on: the office reads the inbox, so a lost row must not tell the
    //    visitor their message failed. Delete the try/catch around the insert
    //    and this goes red.
    const s = spy(async () => ({ ok: true }), true);
    const outcome = await handleContactMessage(message(), s.deps);
    check(outcome.ok === true, `a DB failure is not fatal, got ${JSON.stringify(outcome)}`);
    check(outcome.delivery === 'sent', 'and the send still reports sent');
    check(s.delivered.length === 1, 'because the message went out regardless');
  }

  {
    // 6. The mute → ok/'skipped', and NOTHING sent. The fourth row of the
    //    table, pinned here rather than left to the keyboard: it is the only
    //    arm a route-level run can reach, so route-level success depends on it.
    process.env.BOOKING_NOTIFY_DISABLED = '1';
    try {
      const s = spy(async () => ({ ok: true }));
      const outcome = await handleContactMessage(message(), s.deps);
      check(outcome.ok === true, `the mute reports ok, got ${JSON.stringify(outcome)}`);
      check(outcome.delivery === 'skipped', `and 'skipped', got ${outcome.delivery}`);
      check(s.delivered.length === 0, 'and the INJECTED sender was not called either');
      check(s.inserted.length === 1, 'but the row was still recorded');
    } finally {
      delete process.env.BOOKING_NOTIFY_DISABLED;
    }
  }

  {
    // The mute is checked AFTER the insert on purpose — a muted verification
    // run must still exercise the real INSERT downstream.
    process.env.BOOKING_NOTIFY_DISABLED = '1';
    try {
      const s = spy(null);
      const outcome = await handleContactMessage(message(), s.deps);
      check(
        outcome.delivery === 'skipped',
        'the mute wins over a missing key — a test run cannot report a config error',
      );
    } finally {
      delete process.env.BOOKING_NOTIFY_DISABLED;
    }
  }

  // =========================================================================
  console.log('\nLIB-LEVEL — the schema (AC1)');
  // =========================================================================
  {
    const base = {
      name: 'Dana Reid',
      phone: '780 555 0199',
      email: 'dana@example.com',
      service: 'mold',
      message: 'Hello',
    };

    const ok = parseContactSubmission(base);
    check(ok.ok, 'a complete submission parses');
    if (ok.ok) {
      check(ok.message.service === 'mold', 'and keeps the service it was given');
      check(ok.message.email === 'dana@example.com', 'and the email');
    }

    // service: absent and empty both mean "not given", and both become NULL.
    for (const [label, body] of [
      ['absent', { ...base, service: undefined }],
      ['empty string', { ...base, service: '' }],
      ['whitespace', { ...base, service: '   ' }],
    ] as const) {
      const parsed = parseContactSubmission(body);
      check(parsed.ok, `a submission with ${label} service is VALID — service is optional now`);
      if (parsed.ok) {
        check(parsed.message.service === null, `and ${label} normalizes to NULL, not ''`);
      }
    }

    // message: required, and whitespace is not a message.
    for (const [label, body] of [
      ['absent', { ...base, message: undefined }],
      ['empty', { ...base, message: '' }],
      ['whitespace only', { ...base, message: '   \n  ' }],
    ] as const) {
      check(
        !parseContactSubmission(body).ok,
        `a ${label} message is REJECTED — it is a message form`,
      );
    }

    // email: optional, empty allowed, malformed rejected.
    const noEmail = parseContactSubmission({ ...base, email: '' });
    check(noEmail.ok, 'an empty email is accepted');
    if (noEmail.ok) check(noEmail.message.email === null, 'and normalizes to NULL');
    check(!parseContactSubmission({ ...base, email: 'not-an-email' }).ok, 'a malformed email is rejected');

    check(!parseContactSubmission({ ...base, name: 'D' }).ok, 'a one-character name is rejected');
    check(!parseContactSubmission({ ...base, phone: '780' }).ok, 'a three-digit phone is rejected');
    check(!parseContactSubmission(null).ok, 'and a non-object body is rejected rather than thrown on');
  }

  // =========================================================================
  console.log('\nLIB-LEVEL — the message the office receives (AC1)');
  // =========================================================================
  {
    check(
      contactSubject('Mold Removal') === 'New message — Mold Removal',
      `subject with a service, got "${contactSubject('Mold Removal')}"`,
    );
    check(
      contactSubject(null) === 'New message',
      `subject without one, got "${contactSubject(null)}"`,
    );
    check(!contactSubject(null).includes('Quote'), 'and nothing still says "Quote Request"');

    const withService = buildContactEmail(message(), 'Mold Removal');
    check(withService.subject === 'New message — Mold Removal', 'the email carries that subject');
    check(withService.replyTo === 'dana@example.com', 'and replies go to the visitor');

    // The whole point of AC1: no "null" anywhere when no service was picked.
    const without = buildContactEmail(message({ service: null }), null);
    check(!without.html.includes('null'), 'the HTML body says nothing about "null"');
    check(!without.text.includes('null'), 'nor does the text body');
    check(without.text.includes('Not specified'), 'it says "Not specified" instead');

    const anonymous = buildContactEmail(message({ email: null }), null);
    check(
      anonymous.replyTo === undefined,
      'a visitor with no email produces NO replyTo key — an empty string is an API error',
    );
    check(anonymous.text.includes('Email:   —'), 'and the body shows a dash');

    // Escaping comes from booking-email.ts's five-character version. The
    // apostrophe is the one the retired local copy missed.
    const nasty = buildContactEmail(
      message({ name: `<script>alert('x')</script>`, message: 'a & b' }),
      'Mold Removal',
    );
    check(!nasty.html.includes('<script>'), 'a script tag in a name does not reach the HTML');
    check(nasty.html.includes('&#39;'), 'and the apostrophe is escaped');
    check(nasty.html.includes('a &amp; b'), 'as is the ampersand');
  }

  // =========================================================================
  console.log('\nROUTE-LEVEL — the real endpoint against the dev branch (AC1, AC2)');
  // =========================================================================
  // Mute BEFORE importing anything that reaches readEnv. Everything from here
  // can only reach the `skipped` arm — which is the point: this half exists for
  // the INSERT and the status mapping, not for the send.
  process.env.BOOKING_NOTIFY_DISABLED = '1';
  const { POST: contactRoute } = await import('../src/pages/api/contact');

  check(
    process.env.BOOKING_NOTIFY_DISABLED === '1',
    'the mute is set — no message from this section can reach a real inbox',
  );

  async function post(body: unknown, raw?: string): Promise<Response> {
    const request = new Request('https://verify.local/api/contact/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw ?? JSON.stringify(body),
    });
    return contactRoute({ request } as never);
  }

  type Row = { id: number; service: string | null; email: string | null; message: string | null };

  async function newestRow(): Promise<Row | null> {
    const rows = (await sql`
      SELECT id, service, email, message FROM leads
      WHERE name LIKE ${`${MARKER}%`} ORDER BY id DESC LIMIT 1
    `) as Row[];
    return rows[0] ?? null;
  }

  {
    // The headline case: a message with NO service lands. Before migration 004
    // this violated `service TEXT NOT NULL`, the route's catch ate it, and the
    // visitor saw success over a row that never existed.
    const res = await post({
      name: `${MARKER} no-service`,
      phone: '7805550199',
      email: '',
      service: '',
      message: 'Just a question about mould in a crawlspace.',
    });
    check(res.status === 200, `a valid message answers 200, got ${res.status}`);
    const body = (await res.json()) as { ok?: boolean };
    check(body.ok === true, 'the muted send maps to ok:true — the pinned `skipped` row');

    const row = await newestRow();
    check(row !== null, 'and the row is in the database');
    if (row) {
      createdIds.push(row.id);
      check(row.service === null, `with a NULL service, got ${JSON.stringify(row.service)}`);
      check(row.email === null, 'an empty email stored as NULL, not ""');
      check(row.message?.startsWith('Just a question') === true, 'and the message itself');
    }
  }

  {
    const res = await post({
      name: `${MARKER} with-service`,
      phone: '7805550199',
      service: 'mold',
      message: 'Basement smell.',
    });
    check(res.status === 200, `a message WITH a service answers 200, got ${res.status}`);
    const row = await newestRow();
    if (row) {
      createdIds.push(row.id);
      check(row.service === 'mold', `and stores the service key, got ${row.service}`);
    }
  }

  {
    const before = (await sql`
      SELECT COUNT(*)::int AS n FROM leads WHERE name LIKE ${`${MARKER}%`}
    `) as { n: number }[];

    const noMessage = await post({
      name: `${MARKER} invalid`,
      phone: '7805550199',
      service: 'mold',
      message: '',
    });
    check(noMessage.status === 422, `a missing message is 422, got ${noMessage.status}`);

    const shortName = await post({ name: 'D', phone: '7805550199', message: 'hi' });
    check(shortName.status === 422, `a one-character name is 422, got ${shortName.status}`);

    const notJson = await post(undefined, 'this is not json');
    check(notJson.status === 400, `an unparseable body is 400, got ${notJson.status}`);

    const after = (await sql`
      SELECT COUNT(*)::int AS n FROM leads WHERE name LIKE ${`${MARKER}%`}
    `) as { n: number }[];
    check(
      before[0].n === after[0].n,
      `a rejected submission writes NO row (before ${before[0].n}, after ${after[0].n})`,
    );
  }

  {
    // The FAILED arm at ROUTE level (implementation-review should-fix). Under
    // the mute every route call above reaches only `skipped`, and lib-level
    // pins the outcome VALUE — so the route's own mapping of `failed` to a 500
    // was the one truth-table row no gate observed: `if (outcome.ok)` could
    // rot to `return json({ ok: true }, 200)` with every gate green. With the
    // mute off and no key in reach, the send arm is `failed` with nothing
    // sendable — no mail risk, real mapping observed.
    delete process.env.BOOKING_NOTIFY_DISABLED;
    const savedKey = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
      const res = await post({
        name: `${MARKER} failed-arm`,
        phone: '7805550199',
        service: 'mold',
        message: 'This send cannot succeed — no key is reachable.',
      });
      check(res.status === 500, `a failed send is a 500 at the route, got ${res.status}`);
      const body = (await res.json()) as { ok?: boolean };
      check(body.ok !== true, 'and never ok:true — the shipped false-success stays dead');
      const row = await newestRow();
      check(row !== null, 'while the row still landed — recoverable in admin');
      if (row) createdIds.push(row.id);
    } finally {
      process.env.BOOKING_NOTIFY_DISABLED = '1';
      if (savedKey !== undefined) process.env.RESEND_API_KEY = savedKey;
    }
  }
} finally {
  const removed = await cleanup().catch(() => -1);
  console.log(`\n  cleaned up ${removed} lead row(s)`);
  const left = (await sql`
    SELECT COUNT(*)::int AS n FROM leads
    WHERE id = ANY(${createdIds}::int[]) OR name LIKE ${`${MARKER}%`}
  `) as { n: number }[];
  if (left[0].n > 0) {
    console.error(`  ✗ ${left[0].n} seeded row(s) survived cleanup — remove them manually.`);
    failures++;
  }
}

if (failures > 0) {
  console.error(`\n✗ ${failures} check${failures === 1 ? '' : 's'} failed\n`);
  process.exit(1);
}
console.log('\n✓ contact message checks passed\n');
