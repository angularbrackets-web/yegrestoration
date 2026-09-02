// Checks the admin appointments surface: who is allowed past the login gate,
// which appointments still need a crew, which missing notification stamp is a
// real failure, and that no page renders a timestamp in the server's zone or
// leaks a Blob location.
//
//   npx tsx scripts/verify-booking-admin.ts
//
// Pure: no database, no environment, no network. Everything it imports is a
// pure module, and the page checks read source text off disk.
//
// Exits non-zero if any assertion fails.

// The server this code runs on is UTC (Vercel). Pin the process to UTC before
// anything constructs a formatter, so that "renders Edmonton time" is a claim
// that can actually fail here — on a developer's Edmonton laptop, a formatter
// missing its `timeZone` would otherwise produce the right answer by accident.
process.env.TZ = 'UTC';

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { isPublicAdminPath, ADMIN_LOGIN_PATH } from '../src/lib/auth';
import {
  appointmentMoney,
  paymentReceipt,
  stillOwesPayment,
  type MoneyBearingAppointment,
  ADMIN_APPOINTMENTS_PATH,
  ADMIN_APPOINTMENT_CREATE_ENDPOINT,
  ADMIN_APPOINTMENT_NEW_PATH,
  ADMIN_APPOINTMENT_RESEND_ENDPOINT,
  ADMIN_APPOINTMENT_UPDATE_ENDPOINT,
  ADMIN_BLACKOUTS_PATH,
  ADMIN_BLACKOUT_ADD_ENDPOINT,
  ADMIN_BLACKOUT_DELETE_ENDPOINT,
  ADMIN_FILE_ENDPOINT,
  ADMIN_LEADS_PATH,
  ADMIN_REPLY_ENDPOINT,
  adminAppointmentPath,
  adminFilePath,
  adminLeadPath,
  customerStampState,
  formatAdminTimestamp,
  formatFileSize,
  hasNotificationWarning,
  internalStampState,
  LEAD_SERVICE_UNSPECIFIED,
  leadServiceLabel,
  notificationFlags,
  partitionAppointments,
  type NotifiableAppointment,
  type PartitionableAppointment,
} from '../src/lib/booking-admin';
// LIVE_STATUSES is deliberately NOT imported: this script's expectation is a
// literal, and importing the constant is how it stopped being one.
import { APPOINTMENT_STATUSES } from '../src/lib/booking-status';
import { SUPPORT_PHONE } from '../src/lib/booking-config';
import { gstFor } from '../src/lib/booking-pricing';
import type { Appointment, AppointmentStatus, Lead } from '../src/lib/db';
import { fillTemplate, REPLY_TEMPLATES, SERVICE_FALLBACK } from '../src/lib/reply-templates';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    failures++;
  }
}

// ---------------------------------------------------------------------------
console.log('\nThe login gate under trailingSlash: always (AC1)');
// ---------------------------------------------------------------------------
{
  // The loop this replaced: production 308s /admin/login to /admin/login/, the
  // slashed form missed the exact-match lookup, and the middleware redirected
  // it back to the unslashed one. Forever. So BOTH forms have to be public.
  const publicPaths = [
    '/admin/login',
    '/admin/login/',
    '/api/admin/login',
    '/api/admin/login/',
    '/api/admin/logout',
    '/api/admin/logout/',
  ];
  for (const path of publicPaths) {
    check(isPublicAdminPath(path), `${path} must be reachable without a session`);
  }

  // The other half, and the one that matters more: normalization must not turn
  // a protected path into a public one. Every near-miss below shares a prefix
  // with a public path.
  const protectedPaths = [
    '/admin',
    '/admin/',
    '/admin/appointments/',
    '/admin/appointments/12/',
    '/admin/leads/12/',
    '/admin/login-x',
    '/admin/login-x/',
    '/admin/login//',
    '/admin/login/extra',
    '/admin/loginx/',
    '/api/admin/reply',
    '/api/admin/reply/',
    '/api/admin/login/extra',
    '/api/admin/logout/extra/',
    '/api/admin/loginy/',
    '/admin/Login/',
    '/adminlogin/',
    '',
    '/',
  ];
  for (const path of protectedPaths) {
    check(!isPublicAdminPath(path), `${path || '(empty)'} must NOT be treated as public`);
  }

  // The redirect target is the reason the loop existed at all: an unslashed
  // Location buys a 308 straight back into the middleware.
  check(ADMIN_LOGIN_PATH === '/admin/login/', 'the unauthenticated redirect target is slashed');
  check(isPublicAdminPath(ADMIN_LOGIN_PATH), 'and the target it redirects to is itself public');
}

// ---------------------------------------------------------------------------
console.log('\nEvery form action and redirect the login flow uses is slashed (AC1)');
// ---------------------------------------------------------------------------
{
  // Source-level, because these are strings in templates and route handlers
  // that no unit test reaches. An unslashed one still *works* — it 308s — but
  // it is how the loop was built, and a POST that 308s is a POST replayed.
  const wanted: [string, string[]][] = [
    // The outage did not live in auth.ts — it lived in this call site, as a
    // `Set.has(pathname)` against unslashed literals. Every check above can
    // stay green while the middleware goes back to looking the paths up
    // itself, so the call site is pinned here by name.
    ['src/middleware.ts', ['isPublicAdminPath(pathname)', 'ADMIN_LOGIN_PATH']],
    ['src/pages/admin/login.astro', ['action="/api/admin/login/"']],
    ['src/layouts/AdminLayout.astro', ['action="/api/admin/logout/"']],
    ['src/pages/api/admin/login.ts', [`Location: '/admin/'`, `Location: '/admin/login/?error=1'`]],
    ['src/pages/api/admin/logout.ts', [`Location: '/admin/login/'`]],
  ];
  for (const [file, needles] of wanted) {
    const path = resolve(root, file);
    check(existsSync(path), `${file} exists`);
    if (!existsSync(path)) continue;
    const source = readFileSync(path, 'utf8');
    for (const needle of needles) {
      check(source.includes(needle), `${file} carries ${needle}`);
    }
  }

  // And that it kept no second, unslashed list of its own to fall back on.
  const middleware = readFileSync(resolve(root, 'src/middleware.ts'), 'utf8');
  check(
    !/['"]\/admin\/login['"]/.test(middleware),
    'the middleware holds no unslashed /admin/login literal of its own',
  );
}

// ---------------------------------------------------------------------------
console.log('\nEvery admin path BK-08 added is slashed (BK-08 AC9)');
// ---------------------------------------------------------------------------
{
  // The constants first. These are the only spellings the pages and routes use,
  // so an unslashed one here is an unslashed one everywhere at once.
  const PATHS: [string, string][] = [
    ['ADMIN_APPOINTMENTS_PATH', ADMIN_APPOINTMENTS_PATH],
    ['ADMIN_APPOINTMENT_NEW_PATH', ADMIN_APPOINTMENT_NEW_PATH],
    ['ADMIN_BLACKOUTS_PATH', ADMIN_BLACKOUTS_PATH],
    ['ADMIN_APPOINTMENT_CREATE_ENDPOINT', ADMIN_APPOINTMENT_CREATE_ENDPOINT],
    ['ADMIN_APPOINTMENT_UPDATE_ENDPOINT', ADMIN_APPOINTMENT_UPDATE_ENDPOINT],
    ['ADMIN_APPOINTMENT_RESEND_ENDPOINT', ADMIN_APPOINTMENT_RESEND_ENDPOINT],
    ['ADMIN_BLACKOUT_ADD_ENDPOINT', ADMIN_BLACKOUT_ADD_ENDPOINT],
    ['ADMIN_BLACKOUT_DELETE_ENDPOINT', ADMIN_BLACKOUT_DELETE_ENDPOINT],
    // BK-09's file proxy. It carries more than a redirect: it mints a
    // credential for the private Blob store, so "still needs a session" is the
    // assertion that matters most in this list.
    ['ADMIN_FILE_ENDPOINT', ADMIN_FILE_ENDPOINT],
    // BK-10's two. The leads surface outlived the plan to retire it, so its
    // paths are constants on the same list rather than hand-spelled strings
    // that each cost a 308 per click.
    ['ADMIN_LEADS_PATH', ADMIN_LEADS_PATH],
    ['ADMIN_REPLY_ENDPOINT', ADMIN_REPLY_ENDPOINT],
  ];
  for (const [name, value] of PATHS) {
    check(value.endsWith('/'), `${name} (${value}) ends with a slash`);
    check(value.startsWith('/'), `${name} is root-relative`);
  }
  check(adminAppointmentPath(12) === '/admin/appointments/12/', 'a detail path is built slashed');
  check(adminFilePath(7) === '/api/admin/files/7/', 'and a file link is built slashed (BK-09)');
  check(adminLeadPath(12) === '/admin/leads/12/', 'and a lead detail path too (BK-10)');
  check(!isPublicAdminPath(adminLeadPath(12)), 'a lead detail page still needs a session');

  // Every one of them is behind the middleware, and none accidentally became
  // public. The gate normalizes exactly one trailing slash, so a new public path
  // would have to be added deliberately — this proves none was.
  for (const [, value] of PATHS) {
    check(!isPublicAdminPath(value), `${value} still needs a session`);
  }
  check(!isPublicAdminPath(adminAppointmentPath(12)), 'and so does an appointment detail page');
  check(
    !isPublicAdminPath(adminFilePath(7)),
    'and a file link — the one path that mints a Blob credential — is not public',
  );

  // Now the source. Every `/admin/...` or `/api/admin/...` string literal in the
  // new pages and routes must end in a slash — that is the general shape of the
  // trap, not just the paths this file happens to know the names of. An
  // unslashed form ACTION is a POST replayed after a 308.
  const NEW_SOURCES = [
    'src/pages/admin/appointments/new.astro',
    'src/pages/admin/appointments/index.astro',
    'src/pages/admin/appointments/[id].astro',
    'src/pages/admin/blackouts.astro',
    'src/pages/api/admin/appointments/create.ts',
    'src/pages/api/admin/appointments/update.ts',
    'src/pages/api/admin/appointments/resend.ts',
    'src/pages/api/admin/blackouts/add.ts',
    'src/pages/api/admin/blackouts/delete.ts',
    'src/lib/booking-admin.ts',
    'src/layouts/AdminLayout.astro',
    // BK-10. These three carried the four unslashed literals the ROADMAP had
    // owed since BK-07, and they are the reason the regex below was widened.
    'src/pages/admin/index.astro',
    'src/pages/admin/leads/[id].astro',
    'src/pages/api/admin/reply.ts',
  ];
  for (const file of NEW_SOURCES) {
    const path = resolve(root, file);
    check(existsSync(path), `${file} exists`);
    if (!existsSync(path)) continue;
    // Comments are stripped: prose about `/api/admin/reply` is documentation,
    // not a link, and BK-07's own trap entry is written in exactly that form.
    const source = readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');

    // Backticks are in the delimiter class deliberately. The spelling
    // `adminAppointmentPath` replaced was a TEMPLATE literal
    // (href={`/admin/appointments/${id}/`}), which a quotes-only scan cannot
    // see — so the one form this rule most needs to cover would have been the
    // one it missed. Newlines are excluded so a long template body cannot make
    // the match run away.
    //
    // BK-10 WIDENED THIS, and the old shape is worth stating because the
    // ROADMAP claimed adding a file to the list above was all that was needed.
    // It was not. The previous pattern required `/admin/` — a literal slash
    // after `admin` — so `href="/admin"` was invisible; and it excluded `?`
    // and `#` from the path body, so `'/admin?error=validation'` and
    // `` `/admin/leads/${id}?success=1` `` matched nothing at all rather than
    // matching and failing. Those were the exact four literals this ticket
    // fixed: adding the files without this change would have produced a green
    // scan over unslashed paths.
    //
    // Now the whole literal is captured, the query/fragment is stripped, and
    // the PATH part is what must end in a slash.
    for (const match of source.matchAll(/['"`](\/(?:api\/)?admin[^'"`\n]*)['"`]/g)) {
      const literal = match[1];
      const path = literal.split(/[?#]/)[0];
      check(
        path.endsWith('/'),
        `${file}: ${literal} — the path part (${path}) must end with a slash`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\nThe forms post, and post to the right places (BK-08 AC9)');
// ---------------------------------------------------------------------------
{
  // Each write form is pinned to its endpoint by NAME rather than by literal,
  // because the literal is what the constant exists to stop being retyped. A
  // form that lost its `method="POST"` would issue a GET with the fields in the
  // query string — customer details in a URL, which item 3 of the ticket exists
  // to prevent.
  const FORMS: [string, string[]][] = [
    ['src/pages/admin/appointments/new.astro', ['ADMIN_APPOINTMENT_CREATE_ENDPOINT']],
    [
      'src/pages/admin/appointments/[id].astro',
      ['ADMIN_APPOINTMENT_UPDATE_ENDPOINT', 'ADMIN_APPOINTMENT_RESEND_ENDPOINT'],
    ],
    [
      'src/pages/admin/blackouts.astro',
      ['ADMIN_BLACKOUT_ADD_ENDPOINT', 'ADMIN_BLACKOUT_DELETE_ENDPOINT'],
    ],
    ['src/pages/admin/appointments/index.astro', ['ADMIN_APPOINTMENT_NEW_PATH']],
  ];
  for (const [file, needles] of FORMS) {
    const source = readFileSync(resolve(root, file), 'utf8');
    for (const needle of needles) {
      check(source.includes(`action={${needle}}`) || source.includes(`href={${needle}}`), `${file} wires up ${needle}`);
    }
    const forms = source.match(/<form\b[^>]*>/g) ?? [];
    for (const form of forms) {
      check(/method="POST"/i.test(form), `${file}: every form posts — ${form.slice(0, 60)}…`);
    }
  }

  // The entry form must never round-trip typed values. A `value={` bound to
  // anything read off the query string would put a customer's name back into a
  // URL on the next failed submit.
  const entryForm = readFileSync(resolve(root, 'src/pages/admin/appointments/new.astro'), 'utf8');
  check(
    !/value=\{[^}]*searchParams/.test(entryForm),
    'the entry form repopulates nothing from the query string',
  );
}

// ---------------------------------------------------------------------------
console.log('\npartitionAppointments — who still needs a crew (AC3)');
// ---------------------------------------------------------------------------
const NOW = new Date('2026-08-20T18:30:00Z'); // 12:30 p.m. Edmonton (MDT)

type Row = PartitionableAppointment & { id: number };

function row(id: number, status: AppointmentStatus, offsetMs: number): Row {
  return { id, status, slot_start: new Date(NOW.getTime() + offsetMs) };
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

{
  // BK-23: all eight, not the old four. The three LIVE ones are upcoming-
  // eligible now, so this grid is 24 cells rather than 12 and three of the
  // future rows are upcoming rather than one.
  const STATUSES: AppointmentStatus[] = [...APPOINTMENT_STATUSES];
  const OFFSETS: [string, number][] = [
    ['past', -3 * DAY],
    ['boundary', 0],
    ['future', 3 * DAY],
  ];

  // WHICH STATUSES ARE UPCOMING-ELIGIBLE, SPELLED OUT AS DATA.
  //
  // This list used to be `LIVE_STATUSES.includes(status)` — the same constant
  // `partitionAppointments` reads to make the decision under test. Both sides
  // then moved together: adding 'completed' to LIVE_STATUSES put finished jobs
  // back in the office's upcoming column and **every assertion here stayed
  // green**. Found while logging red rows for this section, 2026-08-18.
  //
  // Seventh instance of the family in ROADMAP's Known traps, and the rule it
  // already states: an assertion must never call the function — or read the
  // constant — it is asserting about. The expectation is a literal now, so
  // changing the production list is a diff someone has to make here too, on
  // purpose, with this comment in front of them.
  const UPCOMING_ELIGIBLE = new Set<string>([
    'pending_review',
    'approved_awaiting_payment',
    'confirmed',
  ]);

  // The complement, stated rather than computed, so a status added to the enum
  // and forgotten fails LOUDLY here instead of being silently absent from both
  // sides of the comparison.
  const PAST_ONLY = new Set<string>([
    'completed',
    'cancelled',
    'declined',
    'payment_expired',
    'no_show',
  ]);
  check(
    UPCOMING_ELIGIBLE.size + PAST_ONLY.size === STATUSES.length,
    `every status is classified here (${UPCOMING_ELIGIBLE.size} + ${PAST_ONLY.size} vs ${STATUSES.length}) — a new status must be added to one of these two lists`,
  );
  for (const status of STATUSES) {
    check(
      UPCOMING_ELIGIBLE.has(status) !== PAST_ONLY.has(status),
      `${status} is in exactly one of the two lists`,
    );
  }

  // Exhaustive: every status against every side of the cutoff. Only the three
  // LIVE statuses are upcoming-eligible, and only at or after the boundary.
  let id = 0;
  const rows: Row[] = [];
  const expected = new Map<number, 'upcoming' | 'past'>();
  for (const status of STATUSES) {
    for (const [, offset] of OFFSETS) {
      id++;
      rows.push(row(id, status, offset));
      expected.set(id, UPCOMING_ELIGIBLE.has(status) && offset >= 0 ? 'upcoming' : 'past');
    }
  }

  const { upcoming, past } = partitionAppointments(rows, NOW);
  check(upcoming.length + past.length === rows.length, 'no appointment is dropped or duplicated');

  for (const [rowId, side] of expected) {
    const inUpcoming = upcoming.some((r) => r.id === rowId);
    const inPast = past.some((r) => r.id === rowId);
    const status = rows.find((r) => r.id === rowId)!.status;
    const when = rows.find((r) => r.id === rowId)!.slot_start.getTime() - NOW.getTime();
    const label = `${status} @ ${when === 0 ? 'the cutoff instant' : when > 0 ? 'future' : 'past'}`;
    check(
      side === 'upcoming' ? inUpcoming && !inPast : inPast && !inUpcoming,
      `${label} belongs in ${side}`,
    );
  }

  // Stated as its own assertion because it is the one the ticket calls out: an
  // appointment starting exactly now has not happened yet.
  check(
    upcoming.some((r) => r.slot_start.getTime() === NOW.getTime()),
    'the boundary instant (slot_start === now) is upcoming, not past',
  );
}

{
  // Ordering. Built shuffled, since a list that arrives sorted cannot tell a
  // working sort from no sort at all.
  const rows: Row[] = [
    row(1, 'confirmed', 5 * HOUR),
    row(2, 'confirmed', 1 * HOUR),
    row(3, 'confirmed', 3 * HOUR),
    row(4, 'completed', -1 * HOUR),
    row(5, 'cancelled', -5 * HOUR),
    row(6, 'no_show', -3 * HOUR),
  ];
  const { upcoming, past } = partitionAppointments(rows, NOW);

  check(
    upcoming.map((r) => r.id).join(',') === '2,3,1',
    'upcoming is ascending — soonest first is the operational order',
  );
  check(
    past.map((r) => r.id).join(',') === '4,6,5',
    'past is descending — most recent first',
  );

  // Cancelled rows stay visible rather than being filtered away: a cancelled
  // slot that gets rebooked is tomorrow's confusion.
  check(past.some((r) => r.id === 5), 'a cancelled appointment is still listed');

  // Pure: the input array is not reordered under the caller.
  const original: Row[] = [row(1, 'confirmed', 5 * HOUR), row(2, 'confirmed', 1 * HOUR)];
  const before = original.map((r) => r.id).join(',');
  partitionAppointments(original, NOW);
  check(original.map((r) => r.id).join(',') === before, 'the caller’s array is left untouched');

  check(
    partitionAppointments([], NOW).upcoming.length === 0,
    'an empty list partitions into two empty lists',
  );
}

// ---------------------------------------------------------------------------
console.log('\nnotificationFlags — which missing stamp is a failure (AC4)');
// ---------------------------------------------------------------------------
{
  const STAMP = new Date('2026-08-20T18:31:00Z');

  function appt(over: Partial<NotifiableAppointment>): NotifiableAppointment {
    return {
      source: 'web',
      email: 'dana@example.com',
      confirmation_sent_at: STAMP,
      internal_notified_at: STAMP,
      ...over,
    };
  }

  // Exhaustive over the four inputs that can move either flag: 2 sources ×
  // 2 email states × 2 confirmation states × 2 internal states = 16.
  for (const source of ['web', 'admin'] as const) {
    for (const email of ['dana@example.com', null]) {
      for (const confirmation of [STAMP, null]) {
        for (const internal of [STAMP, null]) {
          const flags = notificationFlags(
            appt({
              source,
              email,
              confirmation_sent_at: confirmation,
              internal_notified_at: internal,
            }),
          );
          const web = source === 'web';
          const label = `source=${source} email=${email ? 'yes' : 'no'} confirmation=${
            confirmation ? 'sent' : 'null'
          } internal=${internal ? 'sent' : 'null'}`;

          check(
            flags.internalMissing === (web && internal === null),
            `${label} → internalMissing ${web && internal === null}`,
          );
          check(
            flags.customerMissing === (web && email !== null && confirmation === null),
            `${label} → customerMissing ${web && email !== null && confirmation === null}`,
          );
          check(
            hasNotificationWarning(
              appt({
                source,
                email,
                confirmation_sent_at: confirmation,
                internal_notified_at: internal,
              }),
            ) === (flags.internalMissing || flags.customerMissing),
            `${label} → the list-page marker agrees with the flags`,
          );
        }
      }
    }
  }

  // The three cases the flags exist to get right, restated so a failure names
  // the rule rather than a coordinate in the matrix above.
  check(
    !notificationFlags(appt({ source: 'admin', confirmation_sent_at: null, internal_notified_at: null }))
      .internalMissing,
    'an office-entered appointment never had a notification to fail',
  );
  check(
    !notificationFlags(appt({ email: null, confirmation_sent_at: null })).customerMissing,
    'a customer who gave no email was never owed a confirmation',
  );
  check(
    notificationFlags(appt({ email: '  ', confirmation_sent_at: null })).customerMissing === false,
    'nor was one who gave only whitespace',
  );
  check(
    notificationFlags(appt({ internal_notified_at: null })).internalMissing,
    'a web booking nobody told the office about is a failure',
  );

  // sms_consent_at and reminder_sent_at are deliberately NOT inputs: a null
  // consent is a valid state (the timestamp IS the consent) and a null
  // reminder is expected on every row until BK-06 ships. Asserted against the
  // source of `notificationFlags` rather than against this file's own fixture
  // keys — the fixture cannot grow a column on its own, so a check on it would
  // be true by construction and could never report the change it claims to
  // guard.
  // -------------------------------------------------------------------------
  // BK-08 CHANGES THIS MATRIX. BK-07 rendered a null customer stamp as either a
  // warning or "Not applicable"; since manual entries can now send a
  // confirmation, "Not applicable" on an admin row WITH an email is simply
  // false. The third neutral state, `none`, is what the detail page renders
  // there, and `failed` stays web-only so the list page's red marker keeps
  // meaning "the system did not do its job".
  // -------------------------------------------------------------------------
  for (const source of ['web', 'admin'] as const) {
    for (const email of ['dana@example.com', null]) {
      for (const confirmation of [STAMP, null]) {
        for (const internal of [STAMP, null]) {
          const row = appt({
            source,
            email,
            confirmation_sent_at: confirmation,
            internal_notified_at: internal,
          });
          const label = `source=${source} email=${email ? 'yes' : 'no'} confirmation=${
            confirmation ? 'sent' : 'null'
          } internal=${internal ? 'sent' : 'null'}`;

          const expectedCustomer = confirmation
            ? 'sent'
            : source === 'web' && email
              ? 'failed'
              : email
                ? 'none'
                : 'not-applicable';
          check(
            customerStampState(row) === expectedCustomer,
            `${label} → customer stamp ${expectedCustomer}, got ${customerStampState(row)}`,
          );

          const expectedInternal = internal ? 'sent' : source === 'web' ? 'failed' : 'not-applicable';
          check(
            internalStampState(row) === expectedInternal,
            `${label} → office stamp ${expectedInternal}, got ${internalStampState(row)}`,
          );

          // The states that raise a warning are exactly the states the list
          // page marks. Tying them together here is what stops the two drifting
          // into a detail page that shouts and a list that is silent.
          check(
            (customerStampState(row) === 'failed' || internalStampState(row) === 'failed') ===
              hasNotificationWarning(row),
            `${label} → the list marker agrees with the stamp states`,
          );
        }
      }
    }
  }

  // The one cell BK-08 flipped, restated so a failure names the rule rather
  // than a coordinate in the matrix above.
  check(
    customerStampState(
      appt({ source: 'admin', email: 'dana@example.com', confirmation_sent_at: null }),
    ) === 'none',
    'an office-entered row with an email reads "none sent", not "not applicable"',
  );
  check(
    customerStampState(appt({ source: 'admin', email: null, confirmation_sent_at: null })) ===
      'not-applicable',
    'but with no email address there was never anything to send',
  );
  check(
    !hasNotificationWarning(
      appt({ source: 'admin', email: 'dana@example.com', confirmation_sent_at: null }),
    ),
    'and it still raises no warning — an admin row was never owed a confirmation',
  );
  check(
    customerStampState(appt({ source: 'web', email: 'dana@example.com', confirmation_sent_at: null })) ===
      'failed',
    'while a web booking owed a confirmation and never sent one is still a failure',
  );

  const helperSource = readFileSync(resolve(root, 'src/lib/booking-admin.ts'), 'utf8');
  const body = helperSource.slice(
    helperSource.indexOf('export function notificationFlags'),
    helperSource.indexOf('export function hasNotificationWarning'),
  );
  check(body.length > 0, 'notificationFlags is where this file expects it');
  for (const column of ['sms_consent_at', 'reminder_sent_at']) {
    check(!body.includes(column), `notificationFlags does not read ${column} — absence is valid`);
  }
}

// ---------------------------------------------------------------------------
console.log('\nTimestamps render in Edmonton time, not the server’s (AC2)');
// ---------------------------------------------------------------------------
{
  // 2026-08-23T21:30:00Z is 3:30 p.m. MDT — the exact case the ticket names:
  // rendered in the server's UTC it reads 9:30 p.m., the wrong half of the day.
  const instant = new Date('2026-08-23T21:30:00Z');
  const rendered = formatAdminTimestamp(instant);
  check(rendered.includes('3:30'), `formatAdminTimestamp shows 3:30, got "${rendered}"`);
  check(!rendered.includes('9:30'), 'and not the UTC wall clock');
  check(rendered.includes('23'), 'on the right calendar day');
  check(rendered.includes('2026'), 'with the year, which formatSlot omits');

  // The other side of midnight: 2026-08-24T04:00:00Z is still Aug 23 locally,
  // so a zone-less formatter would print tomorrow's date.
  const lateEvening = formatAdminTimestamp(new Date('2026-08-24T04:00:00Z'));
  check(lateEvening.includes('23'), `10 p.m. Edmonton stays on Aug 23, got "${lateEvening}"`);

  // Winter, to catch an offset frozen at one side of DST.
  const winter = formatAdminTimestamp(new Date('2026-01-15T22:30:00Z'));
  check(winter.includes('3:30'), `MST renders 3:30 p.m. too, got "${winter}"`);
}

// ---------------------------------------------------------------------------
console.log('\nFile sizes');
// ---------------------------------------------------------------------------
{
  check(formatFileSize(null) === 'unknown size', 'a null size reads as unknown');
  check(formatFileSize(512) === '512 B', 'bytes');
  check(formatFileSize(1536) === '1.5 KB', 'kilobytes, one decimal');
  check(formatFileSize(5 * 1024 * 1024) === '5.0 MB', 'megabytes');
  // BIGINT comes back from the driver as a string whatever db.ts says.
  check(formatFileSize('5242880') === '5.0 MB', 'a string size is not rendered as unknown');
}

// ---------------------------------------------------------------------------
console.log('\nEvery admin page renders dates in Edmonton time (AC2, AC6)');
// ---------------------------------------------------------------------------
/**
 * A bare `toLocale*` renders the SERVER's zone — UTC on Vercel, six or seven
 * hours off. Slots go through `formatSlot` and everything else through
 * `formatAdminTimestamp`, so no admin page should call one at all; if one ever
 * does, it must name its `timeZone`.
 *
 * Extracted into a function by BK-10 so the LEADS pages can be held to the
 * same rule as the appointments pages. They were the last two sites of the
 * wrong-day pattern, and the ROADMAP had owed the fix since BK-07.
 */
function checkZoneAwareDates(page: string) {
  const path = resolve(root, page);
  // Without this the scan passes vacuously on a file that does not exist.
  check(existsSync(path), `${page} exists`);
  if (!existsSync(path)) return;
  const source = readFileSync(path, 'utf8');

  for (const match of source.matchAll(/\.toLocale[A-Za-z]*\s*\(/g)) {
    const start = match.index ?? 0;
    let depth = 0;
    let end = source.length;
    for (let i = start + match[0].length - 1; i < source.length; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const call = source.slice(start, end + 1);
    check(
      call.includes('timeZone'),
      `${page}: ${match[0]} passes no timeZone — it would render the server's zone`,
    );
  }
}

for (const page of [
  'src/pages/admin/index.astro',
  'src/pages/admin/leads/[id].astro',
  'src/pages/admin/appointments/index.astro',
  'src/pages/admin/appointments/[id].astro',
  'src/pages/admin/appointments/new.astro',
  'src/pages/admin/blackouts.astro',
  'src/layouts/AdminLayout.astro',
]) {
  checkZoneAwareDates(page);
}

// ---------------------------------------------------------------------------
console.log('\nNo admin page leaks a Blob location (BK-09)');
// ---------------------------------------------------------------------------
{
  const PAGES = [
    'src/pages/admin/appointments/index.astro',
    'src/pages/admin/appointments/[id].astro',
    // Renders on every admin page, and BK-07 rewrote it.
    'src/layouts/AdminLayout.astro',
    // BK-08's two new pages.
    'src/pages/admin/appointments/new.astro',
    'src/pages/admin/blackouts.astro',
  ];

  for (const page of PAGES) {
    const path = resolve(root, page);
    check(existsSync(path), `${page} exists`);
    if (!existsSync(path)) continue;
    const source = readFileSync(path, 'utf8');

    // The Blob store is private and 403s an unauthenticated GET, so a URL here
    // would be useless as well as a leak; viewing arrives with BK-09. Pathnames
    // are not rendered even as text. `Astro.url.pathname` is the page's own URL
    // and is not a file location.
    const stripped = source.replace(/Astro\.url\.pathname/g, '').replace(/Astro\.url/g, '');
    // Dotted access, bracket access, and destructuring — the three spellings of
    // the same leak.
    const leaks = [
      /\b(\w+)\.(url|pathname)\b/g,
      /\[\s*['"](url|pathname)['"]\s*\]/g,
      /\{[^}]*\b(url|pathname)\b[^}]*\}\s*=/g,
    ];
    for (const pattern of leaks) {
      for (const match of stripped.matchAll(pattern)) {
        check(false, `${page}: renders ${match[0]} — a Blob location must not reach the HTML`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\nEvery read of appointment_files excludes removed rows (BK-40)');
// ---------------------------------------------------------------------------
//
// A SCAN, NOT A LIST OF THE SITES WE HAPPEN TO REMEMBER. BK-40's implementation
// review found one consumer the ticket had missed (`resend.ts`'s notification
// file count) precisely because the ticket enumerated the consumers by hand,
// and a hand-taken inventory is wrong the moment somebody adds the next query.
// This walks the source instead, so the NEXT one is caught by the gate rather
// than by a reviewer.
//
// The rule: any SELECT/COUNT over `appointment_files` must carry
// `deleted_at IS NULL`, unless it is on the deliberate exemption list below and
// says why.
{
  const EXEMPT = new Map<string, string>([
    // Fetches deleted rows on purpose: it is the one screen that must SHOW a
    // removal happened, and it splits the list in JS.
    ['src/pages/admin/appointments/[id].astro', 'renders the "Removed" section'],
    // Draft-scoped, and a draft's rows are unclaimed by definition — a deleted
    // row can only reach these totals through a draft token reused after its
    // booking committed. Documented at the call site.
    ['src/pages/api/booking/upload-token.ts', 'draft-scoped; documented asymmetry'],
    // Claims rows INTO an appointment at commit time; they cannot be deleted
    // yet, because deletion is an admin action on an already-claimed file.
    ['src/lib/booking-commit.ts', 'claims unclaimed rows at commit'],
    // Reads a row it has just failed to delete, deliberately WITHOUT the
    // clause, to recover the appointment id for the redirect — so a double
    // click lands the office back on the page they were working on instead of
    // on the list with no message.
    ['src/pages/api/admin/appointments/file-delete.ts', 'recovers the id of an already-removed row'],
    // The orphan cron addresses `appointment_id IS NULL` only, and the delete
    // endpoint refuses unclaimed rows — so a soft-deleted row is unreachable
    // from here by construction.
    ['src/pages/api/cron/cleanup-uploads.ts', 'sweeps unclaimed drafts only'],
  ]);

  const walkSrc = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) walkSrc(full, out);
      else out.push(full);
    }
    return out;
  };
  const files = walkSrc(resolve(root, 'src')).filter((f) => /\.(ts|astro|svelte)$/.test(f));
  let reads = 0;
  let scanned = 0;

  for (const file of files) {
    const rel = file.slice(resolve(root).length + 1);
    const source = readFileSync(file, 'utf8');

    // THE STATEMENT IS DELIMITED BY ITS OWN TEMPLATE LITERAL, not by a
    // fixed-size window. The first version of this scan matched
    // `SELECT … FROM appointment_files …` inside 400 characters, and the red
    // pass caught it immediately: `resend.ts`'s query is longer than that, so
    // breaking it produced NO match, no check ran, and the scan stayed green on
    // the exact regression it was written for. A scan that silently skips what
    // it cannot parse is worse than no scan.
    let from = source.indexOf('FROM appointment_files');
    while (from !== -1) {
      const open = source.lastIndexOf('`', from);
      const close = source.indexOf('`', from);
      // A mention outside a template literal is prose, not a query.
      if (open !== -1 && close !== -1) {
        const statement = source.slice(open, close);
        // Reads only. An INSERT, or the UPDATE that sets `deleted_at`, is not a
        // read path; `onUploadCompleted`'s UPDATE addresses one pathname.
        if (/\bSELECT\b/i.test(statement) && !/\bINSERT\s+INTO\b/i.test(statement)) {
          reads++;
          const why = EXEMPT.get(rel);
          if (why) {
            check(true, `${rel} is exempt (${why})`);
          } else {
            check(
              statement.includes('deleted_at IS NULL'),
              `${rel}: a read of appointment_files must carry \`deleted_at IS NULL\` — removed files are not this appointment's photos`,
            );
          }
        }
      }
      from = source.indexOf('FROM appointment_files', from + 1);
    }
    if (source.includes('FROM appointment_files')) scanned++;
  }

  // The scan must be able to find things, or it passes by finding nothing —
  // the shape `verify-cutover.ts` was bitten by in BK-27, and the shape this
  // scan's own first version had. Pinned on the READ count, not the file
  // count, because that is what stops a statement dropping out of range.
  check(reads >= 6, `the scan must reach the query sites, found ${reads} reads`);
  console.log(`  ${reads} reads across ${scanned} files; each filters or is exempt with a reason`);
}

// ---------------------------------------------------------------------------
console.log('\nThe leads surface: every redirect is built, not typed (BK-10 AC6)');
// ---------------------------------------------------------------------------
{
  const source = readFileSync(resolve(root, 'src/pages/api/admin/reply.ts'), 'utf8');

  // The ROADMAP said three Location headers; there were four, and this ticket
  // added a fifth (`?error=sendfailed`). Rather than pin a count that will be
  // wrong again the next time someone adds an arm, every redirect target must
  // be BUILT from the constants — which is the property that actually matters.
  const targets = [...source.matchAll(/return redirect\(([^\n]*)\)/g)].map((m) => m[1]);
  check(targets.length >= 4, `reply.ts issues at least four redirects, found ${targets.length}`);
  for (const target of targets) {
    check(
      target.includes('ADMIN_LEADS_PATH') || target.includes('adminLeadPath('),
      `reply.ts redirect target is built from a constant, got ${target}`,
    );
  }
  check(
    !/['"`]\/admin(?![^'"`]*\/['"`])/.test(source.replace(/^\s*\*.*$/gm, '')),
    'and reply.ts holds no hand-typed /admin literal of its own',
  );

  // The send is not the route's job any more, and neither is the stamp order.
  check(
    source.includes('sendReplyAndStamp'),
    'reply.ts goes through the extracted send-then-stamp helper',
  );
  check(
    !source.includes('resend.emails.send'),
    'and calls the Resend SDK nowhere — createResendSender is the only site',
  );
  check(source.includes("readEnv('RESEND_API_KEY')"), 'the key comes through readEnv (BK-12 rule)');
  check(
    !source.includes('throw new Error'),
    'and a missing key is a logged redirect, not a throw that 500s a redirect-only page',
  );
  check(
    source.includes('error=sendfailed'),
    'a failed send redirects to ?error=sendfailed rather than reporting success',
  );

  const detail = readFileSync(resolve(root, 'src/pages/admin/leads/[id].astro'), 'utf8');
  check(detail.includes("'sendfailed'"), 'and the detail page renders that arm');
}

// ---------------------------------------------------------------------------
console.log('\nA lead with no service reads as something (BK-10 AC1)');
// ---------------------------------------------------------------------------
{
  const labels = { mold: 'Mold Removal' };

  check(
    leadServiceLabel(null, labels) === LEAD_SERVICE_UNSPECIFIED,
    `a NULL service reads as "${LEAD_SERVICE_UNSPECIFIED}"`,
  );
  check(leadServiceLabel('', labels) === LEAD_SERVICE_UNSPECIFIED, 'and so does an empty one');
  check(leadServiceLabel(undefined, labels) === LEAD_SERVICE_UNSPECIFIED, 'and an absent one');
  check(leadServiceLabel('mold', labels) === 'Mold Removal', 'a known service reads as its label');
  check(
    leadServiceLabel('sinkhole', labels) === 'sinkhole',
    'and an unknown one falls back to the key rather than to nothing',
  );
  for (const input of [null, '', undefined, 'mold', 'sinkhole'] as const) {
    const rendered = leadServiceLabel(input, labels);
    check(rendered.trim() !== '', `${String(input)} never renders as an empty cell`);
    check(!rendered.includes('null'), `${String(input)} never renders the word "null"`);
  }

  for (const page of ['src/pages/admin/index.astro', 'src/pages/admin/leads/[id].astro']) {
    const source = readFileSync(resolve(root, page), 'utf8');
    check(source.includes('leadServiceLabel('), `${page} renders the service through the guard`);
  }

  // A compile-time tie: `service` must stay nullable, or the guard above is
  // solving a problem the type says cannot happen and will be "tidied" away.
  const _nullableService: Lead['service'] = null;
  void _nullableService;
}

// ---------------------------------------------------------------------------
console.log('\nReply templates: the right phone number, and never "null" (BK-10 AC1)');
// ---------------------------------------------------------------------------
{
  // The defect this closes: every template told customers to call
  // (780) 244-4747, a number the client does not recognize, and every reply
  // sent since they shipped carried it.
  const WRONG_NUMBERS = ['244-4747', '2444747'];

  check(REPLY_TEMPLATES.length > 0, 'there are templates to check');
  check(SUPPORT_PHONE === '(780) 479-3285', `SUPPORT_PHONE is the advertised line, got ${SUPPORT_PHONE}`);

  let templatesWithAPhone = 0;
  for (const template of REPLY_TEMPLATES) {
    const whole = `${template.subject}\n${template.body}`;
    for (const wrong of WRONG_NUMBERS) {
      check(!whole.includes(wrong), `template "${template.id}" no longer carries ${wrong}`);
    }
    if (whole.includes(SUPPORT_PHONE)) templatesWithAPhone++;
    // Any phone-shaped string in a template must BE the advertised line.
    for (const match of whole.matchAll(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}/g)) {
      check(
        match[0] === SUPPORT_PHONE,
        `template "${template.id}" carries the number ${match[0]}, which is not ${SUPPORT_PHONE}`,
      );
    }
    check(
      !/quote request/i.test(whole),
      `template "${template.id}" is reframed off "Quote Request" — quotes go through /book/ now`,
    );
  }
  check(templatesWithAPhone >= 4, `most templates still offer the phone, got ${templatesWithAPhone}`);

  // The null guard, over every template, with no service picked — which is now
  // the ordinary case rather than an edge one.
  for (const template of REPLY_TEMPLATES) {
    for (const [label, service] of [
      ['null', null],
      ['undefined', undefined],
      ['empty', ''],
    ] as const) {
      const subject = fillTemplate(template.subject, { name: 'Dana', serviceLabel: service });
      const body = fillTemplate(template.body, { name: 'Dana', serviceLabel: service });
      for (const [where, text] of [
        ['subject', subject],
        ['body', body],
      ] as const) {
        check(
          !/\bnull\b/.test(text),
          `template "${template.id}" ${where} with a ${label} service contains no "null"`,
        );
        check(
          !/\bundefined\b/.test(text),
          `template "${template.id}" ${where} with a ${label} service contains no "undefined"`,
        );
        check(
          !text.includes('{{'),
          `template "${template.id}" ${where} has no unsubstituted placeholder left`,
        );
      }
      check(
        !template.body.includes('{{service}}') || body.includes(SERVICE_FALLBACK),
        `template "${template.id}" falls back to "${SERVICE_FALLBACK}"`,
      );
    }
  }

  const filled = fillTemplate('Hi {{name}}, about {{service}}.', {
    name: 'Dana',
    serviceLabel: 'Mold Removal',
  });
  check(filled === 'Hi Dana, about Mold Removal.', `a real label is used, got "${filled}"`);

  // The browser used to run its own copy of these regexes, which is how the
  // guard could exist in the module and still never reach a customer.
  const detail = readFileSync(resolve(root, 'src/pages/admin/leads/[id].astro'), 'utf8');
  check(detail.includes('fillTemplate('), 'the detail page fills templates server-side');
  check(
    !detail.includes('.replace(/\\{\\{'),
    'and its inline script keeps no second, unguarded substitution of its own',
  );
}

// ---------------------------------------------------------------------------
console.log('\nNothing in the admin helpers reads the environment');
// ---------------------------------------------------------------------------
{
  // The ticket's own constraint: booking-admin.ts is importable under tsx with
  // no env and no DB, which is what makes every check above possible.
  const source = readFileSync(resolve(root, 'src/lib/booking-admin.ts'), 'utf8');
  check(!source.includes('import.meta.env'), 'booking-admin.ts reads no import.meta.env');
  check(!source.includes('process.env'), 'booking-admin.ts reads no process.env');
  check(!source.includes('getDb'), 'booking-admin.ts touches db.ts for types only, never its client');
  // MATCHED AS A TYPE-ONLY IMPORT, NOT AS A FIXED LINE. This pinned the exact
  // string `import type { Appointment } from './db'` and went red when BK-46
  // added `AppointmentStatus` to the same import — a change that satisfies
  // every word of the message below. The arm was not relying on the old
  // behaviour; it was over-specified, so the assertion was widened to the
  // property it claims rather than the fix being contorted to match it.
  check(
    /import type \{[^}]*\bAppointment\b[^}]*\} from '\.\/db'/.test(source),
    'and takes those types from db.ts rather than restating the schema',
  );
}

// ---------------------------------------------------------------------------
console.log('\nBK-46 — one money derivation, and it READS the snapshot');
// ---------------------------------------------------------------------------
//
// THE FIXTURE DISAGREES WITH ARITHMETIC ON PURPOSE, and a later reader must not
// "fix" it. `gst_cents` is NOT 5% of the subtotal and `total_amount_cents` is
// NOT base + travel + gst. No row `review.ts` writes can look like this — it
// computes `gstFor(subtotal)` once and adds. That is exactly why the fixture is
// built by hand: an expectation that agreed with the arithmetic could not tell
// "reads the column" from "recomputes", which is the whole property under test.
//
// Two separate disagreements, because they catch two separate breaks: a header
// that recomputes GST, and a header that adds the parts up itself.
{
  const SLOT = new Date('2026-08-24T19:30:00.000Z'); // a Monday, so no weekend rate
  const base = (over: Partial<MoneyBearingAppointment> = {}): MoneyBearingAppointment => ({
    status: 'confirmed',
    service: 'water',
    slot_start: SLOT,
    assessment_tier: 'standard',
    assessment_amount_cents: 57750,
    travel_fee_cents: 4600,
    gst_cents: 9999,
    total_amount_cents: 88888,
    ...over,
  });

  {
    const m = appointmentMoney(base());
    check(m.kind === 'settled', 'a confirmed row with a snapshot is settled');
    if (m.kind === 'settled') {
      check(m.gstCents === 9999, 'the GST is READ from the column, not recomputed at 5%');
      check(m.totalCents === 88888, 'and the total is READ, not added up from the parts');
      check(m.travelCents === 4600, 'and travel is carried — the omission that filed this ticket');
      check(
        m.totalCents > m.baseCents + gstFor(m.baseCents),
        'so the header total exceeds base + GST, which the old one never did',
      );
    }
  }

  // PENDING_REVIEW OUTRANKS A SURVIVING SNAPSHOT, and the row is reachable:
  // the status dropdown walks a row back without nulling the amount columns,
  // while `review.ts`'s own rollBack nulls them and says why.
  {
    const m = appointmentMoney(base({ status: 'pending_review' }));
    check(
      m.kind === 'estimate' && m.basis === 'suggestion',
      'a pending_review row shows the SUGGESTION even when a snapshot survived a walk-back',
    );
    if (m.kind === 'estimate') {
      check(m.totalCents !== 88888, 'and does not quote the stale settled total');
    }
  }

  // A DECLINE FROM THIS MORNING. It carries a tier from the form and no
  // amounts, and the copy for it must claim nothing about the row's age — an
  // earlier draft called this "predates the amount snapshot", which was false
  // twice over.
  for (const status of ['declined', 'cancelled'] as const) {
    const m = appointmentMoney(
      base({ status, assessment_amount_cents: null, gst_cents: null, total_amount_cents: null }),
    );
    check(
      m.kind === 'estimate' && m.basis === 'never-settled',
      `a ${status} row that was never approved is an estimate, basis never-settled`,
    );
  }

  // The legacy rows really do land in `none`: `assessment_tier` is migration
  // 007's and was never backfilled.
  check(
    appointmentMoney(base({ assessment_tier: null })).kind === 'none',
    'a row with no tier has no money answer at all — not $0.00',
  );

  // The $0 approval WAS settled, at zero.
  {
    const m = appointmentMoney(
      base({
        assessment_amount_cents: 0,
        travel_fee_cents: 0,
        gst_cents: 0,
        total_amount_cents: 0,
      }),
    );
    check(m.kind === 'settled' && m.totalCents === 0, 'a $0 approval is settled, not an estimate');
  }

  // A PARTIAL SNAPSHOT IS NOT RENDERED AS A WHOLE ONE. The `?? 0` this avoids
  // would print $0.00 for a real GST amount on the dispute screen.
  check(
    appointmentMoney(base({ gst_cents: null })).kind === 'estimate',
    'a partial snapshot falls back to an estimate rather than printing a zero it invented',
  );

  // AC3(a) — pending_review with NO snapshot, the ordinary unreviewed booking.
  // The precedence arm below constructs one WITH a snapshot, which is the
  // interesting case, and a case that only ever appears with a snapshot is a
  // case nobody has checked in its normal state.
  {
    const m = appointmentMoney(
      base({
        status: 'pending_review',
        assessment_amount_cents: null,
        gst_cents: null,
        total_amount_cents: null,
      }),
    );
    check(
      m.kind === 'estimate' && m.basis === 'suggestion',
      'an ordinary unreviewed booking is a suggestion',
    );
  }

  // AC3(c) — approved and awaiting payment, which is where the office spends
  // most of its time and which nothing else here passes to this function.
  {
    const m = appointmentMoney(base({ status: 'approved_awaiting_payment' }));
    check(
      m.kind === 'settled' && m.totalCents === 88888,
      'an approved row reads its snapshot, exactly as a confirmed one does',
    );
  }

  // The weekend note survives on settled rows — it used to render for every
  // tiered row and would otherwise have vanished with the recompute.
  {
    const sat = appointmentMoney(base({ slot_start: new Date('2026-08-22T19:30:00.000Z') }));
    check(
      sat.kind === 'settled' && sat.afterHours === true,
      'a Saturday settled row still knows it is a weekend booking',
    );
  }
}

// ---------------------------------------------------------------------------
console.log('\nBK-46 — what the row still owes, and how it was paid');
// ---------------------------------------------------------------------------
{
  const owe = (over: Record<string, unknown> = {}) =>
    stillOwesPayment({
      status: 'approved_awaiting_payment',
      payment_status: 'pending',
      total_amount_cents: 41895,
      ...over,
    } as Parameters<typeof stillOwesPayment>[0]);

  check(owe(), 'an approved unpaid row owes');
  check(!owe({ payment_status: 'paid' }), 'a paid row does not');
  check(!owe({ status: 'confirmed' }), 'nor a confirmed one');
  for (const status of ['payment_expired', 'declined', 'cancelled', 'pending_review'] as const) {
    check(!owe({ status }), `nor a ${status} row carrying a stale payment_due_at`);
  }
  // The $0 approval sits at approved_awaiting_payment until markPaid moves it,
  // and a row that owes $0.00 does not owe.
  check(!owe({ total_amount_cents: 0 }), 'and a $0 approval owes nothing');

  const receipt = (over: Record<string, unknown> = {}) =>
    paymentReceipt({
      payment_status: 'paid',
      payment_method: 'stripe',
      paid_at: new Date('2026-08-20T18:00:00.000Z'),
      interac_marked_by: null,
      interac_marked_at: null,
      ...over,
    } as Parameters<typeof paymentReceipt>[0]);

  check(receipt()?.line === 'Paid by card', 'a card payment says so');
  check(
    receipt({ payment_method: 'interac', interac_marked_by: 'dana' })?.line ===
      'Marked paid by dana — e-Transfer',
    'an e-Transfer names the person who asserted it — it is a human claim about money',
  );
  // The actor is optional on the column, so the passive is the fallback rather
  // than the string "null" on the screen the office reads during a dispute.
  check(
    receipt({ payment_method: 'interac' })?.line === 'Marked paid — e-Transfer',
    'and degrades to the passive rather than printing "by null"',
  );
  check(receipt({ payment_method: 'none' })?.line === 'Approved at no charge', 'a $0 approval says so');
  check(receipt({ payment_method: 'onsite' })?.line?.includes('on site') === true, 'a pre-prepay row says so');

  // THE STALE CYCLE THE ROADMAP PREDICTED BY NAME. Nothing clears `paid_at` or
  // `payment_method`, so a paid row walked back and re-approved carries the
  // previous cycle's stamp. Gated on `payment_status`, which the payment path
  // does maintain.
  check(
    receipt({ payment_status: 'pending' }) === null,
    'a re-approved row does NOT report the previous cycle\'s payment',
  );
  check(receipt({ payment_method: null }) === null, 'and an unpaid row reports nothing');

  // ── BK-33: THE REFUNDED ARMS ──────────────────────────────────────────────
  //
  // Two claims, and the second is the one a negative pin cannot make.
  //
  // 1. A refunded row must STOP saying the money is ours. Gating on
  //    `payment_status === 'paid'` alone already did that — by returning null.
  // 2. And it must not go SILENT, which is what null does. A screen that says
  //    nothing about money on a booking that took $628.43 reads as NEVER PAID.
  //    That is a different false statement, and a pin written against the words
  //    "Paid by card" would never have caught it.
  check(
    receipt({ payment_status: 'refunded', refunded_amount_cents: 62843, paid_amount_cents: 62843 })
      ?.line === 'Refunded in full — $628.43 sent back',
    'a fully refunded row says so, with the figure',
  );
  check(
    receipt({ payment_status: 'refunded', refunded_amount_cents: 62843, paid_amount_cents: 62843 })
      ?.refunded === true,
    'and flags itself as a refund, so the panel heading can stop saying "Payment received"',
  );
  check(
    receipt({
      payment_status: 'partially_refunded',
      refunded_amount_cents: 30000,
      paid_amount_cents: 62843,
    })?.line === 'Partially refunded — $300.00 of $628.43 sent back',
    'a partial refund names BOTH figures — what went back and what had arrived',
  );
  // AGAINST `paid_amount_cents`, NOT `total_amount_cents`. The total is the
  // QUOTE; a customer who paid a corrected amount and got all of it back must
  // not read as partially refunded because the quote said something else.
  check(
    receipt({
      payment_status: 'refunded',
      refunded_amount_cents: 41895,
      paid_amount_cents: 41895,
      total_amount_cents: 62843,
    })?.line === 'Refunded in full — $418.95 sent back',
    'and "in full" is judged against what ARRIVED, never against the quote',
  );
  // A refunded row whose figure never landed — the `refunded-not-cancelled`
  // outcome, or a reconcile that could not write. It must still not claim the
  // money is ours.
  check(
    receipt({ payment_status: 'refunded', refunded_amount_cents: null })?.line?.includes(
      'not recorded here',
    ) === true,
    'a refund with no recorded figure says the figure is missing rather than inventing one',
  );
  for (const money of ['refunded', 'partially_refunded'] as const) {
    const line = receipt({ payment_status: money, refunded_amount_cents: 62843 })?.line ?? '';
    check(
      !/Paid by card|Marked paid|Paid on site|Approved at no charge/.test(line),
      `a ${money} row makes no present-tense claim that the payment stands`,
    );
  }
  // THE MIRROR, which is the half that gets forgotten: a pin that only fires
  // one way is how "Refunded in full" ships unconditional.
  check(
    receipt()?.refunded === false && !/[Rr]efund/.test(receipt()?.line ?? ''),
    'and a paid, NON-refunded row claims no refund',
  );
}

// ---------------------------------------------------------------------------
console.log('\nBK-33 — a refunded row stops claiming the money is ours');
// ---------------------------------------------------------------------------
//
// PINNED ON THE CLAIM, NOT ON THE CONSTANT — the shape `verify-cutover.ts`'s
// `BOOKED_CLAIM_SHAPES` established and `CLAUDE.md` records as the answer to
// the copy-inventory trap. A booking refunded in full must not carry a
// present-tense sentence saying we hold the money, whichever constant, heading
// or interpolation happens to produce it.
//
// AND THE MIRROR IS PINNED TOO. A guard that only fires one way is how
// "Refunded in full" ends up rendering unconditionally on every paid booking —
// the second instance of the trap, which BK-48 hit three hours after writing
// the first one down.
{
  const page = readFileSync(resolve(root, 'src/pages/admin/appointments/[id].astro'), 'utf8');
  const stripped = page
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  // THE CLAIMS THE PAGE ITSELF WRITES that assert the money is STILL OURS.
  //
  // Narrower than it looks, and deliberately so: most of the wording comes from
  // `paymentReceipt`, which is asserted directly further up — a rendered-source
  // pin cannot see inside a function. What this file owns is the HEADING and
  // the mismatch line, both of which are page literals, and both of which were
  // unconditional before BK-33.
  const HELD_CLAIM_SHAPES: [string, RegExp][] = [
    ['the "Payment received" heading', /Payment received/],
    ['the "arrived against ... settled" line', /arrived against/],
  ];

  // EVERY ONE MUST BE CONDITIONAL, and specifically on something that knows
  // about the refund. An occurrence with no `receipt.refunded` nearby is the
  // defect itself: the screen stating it on a row whose money went back.
  for (const [what, shape] of HELD_CLAIM_SHAPES) {
    const matches = [...stripped.matchAll(new RegExp(shape.source, 'g'))];
    check(matches.length > 0, `${what} is still on the page (this pin is about WHEN, not whether)`);
    for (const match of matches) {
      const before = stripped.slice(Math.max(0, match.index - 900), match.index);
      check(
        /receipt\.refunded/.test(before),
        `${what} renders only after the page has asked whether this row was refunded`,
      );
    }
  }

  // The refunded heading exists at all, so the panel does not simply vanish —
  // silence reads as NEVER PAID, which is a different false statement.
  check(
    /receipt\.refunded \? 'Refunded' : 'Payment received'/.test(stripped),
    'and the heading itself is derived, so a refunded row is headed "Refunded" rather than nothing',
  );

  // ── THE WITHHELD-STATUS SENTENCES ARE PARTITIONED, NOT STACKED ──────────
  //
  // "Not listed until this booking is paid" is FALSE of a row that WAS paid and
  // refunded, and it points the office at a payment control for a booking whose
  // money has gone back. A fourth sentence beside the third would have both
  // firing over the same statuses — one omission, two different reasons.
  check(
    /const untilPaidWithheld = isRefundedRow \? \[\] : invitesWithheld;/.test(stripped),
    'the payment sentence is withheld on a refunded row',
  );
  check(
    /const refundedWithheld = isRefundedRow \? invitesWithheld : \[\];/.test(stripped),
    'and the refund sentence fires only there — the two are a partition, not a pair',
  );
}

// ---------------------------------------------------------------------------
console.log('\nBK-46 — the page holds no money arithmetic of its own');
// ---------------------------------------------------------------------------
//
// THE STRUCTURAL HALF, and it is what carries the ticket's relationship claim.
// Once the header and the panel read one function, "the two totals agree"
// cannot fail and is not asserted as though it could. What CAN fail is somebody
// adding a second derivation back, and that is what this catches.
//
// ANCHORED TO THE ASSESSMENT CELL, not to the file. The file legitimately calls
// `assessmentQuote` twice more — `suggestedQuote` is the approval form's
// pre-fill and `confirming` is the confirm step — so a file-wide ban would be
// permanently red or would delete the office's pre-fill. And comments are
// stripped first: this ticket ADDS prose naming these very identifiers, and a
// pin a comment can satisfy is the defect the ROADMAP already records.
{
  const page = readFileSync(resolve(root, 'src/pages/admin/appointments/[id].astro'), 'utf8');
  const stripped = page
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  const start = stripped.indexOf('uppercase tracking-wide mb-1">Assessment<');
  check(start > 0, 'the Assessment cell is findable in the page');
  const cell = stripped.slice(start, stripped.indexOf('</dd>', start));

  for (const forbidden of [
    'assessmentQuote(',
    'gstFor(',
    'assessment_amount_cents',
    'travel_fee_cents',
    'gst_cents',
    'total_amount_cents',
  ]) {
    check(
      !cell.includes(forbidden),
      `the header's Assessment cell does not reach for ${forbidden} — one derivation, not two`,
    );
  }
  check(
    stripped.includes('appointmentMoney(appointment)'),
    'and the page derives its money from appointmentMoney',
  );

  // ── AND THE BAN IS FILE-WIDE, NOT CELL-WIDE ─────────────────────────────
  //
  // The cell slice above catches the defect written INLINE. It does not catch
  // it hoisted: a `const headerTotal = a.assessment_amount_cents! +
  // gstFor(a.assessment_amount_cents!)` in the frontmatter, rendered as
  // `{formatCents(headerTotal ?? money.totalCents)}`, is finding 1 restored in
  // full — second derivation, travel omitted, GST recomputed — and the cell
  // names none of the banned identifiers. Implementation review wrote that
  // patch and the suite stayed green.
  //
  // Plan review had named this exact failure mode as "any inline arithmetic
  // over the four money columns", and the first implementation answered only
  // the word "inline". The four amount columns now have NO reader in this file
  // at all — `appointmentMoney` reads them — so their absence is assertable
  // outright, which is stronger than any spelling-based ban.
  for (const column of ['assessment_amount_cents', 'travel_fee_cents', 'gst_cents']) {
    check(
      !stripped.includes(column),
      `${column} is read by appointmentMoney and by nothing on the page`,
    );
  }
  // `total_amount_cents` is exempt and the exemption is narrow: the
  // payment-mismatch line compares what ARRIVED against what was settled, which
  // is a comparison rather than a derivation. It may appear only beside
  // `paid_amount_cents`.
  for (const [i, line] of stripped.split('\n').entries()) {
    if (!line.includes('total_amount_cents')) continue;
    const window = stripped.split('\n').slice(Math.max(0, i - 4), i + 5).join('\n');
    check(
      window.includes('paid_amount_cents'),
      `total_amount_cents on page line ${i + 1} is part of the paid-vs-settled comparison, not a derivation`,
    );
  }
  // One GST recomputation survives in this file — the confirm step, which
  // quotes a number the office is about to approve. Counted rather than banned,
  // so it cannot quietly become two.
  check(
    (stripped.match(/gstFor\(/g) ?? []).length === 1,
    'and exactly one gstFor call survives — the confirm step, never the header',
  );
  // The pre-fill and the confirm step are NOT collateral damage: they
  // legitimately recompute, and a pin that killed them would have been a worse
  // defect than the one it fixed.
  check(
    (stripped.match(/assessmentQuote\(/g) ?? []).length === 1,
    'while the approval pre-fill still recomputes — exactly one call survives, and it is not the header',
  );

  // A COLUMN WITH A WRITER AND NO READER IS THE DEFECT. `markPaid` has written
  // `paid_at` and `payment_method` since BK-32 and nothing rendered them.
  //
  // ASSERTED THROUGH THE HELPER, not by grepping the column names. The first
  // version was `stripped.includes(column) || stripped.includes(...)`, whose
  // right-hand disjunct carried both iterations on its own — the page reads
  // those columns INSIDE `paymentReceipt`, so neither name appears here and the
  // check asserted less than its message claimed.
  check(
    stripped.includes('paymentReceipt(appointment)') && stripped.includes('receipt &&'),
    'paid_at and payment_method reach the screen through paymentReceipt, and it is rendered',
  );
  check(
    stripped.includes('stillOwesPayment('),
    'and the due line asks whether the row owes',
  );
  // THE PROPERTY IS "GUARDED BY `owes`", NOT "NEVER MENTIONED".
  //
  // The first version of this banned `payment_due_at` in any conditional
  // position — and went red on correct code, because the column IS read once
  // the row is known to owe: `formatSlot` takes a non-null Date, so the ternary
  // choosing between the deadline and the pay-now sentence has to test it. The
  // defect was never the test; it was the test standing ALONE, deciding whether
  // to render at all from a column nothing clears.
  //
  // So every read is required to sit inside the `owes` block. Ordering by line
  // rather than by parsing, which is enough here and honest about being a
  // source pin.
  // TWO GUARDS ARE LEGITIMATE, and the second one is why this is a window
  // search rather than a single string. The settled panel's line is gated on
  // `owes`; the Payment panel — the Interac mark-paid form — is gated on
  // `isAwaitingPayment`, which is the same question asked by status alone for a
  // panel that only exists on that status. Either establishes that the row is
  // still owing BEFORE the column is read, which is the whole property.
  const lines = stripped.split('\n');
  for (const [i, line] of lines.entries()) {
    if (!line.includes('appointment.payment_due_at')) continue;
    const before = lines.slice(Math.max(0, i - 12), i).join('\n');
    check(
      /\b(owes|isAwaitingPayment) &&/.test(before),
      `payment_due_at on page line ${i + 1} is read inside a still-owing guard, never as the guard itself`,
    );
  }

  // THE PAID-VS-SETTLED LINE. New behaviour on a money screen, and the first
  // implementation shipped it with no assertion at all: it must be guarded on
  // the payment having happened, or it fires on every unpaid row where
  // `paid_amount_cents` is null.
  const mismatch = stripped.slice(
    stripped.indexOf('paid_amount_cents'),
    stripped.indexOf('arrived against'),
  );
  check(
    mismatch.includes('!== null') && mismatch.includes('!== appointment.total_amount_cents'),
    'the paid-vs-settled line fires only on a real payment that differs from the settled total',
  );
}

// ---------------------------------------------------------------------------
console.log('\nThe Upcoming table shows the state that now matters (BK-50)');
// ---------------------------------------------------------------------------
//
// WHY EVERY ASSERTION HERE IS SLICED, and it is the whole reason this block is
// written the way it is.
//
// `index.astro` renders TWO tables from the same helpers. The Past one has had
// a Status column since BK-23, so the file ALREADY CONTAINS every needle the
// obvious spelling of these checks would use: `>Status<`, `statusClasses(`,
// `STATUS_LABELS`, and `'pending_review'`. A whole-file `includes` for any of
// them passes with this ticket UNIMPLEMENTED — and the red-first rows meant to
// prove these assertions work would have been false reds.
//
// Plan review found three of the four in that state. So the source is split at
// the two section headings first, and every check below runs on ONE side of
// that split.
{
  // Comments stripped, the same idiom this file already uses for the slashed-path
  // scan above and for the same reason: prose ABOUT a helper is documentation,
  // not a call. The `pastStatusLabel` check below is a negative, and the JSX
  // comment that explains why the Upcoming cell must not use it names it — so
  // an unstripped scan reds on its own explanation. (Observed: it did, on the
  // first run of this block.)
  const source = readFileSync(resolve(root, 'src/pages/admin/appointments/index.astro'), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  const upcomingAt = source.indexOf('Upcoming <span');
  const pastAt = source.indexOf('Past <span');

  // THE SLICE MUST PROVE IT WAS FOUND. `''.includes(x)` is false and
  // `!''.includes(x)` is true, so a failed extraction turns every positive
  // check red and every NEGATIVE check vacuously green — the direction that
  // hides a defect. BK-49's rule: a measurement that cannot show it ran is not
  // a measurement.
  check(
    upcomingAt !== -1 && pastAt !== -1 && upcomingAt < pastAt,
    'the Upcoming and Past sections are both locatable, in that order — the slice below is real',
  );
  const upcoming = upcomingAt !== -1 && pastAt !== -1 ? source.slice(upcomingAt, pastAt) : '';
  check(upcoming.length > 0, 'and the Upcoming slice is non-empty');

  check(
    /<th[^>]*>\s*Status\s*<\/th>/.test(upcoming),
    'the Upcoming table has a Status column — under review-then-confirm a pending_review row is otherwise identical to a confirmed one on the screen the office triages from',
  );
  check(
    upcoming.includes('statusClasses(appointment.status)'),
    'and the status is rendered as the badge, not bare text — statusClasses carries the amber "waiting on you" meaning the office reads at a glance',
  );
  // ON THE SAME ELEMENT. Two independent whole-slice `includes` are satisfied
  // by a badge rendering the raw `{appointment.status}` and STATUS_LABELS
  // sitting in a `title=` on a different cell — the office then reads
  // `approved_awaiting_payment` on screen. Same class as the ordinal defect,
  // closed for the <td> and left open for the <span> until now.
  const badge = upcoming.match(/<span[^>]*statusClasses\(appointment\.status\)[^>]*>[\s\S]*?<\/span>/);
  check(
    badge !== null && badge[0].includes('STATUS_LABELS[appointment.status]'),
    'and the badge element itself carries the STATUS_LABELS text — a label elsewhere on the row leaves the raw status rendering in the badge',
  );
  // The plausible wrong fix: copy the Past table's cell wholesale. That renders
  // "Never reviewed" on a request that is merely waiting, and "Elapsed" on a
  // confirmed visit that has not happened yet.
  check(
    !upcoming.includes('pastStatusLabel'),
    'and NEVER pastStatusLabel — it renames live statuses for rows whose slot has gone, and both renamings are false on an upcoming row',
  );

  // Header/cell agreement. The column was inserted in two places and nothing
  // else pins that they agree; a header added without its cell shifts every
  // column right of it by one.
  const thead = upcoming.match(/<thead>([\s\S]*?)<\/thead>/)?.[1] ?? '';
  const tbody = upcoming.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/)?.[1] ?? '';
  check(thead.length > 0 && tbody.length > 0, 'the Upcoming thead and tbody are both locatable');
  const headers = thead.match(/<th\b[\s\S]*?<\/th>/g) ?? [];
  const cells = tbody.match(/<td\b[\s\S]*?<\/td>/g) ?? [];
  check(
    headers.length === cells.length,
    `the Upcoming header and row have the same number of columns (${headers.length} th, ${cells.length} td)`,
  );

  // AND THE STATUS COLUMN IS IN THE SAME ORDINAL POSITION IN BOTH.
  //
  // A count alone does not defend this, and implementation review proved it by
  // building the wrong version: header between Service and City, cell rendered
  // LAST after Files. Counts still agreed 9/9, the suite still exited 0 — and
  // every column from Status rightwards was mislabelled on the screen the
  // office triages from (Status over City data, City over Route, Route over
  // Files). C1 states the ordinal as a requirement; nothing was checking it.
  //
  // The rendered artifact did not close it either: it recorded the header array
  // and the badge's text and classes, never which column the badge landed in.
  const headerIndex = headers.findIndex((h) => /<th[^>]*>\s*Status\s*<\/th>/.test(h));
  const cellIndex = cells.findIndex((c) => c.includes('statusClasses(appointment.status)'));
  check(
    headerIndex !== -1 && cellIndex !== -1 && headerIndex === cellIndex,
    `the Status header and the status cell are the same column (th #${headerIndex}, td #${cellIndex}) — a matching COUNT with a mismatched position mislabels every column to its right`,
  );

  // ── THE COUNTER, AND WHY "IT IS COMPUTED" IS NOT ENOUGH ──────────────────
  //
  // `tsconfig.json` extends astro/tsconfigs/strict, which sets `strict: true`
  // and NOT `noUnusedLocals` — that is `strictest`. So a counter computed in
  // the frontmatter and never rendered typechecks, builds, and satisfies any
  // check that only looks for the derivation. The client's condition was a
  // number the office can SEE. Both halves are pinned.
  const frontmatterEnd = source.indexOf('---', 3);
  check(frontmatterEnd > 0, 'the frontmatter is locatable');
  const frontmatter = source.slice(0, frontmatterEnd);
  const template = source.slice(frontmatterEnd);

  check(
    /const\s+unreviewedCount\s*=\s*upcoming\s*\.filter\(/.test(frontmatter),
    'an unreviewed counter is derived from the UPCOMING rows',
  );
  // THE OPERATOR, NOT THE PROXIMITY. The first spelling asked only that
  // `'pending_review'` appear within 120 characters of `unreviewedCount` —
  // which is equally true of `.filter((a) => a.status !== 'pending_review')`.
  // Adversarial review flipped it and the suite stayed green, leaving a counter
  // that reports every upcoming row NOT awaiting review.
  check(
    /unreviewedCount\s*=\s*upcoming\s*\.filter\(\s*\(\s*\w+\s*\)\s*=>\s*\w+\.status\s*===\s*'pending_review'\s*\)/.test(
      frontmatter,
    ),
    "and it keys on `=== 'pending_review'` — a proximity check cannot tell === from !==",
  );
  check(
    template.includes('unreviewedCount'),
    'and it is RENDERED — noUnusedLocals is off, so a counter computed and never shown passes typecheck, build, and the derivation check above',
  );

  // ── THE SENTENCE ITSELF, AND WHY IT IS PINNED RATHER THAN TRUSTED ────────
  //
  // BK-50's plan review made this wording a blocker: the counter's sentence is
  // the one new string that can be TRUE TODAY AND FALSE LATER. Cron sweep 2 is
  // still live, so "auto-declined at slot-4h" would be accurate right now — and
  // would silently become a lie the day T1/T2 deletes the sweep, on an office
  // screen, with nobody owning it.
  //
  // Implementation review then found the obvious hole: the wording had been
  // specified in the ticket and pinned by NOTHING. A4b is satisfied by any
  // mention of the identifier, so a later edit to
  // "{n} upcoming requests — auto-declined at slot-4h" reddened no assertion,
  // typechecked, and built. That is CLAUDE.md's negative-assertion trap exactly:
  // a claim added to a surface and not added to any banned list.
  //
  // SCOPED TO THE COUNTER'S OWN ELEMENT, not to "the text above the table".
  //
  // The first version of this check sliced `source.slice(0, upcomingAt)` and
  // asserted /text-amber-\d/ over it. That region CONTAINS THE FRONTMATTER, and
  // `statusClasses` returns 'bg-amber-900/40 text-amber-300 …' two lines into
  // it — so recolouring the counter to red left the check green. Caught by
  // red-first, which is the entire reason a colour assertion gets a red row of
  // its own: the pin was named for the counter and matched the whole file.
  const counterAt = template.indexOf('{unreviewedCount > 0');
  const counterEnd = template.indexOf(')}', counterAt);
  check(
    counterAt !== -1 && counterEnd > counterAt,
    'the unreviewed counter renders as its own guarded element — the slice below is real',
  );
  const counter = counterAt !== -1 && counterEnd > counterAt ? template.slice(counterAt, counterEnd) : '';
  check(counter.length > 0, 'and the counter slice is non-empty');
  // THE NUMBER ON SCREEN, not the identifier somewhere in the block.
  //
  // `template.includes('unreviewedCount')` above is satisfied by the GUARD
  // alone. Adversarial review used that twice: once rendering `{warningCount}`
  // in the body while the guard still read `unreviewedCount` — so the office
  // reads the count of never-sent notifications under the words "not yet
  // reviewed" — and once rendering the word "Some" and no number at all. Both
  // passed. This block is a structural copy of the `warningCount` block two
  // lines above it, which is exactly why that substitution is the likely defect
  // rather than a contrived one.
  check(
    /\{\s*unreviewedCount\s*\}/.test(counter),
    'the counter RENDERS unreviewedCount as its number — the guard expression alone satisfies a bare identifier check, and the sibling warningCount block is one substitution away',
  );
  check(
    !/\{\s*warningCount\b/.test(counter),
    'and it does not render warningCount — the two counters sit two lines apart and count different things',
  );
  check(
    /class="[^"]*text-amber-\d/.test(counter),
    'and it is amber, not red — statusClasses reserves amber for "waiting on you" and red for a fault',
  );
  // ── A WHITELIST, NOT A BANNED LIST. THIS IS THE THIRD ATTEMPT. ──────────
  //
  // The first version banned named shapes — `auto-declin`, `releases the
  // slot`, `slot-4h`. Adversarial review probed seven natural phrasings of the
  // same claim and SIX walked through, including the one BK-50's own §C2
  // prints as forbidden: "the slot is released automatically". The banned
  // regex wanted the active voice; the ticket's example is passive, and the
  // two sat one line apart.
  //
  // That is CLAUDE.md's negative-assertion trap for the third time in this one
  // ticket, and the third time inside a pin written to prevent it. A banned
  // list enumerates the sentences somebody already thought of. The claim here
  // is not "these phrasings are wrong" — it is "this sentence says a count and
  // a state and NOTHING ELSE", and that is a whitelist.
  //
  // So: strip the tags and the {expressions}, collapse the whitespace, and
  // require the remaining literal text to be exactly the approved copy. Any
  // added clause — in any voice, tense or vocabulary — reddens, and the
  // failure message shows what was added.
  // The slice opens mid-expression (`{unreviewedCount > 0 && (`), so the guard
  // is dropped before normalising — it is the condition, not the sentence.
  const guardEnd = counter.indexOf('&& (');
  const counterBody = guardEnd === -1 ? counter : counter.slice(guardEnd + 4);
  const counterText = counterBody
    .replace(/<[^>]*>/g, ' ')
    .replace(/\{[^{}]*\}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const APPROVED_COUNTER_TEXT = 'upcoming not yet reviewed';
  check(
    counterText === APPROVED_COUNTER_TEXT,
    `the counter says a count and a state and nothing else — got "${counterText}", expected "${APPROVED_COUNTER_TEXT}". Any clause about what happens next is true only while cron sweep 2 lives and becomes an unowned falsehood the day T1/T2 deletes it`,
  );
}

// A compile-time tie: if `Appointment` ever loses one of the fields the helpers
// destructure, this file stops typechecking rather than silently drifting.
const _shape: Pick<Appointment, 'slot_start' | 'status' | 'source' | 'email'> | null = null;
void _shape;

// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n✗ ${failures} check${failures === 1 ? '' : 's'} failed\n`);
  process.exit(1);
}
console.log('\n✓ booking admin checks passed\n');
