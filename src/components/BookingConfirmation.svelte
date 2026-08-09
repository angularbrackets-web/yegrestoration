<script lang="ts">
  /**
   * `/book/confirmed/` — the page a committed booking lands on.
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
    VISIT_LENGTH_LINE,
  } from '../lib/booking-copy';
  import { loadConfirmation, reportBookingConversion } from '../lib/booking-handoff';
  import { SUPPORT_PHONE } from '../lib/booking-form';

  const PHONE_HREF = 'tel:+17804793285';

  let confirmation = $state<Confirmation | null>(null);

  onMount(() => {
    const stored = loadConfirmation();
    if (!stored) {
      // replace, not assign: the confirmed URL should not sit in history as a
      // Back target that redirects again.
      window.location.replace(BOOKING_PATH);
      return;
    }
    confirmation = stored;
    reportBookingConversion(stored.id);
  });
</script>

<div
  class="bg-white border border-black/10 rounded-xl p-6 lg:p-10 shadow-[0_4px_24px_rgba(0,0,0,0.06)]"
>
  {#if confirmation}
    <div class="text-center">
      <div
        class="w-16 h-16 rounded-full bg-yeg-amber/20 flex items-center justify-center mx-auto mb-6"
      >
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-yeg-amber-deep" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
      </div>
      <h1 class="font-display font-bold text-3xl text-yeg-text mb-3">You're booked</h1>
      {#if confirmation.slotLabel}
        <p class="text-lg text-yeg-text">{confirmation.slotLabel}</p>
      {/if}
      {#if confirmation.address}
        <p class="text-yeg-text-secondary">{confirmation.address}</p>
      {/if}
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
        <p class="text-sm text-yeg-text-secondary mt-2">{EMAILED_LINE}</p>
      {/if}
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
      payload-less visit redirects. Deliberately says nothing about a booking.
    -->
    <p class="text-sm text-yeg-text-secondary py-12 text-center" role="status">
      Checking your booking…
    </p>
  {/if}
</div>
