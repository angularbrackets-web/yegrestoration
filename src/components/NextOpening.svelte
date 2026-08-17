<script lang="ts">
  /**
   * The homepage's one-line availability teaser (BK-39).
   *
   * Read-only and consequence-free: it fetches the public availability
   * endpoint, prints one string, and links nowhere. It is NOT the booking
   * wizard on the homepage and must not become it — one door per intent, which
   * is the whole point of the BK-10 cutover.
   *
   * Three rules:
   *
   *   - **A failure renders nothing.** Not an error, not "call us", not a
   *     retry. The CTA underneath is the page's job and it is already there; an
   *     error message beside a working button only makes the button look
   *     broken. `booking_availability_error` is the booking page's diagnostic
   *     and is deliberately not fired from here, where a visitor never asked
   *     for a calendar.
   *   - **Zero CLS.** The line reserves its height from first paint, so filling
   *     it never moves the CTA. This sits inside the homepage's tallest card;
   *     shifting it after hydration would be a real layout jump.
   *   - **`label` verbatim.** See `booking-preview.ts` — reformatting in the
   *     browser reads the visitor's timezone, not Edmonton's.
   */
  import { onMount } from 'svelte';

  import { BOOKING_AVAILABILITY_ENDPOINT } from '../lib/booking-config';
  import {
    nextOpeningLine,
    readCachedPreview,
    PREVIEW_CACHE_KEY,
  } from '../lib/booking-preview';

  let line = $state<string | null>(null);

  onMount(async () => {
    // sessionStorage throws outright in some privacy modes rather than merely
    // returning null, so every touch of it is guarded. A teaser is never worth
    // an exception that stops the island mounting.
    let store: Storage | null = null;
    try {
      store = window.sessionStorage;
    } catch {
      store = null;
    }

    try {
      const cached = readCachedPreview(store?.getItem(PREVIEW_CACHE_KEY) ?? null, Date.now());
      if (cached) {
        line = cached;
        return;
      }
    } catch {
      // fall through to the network
    }

    try {
      const res = await fetch(BOOKING_AVAILABILITY_ENDPOINT, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return;
      const next = nextOpeningLine(await res.json());
      if (!next) return;
      line = next;
      try {
        store?.setItem(PREVIEW_CACHE_KEY, JSON.stringify({ at: Date.now(), line: next }));
      } catch {
        // A full or blocked quota is not a reason to withhold the line.
      }
    } catch {
      // Silent by design. See the header.
    }
  });
</script>

<!--
  `min-h` rather than a conditional wrapper: the box exists at the reserved
  height from the server-rendered first paint, whether or not it ever fills.
-->
<p class="min-h-[1.25rem] text-sm font-semibold text-yeg-amber-deep mb-3" aria-live="polite">
  {#if line}{line}{/if}
</p>
