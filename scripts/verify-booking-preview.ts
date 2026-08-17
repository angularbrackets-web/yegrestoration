// Property-checks the homepage availability teaser (BK-39). No DOM, no
// database, no network.
//
//   npx tsx scripts/verify-booking-preview.ts
//
// Exits non-zero if any assertion failed.
import { computeAvailability } from '../src/lib/booking-availability';
import {
  firstOpenSlot,
  nextOpeningLine,
  readCachedPreview,
  PREVIEW_CACHE_MS,
} from '../src/lib/booking-preview';
import { addDays, localDateKey, slotStartsForDate } from '../src/lib/booking-time';

let failures = 0;
function check(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    failures++;
  }
}

const NOW = new Date();

/**
 * A REAL payload from the real `computeAvailability`, not a hand-built object.
 *
 * A fixture typed out here would keep passing after the endpoint's shape
 * changed underneath it — the same "assertion that cannot fail" family the
 * ROADMAP records — and shape is most of what this module reads.
 */
const real = computeAvailability({ now: NOW, blackoutDays: [], bookedSlotMs: [] });

// ---------------------------------------------------------------------------
console.log('Finding the next opening');
// ---------------------------------------------------------------------------
{
  const slot = firstOpenSlot(real);
  check(slot !== null, 'an open calendar yields a slot');

  // It must be the EARLIEST one, not merely one of them. Compared by instant
  // against every slot in the payload, so "first in the array" and "soonest"
  // cannot silently diverge.
  const every = real.dates.flatMap((d) => d.slots);
  const soonest = every.reduce((a, b) => (new Date(a.start) <= new Date(b.start) ? a : b));
  check(slot!.start === soonest.start, 'the slot offered is the soonest one in the window');

  check(
    nextOpeningLine(real) === `Next opening: ${soonest.label}`,
    'the line is the prefix plus the payload label',
  );

  // Verbatim, not reformatted. The label is built server-side in Edmonton time;
  // a browser-side re-derivation would render the visitor's zone and disagree
  // with the picker one click later.
  check(
    nextOpeningLine(real)!.endsWith(soonest.label),
    'the label is passed through untouched',
  );
  console.log('  the soonest slot, with its label verbatim');
}

// ---------------------------------------------------------------------------
console.log('\nNothing to show is a real answer');
// ---------------------------------------------------------------------------
{
  // A genuinely full fortnight, built by booking out every grid instant the
  // real computation would offer — again, not a hand-made empty array.
  const bookedOut = computeAvailability({
    now: NOW,
    blackoutDays: [],
    bookedSlotMs: real.dates.flatMap((d) => d.slots.map((s) => new Date(s.start).getTime())),
  });
  check(firstOpenSlot(bookedOut) === null, 'a fully booked window yields no slot');
  check(nextOpeningLine(bookedOut) === null, 'and no line — the caller renders nothing');

  // Every shape a broken or hostile response can take. None may throw: an
  // exception here would stop the island mounting on the homepage.
  for (const [payload, label] of [
    [null, 'null'],
    [undefined, 'undefined'],
    [{}, 'an object with no dates'],
    [{ dates: null }, 'a null dates'],
    [{ dates: 'nope' }, 'a string dates'],
    [{ error: 'Could not load availability.' }, "the endpoint's own 500 body"],
    [{ dates: [{ slots: [] }] }, 'a date with no slots'],
    [{ dates: [{ slots: [{}] }] }, 'a slot with no label'],
    [{ dates: [{ slots: [{ label: '' }] }] }, 'a slot with an empty label'],
    [{ dates: [{}] }, 'a date with no slots key at all'],
    [{ dates: [null] }, 'a null date'],
  ] as const) {
    let threw = false;
    let out: string | null = 'unset';
    try {
      out = nextOpeningLine(payload);
    } catch {
      threw = true;
    }
    check(!threw, `${label} must not throw`);
    check(out === null, `${label} yields no line`);
  }
  console.log('  a full calendar, a 500 body, and every malformed shape yield null, never a throw');
}

// ---------------------------------------------------------------------------
console.log('\nThe 60-second client cache');
// ---------------------------------------------------------------------------
{
  const now = 1_000_000;
  const fresh = JSON.stringify({ at: now - 1000, line: 'Next opening: Mon, Aug 17 · 2:30 p.m.' });

  check(readCachedPreview(fresh, now) === 'Next opening: Mon, Aug 17 · 2:30 p.m.', 'a fresh entry is used');
  check(
    readCachedPreview(JSON.stringify({ at: now - PREVIEW_CACHE_MS - 1, line: 'x' }), now) === null,
    'an entry one millisecond past the window is refused',
  );
  check(
    readCachedPreview(JSON.stringify({ at: now - PREVIEW_CACHE_MS + 1, line: 'x' }), now) === 'x',
    'an entry one millisecond inside it is used',
  );
  // A clock that has gone backwards must not read as infinitely fresh — the
  // same posture `verifyDraftToken` takes with its `ageMs < 0`.
  check(
    readCachedPreview(JSON.stringify({ at: now + 60_000, line: 'x' }), now) === null,
    'an entry stamped in the future is refused, not treated as fresh',
  );

  // sessionStorage is writable by anything else on the origin, so nothing in
  // it is trusted.
  for (const [raw, label] of [
    [null, 'an absent key'],
    ['', 'an empty string'],
    ['not json', 'unparseable text'],
    ['null', 'the literal null'],
    ['[]', 'an array'],
    [JSON.stringify({ at: now, line: 42 }), 'a non-string line'],
    [JSON.stringify({ at: 'now', line: 'x' }), 'a non-numeric stamp'],
    [JSON.stringify({ line: 'x' }), 'a missing stamp'],
  ] as const) {
    let threw = false;
    let out: string | null = 'unset';
    try {
      out = readCachedPreview(raw, now);
    } catch {
      threw = true;
    }
    check(!threw, `${label} must not throw`);
    check(out === null, `${label} is refused`);
  }
  console.log('  fresh is used, stale and tampered are refused, nothing throws');
}

if (failures > 0) {
  console.error(`\n✗ ${failures} check${failures === 1 ? '' : 's'} failed.`);
  process.exit(1);
}
console.log('\n✓ All booking preview checks passed.');
