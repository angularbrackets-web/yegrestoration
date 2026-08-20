// Checks the two booking notifications: what they contain, what they must never
// contain, and how a failed send is reported. No network, no database, no live
// API key — `booking-email.ts` is pure, and `sendBookingNotifications` takes an
// injected sender so its error, timeout and success mappings are reachable here.
//
//   npx tsx scripts/verify-booking-email.ts
//
// Exits non-zero if any assertion fails.
import {
  BOOKING_EMAIL_FROM,
  BOOKING_EMAIL_REPLY_TO,
  BOOKING_INTERNAL_TO,
  POST_COMMIT_BUDGET_MS,
  SUPPORT_PHONE,
} from '../src/lib/booking-config';
import {
  CALENDAR_ATTACHED_LINE,
  RECEIVED_HEADING,
  RECEIVED_HOLD_LINE,
  RECEIVED_NEXT_STEPS,
  EXPIRED_REQUEST_REBOOK_LINE,
  PAYMENT_EXPIRED_REBOOK_LINE,
  AFTER_HOURS_NOTE,
  FEE_TERMS_ACK_LABEL,
  FEE_TERMS_CREDIT,
  FEE_TERMS_HEADING,
  FEE_TERMS_INTRO,
  FEE_TERMS_ITEMS,
  FEE_TERMS_PAYMENT,
  FEE_TERMS_REFUND,
  HAVE_READY_ITEMS,
  TIMEZONE_NOTE,
  VISIT_LENGTH_LINE,
} from '../src/lib/booking-copy';
// The weekend multiplier is asserted against the constants `assessmentQuote`
// actually multiplies by, not against a retyped "1.5" — two hand-written copies
// of one number is the drift this whole module exists to prevent.
import { AFTER_HOURS_DENOMINATOR, AFTER_HOURS_NUMERATOR } from '../src/lib/booking-pricing';
import {
  declineMessage,
  escapeHtml,
  expiredRequestMessage,
  paymentAttentionAlert,
  paymentExpiredMessage,
  headerSafe,
  planBookingNotifications,
  type BookingNotificationInput,
  type Message,
} from '../src/lib/booking-email';
import {
  notifyAndStamp,
  notifyIdempotencyPrefix,
  sendBookingNotifications,
  withDeadline,
  type SendResult,
} from '../src/lib/booking-notify';
import { readFileSync } from 'node:fs';
import type { BookingMessageType } from '../src/lib/booking-email';

/**
 * ONE FROZEN CLOCK FOR EVERY SEND IN THIS FILE (BK-32).
 *
 * The notification idempotency prefix now carries an attempt component, so
 * `new Date()` at each call site would make every prefix in this file unique
 * for a reason that has nothing to do with what is being asserted — and the
 * distinctness checks would then pass with the message TYPE dropped from the
 * key entirely. A fixed instant is what keeps those assertions able to fail.
 */
const SEND_NOW = new Date('2026-08-19T12:00:00.000Z');

let failures = 0;
function check(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    failures++;
  }
}

/**
 * Fixture values are deliberately weird.
 *
 * The policy and claim numbers must not be substrings of anything else in the
 * booking, or "the confirmation does not contain the policy number" passes for
 * free — a policy number of `12345` against an address of `12345 Maple St` is
 * an assertion that cannot fail. Hence the sentinels.
 */
const POLICY = 'POLICYSENTINEL-77Q';
const CLAIM = 'CLAIMSENTINEL-42Z';

/** The instant behind the label above, and the instant the send happens at. */
const SLOT = new Date('2026-08-12T19:30:00.000Z');
const NOW = new Date('2026-08-10T15:00:00.000Z');

const INSURANCE: BookingNotificationInput = {
  id: 481,
  messageType: 'confirmed',
  service: 'water',
  assessmentTier: 'standard',
  slotLabel: 'Tue, Aug 12 · 1:30 p.m.',
  slotStart: SLOT,
  now: NOW,
  name: 'Dana Whitecloud',
  phone: '780-555-0142',
  email: 'dana@example.com',
  serviceLabel: 'Water Damage Restoration',
  description: 'Basement flooded overnight.\nWater is still coming in.',
  address: '123 Maple St',
  city: 'Edmonton',
  postalCode: 'T5J 2R7',
  paymentRoute: 'insurance',
  insurerName: 'Prairie Mutual',
  policyNumber: POLICY,
  claimNumber: CLAIM,
  smsConsent: true,
  filesAttached: 3,
};

const PRIVATE: BookingNotificationInput = {
  ...INSURANCE,
  id: 482,
  paymentRoute: 'private',
  insurerName: null,
  policyNumber: null,
  claimNumber: null,
  filesAttached: 0,
};

const NO_EMAIL: BookingNotificationInput = { ...INSURANCE, id: 483, email: null };

/**
 * Every string a message carries — subject, addresses AND attachments, not just
 * the bodies. The attachment half matters from BK-14 on: an attached file is as
 * customer-facing as a paragraph, and a PII check that skipped it would be
 * green for a confirmation that mailed the policy number as a `.ics`.
 */
function allText(message: Message): string {
  return [
    message.from,
    message.to,
    message.replyTo ?? '',
    message.subject,
    message.html,
    message.text,
    // UNFOLDED. An iCalendar line folds at 75 octets with a CRLF and a leading
    // space, so a sentinel sitting past that boundary is invisible to
    // `includes` on the raw text — a PII assertion that cannot fail on exactly
    // the long messages where it matters. Both forms are joined in, so neither
    // blindness is inherited.
    ...(message.attachments ?? []).flatMap((a) => [
      a.filename,
      a.contentType,
      a.content,
      a.content.replace(/\r\n /g, ''),
    ]),
  ].join('\n');
}

// ---------------------------------------------------------------------------
console.log('\nThe locked rule: no insurance identifiers in the customer confirmation');
// ---------------------------------------------------------------------------
{
  const { customer } = planBookingNotifications(INSURANCE);
  if (!customer) {
    check(false, 'an insurance booking with an email address must produce a customer message');
  } else {
    const text = allText(customer);
    // Across the WHOLE message — subject and replyTo are as customer-facing as
    // the body, and a "not in html" check alone would miss a subject line.
    check(!text.includes(POLICY), 'the confirmation must not contain the policy number');
    check(!text.includes(CLAIM), 'the confirmation must not contain the claim number');
    // The list may ASK for them. That sentence is what makes the rule above a
    // copy rule rather than an omission, so assert it is still there.
    check(
      customer.text.includes('policy and claim numbers'),
      'the confirmation must still ask the customer to have the numbers ready',
    );
    // Cancellation is phone-in at launch: no cancel token, no cancel URL.
    check(!/https?:\/\//.test(customer.text), 'the confirmation carries no URL at all');
    check(!/cancel[/?=]/i.test(text), 'the confirmation carries no cancel link');
  }
}

// ---------------------------------------------------------------------------
console.log('\nCustomer confirmation contents');
// ---------------------------------------------------------------------------
{
  const customer = planBookingNotifications(INSURANCE).customer!;

  check(customer.to === INSURANCE.email, 'it is addressed to the customer');
  check(customer.from === BOOKING_EMAIL_FROM, 'it comes from the shared sender identity');
  check(
    customer.replyTo === BOOKING_EMAIL_REPLY_TO,
    'a reply reaches the office, not the noreply sender',
  );

  for (const part of ['html', 'text'] as const) {
    const body = customer[part];
    check(body.length > 0, `the ${part} part is not empty`);
    check(body.includes(INSURANCE.slotLabel), `the ${part} part carries the slot label`);
    // formatSlot emits no zone marker, so the qualifier has to be copy.
    check(body.includes(TIMEZONE_NOTE), `the ${part} part says the time is Edmonton time`);
    check(body.includes('123 Maple St'), `the ${part} part carries the address`);
    check(body.includes('T5J 2R7'), `the ${part} part carries the postal code`);
    check(body.includes(VISIT_LENGTH_LINE), `the ${part} part says the visit takes about 30 minutes`);
    check(body.includes(SUPPORT_PHONE), `the ${part} part carries the phone number`);
    check(body.includes('481'), `the ${part} part carries the reference number`);
    for (const item of HAVE_READY_ITEMS) {
      const needle = part === 'html' ? escapeHtml(item) : item;
      check(body.includes(needle), `the ${part} part carries "${item.slice(0, 28)}…"`);
    }

    // The fee terms used to be asserted HERE, against this fixture only — which
    // is `messageType: 'confirmed'`. Both customer messages render them, so
    // half the coverage was missing and deleting the block from the request arm
    // kept every gate green. Moved to its own section below, parameterised over
    // both message types. See "BK-36 — the fee terms, on BOTH messages".
  }
  check(customer.subject.includes(INSURANCE.slotLabel), 'the subject carries the slot label');

  // The other half of the pair. The assertions above would stay green if a copy
  // edit replaced both priced lines with "terms apply", because they only ever
  // compare the email to whatever the constants currently say. These check the
  // constants themselves, and they are the reason a silent price deletion
  // cannot ship. The figures live in `booking-copy.ts` and nowhere else.
  const figures = [...FEE_TERMS_ITEMS].join(' ');
  check(figures.includes('399'), 'the fee terms still name the $399 assessment fee');
  check(figures.includes('699'), 'and the $699 assessment-plus-report fee');
  check(figures.includes('1,199'), 'and the $1,199 insurance-sketch fee');
  // GST is the client's own term (2026-08-14) and the figures are BEFORE tax.
  // Its own assertion, not folded into the three above, because losing it is a
  // different failure: the prices would still look right and would still
  // understate what the customer owes by 5%.
  check(figures.includes('GST'), 'and says the figures are before GST');

  // The terms attached to those figures, asserted on the JOINED constants
  // rather than on ITEMS — the credit lives in its own constant, the refund
  // rule in another, and each would survive every assertion above while being
  // deleted.
  //
  // Every other terms assertion compares the email to whatever the constants
  // currently say, precisely so a client wording edit does not redden the gate.
  // THESE ARE THE EXCEPTIONS, for the same reason GST is one: they are the
  // substance of what the customer ticks a box to accept. A substantive reword
  // of one of them SHOULD stop the build and get a human look. That is the
  // trade, and it is the opposite of the trade made above.
  //
  // MATCHED ON POLARITY, NOT ON PRESENCE — the correction that matters. The
  // first version of the refund check was `/refund/i`, which is satisfied by
  // "It is FULLY REFUNDABLE if you decide not to go ahead" — the exact negation
  // of the client's decision. A review proved it by writing that sentence and
  // watching every gate stay green. Its red row had only ever DELETED the word,
  // which demonstrates the weaker "something mentioning refunds exists"
  // property while reading like the stronger one. Same defect the earlier review
  // found in the `showForm` pin, in a different costume.
  //
  // BK-36 MADE THAT WORSE BEFORE IT MADE IT BETTER, and the shape is worth
  // keeping in view. The prepay refund policy has a WINDOW: full refund at 24h+
  // notice, none inside 24h. A bare `/no refund/i` cannot tell those apart, and
  // a bare `/full refund/i` is satisfied by the company-cancel line alone — so
  // deleting the customer-cancel line entirely would have left both green. Each
  // of the three refund claims is therefore anchored to the CASE it is about.
  const terms = [
    FEE_TERMS_INTRO,
    ...FEE_TERMS_ITEMS,
    ...FEE_TERMS_PAYMENT,
    ...FEE_TERMS_REFUND,
    FEE_TERMS_CREDIT,
  ].join(' ');

  check(
    /(?:credited?|comes? off|deducted?)/i.test(terms) &&
      /invoice/i.test(terms) &&
      !/(?:not|never|non|no longer|don't|doesn't|won't)\s+\w*\s*(?:credit|deduct)/i.test(terms),
    'and that the fee comes back off the final invoice — stated, and not negated',
  );

  // Refund claim 1 of 3 — the customer cancels IN TIME. Anchored on the window,
  // not on "full refund": `FEE_TERMS_REFUND[0]` (we cancel) already contains
  // that phrase, so an unanchored pin would survive this line being deleted and
  // the terms would read as non-refundable to a customer who gave a week's
  // notice.
  check(
    /24 hours or more[^.]{0,80}refund|refund[^.]{0,80}24 hours or more/i.test(terms),
    'the terms give a FULL refund at 24 hours notice or more — anchored on the window, because "full refund" alone is satisfied by the company-cancel line',
  );
  // Refund claim 2 of 3 — inside the window, including a no-show. Same anchor,
  // opposite polarity. The client's answer did not name no-shows separately, so
  // the copy covers them inside this sentence rather than inventing a clause.
  check(
    /(?:inside|within) 24 hours[^.]{0,90}(?:not refunded|no refund|not refundable|non-?refundable)/i.test(terms),
    'and NO refund inside 24 hours, which is where a missed appointment falls',
  );
  // Refund claim 3 of 3 — the WALK-AWAY, and it is a different question from
  // both of the above. This customer had the assessment done and then declined
  // the restoration work; the 2026-08-18 cancellation answer says nothing about
  // them. It is the client's own 2026-08-14 term. BK-36's first draft dropped
  // it while replacing its gate with the two window pins above, so nothing
  // asserted it because nothing said it — caught in plan review.
  check(
    /(?:not refunded|no refund|not refundable|non-?refundable)[^.]{0,90}(?:go ahead|proceed)|(?:go ahead|proceed)[^.]{0,90}(?:not refunded|no refund|not refundable|non-?refundable)/i.test(terms),
    'and NO refund once the assessment is done and the customer does not go ahead — a different case from either cancellation rule',
  );

  // WHEN the money moves, and it INVERTED at the prepay flip.
  //
  // This pin used to REQUIRE `paid … end of the visit | on site | on the day`.
  // Under P9 that claim is exactly what must not survive: the customer pays on
  // a link, days before the visit, after the office approves. So the assertion
  // is now two — the mechanism must be stated, and the superseded claim must be
  // refused. Two assertions where there was one, not a loosening.
  //
  // THE REFUSAL KEEPS THE PAYMENT-VERB ANCHOR from the version it replaces. A
  // bare `/on site/i` would fire on `FEE_TERMS_ITEMS[0]`'s "the on-site
  // assessment" and survives today only because of a hyphen; a pin whose
  // greenness depends on a hyphen is the next comment in this file.
  check(
    !/pa(?:id|y|yable|ying)\b[^.]{0,40}(?:end of the visit|at the visit|on site|on the day)/i.test(terms),
    'the terms no longer say the assessment is paid on site or on the day — that is the pre-prepay claim, and it must not survive the flip by even one deploy',
  );
  // SCOPED TO FEE_TERMS_PAYMENT, not to the joined terms. `FEE_TERMS_INTRO`
  // also names the payment link, so a joined-string pin stays green with the
  // whole payment section deleted — and a red row that breaks PAYMENT would
  // have logged a red that never happened.
  const payment = [...FEE_TERMS_PAYMENT].join(' ');
  check(
    /payment link|link we email|secure link/i.test(payment),
    'FEE_TERMS_PAYMENT names the payment link — the mechanism that replaced paying on site',
  );
  check(
    /(?:nothing is charged|not charged|no charge|nothing to pay)/i.test(payment),
    'and that nothing is charged when the request is sent — the form never takes money',
  );
  // The confirmation is CONTINGENT on the payment. Without this the terms
  // describe a link and never say what paying it accomplishes, which is the one
  // thing the customer is trying to work out.
  check(
    /confirm(?:ed|s)?[^.]{0,80}(?:payment|paid)|(?:payment|paid)[^.]{0,80}confirm(?:ed|s)?/i.test(terms),
    'and that the appointment is confirmed BY the payment — the whole point of the flip',
  );

  // THE STANDARD-RATES SENTENCE. `FEE_TERMS_ITEMS` states standard figures
  // while the form shows the price that actually applies: mould is cheaper
  // ($385 against $399) and weekends are 1.5x. Without one sentence
  // reconciling them, a mould customer reads $399 in the box and $385 beside
  // the button with no way to know which is real. It is the single most likely
  // way this copy ships subtly wrong, because nothing about it looks like an
  // error — which is exactly why it gets a pin rather than a comment.
  check(
    /standard rates?/i.test(payment) && /booking form|before you send/i.test(payment),
    'the terms say the listed figures are STANDARD rates and point at the form for the price that applies — the sentence a mould or weekend customer needs to reconcile two different numbers',
  );

  // THE WEEKEND SURCHARGE, and it must agree with the code that charges it.
  //
  // Client, 2026-08-18: "Yes weekend is extra". Two sentences state this fact —
  // `AFTER_HOURS_NOTE` beside the inflated figure on the form, gated on the
  // slot, and `FEE_TERMS_PAYMENT` unconditionally in the terms, which is the
  // only one a homepage visitor or an email reader ever sees. They are two
  // sentences rather than one shared string because they do different jobs; the
  // risk that buys is that they drift to two different multipliers, so both are
  // pinned against the constants `assessmentQuote` actually multiplies by.
  const multiplier = String(AFTER_HOURS_NUMERATOR / AFTER_HOURS_DENOMINATOR);
  check(
    payment.includes(multiplier),
    `FEE_TERMS_PAYMENT states the weekend multiplier the code charges (${multiplier})`,
  );
  check(
    AFTER_HOURS_NOTE.includes(multiplier),
    `and so does AFTER_HOURS_NOTE, so the two cannot drift (${multiplier})`,
  );
  check(
    /Saturday/i.test(payment) && /Sunday/i.test(payment),
    'and it names Saturday and Sunday, in plain words rather than as a formula',
  );

  // TWO WORDS THAT MAY NEVER APPEAR IN THIS COPY, asserted at the constants —
  // which is where the prohibition actually lives. `verify-cutover.ts` asserts
  // the same two against `dist/` after the build, which is the BK-29 lesson;
  // this one is exact and fails with a better message.
  //
  // "deductible": deductible rebating by contractors is explicitly illegal in
  // several US jurisdictions and reads as claims-fraud territory to Canadian
  // insurers. The credit is against OUR invoice and this copy never names what
  // the customer's share is called. (The word is used elsewhere on the site,
  // where it explains coverage rather than pricing an assessment. Different
  // claim, different page, not this block's to make.)
  const allTerms = [FEE_TERMS_HEADING, terms, FEE_TERMS_ACK_LABEL].join(' ');
  check(
    !/deductible/i.test(allTerms),
    'no fee-terms constant contains the word "deductible"',
  );
  // …and nothing says the ASSESSMENT is billed to an insurer. The $699/$1,199
  // language describes documentation the CUSTOMER receives and can hand to
  // their adjuster; it never says who pays.
  const INSURER_BILLING_SHAPES = [
    /billed to your insur\w+/i,
    /your insurance (?:pays|covers|is billed)/i,
    /we bill your (?:insurance|insurer)/i,
    /(?:covered|paid) by your insurance/i,
    /insurance (?:pays|covers) (?:for )?(?:the |this )?assessment/i,
  ];
  check(
    !INSURER_BILLING_SHAPES.some((r) => r.test(allTerms)),
    'and no fee-terms constant states or implies the assessment is billed to an insurer',
  );
}

// ---------------------------------------------------------------------------
console.log('\nBK-36 — the fee terms, on BOTH messages and in BOTH arms');
// ---------------------------------------------------------------------------
//
// THE HOLE THIS CLOSES. `customerConfirmation()` renders the terms block into
// the request-received message AND the paid-confirmation message — BK-23's
// deliberate split, four renders in total. Every terms assertion in this file
// used to run against the `INSURANCE` fixture, which is `messageType:
// 'confirmed'`, so deleting the block from the REQUEST arm left every gate
// green. That is the message every web customer receives first, and the one
// BK-31's refused blocker B3 named.
//
// ORDER IS ASSERTED, NOT JUST PRESENCE. "The block ends on the credit" is an
// ordering claim — the refund and no-refund language sits in the middle so the
// last thing read is the good news — and a presence loop cannot tell the
// difference between that and the reverse.
{
  for (const messageType of ['request', 'confirmed'] as const) {
    const customer = planBookingNotifications({ ...INSURANCE, messageType }).customer!;

    for (const part of ['html', 'text'] as const) {
      const body = customer[part];
      const needle = (line: string) => (part === 'html' ? escapeHtml(line) : line);

      for (const line of [
        FEE_TERMS_HEADING,
        FEE_TERMS_INTRO,
        ...FEE_TERMS_ITEMS,
        ...FEE_TERMS_PAYMENT,
        ...FEE_TERMS_REFUND,
        FEE_TERMS_CREDIT,
      ]) {
        check(
          body.includes(needle(line)),
          `the ${messageType} ${part} part carries the fee terms: "${line.slice(0, 28)}…"`,
        );
      }

      // The render order, in the message the customer keeps. `indexOf` over the
      // first line of each section: they are distinct strings, so a section
      // moved past another moves its index with it.
      const at = (line: string) => body.indexOf(needle(line));
      const chain: [string, number][] = [
        ['HEADING', at(FEE_TERMS_HEADING)],
        ['INTRO', at(FEE_TERMS_INTRO)],
        ['ITEMS', at(FEE_TERMS_ITEMS[0])],
        ['PAYMENT', at(FEE_TERMS_PAYMENT[0])],
        ['REFUND', at(FEE_TERMS_REFUND[0])],
        ['CREDIT', at(FEE_TERMS_CREDIT)],
      ];
      for (let i = 1; i < chain.length; i++) {
        check(
          chain[i - 1][1] >= 0 && chain[i][1] > chain[i - 1][1],
          `the ${messageType} ${part} part renders ${chain[i][0]} after ${chain[i - 1][0]}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\nInternal notification contents');
// ---------------------------------------------------------------------------
{
  const { internal } = planBookingNotifications(INSURANCE);

  check(internal.to === BOOKING_INTERNAL_TO, 'it is addressed to the office');
  check(internal.replyTo === INSURANCE.email, 'replying reaches the customer');

  for (const part of ['html', 'text'] as const) {
    const body = internal[part];
    // The office has to know WHEN and WHICH — the two the first draft of the
    // acceptance criteria left out.
    check(body.includes(INSURANCE.slotLabel), `the ${part} part carries the slot label`);
    check(body.includes('481'), `the ${part} part carries the booking id`);
    check(body.includes('Dana Whitecloud'), `the ${part} part carries the name`);
    check(body.includes('780-555-0142'), `the ${part} part carries the phone number`);
    check(body.includes('dana@example.com'), `the ${part} part carries the email`);
    check(body.includes('Water Damage Restoration'), `the ${part} part carries the service label`);
    check(body.includes('123 Maple St'), `the ${part} part carries the address`);
    check(body.includes('Basement flooded overnight.'), `the ${part} part carries the description`);
    check(body.includes('3'), `the ${part} part carries the file count`);
    // Insurance identifiers ARE allowed here — 002-booking scopes them to
    // "email and the admin panel only".
    check(body.includes('Prairie Mutual'), `the ${part} part carries the insurer`);
    check(body.includes(POLICY), `the ${part} part carries the policy number`);
    check(body.includes(CLAIM), `the ${part} part carries the claim number`);
  }
  check(internal.subject.includes('481'), 'the subject carries the booking id');
}

// ---------------------------------------------------------------------------
console.log('\nThe calendar invite rides the internal notification (BK-14)');
// ---------------------------------------------------------------------------
{
  const { customer, internal } = planBookingNotifications(INSURANCE);

  check(internal.attachments?.length === 1, `the office message carries exactly one attachment, got ${internal.attachments?.length ?? 0}`);
  const ics = internal.attachments?.[0];
  check(ics?.filename === 'assessment-481.ics', `named for the booking, got ${ics?.filename}`);
  check(
    ics?.contentType === 'text/calendar; charset=utf-8; method=REQUEST',
    `typed as a REQUEST invite, got ${ics?.contentType}`,
  );
  check(ics?.content.startsWith('BEGIN:VCALENDAR') ?? false, 'and the content is an iCalendar body');
  check(ics?.content.includes('UID:booking-481@') ?? false, 'for this booking');
  // The instant, not the label: the plan now carries both, and the ICS must use
  // the one that is an instant. `slotLabel` is 1:30 p.m. Edmonton = 19:30 UTC.
  check(ics?.content.includes('DTSTART:20260812T193000Z') ?? false, 'at the slot instant');
  check(ics?.content.includes('DTEND:20260812T200000Z') ?? false, 'lasting the locked 30 minutes');
  // DTSTAMP from the injected `now`, which is what makes the whole plan a value
  // rather than something with a clock inside it.
  check(ics?.content.includes('DTSTAMP:20260810T150000Z') ?? false, 'stamped at the injected send instant');

  // FLIPPED IN BK-16, NOT DELETED. This read "the customer confirmation
  // carries no attachment at all" — BK-14 pinned the ABSENCE, deliberately,
  // because the shared builder made attaching it to both a one-line edit. The
  // client asked for the customer invite, so the pin inverts rather than
  // disappearing: an assert that is deleted instead of inverted is green
  // forever, and this one guards the difference between the customer getting
  // their own invite and the customer getting the OFFICE's copy of it.
  check(
    customer?.attachments?.length === 1,
    `the customer confirmation carries exactly one attachment, got ${customer?.attachments?.length ?? 0}`,
  );
  const customerIcs = customer?.attachments?.[0];
  check(
    customerIcs?.contentType === 'text/calendar; charset=utf-8; method=REQUEST',
    `typed as a REQUEST invite, got ${customerIcs?.contentType}`,
  );
  check(customerIcs?.filename === 'assessment-481.ics', 'named for the same booking');
  const customerIcsText = (customerIcs?.content ?? '').replace(/\r\n /g, '');
  // SAME UID as the office copy. This is what makes the cancellation BK-16 also
  // adds able to clear anything at all: a CANCEL only matches an event the
  // client already holds under that UID.
  check(
    customerIcsText.includes('UID:booking-481@'),
    'against the same UID as the office copy — they are one event',
  );
  check(
    customerIcsText.includes(`RSVP=TRUE:mailto:${INSURANCE.email}`),
    `and the CUSTOMER is the attendee, got ${customerIcsText.match(/ATTENDEE[^\r\n]*/)?.[0]}`,
  );
  check(
    !customerIcsText.includes(`mailto:${BOOKING_INTERNAL_TO}`),
    'with the office address nowhere in it — a defaulted audience is what puts it there',
  );
  // The office's contact line is the customer's phone number. In the
  // customer's own copy that reads as a mistake, and it is the half of the
  // audience swap that breaks nothing if it is forgotten.
  check(
    !customerIcsText.includes(INSURANCE.phone),
    "the customer's own phone number is not the description of their own event",
  );
  check(
    customerIcsText.includes(SUPPORT_PHONE),
    'the description carries SUPPORT_PHONE — the number to call',
  );
  check(
    customer?.text.includes('calendar invite is attached') ?? false,
    'and the copy mentions the attachment rather than leaving a bare .ics',
  );

  // The stricter-than-email rule, checked on the ATTACHMENT of the message
  // whose BODY legitimately carries both identifiers. This is the one place
  // both facts are true at once, which is what makes it worth asserting here as
  // well as in verify:booking:ics.
  // Unfolded, for the reason `allText` states — and `allText` covers the same
  // ground for the whole message, so a regression shows up twice rather than
  // depending on which of the two an editor happens to keep.
  const icsText = (ics?.content ?? '').replace(/\r\n /g, '');
  check(internal.text.includes(POLICY), 'the office BODY still carries the policy number');
  check(icsText.length > 0 && !icsText.includes(POLICY), 'and the ICS does not');
  check(!icsText.includes(CLAIM), 'nor the claim number');
  check(!icsText.includes('Prairie Mutual'), "nor the insurer's name");
}

// ---------------------------------------------------------------------------
console.log('\nPrivate pay drops the insurance section');
// ---------------------------------------------------------------------------
{
  const { internal } = planBookingNotifications(PRIVATE);
  for (const part of ['html', 'text'] as const) {
    check(!internal[part].includes('Policy'), `the ${part} part has no policy row`);
    check(!internal[part].includes('Claim'), `the ${part} part has no claim row`);
    check(!internal[part].includes('Insurer'), `the ${part} part has no insurer row`);
    check(internal[part].includes('Private pay'), `the ${part} part says private pay`);
  }
}

// ---------------------------------------------------------------------------
console.log('\nNo email address means no customer message');
// ---------------------------------------------------------------------------
{
  const plan = planBookingNotifications(NO_EMAIL);
  check(plan.customer === null, 'the customer message is null, not an empty or unaddressed one');
  check(plan.internal.to === BOOKING_INTERNAL_TO, 'the office is still notified');
  check(
    plan.internal.replyTo === BOOKING_EMAIL_REPLY_TO,
    'and a reply reaches the office rather than bouncing off the noreply sender',
  );

  // BK-21. The old assertion here looked for a bare '—', a substring the
  // warning keeps, so it stayed green against a half-done change. These name
  // the three facts the line exists to carry, in BOTH parts.
  for (const part of ['html', 'text'] as const) {
    const body = plan.internal[part];
    check(body.includes('none given'), `the ${part} part says no address was given`);
    check(
      body.includes('NOT reachable by email'),
      `the ${part} part says the customer cannot be emailed at all`,
    );
    check(
      body.includes('replies to this message go to the office'),
      `the ${part} part says where a reply to it lands`,
    );
  }

  // And the with-email arm carries none of it — a warning on every notice is a
  // warning the office learns to read past, which is the whole failure mode.
  const withEmail = planBookingNotifications(INSURANCE).internal;
  for (const part of ['html', 'text'] as const) {
    check(
      !withEmail[part].includes('NOT reachable by email'),
      `a booking WITH an email carries no such warning in its ${part} part`,
    );
  }
}

// ---------------------------------------------------------------------------
console.log('\nEscaping and subject safety');
// ---------------------------------------------------------------------------
{
  check(
    escapeHtml(`<script>alert("x") & 'y'</script>`) ===
      '&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;',
    'escapeHtml escapes all five of & < > " and \'',
  );

  const hostile: BookingNotificationInput = {
    ...INSURANCE,
    name: `<img src=x onerror="alert('xss')">`,
    description: `<b>bold</b> & "quoted"`,
  };
  const plan = planBookingNotifications(hostile);
  const customer = plan.customer!;

  check(!customer.html.includes('<img src=x'), 'the customer html has no injected tag');
  check(!plan.internal.html.includes('<img src=x'), 'the internal html has no injected tag');
  check(
    customer.html.includes('&lt;img src=x'),
    'the injected tag survives as escaped text, so nothing is silently dropped',
  );
  check(!plan.internal.html.includes('<b>bold</b>'), 'the description is escaped in the internal html');
  // The text part is not HTML; escaping it would show customers &amp;.
  check(plan.internal.text.includes('<b>bold</b> & "quoted"'), 'the text part is left as typed');

  // Subjects: parseBookingPayload trims but allows interior newlines.
  check(headerSafe('a\nb\r\n  c') === 'a b c', 'headerSafe collapses newlines and runs of spaces');

  // The name is the ONLY customer-typed string in either subject, and it is in
  // the internal one. Assert that first — without it the newline check below is
  // an assertion that cannot fail, whatever headerSafe does, which is exactly
  // the trap the sentinel comment at the top of this file warns about.
  check(
    planBookingNotifications(INSURANCE).internal.subject.includes(INSURANCE.name),
    'the internal subject carries the name, so headerSafe is load-bearing',
  );
  const multiline = planBookingNotifications({ ...INSURANCE, name: 'Dana\nWhitecloud' });
  check(
    multiline.internal.subject.includes('Dana Whitecloud'),
    'a name with a newline is collapsed, not truncated, in the internal subject',
  );
  check(!multiline.internal.subject.includes('\n'), 'no newline reaches the internal subject');
  check(!multiline.customer!.subject.includes('\n'), 'no newline reaches the customer subject');
}

// ---------------------------------------------------------------------------
console.log('\nSend outcomes — the mapping the SDK makes easy to get wrong');
// ---------------------------------------------------------------------------
{
  const plan = planBookingNotifications(INSURANCE);
  const noEmailPlan = planBookingNotifications(NO_EMAIL);

  const sent = async (): Promise<SendResult> => ({ ok: true });
  const failed = async (): Promise<SendResult> => ({
    // What resend@6.17.1 actually does on a bad key: it RESOLVES with an error
    // rather than throwing, which is why `try/catch` around it catches nothing.
    ok: false,
    error: 'validation_error: API key is invalid',
  });
  const threw = async (): Promise<SendResult> => {
    throw new Error('socket hang up');
  };

  const ok = await sendBookingNotifications(plan, SEND_NOW, { send: sent });
  check(ok.customer === 'sent' && ok.internal === 'sent', 'both send → both sent');

  // The attachments survive the send path. Asserted here as well as on the plan
  // because this is the seam every real send goes through, and a `deliver` that
  // rebuilt its message would drop them.
  //
  // FLIPPED IN BK-16, NOT DELETED. This counted ONE attached message and
  // asserted it was the office one — true until the customer got their own
  // invite. Inverting it rather than dropping it keeps the property that
  // matters: the count is exact, and each message carries the copy addressed to
  // ITS OWN recipient. A builder that attached the office ICS to both would
  // satisfy a bare "two messages carry attachments".
  const delivered: Message[] = [];
  await sendBookingNotifications(plan, SEND_NOW, {
    send: async (m) => {
      delivered.push(m);
      return { ok: true };
    },
  });
  const attached = delivered.filter((m) => (m.attachments?.length ?? 0) > 0);
  check(
    attached.length === 2,
    `both delivered messages carry an attachment, got ${attached.length} of ${delivered.length}`,
  );
  const officeCopy = delivered.find((m) => m.to === BOOKING_INTERNAL_TO);
  const customerCopy = delivered.find((m) => m.to === INSURANCE.email);
  check(officeCopy !== undefined && customerCopy !== undefined, 'one to each recipient');
  const attendeeOf = (m: Message | undefined) =>
    (m?.attachments?.[0]?.content ?? '').replace(/\r\n /g, '').match(/ATTENDEE[^\r\n]*/)?.[0] ?? '';
  check(
    attendeeOf(officeCopy).endsWith(`mailto:${BOOKING_INTERNAL_TO}`),
    `the office's copy names the office, got ${attendeeOf(officeCopy)}`,
  );
  check(
    attendeeOf(customerCopy).endsWith(`mailto:${INSURANCE.email}`),
    `and the customer's names the customer, got ${attendeeOf(customerCopy)}`,
  );
  check(
    attendeeOf(officeCopy) !== attendeeOf(customerCopy),
    'which is to say the two are not the same artifact sent twice',
  );

  const bad = await sendBookingNotifications(plan, SEND_NOW, { send: failed });
  check(
    bad.customer === 'failed' && bad.internal === 'failed',
    'a resolved error response is reported as failed, never as sent',
  );

  const thrown = await sendBookingNotifications(plan, SEND_NOW, { send: threw });
  check(
    thrown.customer === 'failed' && thrown.internal === 'failed',
    'a throwing sender is caught rather than escaping into the route',
  );

  const skipped = await sendBookingNotifications(noEmailPlan, SEND_NOW, { send: sent });
  check(
    skipped.customer === 'skipped' && skipped.internal === 'sent',
    'no customer email → skipped, and the office is still notified',
  );

  // The disable flag is fail-open, and only a deliberate value trips it. `0` and
  // `false` are what someone writes meaning "present but off"; treating those as
  // "disable" would silently stop every confirmation in production.
  for (const [value, expected] of [
    ['1', true],
    ['true', true],
    ['TRUE', true],
    ['0', false],
    ['false', false],
    ['no', false],
    ['', false],
  ] as const) {
    process.env.BOOKING_NOTIFY_DISABLED = value;
    const attempts: Message[] = [];
    const outcome = await sendBookingNotifications(plan, SEND_NOW, {
      send: async (m) => {
        attempts.push(m);
        return { ok: true };
      },
    });
    const muted = outcome.internal === 'skipped';
    check(
      muted === expected,
      `BOOKING_NOTIFY_DISABLED=${JSON.stringify(value)} must ${expected ? 'mute' : 'not mute'}`,
    );
    // Nothing sends under the mute, so no attachment leaves either — the mute
    // is checked before the seam, which is why every route-level script in this
    // repo asserts nothing about sends.
    check(
      (attempts.length === 0) === expected,
      `BOOKING_NOTIFY_DISABLED=${JSON.stringify(value)} delivers ${expected ? 'nothing' : 'both messages'}, got ${attempts.length}`,
    );
  }
  delete process.env.BOOKING_NOTIFY_DISABLED;

  // One slow message must not hold up the other: the office notification is the
  // one that always exists and matters most.
  let internalFinished = false;
  const slowCustomer = async (message: Message): Promise<SendResult> => {
    if (message.to === BOOKING_INTERNAL_TO) {
      internalFinished = true;
      return { ok: true };
    }
    await new Promise((r) => setTimeout(r, 40));
    check(internalFinished, 'the office notification does not wait behind a slow customer send');
    return { ok: true };
  };
  await sendBookingNotifications(plan, SEND_NOW, { send: slowCustomer });
}

// ---------------------------------------------------------------------------
console.log('\nSend then record — the stamp never revises the answer');
// ---------------------------------------------------------------------------
{
  const plan = planBookingNotifications(INSURANCE);
  const sent = async (): Promise<SendResult> => ({ ok: true });
  const failed = async (): Promise<SendResult> => ({ ok: false, error: 'nope' });

  const seen: { customer: boolean; internal: boolean }[] = [];
  const record = async (s: { customer: boolean; internal: boolean }) => {
    seen.push(s);
  };

  check(await notifyAndStamp(plan, SEND_NOW, { send: sent, stamp: record }), 'a sent confirmation reports true');
  check(
    seen.length === 1 && seen[0].customer === true && seen[0].internal === true,
    'and the stamp is told what actually sent',
  );

  check(
    !(await notifyAndStamp(plan, SEND_NOW, { send: failed, stamp: record })),
    'a failed send reports false',
  );
  check(
    seen[1]?.customer === false && seen[1]?.internal === false,
    'and nothing is stamped as sent',
  );

  // The defect this function exists to prevent: the stamp is bookkeeping, so
  // its failure must not rewrite a fact that already happened. The first way
  // this bites is deploying before the migration — the columns are missing,
  // every UPDATE throws, and every booking would report emailSent: false for
  // two emails that went out.
  const throwingStamp = async () => {
    throw new Error('column "confirmation_sent_at" does not exist');
  };
  check(
    await notifyAndStamp(plan, SEND_NOW, { send: sent, stamp: throwingStamp }),
    'a failed stamp does not turn a sent confirmation into an unsent one',
  );
}

// ---------------------------------------------------------------------------
console.log('\nThe deadline');
// ---------------------------------------------------------------------------
{
  check(
    POST_COMMIT_BUDGET_MS > 0 && POST_COMMIT_BUDGET_MS <= 8000,
    'the post-commit budget leaves headroom under a 10s function limit',
  );

  const hang = new Promise<boolean>(() => {});
  const started = Date.now();
  const timedOut = await withDeadline(hang, 30, false);
  check(timedOut === false, 'a send that never settles resolves to the safe answer, not a hang');
  check(Date.now() - started < 1000, 'and it resolves at the deadline rather than waiting');

  check(await withDeadline(Promise.resolve(true), 1000, false), 'a fast send keeps its own answer');

  // A rejection from the losing side must not become an unhandled rejection
  // after the response has already gone out.
  let unhandled: unknown = null;
  const onUnhandled = (err: unknown) => {
    unhandled = err;
  };
  process.on('unhandledRejection', onUnhandled);
  const late = new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error('late')), 10));
  check(await withDeadline(late, 1, false) === false, 'the deadline wins over a late rejection');
  await new Promise((r) => setTimeout(r, 60));
  process.off('unhandledRejection', onUnhandled);
  check(unhandled === null, 'and the late rejection is swallowed rather than crashing the function');
}

// ---------------------------------------------------------------------------
console.log('\nBK-23 — a request must never claim a booking');
// ---------------------------------------------------------------------------
//
// THE CLAIM THIS PINS. Submitting the form used to confirm a booking, so both
// messages said so and both carried a calendar invite. Under P9 submission
// produces a REQUEST: the office has not looked at it and nobody has paid.
//
// A calendar invite is the worst offender of the two, and not because it is
// louder. The sentence is read once; the calendar entry repeats the claim back
// to the customer every day until the appointment, and nothing about a calendar
// entry says "provisional".
{
  const requestPlan = planBookingNotifications({ ...INSURANCE, messageType: 'request' });
  const confirmedPlan = planBookingNotifications({ ...INSURANCE, messageType: 'confirmed' });

  const cust = requestPlan.customer!;
  const office = requestPlan.internal;

  // --- no invite, on either message
  check(cust.attachments === undefined, 'the request message carries NO calendar attachment');
  check(office.attachments === undefined, 'and neither does the office copy of it');
  check(
    confirmedPlan.customer?.attachments?.length === 1,
    'while a confirmed message still carries exactly one',
  );
  check(
    confirmedPlan.internal.attachments?.length === 1,
    'and so does the office copy of that',
  );

  // --- and nothing that describes an invite
  for (const [label, body] of [
    ['html', cust.html],
    ['text', cust.text],
  ] as const) {
    check(
      !body.includes(CALENDAR_ATTACHED_LINE),
      `the request ${label} never mentions an attached invite`,
    );
    check(
      !/you'?re booked/i.test(body),
      `the request ${label} never says "you're booked"`,
    );
  }
  check(
    !/you'?re booked/i.test(cust.subject),
    'and neither does the subject line — the one part that shows in a list view',
  );

  // --- it says what it IS, and what happens next
  check(cust.subject.includes(RECEIVED_HEADING), 'the subject names it a request');
  for (const step of RECEIVED_NEXT_STEPS) {
    check(cust.html.includes(escapeHtml(step)), 'every next step appears in the html');
    check(cust.text.includes(step), 'and in the plaintext arm');
  }
  check(cust.html.includes(escapeHtml(RECEIVED_HOLD_LINE)), 'the slot-held line appears');

  // --- NO PUBLISHED SLA. The client stated "max 1 hour" internally and
  //     deliberately did not publish it; a page a customer can screenshot turns
  //     an operational intent into a commitment.
  for (const body of [cust.html, cust.text, cust.subject]) {
    check(
      !/within (an|1) hour|max(imum)? 1 hour|within \d+ (minutes|hours)/i.test(body),
      'no review-time promise is published anywhere in the request message',
    );
  }

  // --- the office copy is distinguishable at a glance in an inbox
  check(
    office.subject.includes('REQUEST'),
    'the office subject says REQUEST, not "New booking" — it is a decision to make, not news',
  );

  // --- the confirmed message is unchanged in the ways that matter
  check(
    /you'?re booked/i.test(confirmedPlan.customer!.html),
    'the confirmed message still says it plainly',
  );
  check(
    confirmedPlan.customer!.html.includes(CALENDAR_ATTACHED_LINE),
    'and still describes its invite',
  );
}

// ---------------------------------------------------------------------------
console.log('\nBK-43 — the idempotency prefix carries the message type');
// ---------------------------------------------------------------------------
//
// THE DEFECT THIS PINS. The prefix used to be a fixed `booking-<id>`, and
// `createResendSender` sends `Idempotency-Key: <prefix>:<recipient>`. Under
// the prepay flow one booking mails the same address up to five times, so a
// fixed prefix made four of those five byte-identical keys — Resend delivers
// the first and returns SUCCESS for the rest. The customer never sees the
// payment link and nothing logs a thing.
//
// It is invisible in both places anyone would look: BOOKING_NOTIFY_DISABLED
// mutes the sender in dev, and a collapsed send is a 200 in production.
{
  const ALL_TYPES: BookingMessageType[] = [
    'request',
    'payment-link',
    'payment-reminder',
    'confirmed',
    'declined',
    'expired',
  ];

  // AC1 — every transition gets its own prefix.
  //
  // ── THE FROZEN CLOCK IS WHAT MAKES THIS ABLE TO FAIL (BK-32) ─────────────
  //
  // Since the prefix gained an attempt component, mapping these through
  // `new Date()` would vary the epoch on every iteration — so
  // `new Set(prefixes).size === 6` would pass **even with the message type
  // dropped from the prefix entirely**, and this would join the seven
  // assertions this repo has already caught for being unable to go red. One
  // instant across the whole map is what leaves the TYPE as the only thing
  // separating them.
  const prefixes = ALL_TYPES.map((t) => notifyIdempotencyPrefix(7, t, SEND_NOW));
  check(
    new Set(prefixes).size === ALL_TYPES.length,
    `all ${ALL_TYPES.length} message types produce distinct prefixes at one instant`,
  );
  check(
    prefixes.every((p) => /-\d{9,}$/.test(p)),
    'and each carries an attempt component, so a re-issue is not collapsed',
  );
  check(
    notifyIdempotencyPrefix(7, 'payment-link', SEND_NOW) ===
      notifyIdempotencyPrefix(7, 'payment-link', SEND_NOW),
    'one (id, type, attempt) is stable — a retry WITHIN one attempt still collapses',
  );
  // The property BK-32 deliberately gives up, asserted rather than left to be
  // discovered. BK-43's version of this line claimed a retry collapses full
  // stop; it now collapses only inside one attempt, which is exactly what
  // `inviteIdempotencyPrefix` has always done and what makes a re-issued
  // payment link and a second Resend click deliver at all.
  check(
    notifyIdempotencyPrefix(7, 'payment-link', SEND_NOW) !==
      notifyIdempotencyPrefix(7, 'payment-link', new Date(SEND_NOW.getTime() + 1000)),
    'and a LATER attempt at the same transition is a different key — the re-issue delivers',
  );
  check(
    notifyIdempotencyPrefix(7, 'confirmed', SEND_NOW) !==
      notifyIdempotencyPrefix(8, 'confirmed', SEND_NOW),
    'two bookings never share a prefix',
  );

  // AC2 — THE ONE THE USER ASKED FOR, driven end to end through the real seam
  // rather than inferred from the prefix function: two different message types
  // to the SAME recipient must both deliver.
  //
  // `deps.send` receives the key prefix the real sender would have baked in,
  // which is the only reason this is observable without a network.
  const seen: string[] = [];
  const recordingSend = async (message: Message, keyPrefix: string | null) => {
    seen.push(`${keyPrefix}:${message.to}`);
    return { ok: true } as SendResult;
  };

  // ONE INSTANT FOR BOTH SENDS, so the only thing that can separate their keys
  // is the message type. With two clocks this would pass whatever the prefix
  // did with the type.
  const oneAddress = { ...INSURANCE, id: 991, email: 'same@example.com' };
  await sendBookingNotifications(
    planBookingNotifications({ ...oneAddress, messageType: 'request' }),
    SEND_NOW,
    { send: recordingSend },
  );
  await sendBookingNotifications(
    planBookingNotifications({ ...oneAddress, messageType: 'payment-link' }),
    SEND_NOW,
    { send: recordingSend },
  );

  const customerKeys = seen.filter((k) => k.endsWith(':same@example.com'));
  check(
    customerKeys.length === 2,
    'two sends reached the same customer address',
  );
  check(
    new Set(customerKeys).size === 2,
    'and their idempotency keys differ, so Resend delivers both rather than collapsing the second',
  );

  // AC3 — the dedupe the key exists for, and the re-issue it must NOT eat.
  //
  // Two sends of one transition at ONE instant are a retry, and they share a
  // key so Resend collapses them. Two sends at DIFFERENT instants are a
  // deliberate re-issue — the office correcting an amount and re-approving, or
  // clicking Resend because the customer never got the first one — and they must
  // not collapse. That second case is BK-23's S2 and the ROADMAP's Resend trap,
  // and before BK-32 it was silently swallowed with a "sent" flash.
  seen.length = 0;
  const retried = planBookingNotifications({ ...oneAddress, messageType: 'payment-link' });
  await sendBookingNotifications(retried, SEND_NOW, { send: recordingSend });
  await sendBookingNotifications(retried, SEND_NOW, { send: recordingSend });
  const retryKeys = seen.filter((k) => k.endsWith(':same@example.com'));
  check(
    retryKeys.length === 2 && new Set(retryKeys).size === 1,
    'a retry within one attempt reuses one key — Resend still collapses it',
  );

  seen.length = 0;
  await sendBookingNotifications(retried, SEND_NOW, { send: recordingSend });
  await sendBookingNotifications(retried, new Date(SEND_NOW.getTime() + 60_000), {
    send: recordingSend,
  });
  const reissueKeys = seen.filter((k) => k.endsWith(':same@example.com'));
  check(
    reissueKeys.length === 2 && new Set(reissueKeys).size === 2,
    'a RE-ISSUE of the same transition gets its own key — the corrected amount actually reaches the customer',
  );

  // AC4 — source pin. The defect is a template literal at a call site, and it
  // would pass every behavioural check above if someone reintroduced it for
  // one of the three senders. Same pattern verify-booking-ics.ts uses for the
  // attachment whitelist, and for the same reason: the fake sender cannot see
  // what the real one would have done.
  const notifySrc = readFileSync('src/lib/booking-notify.ts', 'utf8');

  // The FIRST version of this pin did not implement AC4, and the review proved
  // it: the regex below used to be
  //
  //     /createResendSender\([^)]*`booking-\$\{/
  //
  // which only matches a template literal sitting INSIDE the argument list,
  // with no intervening `)`. But every sender here was restructured to
  //
  //     const keyPrefix = notifyIdempotencyPrefix(...);
  //     send = createResendSender(apiKey, keyPrefix);
  //
  // so the natural regression — editing the `const keyPrefix =` line — never
  // appears between those parens. Restoring `sendCustomerConfirmation` to the
  // exact pre-BK-43 defect left this whole script GREEN. The pin credited with
  // catching "the failure mode that matters most" caught one spelling of one
  // of four senders.
  //
  // Pinned by COUNT instead: the prefix shape may be spelled exactly once in
  // this file, in `notifyIdempotencyPrefix`'s own return. Any second occurrence
  // is a site building its own, wherever it sits.
  const prefixLiterals = (notifySrc.match(/`booking-\$\{/g) ?? []).length;
  check(
    prefixLiterals === 1,
    `the prefix shape is spelled exactly once — in notifyIdempotencyPrefix's return (found ${prefixLiterals})`,
  );

  // And every sender must take its prefix from a builder rather than from
  // anything else. Checked per call site, not by a total: the old `>= 3`
  // threshold counted a doc-comment mention and the declaration itself, so it
  // stood at 5 against a floor of 3 — two of the three real call sites could
  // have been deleted with it still green.
  // `= createResendSender(` rather than `createResendSender(`, so the exported
  // declaration on line 113 is not counted as a fifth call site.
  //
  // BK-32 ADDED A FIFTH SENDER, AND IT IS THE EXCEPTION THAT HAS TO BE NAMED.
  // `sendOfficeMessage` passes `null` — no `Idempotency-Key` header at all —
  // because its recipient is the fixed office address, so any key stable across
  // sends would make Resend collapse the second payment alert into the first.
  // That is the same decision the contact form and the lead reply already make.
  //
  // Counted separately rather than folded into a looser regex: "four take a
  // keyPrefix and exactly one deliberately takes null" is the property, and a
  // pin that merely allowed `null` anywhere would go green if somebody quietly
  // dropped the prefix from the payment-link send.
  const senderCalls = notifySrc.match(/= createResendSender\([^)]*\)/g) ?? [];
  check(
    senderCalls.length === 5,
    `all five senders in this file construct through createResendSender (found ${senderCalls.length})`,
  );
  const keyed = senderCalls.filter((call) => /createResendSender\(apiKey, keyPrefix\)/.test(call));
  const unkeyed = senderCalls.filter((call) => /createResendSender\(apiKey, null\)/.test(call));
  check(
    keyed.length === 4,
    `four senders pass the keyPrefix variable, never an inline expression (found ${keyed.length})`,
  );
  check(
    unkeyed.length === 1,
    `and exactly one — the office alert — deliberately passes null (found ${unkeyed.length})`,
  );
  check(
    keyed.length + unkeyed.length === senderCalls.length,
    'with nothing else in between: a sender takes a builder prefix or an explicit null',
  );
  const assignments = notifySrc.match(/const keyPrefix = .*/g) ?? [];
  check(
    assignments.length === 4 &&
      assignments.every((line) =>
        /(notifyIdempotencyPrefix|inviteIdempotencyPrefix)\(/.test(line),
      ),
    `every keyPrefix is assigned from a prefix builder (${assignments.length} assignments)`,
  );

  // AC5 — the contact form and lead reply pass null and must keep sending no
  // header at all. A fixed key on a fixed office address would collapse every
  // message after the first.
  check(
    /keyPrefix \? \{ idempotencyKey: `\$\{keyPrefix\}:\$\{message\.to\}` \} : \{\}/.test(notifySrc),
    'a null prefix still passes no Idempotency-Key header',
  );
}

// ---------------------------------------------------------------------------
console.log('\nThe stale-request expiry message (BK-23 Task 4)');
// ---------------------------------------------------------------------------
//
// This customer was not turned away — nobody looked at their request in time.
// Sending them the at-capacity decline would be a tidy untruth of exactly the
// kind P9 exists to remove, so the words are the assertion here.
{
  const expired = expiredRequestMessage({ ...INSURANCE, messageType: 'expired' });
  check(expired !== null, 'a request with an email address gets a message');
  const bodies = [expired?.html ?? '', expired?.text ?? '', expired?.subject ?? ''];

  for (const [i, body] of bodies.entries()) {
    const where = ['html', 'text', 'subject'][i];

    // NOT the decline. "At capacity" is a claim about our schedule and it is
    // false here.
    check(
      !/at capacity/i.test(body),
      `the expiry ${where} does not claim we were at capacity — we simply missed it`,
    );
    // NOT a booking. Same rule the request emails already carry.
    check(
      !/\byou'?re booked\b|\bconfirmed\b/i.test(body),
      `the expiry ${where} claims no booking`,
    );
  }

  // It must OFFER the phone: their damage has not gone away and their slot is
  // hours off, so "pick another time on the website" cannot be the only answer.
  //
  // Asserted on the REBOOK LINE, not on the body. Every message in this file
  // ends with a `YEG Restoration · <phone>` footer, so
  // `body.includes(SUPPORT_PHONE)` is true of all of them and would have passed
  // with the offer deleted entirely — noticed when breaking the copy produced
  // only one red instead of two.
  check(
    EXPIRED_REQUEST_REBOOK_LINE.includes(SUPPORT_PHONE),
    'the expiry REBOOK LINE carries the phone number — not merely the footer, which every message has',
  );
  check(
    /call or text/i.test(EXPIRED_REQUEST_REBOOK_LINE),
    'and offers it in words rather than only printing a number',
  );
  check(
    (expired?.html ?? '').includes(EXPIRED_REQUEST_REBOOK_LINE) &&
      (expired?.text ?? '').includes(EXPIRED_REQUEST_REBOOK_LINE),
    'and that line reaches both bodies',
  );

  // It owns the failure rather than implying the customer did something.
  check(
    /our fault|we did not|we are sorry/i.test(expired?.text ?? ''),
    'and it owns the miss rather than describing it passively',
  );

  // The two messages must not be the same message.
  const declined = declineMessage({ ...INSURANCE, messageType: 'declined' });
  check(
    (expired?.html ?? '') !== (declined?.html ?? ''),
    'the expiry and the decline are different messages',
  );
  check(
    /at capacity/i.test(declined?.text ?? ''),
    'while the real decline still says what the client asked it to say',
  );

  // No address, no message — same posture as the decline: the slot is released
  // either way, and a phone booking with no email is still expired.
  check(
    expiredRequestMessage({ ...INSURANCE, messageType: 'expired', email: null }) === null,
    'a row with no email address yields no message rather than a broken send',
  );
}

// ---------------------------------------------------------------------------
console.log('\nThe PAYMENT expiry message (BK-32) — a third expiry, a third set of words');
// ---------------------------------------------------------------------------
//
// Three ways a booking can end without a visit now, and each describes a
// different event. The at-capacity decline is a claim about our schedule. The
// stale-request expiry is our failure to look. This one is neither: the office
// approved, quoted a price, gave a deadline, and the customer did not pay by it.
//
// The failure mode being guarded is a lazy reuse — sending one of the other two
// because they are "near enough" — which would tell a customer we were at
// capacity when we were not, or apologise for a miss that was theirs.
{
  const lapsed = paymentExpiredMessage({ ...INSURANCE, messageType: 'expired' });
  check(lapsed !== null, 'an unpaid approval with an email address gets a message');
  const bodies = [lapsed?.html ?? '', lapsed?.text ?? '', lapsed?.subject ?? ''];

  for (const [i, body] of bodies.entries()) {
    const where = ['html', 'text', 'subject'][i];
    check(
      !/at capacity/i.test(body),
      `the payment expiry ${where} does not claim we were at capacity`,
    );
    check(
      !/\byou'?re booked\b|\bconfirmed\b/i.test(body),
      `the payment expiry ${where} claims no booking`,
    );
    // NO INVOICE LANGUAGE. Nothing was owed and nothing is outstanding —
    // somebody who simply changed their mind must not be sent something that
    // reads like a missed bill.
    check(
      !/\boverdue\b|\bowe\b|\boutstanding\b|\bunpaid balance\b|\binvoice\b/i.test(body),
      `the payment expiry ${where} does not read as a missed bill`,
    );
  }

  // It says nothing was charged. That is the single most reassuring fact
  // available and the one a customer will scan for.
  check(
    /nothing has been charged/i.test(lapsed?.text ?? ''),
    'it says plainly that nothing was charged',
  );

  // Same rule as the stale-request message: the offer must be in the REBOOK
  // LINE, not merely in the footer every message carries. Asserted this way
  // because the first version of the sibling assertion read the whole body and
  // therefore could not fail.
  check(
    PAYMENT_EXPIRED_REBOOK_LINE.includes(SUPPORT_PHONE),
    'the rebook line carries the phone number — not merely the footer, which every message has',
  );
  check(
    /call or text/i.test(PAYMENT_EXPIRED_REBOOK_LINE),
    'and offers it in words rather than only printing a number',
  );
  check(
    (lapsed?.html ?? '').includes(PAYMENT_EXPIRED_REBOOK_LINE) &&
      (lapsed?.text ?? '').includes(PAYMENT_EXPIRED_REBOOK_LINE),
    'and that line reaches both bodies',
  );

  // THE THREE MESSAGES ARE THREE MESSAGES. This is the assertion that fails if
  // somebody reuses one for another.
  const stale = expiredRequestMessage({ ...INSURANCE, messageType: 'expired' });
  const declined = declineMessage({ ...INSURANCE, messageType: 'declined' });
  const htmls = [lapsed?.html ?? '', stale?.html ?? '', declined?.html ?? ''];
  check(
    new Set(htmls).size === 3,
    'the payment expiry, the stale-request expiry and the decline are three distinct messages',
  );
  const headings = [lapsed?.subject ?? '', stale?.subject ?? '', declined?.subject ?? ''];
  check(
    new Set(headings).size === 3,
    'and three distinct subjects — a customer skimming their inbox can tell them apart',
  );
  // It must not borrow the stale-request message's apology, which owns a
  // failure that is ours. This one is nobody's fault and saying otherwise is
  // its own small untruth.
  check(
    !/our fault/i.test(lapsed?.text ?? ''),
    'the payment expiry does not apologise for a miss that did not happen',
  );

  check(
    paymentExpiredMessage({ ...INSURANCE, messageType: 'expired', email: null }) === null,
    'a row with no email address yields no message rather than a broken send',
  );
}

// ---------------------------------------------------------------------------
console.log('\nEach sweep sends ITS OWN message (BK-32)');
// ---------------------------------------------------------------------------
//
// Everything above asserts that the three expiry messages are three different
// messages. **That is not the same as the right one being sent**, and a
// deliberate swap — sweep 1 calling `expiredRequestMessage` — left every one of
// those assertions green, because they test builders and not callers. The
// customer who did not pay would have been told nobody looked at their request.
//
// A SOURCE PIN, and its weakness is real: it reads the cron rather than running
// it. Running it would not help — the harness mutes mail, and both sweeps use
// `messageType: 'expired'` deliberately (the two lifecycles are mutually
// exclusive), so the mute line cannot tell them apart either. What is pinned is
// the pairing: which builder sits inside which loop.
{
  const cron = readFileSync('src/pages/api/cron/expire-payments.ts', 'utf8');

  const unpaidLoop = cron.slice(cron.indexOf('for (const row of unpaid)'));
  const staleLoop = cron.slice(cron.indexOf('for (const row of stale)'));
  const unpaidBody = unpaidLoop.slice(0, unpaidLoop.indexOf('\n  }'));
  const staleBody = staleLoop.slice(0, staleLoop.indexOf('\n  }'));

  check(unpaidBody.length > 0 && staleBody.length > 0, 'both sweep loops were located in the source');
  check(
    unpaidBody.includes('paymentExpiredMessage(') && !unpaidBody.includes('expiredRequestMessage('),
    'the PAYMENT sweep sends the payment-expiry copy, and only that',
  );
  check(
    staleBody.includes('expiredRequestMessage(') && !staleBody.includes('paymentExpiredMessage('),
    'the STALE-REQUEST sweep sends the stale-request copy, and only that',
  );
  // Neither may ever reach for the at-capacity decline — a claim about our
  // schedule, false in both of these situations.
  check(
    !cron.includes('declineMessage('),
    'and neither sweep sends the at-capacity decline, which is a claim about our schedule',
  );

  console.log('  the payment sweep and the request sweep do not share a message');
}

// ---------------------------------------------------------------------------
console.log('\nThe office alert for money that needs a human (BK-32)');
// ---------------------------------------------------------------------------
{
  const row = {
    id: 4271,
    name: 'Sam Probe',
    status: 'confirmed' as const,
    slot_start: new Date('2026-08-25T17:30:00.000Z'),
  };
  const alert = paymentAttentionAlert(row, 'DOUBLE PAYMENT: a stripe payment arrived.', new Date());

  check(alert.to === BOOKING_INTERNAL_TO, 'it goes to the office, not the customer');
  check(alert.subject.includes('4271'), 'the subject names the booking, so it is actionable from a phone');

  // ALMOST NO PII, and that is a property rather than an accident: an alert has
  // no use for a policy number, a claim number, a description or an address, and
  // every field omitted is a field that cannot leak.
  const whole = `${alert.html}${alert.text}${alert.subject}`;
  check(!/POL-/.test(whole) && !/CLM-/.test(whole), 'it carries no policy or claim number');
  check(
    !whole.includes(INSURANCE.address),
    'and no street address — an alert does not need one',
  );

  // It names what NOT to do. The office reads this with a customer possibly on
  // the phone, and "refund it" is the obvious reflex.
  check(
    /NOT been refunded|not refunded/i.test(`${alert.html}${alert.text}`) ||
      /refund/i.test(alert.text),
    'it mentions the refund question rather than leaving the office to guess',
  );
}

// ---------------------------------------------------------------------------
console.log('\nThe assessment tier reaches both bodies (BK-31 AC5)');
// ---------------------------------------------------------------------------
// The tier line is what a customer points at in a dispute and what BK-32
// charges from, and nothing asserted it: `assessmentSummary` could have named
// the wrong tier, dropped the weekend suffix or vanished from both templates
// with every gate green.
//
// The figures are SPELLED OUT rather than recomputed with `assessmentQuote`.
// An expectation built by the function under test moves with it — the repo has
// six recorded instances of that family, and this is exactly where a seventh
// would go.
{
  // INSURANCE is standard/water on a Tuesday: $399.00 + 5% = $418.95.
  const plan = planBookingNotifications(INSURANCE);
  for (const [who, body] of [
    ['customer', plan.customer?.html ?? ''],
    ['customer text', plan.customer?.text ?? ''],
    ['office', plan.internal.html],
  ] as const) {
    check(
      body.includes('On-site assessment'),
      `the ${who} body names the tier`,
    );
    check(body.includes('$399.00'), `the ${who} body states the base $399.00`);
    check(body.includes('$418.95'), `the ${who} body states the $418.95 total`);
    check(
      !body.includes('weekend rate'),
      `the ${who} body does NOT claim a weekend rate for a Tuesday slot`,
    );
  }

  // A weekend mould booking is the case every hand-written figure gets wrong:
  // the override ($385.00) and the 1.5x both apply. 38500 * 3 / 2 = 57750,
  // + 5% = 60638 (rounded once, at the end).
  const weekendMould = planBookingNotifications({
    ...INSURANCE,
    service: 'mold',
    // 2026-08-15 is a Saturday in Edmonton. Asserted as a local-calendar fact
    // by verify:booking:pricing; used here only to reach the branch.
    slotStart: new Date('2026-08-15T19:30:00.000Z'),
  });
  const mouldBody = weekendMould.customer?.html ?? '';
  check(mouldBody.includes('$577.50'), 'a weekend mould booking states the multiplied base $577.50');
  check(mouldBody.includes('$606.38'), 'and the $606.38 total');
  check(
    mouldBody.includes('weekend rate'),
    'and says WHY it is higher — an unexplained 1.5x reads as an error or as sharp practice',
  );
  check(
    !mouldBody.includes('$399.00'),
    'and does not also carry the standard figure it replaced',
  );

  // The phone-booking fallback. A NULL tier is permanent for admin entries, so
  // the line must degrade to prose rather than to "undefined" or a $0 total.
  const noTier = planBookingNotifications({ ...INSURANCE, assessmentTier: null });
  check(
    noTier.internal.html.includes('Not chosen'),
    'a NULL tier renders as "Not chosen" on the office copy, not as a price',
  );
  check(
    !/undefined|NaN|\$0\.00/.test(noTier.internal.html),
    'and never as undefined, NaN or $0.00',
  );
}

// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n✗ ${failures} check${failures === 1 ? '' : 's'} failed\n`);
  process.exit(1);
}
console.log('\n✓ booking notification checks passed\n');
