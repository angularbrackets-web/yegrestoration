// Checks the assessment pricing table: the mould override, the weekend
// multiplier, GST, and that the copy and the charge still agree.
//
//   npx tsx scripts/verify-booking-pricing.ts
//
// Pure — no network, no database. `booking-pricing.ts` is env-free by design.
//
// Exits non-zero if any assertion fails.
import { SERVICE_LABELS } from '../src/lib/db';
import { FEE_TERMS_ITEMS } from '../src/lib/booking-copy';
import { SLOT_START_TIMES, TIMEZONE } from '../src/lib/booking-config';
import { zonedTimeToUtc } from '../src/lib/booking-time';
import {
  ASSESSMENT_TIERS,
  GST_RATE_PERCENT,
  assessmentQuote,
  formatCents,
  isAfterHoursSlot,
  isAssessmentTier,
  tierBaseCents,
  tierDefaultCents,
  type AssessmentTier,
} from '../src/lib/booking-pricing';

let failures = 0;
function check(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    failures++;
  }
}

/** A slot at the first bookable time on a given Edmonton calendar date. */
function slotOn(dateKey: string): Date {
  return zonedTimeToUtc(dateKey, SLOT_START_TIMES[0], TIMEZONE);
}

// ---------------------------------------------------------------------------
console.log('\nThe tier set');
// ---------------------------------------------------------------------------
{
  check(ASSESSMENT_TIERS.length === 3, 'three tiers');
  check(isAssessmentTier('standard') && isAssessmentTier('sketch'), 'the guard accepts real tiers');
  check(!isAssessmentTier('premium'), 'and rejects an invented one');
  check(!isAssessmentTier(''), 'and rejects the empty string');
  check(!isAssessmentTier(undefined), 'and rejects a missing value');
}

// ---------------------------------------------------------------------------
console.log('\nDefault prices agree with the customer-facing copy');
// ---------------------------------------------------------------------------
//
// THE DRIFT THIS CATCHES. `FEE_TERMS_ITEMS` is client-edited prose; the table
// is what Stripe charges. They are two hand-maintained lists of the same three
// numbers, and nothing but this makes them agree. A client editing "$399" to
// "$425" in the terms without touching the table would otherwise ship a page
// that quotes one price and a checkout that takes another.
{
  const expected: Record<AssessmentTier, string> = {
    standard: '$399',
    report: '$699',
    sketch: '$1,199',
  };

  ASSESSMENT_TIERS.forEach((tier, i) => {
    const copy = FEE_TERMS_ITEMS[i];
    check(
      copy.includes(expected[tier]),
      `FEE_TERMS_ITEMS[${i}] still states ${expected[tier]} for the ${tier} tier`,
    );
    check(
      formatCents(tierDefaultCents(tier)).startsWith(expected[tier]),
      `the ${tier} default (${formatCents(tierDefaultCents(tier))}) matches the copy's ${expected[tier]}`,
    );
    check(copy.includes('+ GST'), `FEE_TERMS_ITEMS[${i}] still says "+ GST" — the figures are ex-tax`);
  });
}

// ---------------------------------------------------------------------------
console.log('\nThe mould override');
// ---------------------------------------------------------------------------
{
  const mouldExpected: Record<AssessmentTier, number> = {
    standard: 38500,
    report: 64500,
    sketch: 118500,
  };

  for (const tier of ASSESSMENT_TIERS) {
    check(
      tierBaseCents(tier, 'mold') === mouldExpected[tier],
      `mold/${tier} is ${formatCents(mouldExpected[tier])}`,
    );
    check(
      tierBaseCents(tier, 'mold') < tierDefaultCents(tier),
      `and it undercuts the standard ${tier} price, which is the point of it`,
    );
  }

  // Every other service falls through. Iterating SERVICE_LABELS rather than a
  // hand-listed set means a service added to db.ts is covered here the day it
  // lands, instead of quietly acquiring whatever price the last edit left.
  for (const service of Object.keys(SERVICE_LABELS)) {
    if (service === 'mold') continue;
    for (const tier of ASSESSMENT_TIERS) {
      check(
        tierBaseCents(tier, service) === tierDefaultCents(tier),
        `${service}/${tier} falls through to the default`,
      );
    }
  }

  check(
    tierBaseCents('standard', 'not-a-service') === tierDefaultCents('standard'),
    'an unknown service key falls through rather than throwing',
  );
}

// ---------------------------------------------------------------------------
console.log('\nThe weekend multiplier, in Edmonton time');
// ---------------------------------------------------------------------------
//
// 2026-08-15 is a Saturday and 2026-08-16 a Sunday; 2026-08-17 is a Monday.
// The DST dates are the ones that matter: reading the weekday off the server's
// zone instead of Edmonton's moves the boundary twice a year, and the failure
// is a customer surcharged 50% on a Friday.
{
  check(isAfterHoursSlot(slotOn('2026-08-15')), 'Saturday is after-hours');
  check(isAfterHoursSlot(slotOn('2026-08-16')), 'Sunday is after-hours');
  check(!isAfterHoursSlot(slotOn('2026-08-17')), 'Monday is not');
  check(!isAfterHoursSlot(slotOn('2026-08-13')), 'Thursday is not');

  // Spring forward 2026-03-08, fall back 2026-11-01 — both Sundays, both
  // after-hours, and both days on which the UTC offset changes mid-day.
  check(isAfterHoursSlot(slotOn('2026-03-08')), 'the spring-forward Sunday is after-hours');
  check(isAfterHoursSlot(slotOn('2026-11-01')), 'the fall-back Sunday is after-hours');
  check(isAfterHoursSlot(slotOn('2026-03-07')), 'the Saturday before spring-forward is too');
  check(!isAfterHoursSlot(slotOn('2026-03-09')), 'and the Monday after is not');

  // THE ZONE ARGUMENT MUST ACTUALLY BE CONSULTED.
  //
  // Worth being precise about what this defends, because the obvious version of
  // this test does not fail: today's grid runs 11:30-15:30 Edmonton, which is
  // 17:30-22:30 UTC, so a real slot's Edmonton date and UTC date are ALWAYS the
  // same day and `slotStart.getDay()` would agree with the correct answer on
  // every bookable instant. The protection is against the grid moving — an
  // evening slot, or a 24h emergency grid, immediately crosses UTC midnight and
  // starts surcharging Mondays.
  //
  // 2026-11-02T04:00Z is Sunday 21:00 in Edmonton (MST, UTC-7) and Monday in
  // UTC. Asserting the two zones DISAGREE is what makes this machine-
  // independent: a `getDay()` implementation ignores the argument, so both
  // calls return the same value and this goes red wherever it runs — on a UTC
  // server and on a laptop set to Edmonton alike.
  const crossesUtcMidnight = new Date('2026-11-02T04:00:00.000Z');
  check(
    isAfterHoursSlot(crossesUtcMidnight, TIMEZONE),
    'an instant that is Sunday evening in Edmonton is after-hours',
  );
  check(
    isAfterHoursSlot(crossesUtcMidnight, TIMEZONE) !==
      isAfterHoursSlot(crossesUtcMidnight, 'UTC'),
    'and the same instant answers differently in UTC — the zone argument is consulted, not ignored',
  );
}

// ---------------------------------------------------------------------------
console.log('\nQuotes: multiplier, GST, and the total that has to add up');
// ---------------------------------------------------------------------------
{
  const weekday = slotOn('2026-08-17'); // Monday
  const weekend = slotOn('2026-08-15'); // Saturday

  const plain = assessmentQuote({ tier: 'standard', service: 'water', slotStart: weekday });
  check(plain.baseCents === 39900, 'a weekday standard water assessment is $399.00');
  check(!plain.afterHours, 'and is not flagged after-hours');
  check(plain.travelCents === 0, 'with no travel fee — never applied automatically');
  check(plain.gstCents === 1995, 'GST is $19.95');
  check(plain.totalCents === 41895, 'total is $418.95');

  const surcharged = assessmentQuote({ tier: 'standard', service: 'water', slotStart: weekend });
  check(surcharged.afterHours, 'a Saturday slot is flagged after-hours');
  check(surcharged.baseCents === 59850, 'and costs 1.5x — $598.50');

  const mouldWeekend = assessmentQuote({ tier: 'sketch', service: 'mold', slotStart: weekend });
  check(
    mouldWeekend.baseCents === Math.round((118500 * 3) / 2),
    'the multiplier applies on top of the mould override, not instead of it',
  );

  const withTravel = assessmentQuote({
    tier: 'report',
    service: 'fire',
    slotStart: weekday,
    travelFeeCents: 4600,
  });
  check(withTravel.travelCents === 4600, 'an admin-entered travel fee is carried through');
  check(withTravel.subtotalCents === 69900 + 4600, 'and is taxed with the base, not after it');
  check(
    withTravel.gstCents === Math.round(((69900 + 4600) * GST_RATE_PERCENT) / 100),
    'GST covers base + travel',
  );

  check(
    assessmentQuote({ tier: 'report', service: 'fire', slotStart: weekday, travelFeeCents: -500 })
      .travelCents === 0,
    'a negative travel fee is floored at zero rather than discounting the assessment',
  );

  // THE INVARIANT BK-32 LEANS ON. The customer reads an itemization; Stripe
  // charges a total. If those disagree by a cent, the receipt contradicts the
  // approval email, and the first person to notice is the customer.
  for (const tier of ASSESSMENT_TIERS) {
    for (const service of Object.keys(SERVICE_LABELS)) {
      for (const slot of [weekday, weekend]) {
        for (const travel of [0, 1, 4600, 123457]) {
          const q = assessmentQuote({ tier, service, slotStart: slot, travelFeeCents: travel });
          check(
            q.totalCents === q.subtotalCents + q.gstCents &&
              q.subtotalCents === q.baseCents + q.travelCents &&
              Number.isInteger(q.totalCents),
            `itemization adds up for ${service}/${tier}/travel=${travel}`,
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\nformatCents');
// ---------------------------------------------------------------------------
{
  check(formatCents(39900) === '$399.00', '$399.00');
  check(formatCents(119900) === '$1,199.00', 'thousands are grouped');
  check(formatCents(0) === '$0.00', 'zero');
  check(formatCents(5) === '$0.05', 'a bare five cents keeps both digits');
  check(formatCents(59850) === '$598.50', 'the surcharged standard tier');
}

// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n✗ ${failures} check${failures === 1 ? '' : 's'} failed\n`);
  process.exit(1);
}
console.log('\n✓ booking pricing checks passed\n');
