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
  isCheckoutSessionId,
  paidLandingSessionId,
  shouldReportConversion,
  type Confirmation,
} from '../src/lib/booking-confirmation';

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
  emailSent: true,
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

  // emailSent gates the "we've emailed you" line, so it must never be inferred.
  // A payload stored by the build that shipped before BK-05 has no such field
  // and must still render — as a confirmation that promises no email.
  check(thin?.emailSent === false, 'a payload with no emailSent renders without promising an email');
  check(
    readConfirmation(serializeConfirmation(BOOKING))?.emailSent === true,
    'emailSent round-trips when the server sent the confirmation',
  );
  for (const value of ['true', 1, {}, null]) {
    check(
      readConfirmation(JSON.stringify({ id: 1, slotLabel: 'x', emailSent: value }))?.emailSent === false,
      `an emailSent of ${JSON.stringify(value)} does not promise an email`,
    );
  }

  console.log('  shape validated; only "no booking here" reads as null');
}

// ---------------------------------------------------------------------------
console.log('\nWhat counts as a payment landing');
// ---------------------------------------------------------------------------
//
// BK-32 moved the conversion off the REQUEST and onto the PAYMENT, and made the
// evidence a Stripe Checkout Session id in the URL. The shape check is a bar,
// not a proof — nothing here contacts Stripe — but it is what stops a leftover
// /book/received/ payload, a bookmark, or a hand-typed URL from being treated
// as a payment at all.
{
  const PARAM = 'session_id';

  check(isCheckoutSessionId('cs_test_a1b2c3d4e5f6g7h8') === true, 'a test-mode session id is one');
  check(isCheckoutSessionId('cs_live_a1b2c3d4e5f6g7h8') === true, 'a live-mode session id is one');
  for (const bad of [
    null,
    undefined,
    '',
    'cs_test_',
    'cs_test_short',
    'pi_test_a1b2c3d4e5f6g7h8',
    'cs_prod_a1b2c3d4e5f6g7h8',
    'cs_test_a1b2c3d4e5f6g7h8!',
    '../../etc/passwd',
    '481',
  ]) {
    check(isCheckoutSessionId(bad) === false, `${JSON.stringify(bad)} is not a session id`);
  }

  check(
    paidLandingSessionId('?session_id=cs_test_a1b2c3d4e5f6g7h8', PARAM) ===
      'cs_test_a1b2c3d4e5f6g7h8',
    'the session id is read out of the query string',
  );
  check(
    paidLandingSessionId('?session_id=cs_test_a1b2c3d4e5f6g7h8&utm_source=x', PARAM) ===
      'cs_test_a1b2c3d4e5f6g7h8',
    'and survives other parameters riding along',
  );
  check(paidLandingSessionId('', PARAM) === null, 'no query string is not a payment landing');
  check(
    paidLandingSessionId('?ref=481', PARAM) === null,
    'and neither is some other parameter — the old ?ref= shape must not resurrect',
  );
  check(
    paidLandingSessionId('?session_id=481', PARAM) === null,
    'a booking id in the session slot is refused, not accepted as a marker',
  );
  check(
    paidLandingSessionId('?session_id={CHECKOUT_SESSION_ID}', PARAM) === null,
    "Stripe's own placeholder, unsubstituted, is refused rather than counted",
  );

  console.log('  only a well-formed Checkout Session id reads as a payment');
}

// ---------------------------------------------------------------------------
console.log('\nReporting once per payment');
// ---------------------------------------------------------------------------
{
  const A = 'cs_test_a1b2c3d4e5f6g7h8';
  const B = 'cs_test_z9y8x7w6v5u4t3s2';

  check(shouldReportConversion(null, A) === true, 'an unreported payment reports');
  check(
    shouldReportConversion(A, A) === false,
    'reloading the confirmed page does not report the same payment twice',
  );
  check(
    shouldReportConversion(B, A) === true,
    'a second, different payment in the same tab reports again',
  );
  check(shouldReportConversion('', A) === true, 'an empty marker reports');
  console.log('  one report per Checkout Session, not per page load');
}

// ---------------------------------------------------------------------------
console.log('\nConversion calls');
// ---------------------------------------------------------------------------
{
  const SESSION = 'cs_test_a1b2c3d4e5f6g7h8';

  const configured = conversionCalls({
    awId: 'AW-1234567890',
    bookingLabel: 'BkNgLaBeL',
    sessionId: SESSION,
    id: 481,
  });
  check(configured.length === 2, 'a configured tag fires both the Ads conversion and the GA4 event');
  check(configured[0]?.event === 'conversion', 'the Ads conversion fires first');
  check(
    configured[0]?.params.send_to === 'AW-1234567890/BkNgLaBeL',
    'send_to is the conversion id and the booking label',
  );
  check(
    configured[0]?.params.transaction_id === SESSION,
    'transaction_id is the CHECKOUT SESSION, so Google dedupes on the payment',
  );
  check(
    configured[1]?.event === 'booking_confirmed',
    'GA4 gets booking_confirmed, not generate_lead — bookings stay apart from contact-form leads',
  );
  check(configured[1]?.params.booking_id === 481, 'the GA4 event carries the booking id when there is one');

  // THE CROSS-DEVICE PAYER — the case that made the session id the key.
  //
  // Request on a desktop, approval email read on a phone, paid there. The
  // sessionStorage payload lives on the desktop, so this landing has no booking
  // id at all. Keyed on the booking id the conversion would simply not fire,
  // and that is most real payments rather than an edge case.
  const crossDevice = conversionCalls({
    awId: 'AW-1234567890',
    bookingLabel: 'BkNgLaBeL',
    sessionId: SESSION,
    id: 0,
  });
  check(
    crossDevice.length === 2,
    'a payer with no stored payload STILL reports — the cross-device case is the common one',
  );
  check(
    crossDevice[0]?.params.transaction_id === SESSION,
    'with the same transaction_id it would have had on the original device',
  );
  check(
    crossDevice[1]?.params.booking_id === undefined,
    'and no booking_id, rather than a made-up one that would collide',
  );

  // A send_to of "undefined/undefined" is a conversion Google silently drops,
  // which is worse than none: it looks like the funnel is tracked.
  const noLabel = conversionCalls({
    awId: 'AW-1234567890',
    bookingLabel: undefined,
    sessionId: SESSION,
    id: 481,
  });
  check(noLabel.length === 1, 'no Ads conversion is emitted without a booking label');
  check(noLabel[0]?.event === 'booking_confirmed', 'GA4 still reports without an Ads label');

  const noAw = conversionCalls({
    awId: undefined,
    bookingLabel: 'BkNgLaBeL',
    sessionId: SESSION,
    id: 481,
  });
  check(noAw.length === 1, 'no Ads conversion is emitted without a conversion id');

  const noneAtAll = conversionCalls({ awId: '', bookingLabel: '', sessionId: SESSION, id: 481 });
  check(noneAtAll.length === 1, 'empty strings count as unset, matching how Analytics.astro reads them');

  console.log('  Ads only when configured; GA4 always; transaction_id is the payment');
}

// ---------------------------------------------------------------------------
console.log('\nThe reporting sequence, end to end');
// ---------------------------------------------------------------------------
{
  const CONFIGURED = { awId: 'AW-1234567890', bookingLabel: 'BkNgLaBeL' };
  const A = 'cs_test_a1b2c3d4e5f6g7h8';
  const B = 'cs_test_z9y8x7w6v5u4t3s2';

  // THE REQUEST PATH FIRES NOTHING, AND THIS IS THE N5 DECISION ITSELF.
  //
  // /book/received/ has a stored payload and NO session id. Under P9 a request
  // is a lead the office may decline and nobody has paid for; counting it would
  // have Google Ads bid against leads. Before BK-32 this exact input fired a
  // conversion.
  check(
    planConversionReport({ marker: null, ...CONFIGURED, sessionId: null, id: 481 }) === null,
    'a submitted REQUEST reports nothing — the conversion is the payment',
  );
  // The leftover payload, re-read on /book/confirmed/ without a session id.
  check(
    planConversionReport({ marker: null, ...CONFIGURED, sessionId: '', id: 481 }) === null,
    'and a leftover request payload on the confirmed page reports nothing either',
  );
  check(
    planConversionReport({ marker: null, ...CONFIGURED, sessionId: 'not-a-session', id: 481 }) ===
      null,
    'a malformed session id reports nothing rather than counting as a payment',
  );

  // A tab that has never reported: fire, then remember this exact payment.
  const first = planConversionReport({ marker: null, ...CONFIGURED, sessionId: A, id: 481 });
  check(first !== null, 'the first load after a payment reports');
  check(first?.calls.length === 2, 'it fires both calls');
  check(
    first?.marker === A,
    'and the marker it writes is the Checkout Session — not a boolean, or a second payment could never report',
  );

  // The reload. This is the whole reason the marker exists: the confirmed page
  // is a URL, and a refresh must not be a second conversion.
  const reload = planConversionReport({ marker: first!.marker, ...CONFIGURED, sessionId: A, id: 481 });
  check(reload === null, 'reloading the confirmed page fires nothing at all');

  // A genuinely different payment in the same tab, after the first one.
  const second = planConversionReport({ marker: first!.marker, ...CONFIGURED, sessionId: B, id: 482 });
  check(second !== null, 'a second, different payment in the same tab does report');
  check(second?.marker === B, 'and it moves the marker on');
  check(
    second?.calls[0]?.params.transaction_id === B,
    'carrying its own transaction_id, not the previous payment’s',
  );

  // Dormant tag: no Ads label configured. GA4 must still get its event, and
  // the marker must still move — otherwise the next reload fires again.
  const ga4Only = planConversionReport({
    marker: null,
    awId: 'AW-1234567890',
    bookingLabel: undefined,
    sessionId: A,
    id: 481,
  });
  check(ga4Only?.calls.length === 1, 'an unconfigured Ads label still reports to GA4');
  check(ga4Only?.marker === A, 'and still marks the payment, so a reload stays quiet');

  console.log('  fire once per payment, remember the session, ignore every request');
}

// ---------------------------------------------------------------------------
console.log('\nWho is allowed to fire a conversion at all (BK-32 N5)');
// ---------------------------------------------------------------------------
//
// SOURCE PINS, and their weakness is stated rather than glossed: they check
// what the islands SAY, not what a browser does. There is no DOM harness in
// this repo, and the alternative — trusting the pure layer above and hoping the
// call sites match it — is how `/book/received/` came to fire a conversion for
// an unapproved request in the first place. The pure decision is asserted
// properly above; these three pin the two places that decision is invoked.
{
  const form = readFileSync(resolve(root, 'src/components/BookingForm.svelte'), 'utf8');
  const island = readFileSync(resolve(root, 'src/components/BookingConfirmation.svelte'), 'utf8');

  // The form commits a REQUEST. Under P9 that is a lead the office may decline
  // and nobody has paid for, so it must not report anything — including on its
  // sessionStorage-write-failed fallback, which is where the old call lived.
  check(
    !/reportBookingConversion/.test(form),
    'BookingForm.svelte does not report a conversion anywhere — a request is not a payment',
  );

  // The island serves both pages. Only the `confirmed` variant may report, and
  // it may only do so with a session id it read from the URL.
  const calls = island.match(/reportBookingConversion\([^)]*\)/g) ?? [];
  check(calls.length === 1, `BookingConfirmation.svelte reports in exactly one place (found ${calls.length})`);
  check(
    calls[0]?.includes('sessionId') === true,
    `and passes the session id it read from the URL, not a stored booking id (found ${calls[0]})`,
  );
  // The received branch returns before reaching it. Pinned on the ORDER rather
  // than on the presence of an `isReceived` check, because a check that runs
  // after the call would satisfy the latter and not the former.
  check(
    island.indexOf('if (isReceived)') !== -1 &&
      island.indexOf('if (isReceived)') < island.indexOf('reportBookingConversion('),
    'and the received branch returns BEFORE the call, so /book/received/ cannot reach it',
  );

  console.log('  one call site, on the confirmed variant, keyed on the URL');
}

if (failures > 0) {
  console.error(`\n✗ ${failures} check${failures === 1 ? '' : 's'} failed.`);
  process.exit(1);
}
console.log('\n✓ All booking confirmation checks passed.');
