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
import { APPOINTMENT_STATUSES, LIVE_STATUSES } from '../src/lib/booking-status';
import { SUPPORT_PHONE } from '../src/lib/booking-config';
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

  // Exhaustive: every status against every side of the cutoff. Only the three
  // LIVE statuses are upcoming-eligible, and only at or after the boundary.
  let id = 0;
  const rows: Row[] = [];
  const expected = new Map<number, 'upcoming' | 'past'>();
  for (const status of STATUSES) {
    for (const [, offset] of OFFSETS) {
      id++;
      rows.push(row(id, status, offset));
      expected.set(id, LIVE_STATUSES.includes(status) && offset >= 0 ? 'upcoming' : 'past');
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
  check(
    source.includes("import type { Appointment } from './db'"),
    'and takes those types from db.ts rather than restating the schema',
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
