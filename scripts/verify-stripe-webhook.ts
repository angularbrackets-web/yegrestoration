// BK-32 — the Stripe half: the Checkout Session, `markPaid()`'s branches, and
// the one thing about this feature that cannot be checked any other way.
//
//   npm run verify:stripe:webhook
//
// No Stripe key, no network, no database. Every external call goes through the
// injected `StripeDeps` gateway, which is the only reason the amount check, the
// idempotency key and the expiry clamp are observable at all.
//
// THE npm SCRIPT BUILDS FIRST, and that is not incidental. The last block reads
// the generated `.vercel/output/config.json` and simulates the deployed route
// table against the real webhook URL, because a webhook is UNSMOKABLE under
// `astro dev` by definition — Stripe cannot post to a laptop — and the failure
// mode it guards is invisible everywhere else. See that block, and the Known
// trap in `/CLAUDE.md`.

import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

import {
  checkoutCancelUrl,
  checkoutSuccessUrl,
  stripeWebhookUrl,
  GST_REGISTRATION_NUMBER,
  PAYMENT_DEADLINE_LEAD_HOURS,
  PAYMENT_WINDOW_HOURS,
  PAY_NOW_THRESHOLD_HOURS,
  STRIPE_SESSION_QUERY_PARAM,
  STRIPE_WEBHOOK_PATH,
  CHECKOUT_BUDGET_MS,
  POST_COMMIT_BUDGET_MS,
} from '../src/lib/booking-config';
import {
  checkoutExpiresAt,
  checkoutIdempotencyKey,
  createCheckoutSession,
  expireCheckoutSession,
  type CheckoutRequest,
  type StripeGateway,
} from '../src/lib/booking-payment';
import { ADMIN_APPOINTMENT_MARK_PAID_ENDPOINT } from '../src/lib/booking-admin';
import { paymentDeadline } from '../src/lib/booking-review';
import { plannedAction } from '../src/pages/api/stripe/webhook';

let failures = 0;
function check(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    failures++;
  }
}

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-08-20T15:00:00.000Z');
const SLOT = new Date('2026-08-25T17:30:00.000Z');
const ORIGIN = 'https://yegrestoration.ca';

const BASE: CheckoutRequest = {
  appointmentId: 4271,
  tier: 'standard',
  baseCents: 39900,
  travelCents: 0,
  gstCents: 1995,
  totalCents: 41895,
  dueAt: new Date(NOW.getTime() + 12 * HOUR),
  slotStart: SLOT,
  approvedAt: NOW,
  customerEmail: 'customer@example.com',
  now: NOW,
  origin: ORIGIN,
};

/** A gateway that records what it was asked for and answers however told to. */
function fakeGateway(options: {
  amountTotal?: number | null;
  url?: string | null;
  createThrows?: Error;
  expireThrows?: Error;
  /** What `retrieve` reports when `expire` errored — how 'already-inactive' is reached. */
  statusAfterExpireError?: string;
} = {}) {
  const created: { params: any; idempotencyKey: string }[] = [];
  const expired: string[] = [];
  const gateway: StripeGateway = {
    createSession: async (params, idempotencyKey) => {
      created.push({ params, idempotencyKey });
      if (options.createThrows) throw options.createThrows;
      const lineTotal = (params.line_items ?? []).reduce(
        (sum: number, item: any) => sum + (item.price_data?.unit_amount ?? 0) * (item.quantity ?? 1),
        0,
      );
      return {
        id: 'cs_test_a1b2c3d4e5f6g7h8',
        url: options.url === undefined ? 'https://checkout.stripe.com/c/pay/cs_test_a1' : options.url,
        amount_total: options.amountTotal === undefined ? lineTotal : options.amountTotal,
      };
    },
    expireSession: async (id) => {
      expired.push(id);
      if (options.expireThrows) throw options.expireThrows;
    },
    sessionStatus: async () => options.statusAfterExpireError ?? null,
  };
  return { gateway, created, expired };
}

// ---------------------------------------------------------------------------
console.log('\nThe session is built from the amounts it was handed');
// ---------------------------------------------------------------------------
{
  const { gateway, created } = fakeGateway();
  const session = await createCheckoutSession(BASE, { gateway });

  check(session?.sessionId === 'cs_test_a1b2c3d4e5f6g7h8', 'the session id comes back to be stored');
  check(session?.url?.startsWith('https://checkout.stripe.com/') === true, 'so does the URL');

  const params = created[0].params;
  check(params.mode === 'payment', "mode is 'payment', not a subscription");
  check(params.currency === 'cad', 'currency is CAD');
  check(params.client_reference_id === '4271', 'client_reference_id is the appointment id');
  check(params.metadata.appointment_id === '4271', 'and metadata carries it too, as the twin');
  check(params.metadata.tier === 'standard', 'metadata carries the tier');
  check(params.customer_email === 'customer@example.com', 'the customer gets a Stripe receipt');

  // A ZERO TRAVEL FEE RENDERS NO LINE. A $0.00 line item invites the question
  // of what it might have been.
  check(params.line_items.length === 2, 'a zero travel fee renders TWO lines, not a $0.00 third');
  check(params.line_items[0].price_data.unit_amount === 39900, 'the assessment line is the base');
  check(params.line_items[1].price_data.unit_amount === 1995, 'and GST is its OWN line item');
  check(
    params.line_items.every((i: any) => i.quantity === 1 && i.price_data.currency === 'cad'),
    'every line is one unit of CAD',
  );

  const travelling = fakeGateway();
  const withTravel = await createCheckoutSession(
    { ...BASE, travelCents: 5000, gstCents: 2245, totalCents: 47145 },
    { gateway: travelling.gateway },
  );
  check(withTravel !== null, 'a non-zero travel fee still mints a session');
  const travelLines = travelling.created[0].params.line_items;
  check(travelLines.length === 3, 'and renders THREE lines when it is non-zero');
  check(
    travelLines[1].price_data.unit_amount === 5000,
    'with travel in the middle, between the assessment and GST',
  );
  check(
    travelLines[2].price_data.unit_amount === 2245,
    'and GST last, computed on base + travel rather than on the base alone',
  );

  // ── THE NAMES, WHICH NOTHING PINNED UNTIL BK-48 ─────────────────────────
  //
  // Every assertion above is about MONEY, and every one of them was green while
  // the receipt carried no GST registration number — because the receipt is
  // made of the NAMES, and no assertion had ever read one. The money was
  // covered and the document was not.
  //
  // Asserted against the imported constant, never a repeated literal: two
  // spellings of a tax registration number is exactly how one of them ends up
  // wrong on a customer's receipt.
  // PINNED WHOLE, NOT BY `.includes`, and implementation review is why. The
  // first version asked only whether the registrant appeared somewhere in the
  // name — so renaming the line to a bare `Reg. 775654577RT0001` left every
  // gate green and would have put a registration number and an amount on the
  // receipt with nothing saying the amount was TAX. On a document whose whole
  // purpose is to let an accountant identify the tax, that is worse than the
  // omission this ticket fixed.
  //
  // The other two names are pinned with `===` and the one this ticket changed
  // was not, which is the wrong way round.
  check(
    travelLines[2].price_data.product_data.name ===
      `GST (5%) — Reg. ${GST_REGISTRATION_NUMBER}`,
    'the GST line names the tax AND the registrant — this is the field the receipt renders',
  );
  check(
    travelLines[2].price_data.product_data.description === 'Goods and services tax',
    'and its description is unchanged — moving the number there is a guess the receipt disproved',
  );
  check(
    travelLines[0].price_data.product_data.name === 'On-site restoration assessment',
    'the assessment line is named for what was sold',
  );
  check(
    travelLines[1].price_data.product_data.name === 'Travel',
    'and the travel line for what it is',
  );

  console.log('  three line items at most, GST always its own, travel only when real');
}

// ---------------------------------------------------------------------------
console.log('\nThe amount check that can actually fail');
// ---------------------------------------------------------------------------
//
// `base + travel + gst === total` is a TAUTOLOGY on the production path: the
// approve route writes all four columns in one statement from each other, so
// both sides of that comparison move together and it cannot fail on anything a
// customer could be charged. This repo has caught seven assertions of exactly
// that shape. It is still checked — against a hand-assembled request, where it
// CAN fail — but it is not what defends the invariant.
//
// What defends it is Stripe's echo: `amount_total` is what Stripe will really
// charge, computed by Stripe from the line items we sent.
{
  let threw = false;
  try {
    // Hand-assembled: the itemisation does not sum. Only reachable by a caller
    // building the request itself, which is why this arm is not theatre.
    await createCheckoutSession({ ...BASE, gstCents: 1 }, { gateway: fakeGateway().gateway });
  } catch {
    threw = true;
  }
  check(threw, 'an itemisation that does not sum to the total is refused before any network call');

  // THE ONE THAT MATTERS. Stripe says it would charge something else.
  const mismatch = fakeGateway({ amountTotal: 99999 });
  let echoed = false;
  try {
    await createCheckoutSession(BASE, { gateway: mismatch.gateway });
  } catch {
    echoed = true;
  }
  check(echoed, "a session Stripe would charge a DIFFERENT amount for is refused");
  check(
    mismatch.expired.includes('cs_test_a1b2c3d4e5f6g7h8'),
    'and that session is expired immediately — never left live at the wrong price',
  );

  let zero = false;
  try {
    await createCheckoutSession(
      { ...BASE, baseCents: 0, travelCents: 0, gstCents: 0, totalCents: 0 },
      { gateway: fakeGateway().gateway },
    );
  } catch {
    zero = true;
  }
  check(zero, 'a $0.00 total never opens a Checkout Session');

  const noUrl = fakeGateway({ url: null });
  let urlless = false;
  try {
    await createCheckoutSession(BASE, { gateway: noUrl.gateway });
  } catch {
    urlless = true;
  }
  check(urlless, 'a session with no URL is an error, not a link the customer cannot open');

  console.log("  Stripe's echo is the check; the arithmetic identity is not");
}

// ---------------------------------------------------------------------------
console.log('\nExpiring a session: three answers, not two');
// ---------------------------------------------------------------------------
//
// The first version returned a boolean, and collapsing "already closed" into
// "failed" was wrong on the ORDINARY path rather than on an edge. On the
// deferred branch `expires_at` equals `payment_due_at` exactly, so by the time
// the payment sweep sees an overdue row Stripe has already closed its session
// and `/expire` errors — which made the cron email the office about links
// "still payable" on essentially every lapsed booking, and made the approve
// route abort a re-approval on the normal path. Both are the crying-wolf
// failure this ticket refuses everywhere else.
{
  const clean = fakeGateway();
  check(
    (await expireCheckoutSession('cs_test_open00000001', { gateway: clean.gateway })) === 'expired',
    'a session that was open reports expired',
  );
  check(clean.expired.includes('cs_test_open00000001'), 'and Stripe was actually asked');

  // Stripe refuses, and the session turns out to have been closed already.
  const closed = fakeGateway({
    expireThrows: new Error('You may only expire a session that is in the open state'),
    statusAfterExpireError: 'expired',
  });
  check(
    (await expireCheckoutSession('cs_test_closed0000001', { gateway: closed.gateway })) ===
      'already-inactive',
    'a session Stripe had already closed is NOT a failure — this is the sweep’s ordinary case',
  );
  const completed = fakeGateway({
    expireThrows: new Error('nope'),
    statusAfterExpireError: 'complete',
  });
  check(
    (await expireCheckoutSession('cs_test_paid00000001', { gateway: completed.gateway })) ===
      'already-inactive',
    'and neither is one that was already paid',
  );

  // Stripe refuses AND the session is still open, or cannot be read at all.
  const stillOpen = fakeGateway({
    expireThrows: new Error('service unavailable'),
    statusAfterExpireError: 'open',
  });
  check(
    (await expireCheckoutSession('cs_test_live00000001', { gateway: stillOpen.gateway })) ===
      'failed',
    'a session that is STILL OPEN after a refused expire is a real failure',
  );
  const unreadable = fakeGateway({ expireThrows: new Error('down') });
  check(
    (await expireCheckoutSession('cs_test_unknown00001', { gateway: unreadable.gateway })) ===
      'failed',
    'and so is one whose status cannot be read — the safe answer when we do not know',
  );

  console.log('  already-closed is not a failure; still-open is');
}

// ---------------------------------------------------------------------------
console.log('\nNo gateway configured');
// ---------------------------------------------------------------------------
{
  const before = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  const none = await createCheckoutSession(BASE);
  check(none === null, 'with no key, createCheckoutSession returns null rather than throwing');
  if (before !== undefined) process.env.STRIPE_SECRET_KEY = before;
  console.log('  null is a supported answer — the approval offers Interac alone');
}

// ---------------------------------------------------------------------------
console.log('\nThe idempotency key, and why it names approved_at');
// ---------------------------------------------------------------------------
{
  const key = checkoutIdempotencyKey(4271, NOW);
  check(key === `appointment-4271-approval-${Math.floor(NOW.getTime() / 1000)}`, 'the shape is the ticket’s');
  check(
    checkoutIdempotencyKey(4271, NOW) === checkoutIdempotencyKey(4271, new Date(NOW)),
    'one approval always produces one key — a retried POST reuses the session',
  );
  // A booking sent back to `pending_review` and approved again is a DIFFERENT
  // approval, possibly at a different amount. It must mint a new session rather
  // than resurrect the old one at the old price.
  check(
    checkoutIdempotencyKey(4271, NOW) !== checkoutIdempotencyKey(4271, new Date(NOW.getTime() + 1000)),
    'a RE-approval is a different key — a corrected amount is not silently reused',
  );
  check(
    checkoutIdempotencyKey(4271, NOW) !== checkoutIdempotencyKey(4272, NOW),
    'two bookings never share one',
  );

  const { gateway, created } = fakeGateway();
  await createCheckoutSession(BASE, { gateway });
  check(
    created[0].idempotencyKey === checkoutIdempotencyKey(4271, NOW),
    'and the session is actually created under it, not merely able to be',
  );

  console.log('  keyed on the STORED approved_at, which is why the transition runs first');
}

// ---------------------------------------------------------------------------
console.log('\nexpires_at, and the relationship that keeps it honest');
// ---------------------------------------------------------------------------
{
  const MIN = 30 * 60_000;
  const MAX = 24 * HOUR;

  // ── THE DEFERRED BRANCH NEVER REACHES EITHER BOUND ───────────────────────
  //
  // Asserted as a RELATIONSHIP between three constants rather than as an
  // observation about today's numbers. If somebody raises PAYMENT_WINDOW_HOURS
  // past 24, a link would start dying before the deadline the customer was
  // given — silently, and only for the longest windows.
  check(
    PAYMENT_WINDOW_HOURS * HOUR <= MAX,
    `PAYMENT_WINDOW_HOURS (${PAYMENT_WINDOW_HOURS}) must fit inside Stripe's 24h ceiling`,
  );
  check(
    PAYMENT_DEADLINE_LEAD_HOURS < PAY_NOW_THRESHOLD_HOURS,
    'and the pay-now threshold must sit above the lead time, or a deferred deadline could be in the past',
  );

  // Every hour of the 14-day window: a deferred deadline is `expires_at`
  // exactly. Neither clamp bound is ever reached, so no customer is ever handed
  // a link that dies before the date printed in their email.
  let drifted = 0;
  for (let h = PAY_NOW_THRESHOLD_HOURS; h < 14 * 24; h++) {
    const slot = new Date(NOW.getTime() + h * HOUR);
    const deadline = paymentDeadline(slot, NOW);
    if (deadline.dueAt === null) continue;
    const expires = checkoutExpiresAt(deadline.dueAt, slot, NOW);
    if (expires.getTime() !== deadline.dueAt.getTime()) drifted++;
  }
  check(drifted === 0, `expires_at equals payment_due_at on every deferred hour (drifted ${drifted})`);

  // The pay-now branch clamps to the slot instead, and the floor is what stops
  // Stripe rejecting a session that would expire in under 30 minutes.
  const soon = new Date(NOW.getTime() + 10 * 60_000);
  const paynow = checkoutExpiresAt(null, soon, NOW);
  check(
    paynow.getTime() === NOW.getTime() + MIN,
    'a slot under 30 minutes away is floored to Stripe’s minimum — the link outlives the visit, deliberately',
  );
  const later = new Date(NOW.getTime() + 6 * HOUR);
  check(
    checkoutExpiresAt(null, later, NOW).getTime() === later.getTime(),
    'and an ordinary pay-now slot expires with the slot',
  );
  const distant = new Date(NOW.getTime() + 40 * HOUR);
  check(
    checkoutExpiresAt(distant, distant, NOW).getTime() === NOW.getTime() + MAX,
    'anything past 24h is capped there — our own cron owns expiry beyond it',
  );

  console.log('  the deferred branch never clamps; the pay-now branch always does');
}

// ---------------------------------------------------------------------------
console.log('\nThe two budgets do not stack past the platform limit');
// ---------------------------------------------------------------------------
{
  // The approve route now runs a Stripe call and a mail send in sequence, each
  // under its own race. `booking-config.ts` records that nothing in this repo
  // raises the function limit, so the lowest documented Vercel default applies
  // and a stacked pair returns a 504 for an approval that already committed.
  check(
    CHECKOUT_BUDGET_MS < POST_COMMIT_BUDGET_MS,
    'the Stripe budget is the smaller of the two',
  );
  check(
    CHECKOUT_BUDGET_MS + POST_COMMIT_BUDGET_MS < 10_000,
    `the two budgets together (${CHECKOUT_BUDGET_MS + POST_COMMIT_BUDGET_MS}ms) must clear Vercel's 10s default`,
  );
  console.log('  3s + 5s, with headroom for the row read and two UPDATEs');
}

// ---------------------------------------------------------------------------
console.log('\nThe URLs Stripe is given');
// ---------------------------------------------------------------------------
{
  const success = checkoutSuccessUrl(ORIGIN);
  const cancel = checkoutCancelUrl(ORIGIN);

  check(success.startsWith('https://'), 'the success URL is ABSOLUTE — Stripe redirects from its own domain');
  check(cancel.startsWith('https://'), 'and so is the cancel URL');
  check(
    success.includes('/book/confirmed/?'),
    'the success URL is SLASHED — the unslashed form would eat a 308 on every payment',
  );
  check(cancel.endsWith('/book/payment-cancelled/'), 'the cancel URL is slashed too');
  check(
    success.includes(`${STRIPE_SESSION_QUERY_PARAM}={CHECKOUT_SESSION_ID}`),
    "Stripe's placeholder is passed RAW — percent-encoding it hands the customer back the literal braces",
  );
  check(
    !success.includes('%7B'),
    'and it is demonstrably not encoded',
  );

  const { gateway, created } = fakeGateway();
  await createCheckoutSession(BASE, { gateway });
  check(created[0].params.success_url === success, 'the session uses the builder, not a literal');
  check(created[0].params.cancel_url === cancel, 'for both URLs');

  console.log('  absolute, slashed, and the placeholder survives');
}

// ---------------------------------------------------------------------------
console.log('\nThe deployed route table — the check astro dev cannot make');
// ---------------------------------------------------------------------------
//
// A WEBHOOK IS UNSMOKABLE IN DEVELOPMENT BY DEFINITION: Stripe cannot post to a
// laptop, so there is no dev-server test that proves anything about this URL.
// And `trailingSlash: 'always'` makes Vercel answer 308 to the unslashed form —
// which a browser follows and **Stripe does not**. Registered one character
// short, every payment event would fail, silently, in production only, and the
// first symptom would be customers who paid and were never confirmed.
//
// So the generated table is simulated, exactly as `verify-appointment-upload.ts`
// does for BK-34a's upload links after that feature shipped to review with
// 100% of its URLs 404ing. See the Known trap in `/CLAUDE.md`.
{
  const configPath = resolve(root, '.vercel/output/config.json');
  if (!existsSync(configPath)) {
    console.error(`  ✗ ${configPath} is missing — run \`npm run build\` before this suite`);
    failures++;
  } else {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      routes: {
        src?: string;
        status?: number;
        headers?: { Location?: string };
        handle?: string;
        dest?: string;
      }[];
    };

    /** Walk the pre-filesystem phase the way Vercel does, following redirects. */
    function resolvePath(start: string): { path: string; hops: string[] } {
      let path = start;
      const hops: string[] = [];
      for (const route of config.routes) {
        if (route.handle) break;
        if (!route.src) continue;
        const re = new RegExp(route.src);
        if (!re.test(path)) continue;
        if (route.status && route.headers?.Location) {
          path = path.replace(re, route.headers.Location);
          hops.push(`${route.status} → ${path}`);
        }
      }
      return { path, hops };
    }

    function servedBy(path: string): string | null {
      const route = config.routes.find(
        (r) => !r.handle && r.src && r.dest && new RegExp(r.src).test(path),
      );
      return route?.dest ?? null;
    }

    // The URL the rollout note tells the user to paste, built from the same
    // constant the route resolves to — so the note and the route cannot drift.
    const registered = new URL(stripeWebhookUrl(ORIGIN));
    check(
      registered.pathname === STRIPE_WEBHOOK_PATH,
      'the URL in the rollout note is the route’s own path, not a second spelling',
    );

    const slashed = resolvePath(registered.pathname);
    check(
      slashed.hops.length === 0,
      `the SLASHED webhook path survives the pre-filesystem phase with no redirect${
        slashed.hops.length ? ` (got ${slashed.hops.join(', ')})` : ''
      }`,
    );
    check(
      servedBy(slashed.path) === '_render',
      `and reaches the SSR function (matched ${JSON.stringify(servedBy(slashed.path))})`,
    );

    // ── THE CONTROL, AND IT IS NOT DECORATION ────────────────────────────
    //
    // The unslashed form MUST 308. Two things follow. First, it is the reason
    // the rollout note has to record the slashed URL — a 308 is fatal here
    // because Stripe does not follow redirects. Second, and this is why it sits
    // here rather than in a comment: this assertion and the one above it cannot
    // BOTH pass unless the simulation is really executing. A no-op `resolvePath`
    // returns zero hops for everything, which satisfies the check above and
    // fails this one. A probe on which everything passes is not evidence.
    const unslashed = resolvePath(STRIPE_WEBHOOK_PATH.replace(/\/$/, ''));
    check(
      unslashed.hops.length > 0,
      'CONTROL: the UNSLASHED webhook path DOES redirect — which is why the slashed one must be registered',
    );
    check(
      unslashed.hops.some((h) => h.startsWith('308')),
      'and it is a 308, the status Stripe will not follow',
    );

    // The dot-stripping rule that killed BK-34a cannot apply here — no segment
    // of this path contains a dot — but it is asserted rather than assumed,
    // because the next person to move this route may not know that.
    const dotStripper = config.routes.find(
      (r) => r.status === 308 && r.src?.includes('\\.\\w+') && !r.handle,
    );
    check(dotStripper !== undefined, 'the trailing-slash-stripping 308 is still in the table');
    if (dotStripper?.src) {
      check(
        !new RegExp(dotStripper.src).test(STRIPE_WEBHOOK_PATH),
        'and the webhook path does not match it — no dot in any segment',
      );
    }

    // The success URL is a real page on the same table. A payment that lands on
    // a 404 is a customer who paid and was told nothing.
    const successPath = new URL(checkoutSuccessUrl(ORIGIN)).pathname;
    const successHops = resolvePath(successPath);
    check(successHops.hops.length === 0, 'the success URL resolves without a redirect too');
    check(
      servedBy(successHops.path) !== null,
      `and something serves it (matched ${JSON.stringify(servedBy(successHops.path))})`,
    );

    const cancelPath = new URL(checkoutCancelUrl(ORIGIN)).pathname;
    const cancelHops = resolvePath(cancelPath);
    check(cancelHops.hops.length === 0, 'the cancel URL resolves without a redirect');
    check(
      servedBy(cancelHops.path) !== null,
      `and something serves it (matched ${JSON.stringify(servedBy(cancelHops.path))})`,
    );

    // The admin action is a new POST endpoint, and the ROADMAP records a trap
    // about those: `/api/admin/files/delete/` would have collided with the
    // dynamic `[id].ts` beside it and generated NO route at all.
    // Reads the ENDPOINT CONSTANT the admin form posts to, not a literal — the
    // independent thing being checked is the generated route table, which comes
    // from the filesystem. A literal here would keep passing while the form
    // posted somewhere with no route at all, which is precisely the trap.
    const markPaid = resolvePath(new URL(ADMIN_APPOINTMENT_MARK_PAID_ENDPOINT, ORIGIN).pathname);
    check(markPaid.hops.length === 0, 'the mark-as-paid endpoint resolves without a redirect');
    // ── `dest === '_render'` IS NOT ENOUGH, AND FINDING THAT OUT IS THE POINT ─
    //
    // Driving this break — pointing the endpoint at `/api/admin/files/mark-paid/`
    // — left a `_render` check GREEN, because the DYNAMIC SIBLING
    // `api/admin/files/[id].ts` generates `^/api/admin/files/([^/]+?)/$`, which
    // matches that path and renders. That is the ROADMAP's trap exactly: the URL
    // resolves, to the wrong handler, and the POST reaches a proxy that only
    // exports GET. So the assertion has to name WHICH route serves it — the
    // endpoint's own literal pattern, not something that merely happens to match.
    const markPaidRoute = config.routes.find(
      (r) => !r.handle && r.src && r.dest && new RegExp(r.src).test(markPaid.path),
    );
    check(
      markPaidRoute?.dest === '_render',
      `and reaches the SSR function (matched ${JSON.stringify(markPaidRoute?.dest ?? null)})`,
    );
    check(
      markPaidRoute?.src?.includes('mark\\-paid') === true ||
        markPaidRoute?.src?.includes('mark-paid') === true,
      `by its OWN route, not a dynamic sibling that happens to match (src ${JSON.stringify(
        markPaidRoute?.src ?? null,
      )})`,
    );

    console.log('  the slashed webhook resolves; the unslashed one 308s, as the control');
  }
}

// ---------------------------------------------------------------------------
console.log('\nThe webhook stays outside the admin middleware');
// ---------------------------------------------------------------------------
//
// Not a behavioural check — a SOURCE pin, because the regression it guards is a
// well-meant tidy-up rather than a bug. Somebody notices an unauthenticated
// POST endpoint and adds it to the gated prefixes; every payment confirmation
// then 401s in production and nothing else changes. Stripe authenticates with a
// signature over the body, not with a cookie it does not have.
{
  const middleware = readFileSync(resolve(root, 'src/middleware.ts'), 'utf8');
  const prefixes = middleware.match(/pathname\.startsWith\('([^']+)'\)/g) ?? [];
  check(prefixes.length === 2, `the middleware gates exactly two prefixes (found ${prefixes.length})`);
  check(
    prefixes.every((p) => p.includes("'/admin'") || p.includes("'/api/admin'")),
    'and they are /admin and /api/admin — nothing else',
  );
  check(
    !STRIPE_WEBHOOK_PATH.startsWith('/admin') && !STRIPE_WEBHOOK_PATH.startsWith('/api/admin'),
    'so the webhook path is outside both, and must stay outside',
  );

  const webhookSrc = readFileSync(resolve(root, 'src/pages/api/stripe/webhook.ts'), 'utf8');
  // COMMENTS STRIPPED BEFORE ANY OF THIS IS MATCHED, and the first run of this
  // block is why. The file's own header explains that it never calls
  // `request.json()` — so the pin asserting that fired on the sentence saying
  // it. A source pin that reads prose is a pin that fails on documentation and
  // passes on code, which is the wrong way round.
  const webhook = webhookSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  // THE RAW BODY. `request.json()` re-serialises, which changes the bytes that
  // were signed and breaks every signature — in production only.
  check(
    /await request\.text\(\)/.test(webhook),
    'the webhook reads the RAW body with request.text()',
  );
  check(
    !/request\.json\(\)/.test(webhook),
    'and never calls request.json(), which would re-serialise what Stripe signed',
  );
  check(
    webhook.indexOf('await request.text()') < webhook.indexOf('constructEventAsync'),
    'and it reads the body before verifying, not after',
  );
  check(
    /ON CONFLICT \(event_id\) DO UPDATE/.test(webhook) &&
      /processed_at IS NULL/.test(webhook),
    'layer 1 CLAIMS unprocessed events rather than skipping seen ones',
  );
  check(
    !/ON CONFLICT \(event_id\) DO NOTHING/.test(webhook),
    'and never reverts to DO NOTHING, which would swallow a payment on a mid-handler crash',
  );

  console.log('  outside the middleware, raw body first, claim not sighting');
}

// ---------------------------------------------------------------------------
console.log('\nWhat each event type actually decides');
// ---------------------------------------------------------------------------
//
// Driven through the real routing function rather than pinned by the presence
// of a `default:` in the source. The first version of this block did the
// latter — and deleting the default, replacing it with `case 'invoice.paid'`,
// left it GREEN. That is the shape this repo has caught seven times: an
// assertion about how code looks rather than about what it decides.
{
  const paid = (type: string) => ({ type, data: { object: { payment_status: 'paid' } } });
  const unpaid = (type: string) => ({ type, data: { object: { payment_status: 'unpaid' } } });

  check(plannedAction(paid('checkout.session.completed')) === 'confirm', 'a paid session confirms');
  check(
    plannedAction(paid('checkout.session.async_payment_succeeded')) === 'confirm',
    'and so does an async payment that succeeded',
  );
  // An async method still in flight. Confirming here would dispatch a crew
  // against money that has not moved.
  check(
    plannedAction(unpaid('checkout.session.completed')) === 'ignore',
    'a completed session whose payment is still UNPAID confirms nothing',
  );
  check(
    plannedAction(paid('checkout.session.async_payment_failed')) === 'flag-failed',
    'a failed async payment is flagged, not expired — the deadline still applies',
  );
  // The cron owns row expiry. Acting here too would race it for the same row
  // and could send two different customer emails about one lapse.
  check(
    plannedAction(paid('checkout.session.expired')) === 'ignore',
    'an expired session changes no status — the cron owns that',
  );

  // EVERYTHING ELSE IS IGNORED, and this is the arm the source pin could not
  // make. A non-2xx tells Stripe to retry for days and to email the account
  // owner about a failing endpoint.
  for (const other of [
    'payment_intent.succeeded',
    'charge.refunded',
    'customer.created',
    'invoice.paid',
    'radar.early_fraud_warning.created',
    'some.type.stripe.has.not.invented.yet',
  ]) {
    check(plannedAction(paid(other)) === 'ignore', `${other} is ignored rather than erroring`);
  }

  console.log('  five events decided, everything else a deliberate no-op');
}

if (failures > 0) {
  console.error(`\n✗ ${failures} check${failures === 1 ? '' : 's'} failed\n`);
  process.exit(1);
}
console.log('\n✓ Stripe checkout and webhook checks passed\n');
