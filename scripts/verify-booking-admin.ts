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

import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { isPublicAdminPath, ADMIN_LOGIN_PATH } from '../src/lib/auth';
import {
  formatAdminTimestamp,
  formatFileSize,
  hasNotificationWarning,
  notificationFlags,
  partitionAppointments,
  type NotifiableAppointment,
  type PartitionableAppointment,
} from '../src/lib/booking-admin';
import type { Appointment, AppointmentStatus } from '../src/lib/db';

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
  const STATUSES: AppointmentStatus[] = ['booked', 'completed', 'cancelled', 'no_show'];
  const OFFSETS: [string, number][] = [
    ['past', -3 * DAY],
    ['boundary', 0],
    ['future', 3 * DAY],
  ];

  // Exhaustive: every status against every side of the cutoff. Only one of the
  // twelve cells is upcoming-eligible per offset, and only for `booked`.
  let id = 0;
  const rows: Row[] = [];
  const expected = new Map<number, 'upcoming' | 'past'>();
  for (const status of STATUSES) {
    for (const [, offset] of OFFSETS) {
      id++;
      rows.push(row(id, status, offset));
      expected.set(id, status === 'booked' && offset >= 0 ? 'upcoming' : 'past');
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
    row(1, 'booked', 5 * HOUR),
    row(2, 'booked', 1 * HOUR),
    row(3, 'booked', 3 * HOUR),
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
  const original: Row[] = [row(1, 'booked', 5 * HOUR), row(2, 'booked', 1 * HOUR)];
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
console.log('\nThe two new pages (AC2, AC6)');
// ---------------------------------------------------------------------------
{
  const PAGES = [
    'src/pages/admin/appointments/index.astro',
    'src/pages/admin/appointments/[id].astro',
    // Renders on every admin page, and this ticket rewrote it.
    'src/layouts/AdminLayout.astro',
  ];

  for (const page of PAGES) {
    const path = resolve(root, page);
    // Without this the scans below pass vacuously on a file that does not exist.
    check(existsSync(path), `${page} exists`);
    if (!existsSync(path)) continue;
    const source = readFileSync(path, 'utf8');

    // A bare toLocale* renders the SERVER's zone — UTC on Vercel, six or seven
    // hours off. Slots go through formatSlot and everything else through
    // formatAdminTimestamp, so neither page should call one at all; if one
    // ever does, it must name its timeZone.
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
