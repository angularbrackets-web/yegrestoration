// Property-checks the availability computation against a fixed injected clock.
// No database or network access — computeAvailability is pure, which is the
// whole reason it was split out from the endpoint.
//
//   npx tsx scripts/verify-availability.ts
//
// What this CANNOT catch, by construction: driver deserialization and query
// bounds, both of which live in the endpoint. The ticket's real-DB round-trip
// covers those.
//
// Exits non-zero on the first failed assertion.
import { MAX_ADVANCE_DAYS, MIN_NOTICE_DAYS, SLOT_START_TIMES } from '../src/lib/booking-config';
import {
  bookedQueryRange,
  computeAvailability,
  type Availability,
} from '../src/lib/booking-availability';
import {
  addDays,
  localDateKey,
  slotStartsForDate,
  weekdayOfDateKey,
  zoneOffsetMs,
  zonedTimeToUtc,
} from '../src/lib/booking-time';

const HOUR_MS = 60 * 60 * 1000;

let failures = 0;

function check(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    failures++;
  }
}

function availability(now: Date, blackoutDays: string[] = [], bookedSlotMs: number[] = []) {
  return computeAvailability({ now, blackoutDays, bookedSlotMs });
}

function slotsOn(a: Availability, date: string) {
  return a.dates.find((d) => d.date === date)?.slots ?? [];
}

/** A Wednesday, 09:00 local — safely away from DST and from the notice cutoff. */
const BASE = zonedTimeToUtc('2026-08-05', '09:00');

// ---------------------------------------------------------------------------
console.log('Window shape');
// ---------------------------------------------------------------------------
{
  const a = availability(BASE);
  const today = localDateKey(BASE);

  check(
    a.dates.length === MAX_ADVANCE_DAYS + 1,
    `expected ${MAX_ADVANCE_DAYS + 1} dates (today through day ${MAX_ADVANCE_DAYS}), got ${a.dates.length}`,
  );
  check(a.dates[0].date === today, `first date should be today (${today}), got ${a.dates[0].date}`);
  check(
    a.dates[a.dates.length - 1].date === addDays(today, MAX_ADVANCE_DAYS),
    'last date should be exactly the horizon',
  );
  check(
    a.dates.every((d, i) => i === 0 || d.date > a.dates[i - 1].date),
    'dates must be strictly ascending',
  );
  check(a.timezone === 'America/Edmonton', 'timezone must be reported');
  check(a.durationMinutes === 30, 'duration must be reported');
  console.log(`  ${a.dates.length} dates, ${a.dates[0].date} → ${a.dates[a.dates.length - 1].date}`);
}

// ---------------------------------------------------------------------------
console.log('\nClosed weekdays');
// ---------------------------------------------------------------------------
{
  const a = availability(BASE);
  const fridays = a.dates.filter((d) => d.weekday === 5);

  check(fridays.length > 0, 'the window should contain at least one Friday');
  check(fridays.every((d) => d.slots.length === 0), 'every Friday must be empty');
  check(
    a.dates.every((d) => d.weekday === weekdayOfDateKey(d.date)),
    'reported weekday must match the date',
  );
  check(
    a.dates.some((d) => d.weekday === 0 && d.slots.length > 0),
    'Sunday is open and should have slots',
  );
  console.log(`  ${fridays.length} Fridays, all empty; Sundays open`);
}

// ---------------------------------------------------------------------------
console.log('\nBlackout dates');
// ---------------------------------------------------------------------------
{
  const target = addDays(localDateKey(BASE), 3);
  const before = slotsOn(availability(BASE), target);
  const after = slotsOn(availability(BASE, [target]), target);

  check(before.length > 0, `${target} should be bookable before the blackout`);
  check(after.length === 0, 'a blacked-out day must offer nothing');

  // AC6 (no leaked reason) cannot fail here — AvailabilityInput carries only
  // DateKeys, so a reason never reaches the pure function. The real risk is the
  // endpoint's SELECT list, and verify-availability-db.ts is what tests it.
  const day = availability(BASE, [target]).dates.find((d) => d.date === target);
  check(day !== undefined, 'a blacked-out day must still appear in the window');
  console.log(`  ${target}: ${before.length} slots → 0, still present`);
}

// ---------------------------------------------------------------------------
console.log('\nBooked slots and cancellation');
// ---------------------------------------------------------------------------
{
  const target = addDays(localDateKey(BASE), 3);
  const [first, second] = slotStartsForDate(target);

  const withBooking = slotsOn(availability(BASE, [], [first.getTime()]), target);
  check(
    !withBooking.some((s) => s.start === first.toISOString()),
    'a booked slot must not be offered',
  );
  check(
    withBooking.some((s) => s.start === second.toISOString()),
    'other slots that day must remain',
  );

  // AC3 (a cancelled booking frees its slot) is NOT testable here. Cancellation
  // is expressed solely by the endpoint's SLOT_HOLD_PREDICATE, so
  // a cancelled row simply never reaches this function — asserting on the
  // empty-bookings case would restate a check already made above. AC3 is
  // covered by verify-availability-db.ts against real rows.

  const allTaken = slotStartsForDate(target).map((s) => s.getTime());
  const fullDay = availability(BASE, [], allTaken).dates.find((d) => d.date === target);
  check(fullDay !== undefined, 'a fully booked day must still appear in the window');
  check(fullDay?.slots.length === 0, 'a fully booked day must have no slots');
  console.log('  booked slot hidden, siblings kept, full day still listed but empty');
}

// ---------------------------------------------------------------------------
console.log('\nMinimum notice boundary');
// ---------------------------------------------------------------------------
{
  const date = '2026-08-05';
  const [firstSlot] = slotStartsForDate(date); // 11:30 local

  // BK-23's cutoff is a CALENDAR boundary, so it is probed at the boundary that
  // exists: the last instant of the previous day and the first instant of the
  // day itself, both in Edmonton.
  //
  // 23:59:59 the night before — the slot is tomorrow, so it is offered.
  const nightBefore = new Date(zonedTimeToUtc(addDays(date, -MIN_NOTICE_DAYS), '00:00').getTime() + 86_399_000);
  const justInside = slotsOn(availability(nightBefore), date);
  check(
    justInside.some((s) => s.start === firstSlot.toISOString()),
    'at one second to midnight, the next day is still bookable',
  );

  // 00:00:00 on the day itself — now it is today, and today is never bookable,
  // even eleven and a half hours ahead of the slot. This is the assertion a
  // rolling-hours rule would fail.
  const sameDay = zonedTimeToUtc(date, '00:00');
  const justOutside = slotsOn(availability(sameDay), date);
  check(
    !justOutside.some((s) => s.start === firstSlot.toISOString()),
    'one second later it is same-day, and same-day is never offered',
  );
  console.log('  next-day-earliest cutoff exact on both sides of local midnight');
}

// ---------------------------------------------------------------------------
console.log('\nHorizon boundary');
// ---------------------------------------------------------------------------
{
  const a = availability(BASE);
  const horizon = addDays(localDateKey(BASE), MAX_ADVANCE_DAYS);
  const beyond = addDays(horizon, 1);

  check(a.dates.some((d) => d.date === horizon), 'the horizon date must be offered');
  check(!a.dates.some((d) => d.date === beyond), 'nothing past the horizon may appear');

  // The horizon's last slot is well past now + MAX_ADVANCE_DAYS × 24h — this is
  // exactly what a naive instant-based query bound would miss.
  const lastSlot = slotStartsForDate(horizon)[SLOT_START_TIMES.length - 1];
  const naiveBound = new Date(BASE.getTime() + MAX_ADVANCE_DAYS * 24 * HOUR_MS);
  check(
    lastSlot.getTime() > naiveBound.getTime(),
    'sanity: the horizon afternoon should indeed fall outside a naive 14×24h bound',
  );

  const range = bookedQueryRange(BASE);
  check(range.to.getTime() > lastSlot.getTime(), 'query range must cover the horizon afternoon');
  check(range.from.getTime() <= BASE.getTime(), 'query range must start no later than now');
  console.log(
    `  horizon ${horizon}; query range covers its last slot (naive 14×24h bound would miss it by ${Math.round(
      (lastSlot.getTime() - naiveBound.getTime()) / HOUR_MS,
    )}h)`,
  );
}

// ---------------------------------------------------------------------------
console.log('\nDST transitions');
// ---------------------------------------------------------------------------
for (const [label, transition] of [
  ['spring forward', '2026-03-08'],
  ['fall back', '2026-11-01'],
] as const) {
  // Start far enough back that the transition sits inside the 15-day window.
  const now = zonedTimeToUtc(addDays(transition, -3), '09:00');
  const a = availability(now);

  // Days after today are untouched by the notice cutoff, so a correct
  // conversion must produce the whole grid, in order. Comparing the reported
  // `time` back against the instant would be circular — both come from the same
  // toZonedParts call — so compare against the grid constant instead.
  const grid = [...SLOT_START_TIMES].join(',');
  const openDays = a.dates.filter((d) => d.date > localDateKey(now) && d.slots.length > 0);
  check(openDays.length > 0, `${label}: expected bookable days around the transition`);

  for (const day of openDays) {
    check(
      day.slots.map((s) => s.time).join(',') === grid,
      `${label}: ${day.date} wall clocks are ${day.slots.map((s) => s.time).join(',')}, not the grid`,
    );

    const ms = day.slots.map((s) => new Date(s.start).getTime());
    check(
      ms.every((t, i) => i === 0 || t - ms[i - 1] === HOUR_MS),
      `${label}: ${day.date} slot instants are not exactly 60 min apart`,
    );
    check(
      day.slots.every((s) => localDateKey(new Date(s.start)) === day.date),
      `${label}: ${day.date} has a slot that lands on another date`,
    );
  }

  // The point of the section: the window really does straddle the offset
  // change, and identical wall clocks were produced on both sides of it.
  const offsets = new Set(openDays.map((d) => zoneOffsetMs(new Date(d.slots[0].start))));
  check(
    offsets.size === 2,
    `${label}: expected the window to span both offsets, saw ${offsets.size}`,
  );
  console.log(
    `  ${label} (${transition}): ${openDays.length} open days, full grid on both offsets`,
  );
}

// ---------------------------------------------------------------------------
console.log('\nDeterminism');
// ---------------------------------------------------------------------------
{
  const args = { now: BASE, blackoutDays: ['2026-08-08'], bookedSlotMs: [] as number[] };
  check(
    JSON.stringify(computeAvailability(args)) === JSON.stringify(computeAvailability(args)),
    'the same input must produce byte-identical output',
  );
  console.log('  identical for identical input');
}

if (failures > 0) {
  console.error(`\n✗ ${failures} check${failures === 1 ? '' : 's'} failed.`);
  process.exit(1);
}
console.log('\n✓ All availability checks passed.');
