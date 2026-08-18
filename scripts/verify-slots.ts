// Property-checks the slot grid across a full year, including both DST
// transitions. No database or network access.
//
//   npx tsx scripts/verify-slots.ts          checks 2026
//   npx tsx scripts/verify-slots.ts 2027      checks another year
//
// Exits non-zero on the first failed assertion.
import {
  MAX_ADVANCE_DAYS,
  MIN_NOTICE_DAYS,
  SLOT_START_TIMES,
  TIMEZONE,
} from '../src/lib/booking-config';
import {
  addDays,
  formatSlot,
  isClosedWeekday,
  isSlotOnGrid,
  isWithinBookingWindow,
  localDateKey,
  slotStartsForDate,
  toZonedParts,
  weekdayOfDateKey,
  zoneOffsetMs,
} from '../src/lib/booking-time';

const year = Number(process.argv[2]) || 2026;
const HOUR_MS = 60 * 60 * 1000;

let failures = 0;

function check(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    failures++;
  }
}

function offsetLabel(instant: Date): string {
  const hours = zoneOffsetMs(instant) / HOUR_MS;
  const sign = hours <= 0 ? '-' : '+';
  return `UTC${sign}${String(Math.abs(hours)).padStart(2, '0')}:00`;
}

console.log(`Verifying booking slot grid for ${year} in ${TIMEZONE}\n`);

// ---------------------------------------------------------------------------
// 1. Every day of the year: five slots, exactly one hour apart, each landing on
//    the wall-clock time it claims and on the calendar date it belongs to.
// ---------------------------------------------------------------------------
let day = `${year}-01-01`;
let daysChecked = 0;
const transitions: { date: string; from: string; to: string }[] = [];
let previousOffset: number | null = null;

while (day.startsWith(String(year))) {
  const slots = slotStartsForDate(day);

  check(slots.length === SLOT_START_TIMES.length, `${day}: expected ${SLOT_START_TIMES.length} slots, got ${slots.length}`);

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const expected = SLOT_START_TIMES[i];
    const parts = toZonedParts(slot);
    const actual = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;

    check(actual === expected, `${day}: slot ${i} is ${actual} local, expected ${expected}`);
    check(localDateKey(slot) === day, `${day}: slot ${i} falls on ${localDateKey(slot)}`);
    check(isSlotOnGrid(slot), `${day}: slot ${i} (${expected}) not recognised as on-grid`);

    if (i > 0) {
      const gap = slot.getTime() - slots[i - 1].getTime();
      check(gap === HOUR_MS, `${day}: gap before slot ${i} is ${gap / 60000} min, expected 60`);
    }
  }

  const offset = zoneOffsetMs(slots[0]);
  if (previousOffset !== null && offset !== previousOffset) {
    transitions.push({
      date: day,
      from: offsetLabel(slotStartsForDate(addDays(day, -1))[0]),
      to: offsetLabel(slots[0]),
    });
  }
  previousOffset = offset;

  daysChecked++;
  day = addDays(day, 1);
}

console.log(`Checked ${daysChecked} days — 5 slots each, all on the hour, all correctly dated.`);

// ---------------------------------------------------------------------------
// 2. DST transitions. Edmonton is MST (UTC-7) in winter, MDT (UTC-6) in summer.
//    The grid must survive both without shifting local start times.
// ---------------------------------------------------------------------------
console.log(`\nDST transitions detected in ${year}:`);
check(transitions.length === 2, `expected 2 DST transitions, found ${transitions.length}`);

for (const t of transitions) {
  console.log(`  ${t.date}: ${t.from} → ${t.to}`);
  const before = slotStartsForDate(addDays(t.date, -1));
  const after = slotStartsForDate(t.date);
  check(offsetLabel(before[0]) !== offsetLabel(after[0]), `${t.date}: offset did not actually change`);

  // The whole point: the office's day still starts at 11:30 local on both sides.
  for (const [label, slots] of [['day before', before], ['transition day', after]] as const) {
    const parts = toZonedParts(slots[0]);
    check(
      `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}` === SLOT_START_TIMES[0],
      `${t.date} (${label}): first slot drifted off ${SLOT_START_TIMES[0]}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 3. Closed weekdays. Fridays only, and every other day open.
// ---------------------------------------------------------------------------
const closedSample = `${year}-01-01`;
let fridays = 0;
let closed = 0;
let cursor = closedSample;
while (cursor.startsWith(String(year))) {
  const isFriday = weekdayOfDateKey(cursor) === 5;
  if (isFriday) fridays++;
  if (isClosedWeekday(cursor)) {
    closed++;
    check(isFriday, `${cursor}: closed but not a Friday`);
  } else {
    check(!isFriday, `${cursor}: Friday but not closed`);
  }
  cursor = addDays(cursor, 1);
}
console.log(`\nClosed days: ${closed} (all Fridays; ${fridays} Fridays in ${year}).`);

// ---------------------------------------------------------------------------
// 4. Booking window: minimum notice and the two-week horizon.
// ---------------------------------------------------------------------------
const now = new Date(`${year}-06-15T09:00:00-06:00`); // a Monday morning, mid-summer
const todayKey = localDateKey(now);
const todaySlots = slotStartsForDate(todayKey);

// BK-23: next-day earliest. EVERY slot today is refused, not just the ones
// inside a rolling window — that is the difference between the calendar rule
// that shipped and the 24-hour rule P9 first recorded.
for (const slot of todaySlots) {
  check(
    !isWithinBookingWindow(slot, now),
    `${formatSlot(slot)}: same-day slots must never be publicly bookable`,
  );
}

// And every slot on the first bookable date IS offered, whatever the hour now.
// A rolling-hours rule would drop the early ones on a late-afternoon visit, so
// this is the assertion that distinguishes the two rules rather than merely
// restating the one above.
const tomorrowKey = addDays(todayKey, MIN_NOTICE_DAYS);
for (const slot of slotStartsForDate(tomorrowKey)) {
  check(
    isWithinBookingWindow(slot, now),
    `${formatSlot(slot)}: every slot on the first bookable date must be offered`,
  );
}

const withinHorizon = slotStartsForDate(addDays(todayKey, MAX_ADVANCE_DAYS))[0];
const pastHorizon = slotStartsForDate(addDays(todayKey, MAX_ADVANCE_DAYS + 1))[0];
check(isWithinBookingWindow(withinHorizon, now), `day ${MAX_ADVANCE_DAYS} should be bookable`);
check(!isWithinBookingWindow(pastHorizon, now), `day ${MAX_ADVANCE_DAYS + 1} should be beyond the horizon`);

console.log(
  `\nBooking window from ${formatSlot(now)}: ` +
    `all ${todaySlots.length} of today's slots blocked by next-day-earliest, ` +
    `horizon ends ${addDays(todayKey, MAX_ADVANCE_DAYS)}.`,
);

// ---------------------------------------------------------------------------
console.log('');
if (failures > 0) {
  console.error(`✗ ${failures} check${failures === 1 ? '' : 's'} failed.`);
  process.exit(1);
}
console.log('✓ All slot grid checks passed.');
