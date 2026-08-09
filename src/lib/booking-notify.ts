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

import type { Message, NotificationPlan } from './booking-email';
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
   */
  send?: (message: Message) => Promise<SendResult>;
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
function notificationsDisabled(): boolean {
  const value = readEnv(DISABLE_FLAG)?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

/**
 * The real send. Reads the error off the resolved value, never off a catch.
 *
 * `idempotencyKey` is the SDK's documented `Idempotency-Key` header: if this
 * function is ever retried for the same booking, Resend collapses the duplicate
 * rather than mailing the customer twice.
 */
function resendSender(apiKey: string, bookingId: number) {
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
      },
      { idempotencyKey: `booking-${bookingId}:${message.to}` },
    );

    if (error) return { ok: false, error: `${error.name}: ${error.message}` };
    if (!data) return { ok: false, error: 'Resend returned neither an id nor an error' };
    return { ok: true };
  };
}

/** Wraps one send so a throw from an injected fake cannot escape either. */
async function deliver(
  send: (message: Message) => Promise<SendResult>,
  message: Message,
  label: string,
  bookingId: number,
): Promise<SendOutcome> {
  try {
    const result = await send(message);
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
  if (notificationsDisabled()) {
    // error, not warn: in a deployed environment this is a misconfiguration
    // that silently stops every customer confirmation.
    console.error(`${DISABLE_FLAG} is set — booking ${plan.bookingId} was not notified.`);
    return { customer: 'skipped', internal: 'skipped' };
  }

  let send = deps.send;
  if (!send) {
    const apiKey = readEnv('RESEND_API_KEY');
    if (!apiKey) {
      // Before `new Resend()`, which throws on a falsy key.
      console.error('RESEND_API_KEY is not configured — booking notifications were not sent.');
      return { customer: 'failed', internal: 'failed' };
    }
    send = resendSender(apiKey, plan.bookingId);
  }

  const [customer, internal] = await Promise.all([
    plan.customer
      ? deliver(send, plan.customer, 'confirmation', plan.bookingId)
      : Promise.resolve<SendOutcome>('skipped'),
    deliver(send, plan.internal, 'internal', plan.bookingId),
  ]);

  return { customer, internal };
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
