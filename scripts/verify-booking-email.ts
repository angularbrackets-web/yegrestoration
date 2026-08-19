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
  FEE_TERMS_HEADING,
  FEE_TERMS_INTRO,
  FEE_TERMS_ITEMS,
  FEE_TERMS_OUTRO,
  HAVE_READY_ITEMS,
  TIMEZONE_NOTE,
  VISIT_LENGTH_LINE,
} from '../src/lib/booking-copy';
import {
  escapeHtml,
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

    // BK-27: the fee terms are echoed back to the customer in the message they
    // keep. Asserted against the CONSTANTS, not retyped prose, so the client's
    // pending wording sign-off does not turn this gate red — paired with the
    // figure assertions below, which are what stop the prices vanishing.
    for (const line of [
      FEE_TERMS_HEADING,
      FEE_TERMS_INTRO,
      ...FEE_TERMS_ITEMS,
      ...FEE_TERMS_OUTRO,
    ]) {
      const needle = part === 'html' ? escapeHtml(line) : line;
      check(body.includes(needle), `the ${part} part carries the fee terms: "${line.slice(0, 28)}…"`);
    }
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

  // The two terms attached to those figures, asserted on the whole block rather
  // than on ITEMS — the credit lives in the intro and the refund rule in the
  // outro, and both would survive every assertion above while being deleted.
  //
  // The four terms the client settled on 2026-08-14, each asserted on the joined
  // constants. Every other terms assertion compares the email to whatever the
  // constants currently say, precisely so a client wording edit does not redden
  // the gate. THESE FOUR ARE THE EXCEPTIONS, for the same reason GST is one:
  // they are the substance of what the customer ticks a box to accept. A
  // substantive reword of one of them SHOULD stop the build and get a human
  // look. That is the trade, and it is the opposite of the trade made above.
  //
  // MATCHED ON POLARITY, NOT ON PRESENCE — this is the correction that matters.
  // The first version of the refund check was `/refund/i`, which is satisfied by
  // "It is FULLY REFUNDABLE if you decide not to go ahead" — the exact negation
  // of the client's decision. A review proved it by writing that sentence and
  // watching every gate stay green. Its red row had only ever DELETED the word,
  // which demonstrates the weaker "something mentioning refunds exists"
  // property while reading like the stronger one. Same defect the earlier review
  // found in the `showForm` pin, in a different costume.
  //
  // So each check names the accepted PHRASINGS of the correct claim, and the
  // credit check additionally refuses a negated one. Alternations, not exact
  // sentences, so "no refunds" or "we deduct it from your invoice" still pass.
  const terms = [FEE_TERMS_INTRO, ...FEE_TERMS_ITEMS, ...FEE_TERMS_OUTRO].join(' ');
  check(
    /(?:credited?|comes? off|deducted?)/i.test(terms) &&
      /invoice/i.test(terms) &&
      !/(?:not|never|non|no longer|don't|doesn't|won't)\s+\w*\s*(?:credit|deduct)/i.test(terms),
    'and that the fee comes back off the final invoice — stated, and not negated',
  );
  check(
    /(?:not refundable|non-?refundable|no refunds?|isn't refundable)/i.test(terms),
    'and that it is NOT refundable otherwise — the term most likely to be disputed, so it is disclosed where the box is ticked',
  );
  // The other two disclosures the revision named as material and then did not
  // assert. Both were deletable with every gate green until now: the payment
  // timing is the answer to the previous review's most material open question
  // (when does the charge land?), and "nothing is charged when you book" is what
  // stops a visitor ticking a box beside "$1,199" believing the next button
  // bills them.
  // ANCHORED TO THE PAYMENT VERB. The first version matched a bare
  // `on the day`, which the outro's "Tell the tech on the day which of these
  // you want" satisfies — a sentence about choosing a TIER, not about when
  // money changes hands. Deleting "paid at the end of the visit" left this
  // green. Caught on its own red pass; the timing phrase has to sit within a
  // clause of the paying for it to mean anything.
  check(
    /pa(?:id|y|yable|ying)\b[^.]{0,40}(?:end of the visit|at the visit|on site|on the day)/i.test(terms),
    'and WHEN the fee is payable, which is what the customer is agreeing to',
  );
  check(
    /(?:nothing is charged|not charged|no charge|nothing to pay)/i.test(terms),
    'and that nothing is charged at booking time — the site never takes money',
  );
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

  const ok = await sendBookingNotifications(plan, { send: sent });
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
  await sendBookingNotifications(plan, {
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

  const bad = await sendBookingNotifications(plan, { send: failed });
  check(
    bad.customer === 'failed' && bad.internal === 'failed',
    'a resolved error response is reported as failed, never as sent',
  );

  const thrown = await sendBookingNotifications(plan, { send: threw });
  check(
    thrown.customer === 'failed' && thrown.internal === 'failed',
    'a throwing sender is caught rather than escaping into the route',
  );

  const skipped = await sendBookingNotifications(noEmailPlan, { send: sent });
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
    const outcome = await sendBookingNotifications(plan, {
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
  await sendBookingNotifications(plan, { send: slowCustomer });
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

  check(await notifyAndStamp(plan, { send: sent, stamp: record }), 'a sent confirmation reports true');
  check(
    seen.length === 1 && seen[0].customer === true && seen[0].internal === true,
    'and the stamp is told what actually sent',
  );

  check(
    !(await notifyAndStamp(plan, { send: failed, stamp: record })),
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
    await notifyAndStamp(plan, { send: sent, stamp: throwingStamp }),
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

  // AC1 — every transition gets its own prefix, and the same one twice.
  const prefixes = ALL_TYPES.map((t) => notifyIdempotencyPrefix(7, t));
  check(
    new Set(prefixes).size === ALL_TYPES.length,
    `all ${ALL_TYPES.length} message types produce distinct prefixes`,
  );
  check(
    notifyIdempotencyPrefix(7, 'payment-link') === notifyIdempotencyPrefix(7, 'payment-link'),
    'the same (id, type) is stable — a retry still collapses',
  );
  check(
    notifyIdempotencyPrefix(7, 'confirmed') !== notifyIdempotencyPrefix(8, 'confirmed'),
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

  const oneAddress = { ...INSURANCE, id: 991, email: 'same@example.com' };
  await sendBookingNotifications(
    planBookingNotifications({ ...oneAddress, messageType: 'request' }),
    { send: recordingSend },
  );
  await sendBookingNotifications(
    planBookingNotifications({ ...oneAddress, messageType: 'payment-link' }),
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

  // AC3 — the dedupe the key exists for still works inside one transition.
  seen.length = 0;
  const retried = planBookingNotifications({ ...oneAddress, messageType: 'payment-link' });
  await sendBookingNotifications(retried, { send: recordingSend });
  await sendBookingNotifications(retried, { send: recordingSend });
  const retryKeys = seen.filter((k) => k.endsWith(':same@example.com'));
  check(
    retryKeys.length === 2 && new Set(retryKeys).size === 1,
    'a retry of the SAME transition reuses one key — Resend still collapses it',
  );

  // AC4 — source pin. The defect is a template literal at a call site, and it
  // would pass every behavioural check above if someone reintroduced it for
  // one of the three senders. Same pattern verify-booking-ics.ts uses for the
  // attachment whitelist, and for the same reason: the fake sender cannot see
  // what the real one would have done.
  const notifySrc = readFileSync('src/lib/booking-notify.ts', 'utf8');
  check(
    !/createResendSender\([^)]*`booking-\$\{/.test(notifySrc),
    'no send site builds a prefix from a template literal — notifyIdempotencyPrefix is the only source',
  );
  check(
    (notifySrc.match(/notifyIdempotencyPrefix\(/g) ?? []).length >= 3,
    'both notification senders and the declaration all go through notifyIdempotencyPrefix',
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
