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
import { HAVE_READY_ITEMS, TIMEZONE_NOTE, VISIT_LENGTH_LINE } from '../src/lib/booking-copy';
import {
  escapeHtml,
  headerSafe,
  planBookingNotifications,
  type BookingNotificationInput,
  type Message,
} from '../src/lib/booking-email';
import {
  notifyAndStamp,
  sendBookingNotifications,
  withDeadline,
  type SendResult,
} from '../src/lib/booking-notify';

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

const INSURANCE: BookingNotificationInput = {
  id: 481,
  slotLabel: 'Tue, Aug 12 · 1:30 p.m.',
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

/** Every string a message carries — subject and addresses included, not just the bodies. */
function allText(message: Message): string {
  return [message.from, message.to, message.replyTo ?? '', message.subject, message.html, message.text].join(
    '\n',
  );
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
  }
  check(customer.subject.includes(INSURANCE.slotLabel), 'the subject carries the slot label');
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
  check(plan.internal.replyTo === undefined, 'with no reply-to, since there is nobody to reply to');
  check(plan.internal.text.includes('—'), 'and the email field reads as absent');
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
    const outcome = await sendBookingNotifications(plan, { send: sent });
    const muted = outcome.internal === 'skipped';
    check(
      muted === expected,
      `BOOKING_NOTIFY_DISABLED=${JSON.stringify(value)} must ${expected ? 'mute' : 'not mute'}`,
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
if (failures > 0) {
  console.error(`\n✗ ${failures} check${failures === 1 ? '' : 's'} failed\n`);
  process.exit(1);
}
console.log('\n✓ booking notification checks passed\n');
