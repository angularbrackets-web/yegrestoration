<script lang="ts">
  /**
   * The public booking form.
   *
   * All decision-making lives in `../lib/booking-form` so it can be verified
   * without a browser; this file is state, markup, and fetch. Three things here
   * are load-bearing and easy to "tidy" into bugs:
   *
   *   - Every path comes from `booking-config.ts`. `trailingSlash: 'always'`
   *     308-redirects the unslashed form, and a followed 308 looks like success.
   *   - A file is attached when `upload()` resolves. `upload_state` is never
   *     read: `onUploadCompleted` does not fire on localhost, so in dev every
   *     row stays 'pending' while the file is genuinely there.
   *   - The submit guard is a real state machine, not the disabled attribute.
   *     BK-02 declined idempotency on the strength of it.
   */
  import { onMount } from 'svelte';
  import { upload } from '@vercel/blob/client';

  import {
    ALLOWED_UPLOAD_TYPES,
    BOOKING_AVAILABILITY_ENDPOINT,
    BOOKING_RECEIVED_PATH,
    BOOKING_CREATE_ENDPOINT,
    BOOKING_DRAFT_ENDPOINT,
    BOOKING_UPLOAD_ENDPOINT,
    MAX_FILES_PER_BOOKING,
    MAX_FILE_BYTES,
  } from '../lib/booking-config';
  import type { Confirmation } from '../lib/booking-confirmation';
  import {
    FEE_TERMS_ACK_LABEL,
    FEE_TERMS_CREDIT,
    FEE_TERMS_HEADING,
    FEE_TERMS_INTRO,
    FEE_TERMS_ITEMS,
    FEE_TERMS_PAYMENT,
    FEE_TERMS_REFUND,
    AFTER_HOURS_NOTE,
    ASSESSMENT_TIER_DESCRIPTIONS,
    ASSESSMENT_TIER_LEGEND,
    ASSESSMENT_TIER_NAMES,
    QUOTE_HEADING,
    QUOTE_TIMING_NOTE,
    RECEIVED_EMAILED_LINE,
    RECEIVED_HEADING,
    RECEIVED_HOLD_LINE,
    RECEIVED_LEAD,
  } from '../lib/booking-copy';
  import {
    reportBookingFunnelEvent,
    storeConfirmation,
  } from '../lib/booking-handoff';
  import type { AvailableDate, AvailableSlot } from '../lib/booking-availability';
  import {
    ASSESSMENT_TIERS,
    assessmentQuote,
    formatCents,
    type AssessmentTier,
  } from '../lib/booking-pricing';
  import { MAX_FIELD_LENGTHS } from '../lib/booking-payload';
  import { buildUploadPathname, formatBytes } from '../lib/booking-uploads';
  import {
    applyPrefill,
    assembleBookingPayload,
    checkFileAcceptance,
    createDraftSession,
    createSubmitGuard,
    dayChipCaption,
    dayChipKind,
    dayChipLabel,
    emptyFormValues,
    mapCommitResponse,
    monthHeading,
    readAvailabilityResponse,
    startsNewMonth,
    validateStep,
    SUPPORT_PHONE,
    type Step,
  } from '../lib/booking-form';
  import { services } from '../data/services';

  const PHONE_DISPLAY = SUPPORT_PHONE;
  const PHONE_HREF = 'tel:+17804793285';

  /** Above this, a dropped connection would otherwise restart the whole file. */
  const MULTIPART_THRESHOLD_BYTES = 10 * 1024 * 1024;

  const SERVICE_IDS = new Set([...services.map((s) => s.id), 'other']);

  // The file picker matches on both MIME types and extensions: browsers often
  // report no type at all for HEIC, and an accept list of types alone hides
  // every iPhone photo behind "no files available".
  const ACCEPT = [...ALLOWED_UPLOAD_TYPES, '.heic', '.heif', '.mov'].join(',');

  type Attachment = {
    id: string;
    name: string;
    size: number;
    contentType: string;
    /** Reused on retry — regenerating it burns a second slot against the draft quota. */
    pathname: string;
    /**
     * The token of the draft this pathname was built under. Held per file
     * rather than read from the session at upload time: the two must not be
     * able to drift, or the server verifies one draft and rejects a pathname
     * belonging to another.
     */
    draftToken: string;
    status: 'uploading' | 'done' | 'failed';
    progress: number;
    message: string;
  };

  let step = $state<Step>(1);
  let values = $state(emptyFormValues());
  let errors = $state<Record<string, string>>({});
  let formMessage = $state('');

  let dates = $state<AvailableDate[]>([]);
  let selectedDate = $state<string | null>(null);
  let availabilityError = $state('');
  let loadingAvailability = $state(true);

  let attachments = $state<Attachment[]>([]);
  let photoNotice = $state('');
  let uploadsInFlight = $state(0);

  let submitting = $state(false);
  /**
   * Only ever set when the handoff to `/book/confirmed/` could not happen.
   * The happy path navigates; this is the card that keeps a committed booking
   * on screen when `sessionStorage` refuses to hold it. See BK-04.
   */
  let result = $state<Confirmation | null>(null);

  // Disabled until hydration: a pre-hydration submit does a native GET
  // navigation with no handler attached and silently drops everything.
  let hydrated = $state(false);

  /**
   * Set once the booking is committed and the browser is on its way to
   * `/book/confirmed/`. The unload is not instant, and `submitting` is cleared
   * in `finally` — without this the button re-enables for the window in
   * between, and a second click books a second appointment.
   */
  let leaving = $state(false);

  const guard = createSubmitGuard();

  /** Files never enter `$state` — Svelte's deep proxy has no business wrapping a File. */
  const pendingFiles = new Map<string, File>();
  /** So a stalled upload can be abandoned without abandoning the booking. */
  const uploadAborts = new Map<string, AbortController>();

  /** One draft per form session, minted on first file selection, never on mount. */
  type Draft = { draftId: string; draftToken: string };
  const draftSession = createDraftSession<Draft>(mintDraft);

  const chosenSlot = $derived(
    dates.flatMap((d) => d.slots).find((s) => s.start === values.slotStart) ?? null,
  );
  const selectedDay = $derived(dates.find((d) => d.date === selectedDate) ?? null);

  /**
   * What the customer will be asked to pay, shown BEFORE they send the request.
   *
   * Three inputs, all of which the visitor can still change on this page: the
   * tier, the service (step 1) and the slot (step 1). Weekend slots carry the
   * 1.5x after-hours rate and mould carries its own lower prices, so a static
   * figure lifted from the terms box would be wrong for a good share of real
   * bookings.
   *
   * **This is display, not trust.** The server recomputes with the same
   * function from the tier key, service and slot it stored — see
   * `booking-pricing.ts`. Nothing here is sent.
   *
   * Null until all three are known, which is why the price block renders
   * conditionally rather than showing a placeholder number.
   */
  const quote = $derived(
    values.assessmentTier && values.service && values.slotStart
      ? assessmentQuote({
          tier: values.assessmentTier,
          service: values.service,
          slotStart: new Date(values.slotStart),
        })
      : null,
  );

  /**
   * The per-tier prices for the radio labels, for the service and slot chosen.
   *
   * Computed for every tier rather than only the selected one: the point of the
   * list is comparing them, and a visitor on a Saturday mould job should see
   * three real numbers, not three standard ones and a surprise at the bottom.
   */
  const tierQuotes = $derived(
    values.service && values.slotStart
      ? Object.fromEntries(
          ASSESSMENT_TIERS.map((tier) => [
            tier,
            assessmentQuote({
              tier,
              service: values.service,
              slotStart: new Date(values.slotStart as string),
            }),
          ]),
        )
      : null,
  );
  const busy = $derived(submitting || leaving || uploadsInFlight > 0);

  /**
   * What satisfies BK-22's "at least one photo or video" on the client.
   *
   * `done` **and** `failed`, never `done` alone — Q3 on the ticket, and the
   * reason is `skipUpload`: a stalled 100 MB video on bad wifi is the case this
   * form was built to survive, and Skip marks the attachment `failed`. Counting
   * only completed uploads would let the visitor out of the stall and into a
   * step that will not release them, for a booking **the server would have
   * accepted** — the `appointment_files` row exists from token-mint time,
   * before any bytes. Uploads still in flight are excluded, and cost nothing:
   * `busy` already disables submit while `uploadsInFlight > 0`.
   */
  const attachmentCount = $derived(
    attachments.filter((a) => a.status === 'done' || a.status === 'failed').length,
  );

  /**
   * Every day in the window is full — a different state from "nothing open on
   * the day you clicked", and the one that used to render as "try another day"
   * when there was no other day to try.
   */
  const allDaysFull = $derived(
    !loadingAvailability &&
      !availabilityError &&
      dates.length > 0 &&
      dates.every((d) => d.slots.length === 0),
  );

  onMount(() => {
    hydrated = true;
    // Prefill before the first paint of step 2. Only ever selects an option
    // the form already offers; anything else is ignored. See `applyPrefill`.
    values = applyPrefill(values, window.location.search, SERVICE_IDS);
    void loadAvailability();
  });

  // -------------------------------------------------------------------------
  // Availability
  // -------------------------------------------------------------------------

  async function loadAvailability() {
    loadingAvailability = true;
    availabilityError = '';
    try {
      const res = await fetch(BOOKING_AVAILABILITY_ENDPOINT, {
        headers: { Accept: 'application/json' },
      });
      const body = await res.json().catch(() => null);
      const outcome = readAvailabilityResponse(res.status, body);
      if (!outcome.ok) {
        dates = [];
        availabilityError = outcome.message;
        // The funnel event, not a conversion: with the form demoted, a
        // visitor who cannot see any times is a lost quote that leaves no
        // other trace. No parameters, no PII.
        reportBookingFunnelEvent('booking_availability_error');
        return;
      }
      dates = outcome.dates as AvailableDate[];
      availabilityAt = new Date();
      if (dates.length > 0 && dates.every((d) => d.slots.length === 0)) {
        reportBookingFunnelEvent('booking_availability_empty');
      }
      const stillThere = dates.some((d) => d.date === selectedDate && d.slots.length > 0);
      if (!stillThere) selectedDate = dates.find((d) => d.slots.length > 0)?.date ?? null;
      if (values.slotStart && !dates.some((d) => d.slots.some((s) => s.start === values.slotStart))) {
        values.slotStart = null;
      }
    } catch {
      dates = [];
      availabilityError = `We could not load available times. Please call us at ${PHONE_DISPLAY}.`;
      reportBookingFunnelEvent('booking_availability_error');
    } finally {
      loadingAvailability = false;
    }
  }

  function chooseSlot(slot: AvailableSlot) {
    values.slotStart = slot.start;
    delete errors.slot_start;
  }

  // -------------------------------------------------------------------------
  // Steps
  // -------------------------------------------------------------------------

  function applyErrors(list: { field: string; message: string }[]): void {
    const next: Record<string, string> = {};
    for (const e of list) if (!next[e.field]) next[e.field] = e.message;
    errors = next;
  }

  function goTo(next: Step) {
    step = next;
    formMessage = '';
  }

  function nextStep() {
    const found = validateStep(step, values, SERVICE_IDS, attachmentCount);
    if (found.length > 0) {
      applyErrors(found);
      return;
    }
    errors = {};
    if (step < 3) goTo((step + 1) as Step);
  }

  // -------------------------------------------------------------------------
  // Uploads
  // -------------------------------------------------------------------------

  /**
   * Mint the session's draft, or report why photos are unavailable.
   *
   * **This used to say a failure here must never block the booking, because an
   * appointment without photos is still an appointment. Since BK-22 that is no
   * longer true**: a photo is required, so no draft means no booking, and this
   * function's failure message is the last thing a losable customer reads.
   * That is why it says two different things rather than one.
   *
   * - **429 — retryable, and only retryable.** `draft.ts` throttles per IP per
   *   hour, and `createDraftSession` does not cache a failed mint, so the next
   *   tap genuinely can succeed. Telling this visitor to abandon the form and
   *   phone instead would be wrong; they are 30 seconds from booking.
   * - **Anything else — hard.** Photos cannot be attached and therefore the
   *   booking cannot be made here, so the only honest thing to offer is the
   *   phone. That fallback is real rather than a brush-off: the office takes it
   *   as an admin entry, which is exempt from this requirement by the client's
   *   own instruction, and they ask for the pictures by text afterwards.
   *
   * Do NOT add a "couldn't attach? book anyway" escape. It reopens precisely
   * the hole the client asked to close, and it is reachable by anyone who
   * blocks one request. Settled on the ticket; not to be relitigated here.
   */
  async function mintDraft(): Promise<Draft | null> {
    try {
      // The Content-Type is not decoration on a bodyless POST. Astro's origin
      // check forbids a POST that carries NO content-type unless `Origin`
      // matches exactly (`core/app/origin-check.js:16-21`); with a non-form
      // content-type it is allowed regardless. A browser always sends `Origin`,
      // so this works either way — but it removes a silent dependency on a
      // header we do not control.
      const res = await fetch(BOOKING_DRAFT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const body = (await res.json().catch(() => null)) as
        | { draftId?: unknown; draftToken?: unknown }
        | null;
      if (!res.ok || typeof body?.draftId !== 'string' || typeof body?.draftToken !== 'string') {
        // A 429 is the throttle, not a breakage. Note this branch is also
        // reached by a 200 carrying a malformed body, which is a hard failure —
        // hence the status test rather than `!res.ok`.
        if (res.status === 429) {
          photoNotice = RETRY_PHOTO_NOTICE;
          return null;
        }
        failPhotoUpload();
        return null;
      }
      return { draftId: body.draftId, draftToken: body.draftToken };
    } catch {
      // Network-level: no status to read, so it can only be treated as hard.
      failPhotoUpload();
      return null;
    }
  }

  const RETRY_PHOTO_NOTICE =
    'Too many people on this connection right now — wait a moment and try again.';

  /**
   * The hard branch: say to call, and count it.
   *
   * The event is a diagnostic, not a conversion, and it counts **attempts, not
   * visitors** — `createDraftSession` retries on the next file selection, so one
   * stuck person can raise it several times. That is the same reading hazard the
   * ROADMAP records for the availability events, and the reason the name
   * describes a condition rather than a headcount.
   */
  function failPhotoUpload() {
    photoNotice = `Photos can't be attached right now, and a photo is required to book online. Please call or text us at ${PHONE_DISPLAY} and we'll book it for you.`;
    reportBookingFunnelEvent('booking_photo_upload_unavailable');
  }

  async function onFilesChosen(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const chosen = Array.from(input.files ?? []);
    input.value = ''; // so re-picking the same file fires change again
    photoNotice = '';

    for (const file of chosen) {
      const verdict = checkFileAcceptance(file, attachments.map((a) => ({ size: a.size })));
      if (!verdict.ok) {
        photoNotice = `${file.name}: ${verdict.message}`;
        continue;
      }
      const session = await draftSession.get();
      if (!session) return;

      const id = crypto.randomUUID();
      pendingFiles.set(id, file);
      attachments = [
        ...attachments,
        {
          id,
          name: file.name,
          size: file.size,
          contentType: verdict.contentType,
          pathname: buildUploadPathname(session.draftId, verdict.contentType),
          draftToken: session.draftToken,
          status: 'uploading',
          progress: 0,
          message: '',
        },
      ];
      await sendUpload(id);
    }
  }

  async function sendUpload(id: string) {
    const file = pendingFiles.get(id);
    const entry = attachments.find((a) => a.id === id);
    if (!file || !entry) return;
    // A second Retry click before the first re-render would otherwise start two
    // concurrent PUTs to one pathname, which `allowOverwrite: false` rejects.
    if (uploadAborts.has(id)) return;

    const controller = new AbortController();
    uploadAborts.set(id, controller);
    entry.status = 'uploading';
    entry.message = '';
    entry.progress = 0;
    uploadsInFlight += 1;

    try {
      await upload(entry.pathname, file, {
        access: 'private',
        handleUploadUrl: BOOKING_UPLOAD_ENDPOINT,
        contentType: entry.contentType,
        clientPayload: JSON.stringify({
          // This file's own draft token, not whatever the session holds now.
          draftToken: entry.draftToken,
          size: file.size,
          originalName: file.name,
        }),
        multipart: file.size > MULTIPART_THRESHOLD_BYTES,
        abortSignal: controller.signal,
        onUploadProgress: (e: { percentage: number }) => {
          entry.progress = Math.round(e.percentage);
        },
      });
      // Resolved means uploaded. Nothing here reads upload_state: the server
      // only learns of completion via a callback that never fires on localhost.
      entry.status = 'done';
      entry.progress = 100;
    } catch {
      // The SDK throws one fixed string for every server-side rejection and
      // discards the message the route wrote, so there is nothing specific to
      // show. Ours is at least true.
      entry.status = 'failed';
      entry.message = controller.signal.aborted ? 'Skipped.' : "That upload didn't finish.";
    } finally {
      uploadAborts.delete(id);
      uploadsInFlight -= 1;
    }
  }

  /**
   * Abandon one upload without abandoning the booking.
   *
   * The submit button waits for uploads to finish, so a 100 MB video stalled on
   * hotel wifi — exactly the case this form is built for — would otherwise trap
   * the visitor with no exit but a reload that loses everything they typed. A
   * failed upload never blocks; only a hanging one did.
   */
  function skipUpload(id: string) {
    uploadAborts.get(id)?.abort();
  }

  // -------------------------------------------------------------------------
  // Submit
  // -------------------------------------------------------------------------

  async function handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    // The booking is committed and the page is unloading. Nothing below this
    // line may run again, whatever the button currently looks like.
    if (leaving) return;
    formMessage = '';

    const found = ([1, 2, 3] as Step[]).flatMap((s) =>
      validateStep(s, values, SERVICE_IDS, attachmentCount),
    );
    if (found.length > 0) {
      applyErrors(found);
      const target = ([1, 2, 3] as Step[]).find(
        (s) => validateStep(s, values, SERVICE_IDS, attachmentCount).length > 0,
      );
      if (target) step = target;
      return;
    }
    errors = {};

    if (!guard.begin()) return;
    submitting = true;
    try {
      const res = await fetch(BOOKING_CREATE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The token of the draft the uploads were made under, if any.
        body: JSON.stringify(assembleBookingPayload(values, attachments[0]?.draftToken ?? null)),
      });
      const body = await res.json().catch(() => null);
      const outcome = mapCommitResponse(res.status, body);

      switch (outcome.kind) {
        case 'booked': {
          const uploaded = attachments.filter((a) => a.status === 'done').length;
          if (outcome.filesAttached !== uploaded) {
            console.warn(
              `Booking ${outcome.id}: server attached ${outcome.filesAttached} files, browser uploaded ${uploaded}.`,
            );
          }
          const confirmation: Confirmation = {
            id: outcome.id,
            slotLabel: outcome.slotLabel,
            address: [values.address.trim(), values.city.trim()].filter(Boolean).join(', '),
            emailSent: outcome.emailSent,
          };

          if (storeConfirmation(confirmation)) {
            leaving = true;
            // `replace`, not `assign`: Back from the request page must not land
            // on a fresh empty form, which is how one job gets booked twice.
            window.location.replace(BOOKING_RECEIVED_PATH);
            break;
          }

          // sessionStorage refused the write. The request is committed either
          // way, so navigating would send them to a page with nothing to show
          // that bounces straight back to an empty form. Keep the BK-03 card.
          //
          // NO CONVERSION IS REPORTED HERE, and its absence is the decision
          // rather than an omission (BK-32, N5). This branch is on the REQUEST
          // path — the office has not reviewed it and nobody has paid for it —
          // and under P9 the conversion is the payment. It fires once, on
          // /book/confirmed/, keyed on the Stripe Checkout Session.
          result = confirmation;
          break;
        }
        case 'fields':
          applyErrors(outcome.errors);
          step = outcome.step;
          break;
        case 'slotGone':
          // Keep every other answer. Losing a typed address because someone
          // else took 13:30 is how a booking becomes a call to a competitor.
          values.slotStart = null;
          step = 1;
          formMessage = outcome.message;
          await loadAvailability();
          break;
        case 'draftExpired':
          draftSession.reset();
          attachments = [];
          pendingFiles.clear();
          step = 3;
          formMessage = outcome.message;
          break;
        case 'formError':
          formMessage = outcome.message;
          break;
      }
    } catch {
      formMessage = `Network error. Please check your connection, or call us at ${PHONE_DISPLAY}.`;
    } finally {
      submitting = false;
      guard.end();
    }
  }

  // -------------------------------------------------------------------------
  // Day strip (BK-38)
  //
  // The labelling rules are pure and live in `booking-form.ts`; what is here is
  // the one thing that genuinely needs the DOM — which month the strip is
  // showing right now, as it scrolls.
  // -------------------------------------------------------------------------

  let stripEl = $state<HTMLDivElement | null>(null);

  /**
   * The month named above the strip.
   *
   * Seeded from the first date rather than left blank, so the header is correct
   * before any scroll happens and never renders as an empty line that pushes
   * the chips down when it fills (the strip sits above the fold on mobile).
   */
  let visibleMonth = $state('');

  /**
   * The clock the chips are labelled against, stamped when availability lands
   * rather than read per-chip.
   *
   * One instant for the whole strip, so a row rendered across a cutoff boundary
   * cannot label two days by two different "now"s. It is refreshed on every
   * `loadAvailability`, which is the only moment the strip's contents change.
   */
  let availabilityAt = $state(new Date());

  $effect(() => {
    if (dates.length > 0 && !visibleMonth) visibleMonth = monthHeading(dates[0].date);
  });

  /**
   * Read the month off the leftmost chip still in view.
   *
   * Geometry rather than arithmetic on `scrollLeft`: chips are not a fixed
   * width (a "Closed" caption is narrower than "5 open", and a boundary chip
   * carries a month), so any width-per-chip calculation would drift by the end
   * of the row.
   */
  function onStripScroll() {
    if (!stripEl) return;
    const left = stripEl.getBoundingClientRect().left;
    for (const chip of Array.from(stripEl.children) as HTMLElement[]) {
      // A chip counts as "the one in view" once its right edge clears the
      // container's left edge — i.e. any part of it is still visible.
      if (chip.getBoundingClientRect().right > left + 1) {
        const month = chip.dataset.month;
        if (month) visibleMonth = month;
        return;
      }
    }
  }

  const FIELD_CLASS =
    'w-full bg-yeg-bg border border-black/10 rounded-lg px-4 py-3 text-yeg-text placeholder-yeg-text-secondary/50 focus:outline-none focus:border-yeg-amber/50 transition-colors';
  const LABEL_CLASS = 'block text-xs text-yeg-text-secondary uppercase tracking-wider mb-2';
</script>

<div
  class="bg-white border border-black/10 rounded-xl p-6 lg:p-10 shadow-[0_4px_24px_rgba(0,0,0,0.06)]"
>
  <!--
    THE FALLBACK CARD, AND IT SAID "YOU'RE BOOKED" UNTIL BK-36.

    This branch is live, not theoretical: `storeConfirmation()` fails whenever
    `sessionStorage` refuses the write (private mode, storage pressure), and the
    handler at the top of this file deliberately keeps the visitor here rather
    than navigating them to a page with nothing to show. The request IS
    committed at that point — but under P9 a committed request is
    `pending_review`. Nobody has looked at it and nobody has paid for it.

    So the old heading was a claim about state that this component is in no
    position to make, under a checkmark, beside a reference number — the exact
    shape P9 exists to remove, on the surface a visitor is most likely to
    screenshot. BK-23 swept `/book/confirmed/`, `BookingConfirmation.svelte` and
    both messages; `verify-booking-email.ts` pins the claim out of the request
    EMAIL. Nothing pinned the island, which is how it survived.

    It now renders the request wording from the SAME constants `/book/received/`
    and the request email use, so the three cannot drift. `verify-cutover.ts`
    pins that this file makes no booked/confirmed claim at all.

    `result.emailSent` still gates the emailed line, and the constant is
    `RECEIVED_EMAILED_LINE` — "a copy of this REQUEST" — not `EMAILED_LINE`,
    which says "a copy of this confirmation". The message that went out is
    subject-lined "Request received"; nothing has been confirmed. That was the
    fourth sibling of the three claims above, and it survived the first pass
    because it hides inside a constant name rather than in a sentence.
    `BookingConfirmation.svelte` already made this exact choice for this exact
    state.
  -->
  {#if result}
    <div class="text-center py-12">
      <div class="w-16 h-16 rounded-full bg-yeg-amber/20 flex items-center justify-center mx-auto mb-6">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-yeg-amber-deep" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
      </div>
      <h3 class="font-display font-bold text-2xl text-yeg-text mb-2">{RECEIVED_HEADING}</h3>
      <p class="text-yeg-text-secondary mb-3">{RECEIVED_LEAD}</p>
      <p class="text-yeg-text-secondary mb-1">{result.slotLabel}</p>
      <p class="text-yeg-text-secondary text-sm">{RECEIVED_HOLD_LINE}</p>
      <p class="text-yeg-text-secondary text-sm mt-2">
        Reference #{result.id}. The visit takes about 30 minutes. To cancel or reschedule, call or
        text
        <a class="text-yeg-amber-deep font-semibold" href={PHONE_HREF}>{PHONE_DISPLAY}</a>.
      </p>
      {#if result.emailSent}
        <p class="text-yeg-text-secondary text-sm mt-2">{RECEIVED_EMAILED_LINE}</p>
      {/if}
    </div>
  {:else}
    <form onsubmit={handleSubmit} novalidate>
      <ol class="flex items-center gap-2 mb-8 text-xs uppercase tracking-wider" aria-label="Progress">
        {#each [{ n: 1, label: 'Time' }, { n: 2, label: 'Details' }, { n: 3, label: 'Photos' }] as s (s.n)}
          <li class="flex items-center gap-2">
            <span
              class="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold"
              class:bg-yeg-amber={step >= s.n}
              class:text-yeg-text={step >= s.n}
              class:bg-black-5={step < s.n}
              class:text-yeg-text-secondary={step < s.n}
              style={step < s.n ? 'background-color:rgba(0,0,0,0.06)' : ''}
              aria-current={step === s.n ? 'step' : undefined}>{s.n}</span
            >
            <span class:text-yeg-text={step === s.n} class="text-yeg-text-secondary">{s.label}</span>
            {#if s.n < 3}<span class="w-6 h-px bg-black/10" aria-hidden="true"></span>{/if}
          </li>
        {/each}
      </ol>

      <!-- ------------------------------------------------------------ Step 1 -->
      {#if step === 1}
        <fieldset class="border-0 p-0 m-0 min-w-0">
          <legend class="font-display font-bold text-xl text-yeg-text mb-1">
            When should we come out?
          </legend>
          <!--
            BK-27: this line used to open "Free on-site assessment", which the
            fee terms made conditional. It is inside the form whose step 3 now
            states the condition in full, so it says "about 30 minutes" and
            leaves the price to the place that qualifies it — a bare "free"
            two steps before the terms box is the contradiction the ticket
            exists to remove.
          -->
          <p class="text-sm text-yeg-text-secondary mb-5">
            On-site assessment, about 30 minutes. All times are Edmonton time.
          </p>

          {#if loadingAvailability}
            <p class="text-sm text-yeg-text-secondary py-8 text-center">Loading available times…</p>
          {:else if availabilityError}
            <div class="rounded-lg border border-yeg-signal/30 bg-yeg-signal/5 p-4">
              <p class="text-sm text-yeg-text mb-2">{availabilityError}</p>
              <a class="cta-primary text-sm" href={PHONE_HREF}>Call {PHONE_DISPLAY}</a>
              <button type="button" class="cta-secondary ml-4" onclick={() => loadAvailability()}>
                Try again
              </button>
            </div>
          {:else if allDaysFull}
            <!--
              Every day in the window is full. The generic "try another day"
              below is actively wrong here — there is no other day — so this is
              its own state, and it hands over to the two channels that can
              still take the job.
            -->
            <div class="rounded-lg border border-yeg-signal/30 bg-yeg-signal/5 p-4">
              <p class="text-sm text-yeg-text mb-2">
                We're fully booked for the next two weeks — call or send a message and we'll fit
                you in.
              </p>
              <a class="cta-primary text-sm" href={PHONE_HREF}>Call {PHONE_DISPLAY}</a>
              <a class="cta-secondary underline ml-4" href="/contact/">Send a message</a>
            </div>
          {:else}
            <p
              class="text-xs uppercase tracking-wider text-yeg-text-secondary mb-2"
              aria-hidden="true"
            >
              {visibleMonth}
            </p>

            <div
              bind:this={stripEl}
              onscroll={onStripScroll}
              class="flex gap-2 overflow-x-auto pb-2 mb-5"
            >
              {#each dates as d, i (d.date)}
                {@const kind = dayChipKind(d.date, d.weekday, d.slots.length, availabilityAt)}
                {@const boundary = startsNewMonth(d.date, dates[i - 1]?.date)}
                <button
                  type="button"
                  data-month={monthHeading(d.date)}
                  class="shrink-0 px-3 py-2 rounded-lg border text-sm transition-colors disabled:cursor-not-allowed"
                  class:border-yeg-amber={selectedDate === d.date}
                  class:bg-yeg-amber={selectedDate === d.date}
                  class:border-black-10={selectedDate !== d.date}
                  class:opacity-40={kind === 'full'}
                  class:opacity-50={kind === 'closed' || kind === 'elapsed'}
                  class:border-dashed={kind === 'closed' || kind === 'elapsed'}
                  style={selectedDate === d.date ? '' : 'border-color:rgba(0,0,0,0.1)'}
                  disabled={kind !== 'open'}
                  aria-pressed={selectedDate === d.date}
                  aria-label={`${dayChipLabel(d.date, d.weekday, boundary)}, ${dayChipCaption(kind, d.slots.length)}`}
                  onclick={() => (selectedDate = d.date)}
                >
                  <span class="block font-semibold">{dayChipLabel(d.date, d.weekday, boundary)}</span>
                  <span class="block text-[11px] text-yeg-text-secondary">
                    {dayChipCaption(kind, d.slots.length)}
                  </span>
                </button>
              {/each}
            </div>

            {#if selectedDay && selectedDay.slots.length > 0}
              <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {#each selectedDay.slots as slot (slot.start)}
                  <button
                    type="button"
                    class="px-3 py-3 rounded-lg border text-sm font-semibold transition-colors"
                    class:bg-yeg-amber={values.slotStart === slot.start}
                    style={values.slotStart === slot.start ? '' : 'border-color:rgba(0,0,0,0.1)'}
                    aria-pressed={values.slotStart === slot.start}
                    onclick={() => chooseSlot(slot)}
                  >
                    {slot.label.split('·')[1]?.trim() ?? slot.time}
                  </button>
                {/each}
              </div>
            {:else}
              <p class="text-sm text-yeg-text-secondary">
                Nothing open that day. Try another, or call us at
                <a class="text-yeg-amber-deep font-semibold" href={PHONE_HREF}>{PHONE_DISPLAY}</a>.
              </p>
            {/if}

            <!--
              Friday is closed by configuration, not by a blackout row, so the
              column simply is not there. Said out loud, the gap reads as
              policy; unsaid, it reads as a bug in the calendar.
            -->
            <p class="text-xs text-yeg-text-secondary mt-4">
              We're closed Fridays — every other day, including Sunday, is open.
            </p>
          {/if}

          {#if errors.slot_start}
            <p class="text-red-500 text-xs mt-3">{errors.slot_start}</p>
          {/if}
        </fieldset>

      <!-- ------------------------------------------------------------ Step 2 -->
      {:else if step === 2}
        <fieldset class="border-0 p-0 m-0 min-w-0">
          <legend class="font-display font-bold text-xl text-yeg-text mb-1">Where and what</legend>
          <p class="text-sm text-yeg-text-secondary mb-5">
            {chosenSlot ? chosenSlot.label : 'Appointment time selected.'}
          </p>

          <div class="space-y-5">
            <div>
              <label class={LABEL_CLASS} for="bk-name">Name</label>
              <input id="bk-name" class={FIELD_CLASS} class:border-red-500={errors.name}
                type="text" bind:value={values.name} maxlength={MAX_FIELD_LENGTHS.name}
                autocomplete="name" placeholder="Your name" />
              {#if errors.name}<p class="text-red-500 text-xs mt-1">{errors.name}</p>{/if}
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div>
                <label class={LABEL_CLASS} for="bk-phone">Phone</label>
                <input id="bk-phone" class={FIELD_CLASS} class:border-red-500={errors.phone}
                  type="tel" bind:value={values.phone} maxlength={MAX_FIELD_LENGTHS.phone}
                  autocomplete="tel" placeholder="(780) 479-3285" />
                {#if errors.phone}<p class="text-red-500 text-xs mt-1">{errors.phone}</p>{/if}
              </div>
              <div>
                <label class={LABEL_CLASS} for="bk-email">Email</label>
                <input id="bk-email" class={FIELD_CLASS} class:border-red-500={errors.email}
                  type="email" bind:value={values.email} maxlength={MAX_FIELD_LENGTHS.email}
                  autocomplete="email" placeholder="you@email.com" />
                {#if errors.email}<p class="text-red-500 text-xs mt-1">{errors.email}</p>{/if}
              </div>
            </div>

            <div>
              <label class={LABEL_CLASS} for="bk-service">Service needed</label>
              <select id="bk-service" class={`${FIELD_CLASS} appearance-none cursor-pointer`}
                class:border-red-500={errors.service} bind:value={values.service}>
                <option value="">Select a service</option>
                {#each services as s (s.id)}
                  <option value={s.id}>{s.name}</option>
                {/each}
                <option value="other">Other / not sure</option>
              </select>
              {#if errors.service}<p class="text-red-500 text-xs mt-1">{errors.service}</p>{/if}
              {#if values.service === 'other'}
                <p class="text-xs text-yeg-text-secondary mt-2">
                  Not sure is fine — describe it below and we'll work it out on site. If this
                  can't wait,
                  <a class="text-yeg-amber-deep font-semibold" href={PHONE_HREF}>call now</a>.
                </p>
              {/if}
            </div>

            <div>
              <label class={LABEL_CLASS} for="bk-address">Address</label>
              <input id="bk-address" class={FIELD_CLASS} class:border-red-500={errors.address}
                type="text" bind:value={values.address} maxlength={MAX_FIELD_LENGTHS.address}
                autocomplete="street-address" placeholder="123 Maple St" />
              {#if errors.address}<p class="text-red-500 text-xs mt-1">{errors.address}</p>{/if}
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div>
                <label class={LABEL_CLASS} for="bk-city">City</label>
                <input id="bk-city" class={FIELD_CLASS} class:border-red-500={errors.city}
                  type="text" bind:value={values.city}
                  maxlength={MAX_FIELD_LENGTHS.city} autocomplete="address-level2" />
                {#if errors.city}<p class="text-red-500 text-xs mt-1">{errors.city}</p>{/if}
                <p class="text-xs text-yeg-text-secondary mt-1">
                  Edmonton and area. Further out? Call first.
                </p>
              </div>
              <div>
                <label class={LABEL_CLASS} for="bk-postal">Postal code <span class="normal-case">(optional)</span></label>
                <input id="bk-postal" class={FIELD_CLASS} class:border-red-500={errors.postal_code}
                  type="text" bind:value={values.postal_code}
                  maxlength={MAX_FIELD_LENGTHS.postal_code} autocomplete="postal-code" placeholder="T5J 0N3" />
                {#if errors.postal_code}<p class="text-red-500 text-xs mt-1">{errors.postal_code}</p>{/if}
              </div>
            </div>

            <div>
              <label class={LABEL_CLASS} for="bk-description">What happened? <span class="normal-case">(optional)</span></label>
              <textarea id="bk-description" class={`${FIELD_CLASS} resize-none`} rows={3}
                bind:value={values.description} maxlength={MAX_FIELD_LENGTHS.description}
                placeholder="Burst pipe in the basement, water across the floor…"></textarea>
              {#if errors.description}<p class="text-red-500 text-xs mt-1">{errors.description}</p>{/if}
            </div>

            <fieldset class="border-0 p-0 m-0 min-w-0">
              <legend class={LABEL_CLASS}>How is this being paid for?</legend>
              <div class="grid grid-cols-2 gap-3">
                <label class="flex items-center gap-2 border rounded-lg px-4 py-3 cursor-pointer"
                  style="border-color:rgba(0,0,0,0.1)">
                  <input type="radio" name="payment_route" value="private"
                    bind:group={values.payment_route} />
                  <span class="text-sm">Paying privately</span>
                </label>
                <label class="flex items-center gap-2 border rounded-lg px-4 py-3 cursor-pointer"
                  style="border-color:rgba(0,0,0,0.1)">
                  <input type="radio" name="payment_route" value="insurance"
                    bind:group={values.payment_route} />
                  <span class="text-sm">Insurance claim</span>
                </label>
              </div>
              <!--
                Renters are the case neither option describes: the policy is
                usually the landlord's, and picking "paying privately" is how a
                tenant ends up personally invoiced for a covered loss.
              -->
              <p class="text-xs text-yeg-text-secondary mt-3">
                Renting? Choose insurance and mention it in the description below — we'll sort out
                whose policy it is.
              </p>
            </fieldset>

            {#if values.payment_route === 'insurance'}
              <div class="space-y-5 rounded-lg p-4" style="background-color:rgba(0,0,0,0.03)">
                <div>
                  <label class={LABEL_CLASS} for="bk-insurer">Insurance company</label>
                  <input id="bk-insurer" class={FIELD_CLASS} class:border-red-500={errors.insurer_name}
                    type="text" bind:value={values.insurer_name} maxlength={MAX_FIELD_LENGTHS.insurer_name} />
                  {#if errors.insurer_name}<p class="text-red-500 text-xs mt-1">{errors.insurer_name}</p>{/if}
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-5">
                  <div>
                    <label class={LABEL_CLASS} for="bk-policy">Policy number <span class="normal-case">(optional)</span></label>
                    <input id="bk-policy" class={FIELD_CLASS} class:border-red-500={errors.policy_number}
                      type="text" bind:value={values.policy_number}
                      maxlength={MAX_FIELD_LENGTHS.policy_number} />
                    {#if errors.policy_number}<p class="text-red-500 text-xs mt-1">{errors.policy_number}</p>{/if}
                  </div>
                  <div>
                    <label class={LABEL_CLASS} for="bk-claim">Claim number <span class="normal-case">(optional)</span></label>
                    <input id="bk-claim" class={FIELD_CLASS} class:border-red-500={errors.claim_number}
                      type="text" bind:value={values.claim_number}
                      maxlength={MAX_FIELD_LENGTHS.claim_number} />
                    {#if errors.claim_number}<p class="text-red-500 text-xs mt-1">{errors.claim_number}</p>{/if}
                  </div>
                </div>
                <p class="text-xs text-yeg-text-secondary">
                  Have these handy for the visit — we never send them by text.
                </p>
              </div>
            {/if}
          </div>
        </fieldset>

      <!-- ------------------------------------------------------------ Step 3 -->
      {:else}
        <fieldset class="border-0 p-0 m-0 min-w-0">
          <legend class="font-display font-bold text-xl text-yeg-text mb-1">Photos and confirm</legend>
          <p class="text-sm text-yeg-text-secondary mb-5">
            Add at least one photo or video of the damage. It's how we arrive with the right
            equipment and the right crew.
          </p>

          <div class="rounded-lg border border-dashed p-5 mb-5" style="border-color:rgba(0,0,0,0.15)">
            <label class="cta-primary text-sm cursor-pointer inline-flex" for="bk-files">
              Add photos or video
            </label>
            <input id="bk-files" class="sr-only" type="file" multiple accept={ACCEPT}
              onchange={onFilesChosen} />
            <p class="text-xs text-yeg-text-secondary mt-3">
              Up to {MAX_FILES_PER_BOOKING} files, {formatBytes(MAX_FILE_BYTES)} each. Uploads are
              final for this booking.
            </p>

            <!--
              One line, never two. `photoNotice` wins when both are set: it is
              the specific complaint (this file was rejected, or photos cannot
              be attached at all and here is what to do instead), while
              `errors.files` is the generic requirement, and stacking two red
              lines in one box reads as two separate problems. `photoNotice` is
              cleared on every new selection, so the generic line reappears the
              moment the specific one stops applying.
            -->
            {#if photoNotice}
              <p class="text-red-500 text-xs mt-3" role="alert">{photoNotice}</p>
            {:else if errors.files}
              <p class="text-red-500 text-xs mt-3" role="alert">{errors.files}</p>
            {/if}

            {#if attachments.length > 0}
              <ul class="mt-4 space-y-2">
                {#each attachments as file (file.id)}
                  <li class="flex items-center justify-between gap-3 text-sm">
                    <span class="truncate">{file.name}</span>
                    <span class="shrink-0 text-xs text-yeg-text-secondary">
                      {#if file.status === 'uploading'}
                        {file.progress}%
                        <button type="button" class="cta-secondary underline ml-1"
                          onclick={() => skipUpload(file.id)}>Skip</button>
                      {:else if file.status === 'done'}
                        Attached
                      {:else}
                        {file.message}
                        <button type="button" class="cta-secondary underline ml-1"
                          onclick={() => sendUpload(file.id)}>Retry</button>
                      {/if}
                    </span>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>

          <!--
            BK-27. The terms box and its checkbox are one unit and must stay
            adjacent in this order: `FEE_TERMS_ACK_LABEL` says "the assessment
            terms above", which is a claim about this markup. Moving the box, or
            putting the SMS consent between them, makes the label a lie.

            THIS IS THE ACKNOWLEDGED COPY, and it is the reason BK-36 could move
            `/book/`'s informational block below the picker without touching the
            label's claim: the box the label points at is this one, not that one.

            Order inside the box is a constraint, not layout — HEADING -> INTRO
            -> ITEMS -> PAYMENT -> REFUND -> CREDIT, then the radios, then the
            checkbox below. The prose ends on the credit because the last thing
            read should be the good news, and everything being acknowledged
            (the tier choice included) sits above the box that acknowledges it.
            `verify-cutover.ts` pins the whole chain.
          -->
          <div class="rounded-lg p-4 mb-3 text-sm" style="background-color:rgba(0,0,0,0.03)">
            <p class="font-semibold text-yeg-text mb-1">{FEE_TERMS_HEADING}</p>
            <p class="text-yeg-text-secondary">{FEE_TERMS_INTRO}</p>
            <ul class="mt-2 space-y-1 text-yeg-text-secondary list-disc pl-5">
              {#each FEE_TERMS_ITEMS as item}
                <li>{item}</li>
              {/each}
            </ul>
            {#each FEE_TERMS_PAYMENT as line}
              <p class="text-yeg-text-secondary mt-2">{line}</p>
            {/each}
            {#each FEE_TERMS_REFUND as line}
              <p class="text-yeg-text-secondary mt-2">{line}</p>
            {/each}
            <p class="text-yeg-text-secondary mt-2">{FEE_TERMS_CREDIT}</p>

            <!--
              BK-31. The radios live INSIDE the terms box and at the bottom of
              it, which keeps `FEE_TERMS_ACK_LABEL`'s "the terms above" true:
              everything the visitor is acknowledging, the choice included, is
              above the checkbox that follows.

              No `checked` on any option. A pre-selected tier charges someone
              for a choice they never made, and the server rejects a missing
              tier rather than defaulting one.
            -->
            <fieldset class="mt-4">
              <legend class="font-semibold text-yeg-text mb-2">{ASSESSMENT_TIER_LEGEND}</legend>
              <!--
                The weekend note belongs HERE, not beside the total, because
                the radio prices are already multiplied before any tier is
                picked. Gated on the same `tierQuotes` the prices come from,
                so the explanation and the higher number appear together by
                construction: a Saturday visitor comparing three inflated
                figures against a terms box quoting the standard ones sees why
                at the moment of comparison, not after committing to a radio.
                Any tier answers `afterHours` — it is a property of the slot,
                not of the tier — so the first one is read arbitrarily.
              -->
              {#if tierQuotes?.[ASSESSMENT_TIERS[0]].afterHours}
                <p class="text-yeg-text-secondary mb-2">{AFTER_HOURS_NOTE}</p>
              {/if}
              <div class="space-y-2">
                {#each ASSESSMENT_TIERS as tier}
                  <label
                    class="flex items-start gap-3 cursor-pointer rounded-lg p-3"
                    style="background-color:{values.assessmentTier === tier
                      ? 'rgba(0,0,0,0.05)'
                      : 'transparent'}"
                  >
                    <input
                      type="radio"
                      class="mt-1 shrink-0"
                      name="assessment_tier"
                      value={tier}
                      bind:group={values.assessmentTier}
                    />
                    <span class="min-w-0">
                      <span class="flex flex-wrap items-baseline gap-x-2">
                        <span class="font-semibold text-yeg-text">{ASSESSMENT_TIER_NAMES[tier]}</span>
                        {#if tierQuotes}
                          <span class="text-yeg-text font-semibold whitespace-nowrap">
                            {formatCents(tierQuotes[tier].baseCents)} + GST
                          </span>
                        {/if}
                      </span>
                      <span class="block text-yeg-text-secondary mt-1">
                        {ASSESSMENT_TIER_DESCRIPTIONS[tier]}
                      </span>
                    </span>
                  </label>
                {/each}
              </div>
              {#if errors.assessment_tier}
                <p class="text-red-500 text-xs mt-1" role="alert">{errors.assessment_tier}</p>
              {/if}
            </fieldset>

            <!--
              The total, once all three inputs exist. Rendered from the same
              `assessmentQuote` the server will call, so the customer and the
              charge cannot come from two different calculations.

              The weekend note is not decoration: a 1.5x figure a visitor
              discovers by comparing it against the terms box reads as an error
              or as sharp practice. It is stated where the higher number is.
            -->
            {#if quote}
              <div class="mt-4 pt-3" style="border-top:1px solid rgba(0,0,0,0.08)">
                <p class="font-semibold text-yeg-text">{QUOTE_HEADING}</p>
                <dl class="mt-2 space-y-1">
                  <div class="flex justify-between gap-4">
                    <dt class="text-yeg-text-secondary">Assessment</dt>
                    <dd class="text-yeg-text">{formatCents(quote.baseCents)}</dd>
                  </div>
                  <div class="flex justify-between gap-4">
                    <dt class="text-yeg-text-secondary">GST</dt>
                    <dd class="text-yeg-text">{formatCents(quote.gstCents)}</dd>
                  </div>
                  <div class="flex justify-between gap-4 font-semibold">
                    <dt class="text-yeg-text">Total</dt>
                    <dd class="text-yeg-text">{formatCents(quote.totalCents)}</dd>
                  </div>
                </dl>
                <p class="text-yeg-text-secondary mt-2 text-xs">{QUOTE_TIMING_NOTE}</p>
              </div>
            {/if}
          </div>

          <div class="mb-5">
            <label class="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" class="mt-1" bind:checked={values.termsAck} />
              <span class="text-sm text-yeg-text">{FEE_TERMS_ACK_LABEL}</span>
            </label>
            {#if errors.terms_ack}
              <p class="text-red-500 text-xs mt-1" role="alert">{errors.terms_ack}</p>
            {/if}
          </div>

          <label class="flex items-start gap-3 mb-5 cursor-pointer">
            <input type="checkbox" class="mt-1" bind:checked={values.smsConsent} />
            <span class="text-sm text-yeg-text-secondary">
              Text me a reminder from YEG Restoration before the appointment, at the number above. Message and data rates
              may apply; reply STOP to opt out. Optional — your request goes through either way.
            </span>
          </label>

          <div class="rounded-lg p-4 text-sm" style="background-color:rgba(0,0,0,0.03)">
            <p class="font-semibold text-yeg-text">{chosenSlot?.label ?? 'Your appointment'}</p>
            <p class="text-yeg-text-secondary">{values.address}{values.city ? `, ${values.city}` : ''}</p>
            <p class="text-yeg-text-secondary mt-2 text-xs">
              To change or cancel, call or text {PHONE_DISPLAY}.
            </p>
          </div>
        </fieldset>
      {/if}

      {#if formMessage}
        <p class="text-red-500 text-sm mt-5 text-center" role="alert">{formMessage}</p>
      {/if}

      <div class="flex items-center gap-3 mt-8">
        {#if step > 1}
          <button type="button" class="cta-secondary" onclick={() => goTo((step - 1) as Step)}>
            Back
          </button>
        {/if}
        <div class="ml-auto">
          {#if step < 3}
            <button type="button" class="cta-primary" onclick={nextStep} disabled={!hydrated}>
              Continue
            </button>
          {:else}
            <button type="submit" class="cta-primary disabled:opacity-60 disabled:cursor-not-allowed"
              disabled={busy || !hydrated}>
              <!--
                "Send request", not "Confirm booking" (BK-36). The button that
                commits is the loudest mechanism claim on the page, and under
                prepay it commits a REQUEST — review and payment both come
                after. Same defect family as the fallback card above and the
                homepage's old "Instant confirmation" bullet.
              -->
              {submitting || leaving
                ? 'Sending…'
                : uploadsInFlight > 0
                  ? 'Uploading…'
                  : 'Send request'}
            </button>
          {/if}
        </div>
      </div>
    </form>
  {/if}
</div>
