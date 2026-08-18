/**
 * Sending the two booking messages. The only file here that touches the Resend
 * SDK or the environment.
 *
 * **THE CONTRACT: this module never throws and never rejects.** It runs after
 * the appointment row already exists, so an exception propagating out of it
 * would reach `create.ts`'s outer catch and answer 500 for a booking that
 * committed — telling a customer their booking failed when the slot is gone is
 * strictly worse than telling them nothing about email.
 *
 * TWO THINGS ABOUT THE SDK, READ OFF THE INSTALLED SOURCE (resend@6.17.1,
 * `dist/index.mjs`), NOT FROM MEMORY:
 *
 *   1. `emails.send()` NEVER THROWS. `fetchRequest` wraps its `fetch` in a
 *      `try` and returns `{ data: null, error }` for a non-2xx *and* for a
 *      network failure. `try { await send() } catch` therefore catches nothing,
 *      and `api/contact.ts` — written exactly that way — reports every failed
 *      send as success. The error must be read off the returned value.
 *   2. `new Resend(key)` DOES throw when the key is falsy, and before that it
 *      silently falls back to `process.env.RESEND_API_KEY` — which under
 *      `astro dev` is empty precisely when `import.meta.env` holds the value.
 *      So the key is read through `readEnv`, checked, and passed explicitly.
 */

import { Resend } from 'resend';

import type { BookingMessageType, Message, NotificationPlan } from './booking-email';
import { inviteIdempotencyPrefix, type IcsAudienceName, type IcsKind } from './booking-ics';
import { readEnv } from './env';

/** Per message: sent, deliberately not sent, or attempted and failed. */
export type SendOutcome = 'sent' | 'skipped' | 'failed';

export type NotificationResult = {
  customer: SendOutcome;
  internal: SendOutcome;
};

/** What a single send reports back. Deliberately not the SDK's shape. */
export type SendResult = { ok: boolean; error?: string };

export type NotifyDeps = {
  /**
   * The seam. Defaults to the Resend call; `verify-booking-email.ts` injects a
   * fake to drive success, an error response, and a hang — none of which are
   * reachable through the real client without a network and a live key. Without
   * this the mapping in `deliver()` below would be verified by nothing, which
   * is unacceptable for the one behaviour the module header calls a trap.
   *
   * **The second parameter is the idempotency prefix the real sender would have
   * used** (BK-43). The real path bakes the prefix into `createResendSender`'s
   * closure and ignores this argument; it exists so a verify script can read
   * the key rather than infer it from the source. Without it, "two message
   * types to one recipient both deliver" is checkable only by reading code —
   * which is how the fixed-prefix defect survived review in the first place.
   *
   * Injected fakes taking only `(message)` still typecheck: a function of fewer
   * parameters is assignable to one of more.
   */
  send?: (message: Message, keyPrefix: string | null) => Promise<SendResult>;
};

/**
 * Test-only escape hatch, honoured before anything else.
 *
 * `verify:booking:smoke` commits a real booking on every run, and
 * `BOOKING_INTERNAL_TO` is the client's real inbox. Removing `RESEND_API_KEY`
 * from the spawned dev server's environment cannot mute it — `readEnv` falls
 * back to `import.meta.env`, which Vite populates from the dotenv files inside
 * that process. A positive signal in `process.env` can, because `readEnv`
 * checks `process.env` first and a non-empty value wins.
 *
 * Fail-open on purpose: unset means enabled, so no production misconfiguration
 * can silence mail by omission. Never set this in a deployed environment.
 */
const DISABLE_FLAG = 'BOOKING_NOTIFY_DISABLED';

/**
 * Only `1` and `true` disable. Any other value is ignored and mail still goes.
 *
 * `!== undefined` was the first spelling and it is a trap: someone writing
 * `BOOKING_NOTIFY_DISABLED=0` or `=false` — the natural way to say "present but
 * off" — would silently stop every booking email in production, with one
 * `console.warn` as the entire trace. Failing toward *sending* is right, because
 * an unwanted email is recoverable and a customer who was never told is not.
 */
export function mailDisabled(): boolean {
  const value = readEnv(DISABLE_FLAG)?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

/**
 * The real send. Reads the error off the resolved value, never off a catch.
 *
 * **This is the only place in the codebase that calls `resend.emails.send`.**
 * BK-10 pulled it out of `api/contact.ts` and `api/admin/reply.ts`, both of
 * which had their own copy wrapped in a `try/catch` that could not fire.
 *
 * `idempotencyKey` is the SDK's documented `Idempotency-Key` header, and it is
 * a *prefix* the caller supplies rather than something derived here, because
 * only the caller knows what "the same message" means. A booking notification
 * passes `notifyIdempotencyPrefix(id, type)` and an invite passes
 * `inviteIdempotencyPrefix(id, kind, now)` — both carry the transition, so a
 * retry of one message collapses while a *different* message to the same
 * address still goes out. A fixed `booking-<id>` was the original spelling and
 * it is the BK-43 defect: it made every later message in a booking's lifecycle
 * a duplicate of the first, silently and successfully.
 *
 * `null` passes no header at all, which is what the contact form and the lead
 * reply need: their recipient is a fixed office address, so any fixed key
 * would make Resend collapse every subsequent message into the first one.
 */
export function createResendSender(apiKey: string, keyPrefix: string | null) {
  const resend = new Resend(apiKey);

  return async (message: Message): Promise<SendResult> => {
    const { data, error } = await resend.emails.send(
      {
        from: message.from,
        to: [message.to],
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        subject: message.subject,
        html: message.html,
        text: message.text,
        // THIS LINE IS THE WHOLE MAPPING FOR ATTACHMENTS, and the literal above
        // is a whitelist: a `Message` field this object does not name is
        // silently dropped at the SDK boundary. Every verify script would stay
        // green if it were removed, because their injected senders receive the
        // `Message` and never this literal — which is why
        // `verify-booking-ics.ts` pins it at the source level and says so.
        ...(message.attachments ? { attachments: message.attachments } : {}),
      },
      keyPrefix ? { idempotencyKey: `${keyPrefix}:${message.to}` } : {},
    );

    if (error) return { ok: false, error: `${error.name}: ${error.message}` };
    if (!data) return { ok: false, error: 'Resend returned neither an id nor an error' };
    return { ok: true };
  };
}


/**
 * The idempotency-key prefix for one notification send (BK-43).
 *
 * `createResendSender` appends `:<to>`, so the key is
 * `booking-<id>-<type>:<recipient>`. The type is what makes the request,
 * the payment link, the reminder, the confirmation and the decline five
 * distinct keys to one address instead of one key sent five times — which
 * Resend answers by delivering the first and silently returning success for
 * the rest.
 *
 * **This is the only place a notification prefix is spelled.** A template
 * literal at a call site is the defect returning, and
 * `verify-booking-email.ts` pins its absence at the source level.
 *
 * The audience is deliberately not in the prefix, matching
 * `inviteIdempotencyPrefix`: the customer and office copies of one transition
 * go to different addresses, and the `:<to>` suffix already separates them.
 * (The one case where it does not — a customer whose address *is*
 * `BOOKING_INTERNAL_TO` — is recorded as a known nit on BK-43 and applies
 * identically to the calendar path.)
 */
export function notifyIdempotencyPrefix(id: number, type: BookingMessageType): string {
  return `booking-${id}-${type}`;
}

/** Wraps one send so a throw from an injected fake cannot escape either. */
async function deliver(
  send: (message: Message, keyPrefix: string | null) => Promise<SendResult>,
  message: Message,
  label: string,
  bookingId: number,
  keyPrefix: string | null,
): Promise<SendOutcome> {
  try {
    const result = await send(message, keyPrefix);
    if (result.ok) return 'sent';
    // The booking id is the whole point of this line. Until BK-07 surfaces the
    // two stamp columns, this log is the ONLY signal that a customer was not
    // told — and a failure naming no appointment cannot be acted on.
    console.error(`Booking ${bookingId} ${label} email failed: ${result.error ?? 'unknown error'}`);
    return 'failed';
  } catch (err) {
    // Not reachable through the real client, which resolves rather than throws.
    // Kept because an injected `send` and any future client can.
    console.error(`Booking ${bookingId} ${label} email threw:`, err);
    return 'failed';
  }
}

/**
 * Send both messages, concurrently, and report what happened to each.
 *
 * Concurrent rather than sequential so a slow customer send cannot starve the
 * office notification — which is the message that matters most, and the one
 * that is always present.
 *
 * `Promise.all` and not `allSettled`, which would be the defensive-looking
 * choice: `deliver` cannot reject — that is its contract and the reason it
 * catches — so `allSettled` would add a settled-wrapper to unwrap for a case
 * that cannot arise, and would hide it if `deliver` ever stopped honouring the
 * contract. The rejection guard belongs in `deliver`, where it is asserted.
 *
 * There is no timeout here on purpose: the deadline belongs to the whole
 * post-commit block and is applied by the caller, so one budget covers the
 * sends and the stamps together rather than stacking per-operation timers.
 */
export async function sendBookingNotifications(
  plan: NotificationPlan,
  deps: NotifyDeps = {},
): Promise<NotificationResult> {
  if (mailDisabled()) {
    // error, not warn: in a deployed environment this is a misconfiguration
    // that silently stops every customer confirmation.
    console.error(`${DISABLE_FLAG} is set — booking ${plan.bookingId} was not notified.`);
    return { customer: 'skipped', internal: 'skipped' };
  }

  // Computed before the sender so an injected fake sees the same prefix the
  // real one would have baked in — that is what makes BK-43 assertable.
  const keyPrefix = notifyIdempotencyPrefix(plan.bookingId, plan.messageType);

  let send = deps.send;
  if (!send) {
    const apiKey = readEnv('RESEND_API_KEY');
    if (!apiKey) {
      // Before `new Resend()`, which throws on a falsy key.
      console.error('RESEND_API_KEY is not configured — booking notifications were not sent.');
      return { customer: 'failed', internal: 'failed' };
    }
    send = createResendSender(apiKey, keyPrefix);
  }

  const [customer, internal] = await Promise.all([
    plan.customer
      ? deliver(send, plan.customer, 'confirmation', plan.bookingId, keyPrefix)
      : Promise.resolve<SendOutcome>('skipped'),
    deliver(send, plan.internal, 'internal', plan.bookingId, keyPrefix),
  ]);

  return { customer, internal };
}

/**
 * Send the customer's confirmation and nothing else. The admin path's only
 * send.
 *
 * THE INVARIANT: this function never delivers the internal message. It reads
 * `plan.customer` and no other field of the plan, so "the office was not
 * mailed" is a property of the code rather than a rule to remember — the same
 * shape as `customerConfirmation` in `booking-email.ts` not reading the policy
 * number. A manual entry is the office typing the booking in; mailing them
 * about their own keystrokes is noise, and the office inbox is a real one.
 *
 * It exists because the existing seam could not express this (plan-review
 * blocker 1): `sendBookingNotifications` delivers `plan.internal`
 * unconditionally, and `deliver` is module-private, so "just
 * don't send the internal one" was not buildable from outside. Everything that
 * matters is shared with it rather than re-implemented — the disable flag, the
 * key lookup, the adapter, and `deliver`'s never-throws contract — so a fix to
 * any of those reaches both paths.
 *
 * Same contract as the rest of the module: it never throws. It runs after the
 * appointment row exists, and an entry that saved must not report as failed.
 *
 * Takes the whole `NotificationPlan` rather than a bare `Message` so the
 * caller builds it with `planBookingNotifications` — one copy module, one set
 * of PII rules — and so the booking id is available for the idempotency key.
 */
export async function sendCustomerConfirmation(
  plan: NotificationPlan,
  deps: NotifyDeps = {},
): Promise<SendOutcome> {
  // No email address on the appointment: nothing to send, and not a failure.
  if (!plan.customer) return 'skipped';

  if (mailDisabled()) {
    console.error(`${DISABLE_FLAG} is set — booking ${plan.bookingId} was not notified.`);
    return 'skipped';
  }

  const keyPrefix = notifyIdempotencyPrefix(plan.bookingId, plan.messageType);

  let send = deps.send;
  if (!send) {
    const apiKey = readEnv('RESEND_API_KEY');
    if (!apiKey) {
      console.error('RESEND_API_KEY is not configured — the confirmation was not sent.');
      return 'failed';
    }
    send = createResendSender(apiKey, keyPrefix);
  }

  return deliver(send, plan.customer, 'confirmation', plan.bookingId, keyPrefix);
}

/**
 * Send one calendar invite. The office's copy of what the crew is doing.
 *
 * A separate exported function rather than a `NotificationPlan` wrapped around
 * the invite message, and the difference is not cosmetic — it is the
 * plan-review blocker. `sendBookingNotifications` and `sendCustomerConfirmation`
 * both key idempotency on `booking-<id>`, which is exactly right for a
 * notification: a retried booking must not mail the customer twice. Every
 * invite in one booking's lifecycle goes to the SAME office address, so that
 * fixed prefix would make the create, the cancel and the restore
 * byte-identical keys — Resend would collapse the CANCEL into a duplicate of
 * the REQUEST, the calendar event would never clear, and nothing anywhere would
 * report a failure. The key here therefore carries the transition:
 * `inviteIdempotencyPrefix`.
 *
 * Everything else is shared with the two functions above rather than
 * re-implemented — the disable flag, the key lookup, the adapter, and
 * `deliver`'s never-throws contract — so a fix to any of those reaches all
 * three. Same contract as the rest of the module: it never throws. It runs
 * after the row exists or after the status has already changed, and neither may
 * be turned into a 500 by a calendar artifact.
 *
 * **The mute line names the kind and the audience, and that is a verification
 * requirement rather than nicer logging** (BK-16 plan review). It used to name
 * only the booking id. Under `BOOKING_NOTIFY_DISABLED` — which is how
 * `verify-booking-admin-db.ts` drives the routes, because the mute silences
 * injected seams too — that line is the ONLY evidence a route reached a send at
 * all. A boundary crossing now owes two sends, office and customer, and two
 * identical lines cannot tell "both went" from "the office one went twice with
 * the customer half never wired". Naming the audience makes them
 * distinguishable, which is what the route arms assert.
 */
export async function sendCalendarInvite(
  message: Message,
  keyParts: { id: number; kind: IcsKind; now: Date; audience: IcsAudienceName },
  deps: NotifyDeps = {},
): Promise<SendOutcome> {
  const label = `calendar ${keyParts.kind} (${keyParts.audience})`;

  if (mailDisabled()) {
    console.error(
      `${DISABLE_FLAG} is set — no ${label} for booking ${keyParts.id}.`,
    );
    return 'skipped';
  }

  // No audience in the prefix: `createResendSender` appends `:<to>`, and the
  // office and customer copies of one transition go to different addresses.
  // See `inviteIdempotencyPrefix`.
  const keyPrefix = inviteIdempotencyPrefix(keyParts.id, keyParts.kind, keyParts.now);

  let send = deps.send;
  if (!send) {
    const apiKey = readEnv('RESEND_API_KEY');
    if (!apiKey) {
      // Before `new Resend()`, which throws on a falsy key.
      console.error(`RESEND_API_KEY is not configured — the ${label} was not sent.`);
      return 'failed';
    }
    send = createResendSender(apiKey, keyPrefix);
  }

  return deliver(send, message, label, keyParts.id, keyPrefix);
}

/**
 * Send, then record — and return what was *sent*, never what was recorded.
 *
 * This exists as its own function because the ordering is a defect waiting to
 * be reintroduced. The first version let the stamp share the send's return
 * path, so a failed `UPDATE` reported `emailSent: false` for two emails that
 * had gone out. The first way that happens in practice is deploying before the
 * migration runs: the columns do not exist, every booking under-reports, the
 * confirmation page never mentions the email it did send, and the log blames
 * the notification. `stamp` is injectable so that failure is assertable rather
 * than merely commented.
 *
 * The stamp is advisory bookkeeping. Whether the customer was emailed is a fact
 * that already happened by the time it runs.
 */
export async function notifyAndStamp(
  plan: NotificationPlan,
  deps: NotifyDeps & {
    /** Records what sent. Its failure is logged and changes nothing. */
    stamp?: (sent: { customer: boolean; internal: boolean }) => Promise<void>;
  } = {},
): Promise<boolean> {
  const outcome = await sendBookingNotifications(plan, deps);
  const emailed = outcome.customer === 'sent';

  if (deps.stamp) {
    try {
      await deps.stamp({ customer: emailed, internal: outcome.internal === 'sent' });
    } catch (err) {
      console.error(`Booking ${plan.bookingId} was notified but the stamp failed:`, err);
    }
  }

  return emailed;
}

/**
 * Runs `work` under a wall-clock deadline, resolving to `onTimeout` instead of
 * hanging.
 *
 * The losing promise keeps running — there is nothing to cancel, since the SDK
 * accepts no `AbortSignal` (`PostOptions` is `{query?, headers?}`), and letting
 * a late send complete is harmless: the mail arrives and only the stamp is
 * missing.
 *
 * A late *rejection* cannot become an unhandled rejection, because
 * `Promise.race` subscribes to every input promise — so the race absorbs it
 * even after it has already settled on the timeout. The explicit `.catch` below
 * is therefore redundant today and is kept only as a guard for whoever replaces
 * the race with something that does not subscribe. It was proved redundant
 * rather than assumed: removing it left the unhandled-rejection assertion in
 * `verify-booking-email.ts` green, which is recorded in BK-05's red table as
 * the one failure mode that would not go red.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  work.catch(() => {});

  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), ms);
  });

  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
