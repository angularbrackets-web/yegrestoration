// Property-checks the confirmation handoff and its conversion reporting. No
// DOM, no database, no network — everything asserted here is a pure function.
//
//   npx tsx scripts/verify-booking-confirmation.ts
//
// Exits non-zero if any assertion fails.
import { BOOKING_CONFIRMED_PATH, BOOKING_PATH } from '../src/lib/booking-config';
import {
  conversionCalls,
  planConversionReport,
  readConfirmation,
  serializeConfirmation,
  shouldReportConversion,
  type Confirmation,
} from '../src/lib/booking-confirmation';

let failures = 0;
function check(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    failures++;
  }
}

const BOOKING: Confirmation = {
  id: 481,
  slotLabel: 'Tue, Aug 12 · 1:30 p.m.',
  address: '123 Maple St, Edmonton',
};

// ---------------------------------------------------------------------------
console.log('\nPaths');
// ---------------------------------------------------------------------------
{
  // trailingSlash: 'always'. The unslashed form 308-redirects, and a redirect
  // followed by location.replace() is a second navigation on a page that is
  // already unloading. ROADMAP Known traps.
  check(BOOKING_CONFIRMED_PATH.endsWith('/'), 'the confirmed path ends with a trailing slash');
  check(BOOKING_PATH.endsWith('/'), 'the booking path ends with a trailing slash');
  check(
    BOOKING_CONFIRMED_PATH.startsWith(BOOKING_PATH),
    'the confirmed page lives under the booking page, so both are excluded together',
  );
  console.log(`  ${BOOKING_PATH} → ${BOOKING_CONFIRMED_PATH}`);
}

// ---------------------------------------------------------------------------
console.log('\nReading the stored confirmation');
// ---------------------------------------------------------------------------
{
  const round = readConfirmation(serializeConfirmation(BOOKING));
  check(round?.id === BOOKING.id, 'a stored confirmation round-trips its id');
  check(round?.slotLabel === BOOKING.slotLabel, 'a stored confirmation round-trips its slot label');
  check(round?.address === BOOKING.address, 'a stored confirmation round-trips its address');

  // Nothing stored means no booking happened in this tab. The island redirects
  // on null, so every one of these has to be null and not a partial object —
  // a half-read confirmation would render as a booking that does not exist.
  check(readConfirmation(null) === null, 'no stored payload reads as nothing');
  check(readConfirmation('') === null, 'an empty payload reads as nothing');
  check(readConfirmation('{not json') === null, 'malformed JSON reads as nothing');
  check(readConfirmation('"a string"') === null, 'a non-object payload reads as nothing');
  check(readConfirmation('null') === null, 'a null payload reads as nothing');
  check(readConfirmation('[1,2]') === null, 'an array payload reads as nothing');
  check(
    readConfirmation(JSON.stringify({ slotLabel: 'x', address: 'y' })) === null,
    'a payload with no id reads as nothing',
  );
  check(
    readConfirmation(JSON.stringify({ id: '481', slotLabel: 'x' })) === null,
    'a payload whose id is not a number reads as nothing',
  );
  check(
    readConfirmation(JSON.stringify({ id: Number.NaN, slotLabel: 'x' })) === null,
    'a payload whose id is NaN reads as nothing',
  );
  check(
    readConfirmation(JSON.stringify({ id: 1 })) === null,
    'a payload with no slot label reads as nothing',
  );

  // The other side of that line. `mapCommitResponse` defaults a malformed 201
  // to id 0 and an empty label, and that visitor's booking still committed —
  // bouncing them to an empty form would be the worse failure.
  const thin = readConfirmation(JSON.stringify({ id: 0, slotLabel: '' }));
  check(thin !== null, 'a committed booking with no label still renders');
  check(thin?.address === '', 'a missing address reads as empty, not as a rejection');

  console.log('  shape validated; only "no booking here" reads as null');
}

// ---------------------------------------------------------------------------
console.log('\nReporting once per booking');
// ---------------------------------------------------------------------------
{
  check(shouldReportConversion(null, 481) === true, 'an unreported booking reports');
  check(
    shouldReportConversion('481', 481) === false,
    'reloading the confirmed page does not report the same booking twice',
  );
  check(
    shouldReportConversion('480', 481) === true,
    'a second, different booking in the same tab reports again',
  );
  check(shouldReportConversion('', 481) === true, 'an empty marker reports');
  check(shouldReportConversion('0', 0) === false, 'the marker works for id 0 too');
  console.log('  one report per booking id, not per page load');
}

// ---------------------------------------------------------------------------
console.log('\nConversion calls');
// ---------------------------------------------------------------------------
{
  const configured = conversionCalls({
    awId: 'AW-1234567890',
    bookingLabel: 'BkNgLaBeL',
    id: 481,
  });
  check(configured.length === 2, 'a configured tag fires both the Ads conversion and the GA4 event');
  check(configured[0]?.event === 'conversion', 'the Ads conversion fires first');
  check(
    configured[0]?.params.send_to === 'AW-1234567890/BkNgLaBeL',
    'send_to is the conversion id and the booking label',
  );
  check(
    configured[0]?.params.transaction_id === '481',
    'the Ads conversion carries transaction_id, so Google drops a duplicate the marker cannot see',
  );
  check(
    configured[1]?.event === 'booking_confirmed',
    'GA4 gets booking_confirmed, not generate_lead — bookings stay apart from contact-form leads',
  );
  check(configured[1]?.params.booking_id === 481, 'the GA4 event carries the booking id');

  // A send_to of "undefined/undefined" is a conversion Google silently drops,
  // which is worse than none: it looks like the funnel is tracked.
  const noLabel = conversionCalls({ awId: 'AW-1234567890', bookingLabel: undefined, id: 481 });
  check(noLabel.length === 1, 'no Ads conversion is emitted without a booking label');
  check(noLabel[0]?.event === 'booking_confirmed', 'GA4 still reports without an Ads label');

  const noAw = conversionCalls({ awId: undefined, bookingLabel: 'BkNgLaBeL', id: 481 });
  check(noAw.length === 1, 'no Ads conversion is emitted without a conversion id');

  const noneAtAll = conversionCalls({ awId: '', bookingLabel: '', id: 481 });
  check(noneAtAll.length === 1, 'empty strings count as unset, matching how Analytics.astro reads them');

  const noId = conversionCalls({ awId: 'AW-1234567890', bookingLabel: 'BkNgLaBeL', id: 0 });
  check(
    noId[0]?.params.transaction_id === undefined,
    'a non-positive id sends no transaction_id — it is not an appointment number and would collide',
  );
  check(noId[1]?.params.booking_id === undefined, 'and no booking_id either');

  console.log('  Ads only when configured; GA4 always; transaction_id on real bookings');
}

// ---------------------------------------------------------------------------
console.log('\nThe reporting sequence, end to end');
// ---------------------------------------------------------------------------
{
  const CONFIGURED = { awId: 'AW-1234567890', bookingLabel: 'BkNgLaBeL' };

  // A tab that has never reported: fire, then remember this exact booking.
  const first = planConversionReport({ marker: null, ...CONFIGURED, id: 481 });
  check(first !== null, 'the first load of a confirmed booking reports');
  check(first?.calls.length === 2, 'it fires both calls');
  check(
    first?.marker === '481',
    'and the marker it writes afterwards is the booking id — not a boolean, or a second booking could never report',
  );

  // The reload. This is the whole reason the marker exists: the confirmed page
  // is a URL, and a refresh must not be a second conversion.
  const reload = planConversionReport({ marker: first!.marker, ...CONFIGURED, id: 481 });
  check(reload === null, 'reloading the confirmed page fires nothing at all');

  // A genuinely different booking in the same tab, after the first one.
  const second = planConversionReport({ marker: first!.marker, ...CONFIGURED, id: 482 });
  check(second !== null, 'a second, different booking in the same tab does report');
  check(second?.marker === '482', 'and it moves the marker on');
  check(
    second?.calls[0]?.params.transaction_id === '482',
    'carrying its own transaction_id, not the previous booking’s',
  );

  // Dormant tag: no Ads label configured. GA4 must still get its event, and
  // the marker must still move — otherwise the next reload fires again.
  const ga4Only = planConversionReport({
    marker: null,
    awId: 'AW-1234567890',
    bookingLabel: undefined,
    id: 481,
  });
  check(ga4Only?.calls.length === 1, 'an unconfigured Ads label still reports to GA4');
  check(ga4Only?.marker === '481', 'and still marks the booking, so a reload stays quiet');

  console.log('  fire once, remember the id, move on for the next booking');
}

if (failures > 0) {
  console.error(`\n✗ ${failures} check${failures === 1 ? '' : 's'} failed.`);
  process.exit(1);
}
console.log('\n✓ All booking confirmation checks passed.');
