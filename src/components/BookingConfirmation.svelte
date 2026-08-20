<script lang="ts">
  /**
   * The page a submitted booking lands on — in one of TWO variants (BK-23).
   *
   * It renders from `sessionStorage`, never from the URL, so there is no link
   * anyone can craft that shows a confirmation for a booking that is not
   * theirs. Two consequences worth keeping in mind before editing:
   *
   *   - Nothing here is server-rendered except the "checking" state. That is
   *     the whole point; `output: 'static'` could not render a confirmation
   *     even if the data were in the URL.
   *   - No payload means no booking happened in this tab, so this is not a page
   *     to soften with a generic message — it redirects to the form.
   */
  import { onMount } from 'svelte';

  import { BOOKING_PATH } from '../lib/booking-config';
  import type { Confirmation } from '../lib/booking-confirmation';
  // The have-ready list, the visit length, and the emailed line are the copy the
  // client settled on 2026-08-08 and will edit later. They live in
  // `booking-copy.ts` so this page and the confirmation email cannot drift —
  // before BK-05 this component owned a second copy of the list.
  import {
    EMAILED_LINE,
    HAVE_READY_HEADING,
    HAVE_READY_ITEMS,
    RECEIVED_EMAILED_LINE,
    RECEIVED_HEADING,
    RECEIVED_HOLD_LINE,
    RECEIVED_LEAD,
    RECEIVED_NEXT_STEPS,
    PAID_HEADING,
    PAID_HELP_LINE,
    PAID_LEAD,
    RECEIVED_TIMING_LINE,
    VISIT_LENGTH_LINE,
  } from '../lib/booking-copy';
  import {
    loadConfirmation,
    paidLandingSession,
    reportBookingConversion,
  } from '../lib/booking-handoff';
  import { planConfirmationRender } from '../lib/booking-confirmation';
  import { SUPPORT_PHONE } from '../lib/booking-form';

  const PHONE_HREF = 'tel:+17804793285';

  /**
   * WHICH OF THE TWO PAGES THIS IS, and it is required rather than defaulted.
   *
   * `received` is where the form lands: a request exists, nothing is confirmed,
   * and no invite has been sent. `confirmed` is where the payment redirect
   * lands (BK-32).
   *
   * No default, deliberately. The two variants differ in whether they tell a
   * customer they have an appointment, and a defaulted prop means a new caller
   * silently gets whichever the default happens to be. Getting that wrong in
   * the `confirmed` direction is precisely the false claim P9 exists to remove.
   */
  let { variant }: { variant: 'received' | 'confirmed' } = $props();

  const isReceived = $derived(variant === 'received');

  let confirmation = $state<Confirmation | null>(null);
  /** True once this load has been established as a real payment landing. */
  let paid = $state(false);

  onMount(() => {
    // THE DECISION IS NOT MADE HERE. `planConfirmationRender` is a pure
    // function in `booking-confirmation.ts` and every arm of it is driven by
    // `verify:booking:confirmation` — this block only carries out what it says.
    // It used to be an `if` chain, pinned by a verify check on the textual order
    // of an `if` and a call, which is an assertion about how code looks rather
    // than about what it decides.
    const stored = loadConfirmation();
    const sessionId = paidLandingSession();
    const plan = planConfirmationRender({
      variant,
      sessionId,
      hasStoredRequest: stored !== null,
    });

    if (plan === 'redirect') {
      // replace, not assign: the page should not sit in history as a Back
      // target that redirects again.
      window.location.replace(BOOKING_PATH);
      return;
    }

    if (plan === 'request') {
      confirmation = stored;
      return;
    }

    paid = true;
    // Keyed on the session, not on the booking id: `sessionStorage` is empty
    // whenever the customer paid from the emailed link on another device, which
    // is the common case. `id` is 0 with no payload, and the GA4 event then
    // omits `booking_id` rather than inventing one.
    reportBookingConversion(sessionId, stored?.id ?? 0);
  });
</script>

<div
  class="bg-white border border-black/10 rounded-xl p-6 lg:p-10 shadow-[0_4px_24px_rgba(0,0,0,0.06)]"
>
  {#if isReceived && confirmation}
    <div class="text-center">
      <div
        class="w-16 h-16 rounded-full bg-yeg-amber/20 flex items-center justify-center mx-auto mb-6"
      >
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-yeg-amber-deep" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
      </div>
      <h1 class="font-display font-bold text-3xl text-yeg-text mb-3">
        {RECEIVED_HEADING}
      </h1>
      <p class="text-yeg-text-secondary mb-4">{RECEIVED_LEAD}</p>
      {#if confirmation.slotLabel}
        <p class="text-lg text-yeg-text">{confirmation.slotLabel}</p>
      {/if}
      {#if confirmation.address}
        <p class="text-yeg-text-secondary">{confirmation.address}</p>
      {/if}
      <p class="text-sm text-yeg-text-secondary mt-2">{RECEIVED_HOLD_LINE}</p>
      <p class="text-sm text-yeg-text-secondary mt-2">
        {VISIT_LENGTH_LINE}{#if confirmation.id > 0}
          Reference #{confirmation.id}.{/if}
      </p>
      {#if confirmation.emailSent}
        <!--
          Only when the server actually sent it. `emailSent` defaults to false
          everywhere, so a failed send, a send that missed the deadline, or a
          booking with no email address all render nothing here rather than
          promising a message that will not arrive.
        -->
        <p class="text-sm text-yeg-text-secondary mt-2">{RECEIVED_EMAILED_LINE}</p>
      {/if}
    </div>

    <!--
      What happens next. The confirmed page needs no such list: by the time
      anyone reaches it the only thing left is the visit.

      This block does the work the old "You're booked" heading was doing badly.
      It tells the customer where they actually stand, in order, including that
      the calendar invite arrives AFTER payment rather than now.
    -->
    <ol class="mt-8 rounded-lg p-5 text-left space-y-3" style="background-color:rgba(0,0,0,0.03)">
        {#each RECEIVED_NEXT_STEPS as step, i (step)}
          <li class="flex items-start gap-3 text-sm text-yeg-text-secondary">
            <span
              class="shrink-0 w-6 h-6 rounded-full bg-yeg-amber/20 text-yeg-amber-deep font-semibold flex items-center justify-center text-xs"
              aria-hidden="true">{i + 1}</span
            >
            <span>{step}</span>
          </li>
        {/each}
      </ol>
    <p class="mt-4 text-sm text-yeg-text-secondary text-center">{RECEIVED_TIMING_LINE}</p>

    <div class="mt-8 rounded-lg p-5 text-left" style="background-color:rgba(0,0,0,0.03)">
      <h2 class="font-display font-bold text-lg text-yeg-text mb-3">{HAVE_READY_HEADING}</h2>
      <ul class="space-y-2">
        {#each HAVE_READY_ITEMS as item (item)}
          <li class="flex items-start gap-2 text-sm text-yeg-text-secondary">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-yeg-amber-deep mt-0.5 shrink-0" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
            <span>{item}</span>
          </li>
        {/each}
      </ul>
    </div>

    <p class="mt-6 text-sm text-yeg-text-secondary text-center">
      To cancel or reschedule, call or text
      <a class="text-yeg-amber-deep font-semibold" href={PHONE_HREF}>{SUPPORT_PHONE}</a>.
    </p>
  {:else if paid}
    <!--
      THE PAYMENT LANDING — A RECEIPT, NOT A STATE CLAIM.
      ==================================================
      This page verifies nothing. It makes no network call, it writes nothing,
      and the session id in its URL is shape-checked rather than confirmed
      against Stripe — so it must not assert what only the webhook knows. "Your
      booking is confirmed" is a claim about state; "payment received" is a
      claim about what the visitor just did, and only the second one is ours to
      make.

      IT ALSO RENDERS NO STORED PAYLOAD, DELIBERATELY. The `sessionStorage`
      record on this origin was written by /book/received/ for a REQUEST and has
      no relationship to any payment: someone who submitted two requests in one
      tab and paid for the first would be shown the second one's slot, address
      and reference. A wrong booking under a confident heading is worse than no
      detail at all — and the real details are in the confirmation email, which
      `markPaid()` sends and which is the artifact that actually knows.
    -->
    <div class="text-center">
      <div
        class="w-16 h-16 rounded-full bg-yeg-amber/20 flex items-center justify-center mx-auto mb-6"
      >
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-yeg-amber-deep" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
      </div>
      <h1 class="font-display font-bold text-3xl text-yeg-text mb-3">{PAID_HEADING}</h1>
      <p class="text-yeg-text-secondary mb-4">{PAID_LEAD}</p>
      <p class="text-sm text-yeg-text-secondary">{PAID_HELP_LINE}</p>
    </div>

    <div class="mt-8 rounded-lg p-5 text-left" style="background-color:rgba(0,0,0,0.03)">
      <h2 class="font-display font-bold text-lg text-yeg-text mb-3">{HAVE_READY_HEADING}</h2>
      <ul class="space-y-2">
        {#each HAVE_READY_ITEMS as item (item)}
          <li class="flex items-start gap-2 text-sm text-yeg-text-secondary">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-yeg-amber-deep mt-0.5 shrink-0" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
            <span>{item}</span>
          </li>
        {/each}
      </ul>
    </div>

    <p class="mt-6 text-sm text-yeg-text-secondary text-center">
      To cancel or reschedule, call or text
      <a class="text-yeg-amber-deep font-semibold" href={PHONE_HREF}>{SUPPORT_PHONE}</a>.
    </p>

  {:else}
    <!--
      The pre-hydration state, and the one that shows for the instant before a
      visit with nothing to show redirects. Deliberately says nothing about a
      booking or a payment.
    -->
    <p class="text-sm text-yeg-text-secondary py-12 text-center" role="status">
      {isReceived ? 'Checking your request…' : 'Checking your booking…'}
    </p>
  {/if}
</div>
