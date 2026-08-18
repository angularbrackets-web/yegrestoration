/**
 * Single source of truth for booking rules.
 *
 * Imported by BOTH the public date picker and the server-side validator so
 * the two can never drift. Nothing in here reads the environment — it is
 * safe to import from Svelte islands, API routes, and CLI scripts alike.
 */

/** Every wall-clock time in the booking system is this zone. */
export const TIMEZONE = 'America/Edmonton';

/**
 * Bookable start times, local wall clock.
 *
 * Appointments are 30 minutes with a mandatory 30-minute gap after each,
 * which collapses to an hourly grid. The last start is 15:30, ending the
 * day at 16:00 (no trailing gap needed). Five slots a day is the office's
 * "max 5 per day" falling out of the grid rather than being enforced.
 */
export const SLOT_START_TIMES = [
  '11:30',
  '12:30',
  '13:30',
  '14:30',
  '15:30',
] as const;

/** Appointment length. The 30-minute buffer after it lives in the grid above. */
export const SLOT_MINUTES = 30;

/** 0 = Sunday … 6 = Saturday. Fridays are permanently off — config, not a blackout row. */
export const CLOSED_WEEKDAYS: readonly number[] = [5];

/**
 * How many CALENDAR DAYS ahead the earliest publicly bookable slot sits.
 *
 * `1` means next-day earliest: no same-day web bookings, and every slot from
 * tomorrow onward is offered regardless of the hour it is now. Client decision,
 * 2026-08-18.
 *
 * ── WHY DAYS AND NOT HOURS ────────────────────────────────────────────────
 *
 * This replaced `MIN_NOTICE_HOURS = 4`. P9 first recorded the client's
 * 2026-08-12 decision as "4h → 24h", and 24 rolling hours is NOT the same rule:
 * it would refuse a Wednesday 11:30 slot to somebody booking Tuesday at 15:00,
 * which next-day-earliest allows. The client's 2026-08-18 answer is the
 * calendar-day version, so that is what ships. The intent was always the same —
 * the office will not take a web booking for today.
 *
 * ── WHAT IT DOES TO THE PAYMENT DEADLINE ──────────────────────────────────
 *
 * The tight case is a request at 15:29 for the next day's 11:30: about 20 hours
 * of notice, but an 07:00 approval leaves barely half an hour before
 * `slot − 4h`. That case is covered by the pay-now branch rather than by this
 * constant — see `PAY_NOW_THRESHOLD_HOURS`, which skips the deferred deadline
 * entirely when the slot is close. This constant deliberately does not try to
 * guarantee a payable window; a rule that did would have to be hours-based and
 * would refuse the bookings the client wants to take.
 *
 * The admin grid is exempt from this and from every other window check — see
 * `ADMIN_MIN_NOTICE_HOURS`.
 */
export const MIN_NOTICE_DAYS = 1;

/**
 * The floor the office works to when typing a booking in by hand.
 *
 * Documentation rather than enforcement: `api/admin/appointments/create.ts`
 * never calls `isSlotBookable`, so nothing checks this. It is recorded because
 * "the admin path has a 4-hour floor" is the sentence everybody repeats, and
 * the truth is that the admin path has no floor at all — an emergency at 08:00
 * for 11:30 is exactly what that bypass is for.
 */
export const ADMIN_MIN_NOTICE_HOURS = 4;

/** The public calendar shows at most this many days ahead. */
export const MAX_ADVANCE_DAYS = 14;

// ---------------------------------------------------------------------------
// The payment window (BK-23 / BK-32)
//
// Three constants that have to be read together, because two of them describe
// the same deadline from different ends and the third is what stops them
// producing a deadline in the past.
// ---------------------------------------------------------------------------

/**
 * How long a customer gets to pay, measured from the moment the office
 * approves.
 *
 * Approve at 9am, pay by 9pm. Long enough for somebody at work, short enough to
 * recycle a slot that is not going to be paid for. A business-feel number, not
 * an engineering one — the client may move it and it is a constant so that they
 * can.
 */
export const PAYMENT_WINDOW_HOURS = 12;

/**
 * The other end of the same deadline: payment must land at least this far
 * before the visit.
 *
 * Past this point a confirmation can no longer usefully complete — the crew is
 * being dispatched — which is why the auto-decline timer is pinned to the same
 * instant rather than to a number somebody picked.
 */
export const PAYMENT_DEADLINE_LEAD_HOURS = 4;

/**
 * Below this much time-to-slot at approval, the deferred deadline is skipped
 * and the link is sent to be paid NOW.
 *
 * REQUIRED, NOT AN OPTIMISATION. `min(approved_at + 12h, slot − 4h)` produces a
 * deadline in the past — or minutes away — whenever the slot is close, and
 * "close" is reachable on both paths: a 2am emergency typed in by the office,
 * and an ordinary web request made at 15:29 for the next day's 11:30 that the
 * office approves at 07:00. Without this branch those bookings get a link that
 * is dead on arrival, or one that expires while the customer is finding their
 * card.
 *
 * Eight hours covers both. When it applies, `payment_due_at` is left NULL and
 * the expiry cron must leave the row alone — the office is on the phone to that
 * customer, not waiting on a timer.
 */
export const PAY_NOW_THRESHOLD_HOURS = 8;

/** How long before the appointment the reminder SMS goes out. */
export const REMINDER_LEAD_HOURS = 3;

// ---------------------------------------------------------------------------
// Upload limits
//
// All three are enforced server-side when the upload token is minted, not
// just in the browser. Per-file size is handed to Vercel Blob as a hard
// ceiling on the token itself, so an oversized body is rejected by Blob even
// if our own check is bypassed.
// ---------------------------------------------------------------------------

export const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB
export const MAX_FILES_PER_BOOKING = 10;
export const MAX_TOTAL_BYTES = 300 * 1024 * 1024; // 300 MB

/**
 * Accepted upload types. `image/heic` and `image/heif` matter — that is what
 * iPhones produce by default. `video/quicktime` is the iPhone .mov container.
 */
export const ALLOWED_UPLOAD_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'video/mp4',
  'video/quicktime',
  'video/webm',
];

/** Extension used for each accepted type. Pathnames are server-validated against this map. */
export const UPLOAD_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

/** Uploads not claimed by a booking within this window are deleted by the cleanup cron. */
export const UPLOAD_ORPHAN_TTL_HOURS = 24;

/**
 * How long an admin file link stays usable.
 *
 * The Blob store is private, so `/api/admin/files/<id>/` answers a 302 to a
 * presigned CDN URL. That URL is a CAPABILITY: whoever holds it can fetch that
 * one blob, with no cookie and no session, until it expires. Five minutes is
 * long enough to open a 100 MB walkthrough video and short enough that a URL
 * pasted into a chat log is dead before anyone reads it. Re-clicking the link
 * mints a fresh one, so shortening this costs the office nothing.
 */
export const FILE_LINK_TTL_MS = 5 * 60_000;

/**
 * Wall-clock ceiling on the one Blob control-API call an admin file link makes.
 *
 * Read off the installed SDK (@vercel/blob 2.6.1, `dist/chunk-*.js`):
 * `requestApi` wraps every call in `async-retry` with `retries: 10`, and both
 * network errors and 5xx responses re-throw into that loop. A down control API
 * therefore keeps `issueSignedToken` pending well past the platform function
 * limit, and the office gets a platform 504 instead of this route's 502. The
 * same source shows the escape: an `AbortError` from the in-flight fetch calls
 * `bail(new BlobRequestAbortedError())`, which ends the retry loop immediately
 * rather than counting as another failure. So an `AbortSignal.timeout` on the
 * issue call is what makes "Blob API down → 502" true rather than merely
 * intended. Fast-bail failures (a bad token, any 4xx) never reach it.
 */
export const BLOB_ISSUE_TIMEOUT_MS = 4000;

/** Draft tokens expire this long after being issued — an upper bound on how long a form sits open. */
export const DRAFT_TOKEN_TTL_HOURS = 6;

/**
 * Draft tokens a single IP may request per hour. Gates the whole upload funnel.
 *
 * Raised 20 → 50 by BK-22 (user decision, 2026-08-12), because that ticket made
 * a photo mandatory and turned this from "how many people can attach photos"
 * into **how many people can book at all**. One shared connection — an office,
 * an apartment building, a coffee shop — exhausting it now locks everyone
 * behind it out of the booking form entirely.
 *
 * It is also a storage-cost ceiling, which is why the number was the user's to
 * pick rather than the implementer's: each draft independently permits 10 files
 * / 300 MB (`upload-token.ts`), so the worst case from a single IP is ~6 GB/h
 * at 20 and ~15 GB/h at 50. The 100 that was floated would have been ~30 GB/h
 * and was not taken. The island mints exactly one draft per form session
 * (memoised in `booking-form.ts`), so the real unit is booking sessions per
 * hour per NAT, and 50 is headroom for any plausible shared connection.
 *
 * Note `/api/booking/upload-token/` has no limit of its own, so one draft token
 * is worth 10 unthrottled calls — raising this scales that linearly. Recorded
 * in the ROADMAP's Known traps; the per-draft caps are what bound it.
 */
export const DRAFT_RATE_LIMIT_PER_HOUR = 50;

/**
 * Bookings a single IP may commit per hour. Generous next to five slots a day —
 * it exists to stop a script, not to ration a household or an office behind one
 * NAT. Must stay above the concurrency hammer's request count in
 * `scripts/verify-booking-commit.ts`, or the hammer's expected 409s arrive as 429s.
 */
export const BOOKING_RATE_LIMIT_PER_HOUR = 30;

/**
 * How long an SMS'd photo-upload link stays live (BK-34a).
 *
 * 72h, not the draft token's 6h: a customer texted at 4pm looks at it that
 * evening or the next morning, and a link that has died by then sends them back
 * to the office to ask for another one.
 *
 * That is twelve times the draft token's exposure, which is exactly why
 * `/api/booking/appointment-upload-token/` carries a rate limit that
 * `/api/booking/upload-token/` does not. The Known trap tolerated there — one
 * draft token is worth 10 unthrottled calls — is tolerable because a draft
 * token dies in 6h and is minted behind a throttle. Neither is true here.
 */
export const APPOINTMENT_UPLOAD_TTL_HOURS = 72;

/**
 * Token requests per hour, per APPOINTMENT — not per IP.
 *
 * The customer is on a phone behind CGNAT, so an IP bucket would either be
 * shared with strangers or be meaningless. The thing worth bounding is the
 * link.
 *
 * 30 covers the 10-file cap with room for retries on a bad connection, which is
 * the case this whole feature exists for. The per-appointment file and byte
 * caps are still what bound storage; this bounds the SQL.
 */
export const APPOINTMENT_UPLOAD_RATE_LIMIT_PER_HOUR = 30;

// ---------------------------------------------------------------------------
// Paths and endpoints
//
// The trailing slashes are required. astro.config.mjs sets
// trailingSlash: 'always', so the unslashed form answers with a 308 redirect
// rather than running the function.
// ---------------------------------------------------------------------------

/** The booking form. Where a confirmed page with nothing to show sends people. */
export const BOOKING_PATH = '/book/';

/**
 * Where a SUBMITTED REQUEST lands (BK-23). Both `noindex` and out of the
 * sitemap, like its sibling below.
 *
 * New in P9, and the split is the point. Submitting the form used to produce a
 * booking, so it landed on a page that said "You're booked". It now produces a
 * REQUEST the office has not looked at and nobody has paid for, and that page
 * would be making the exact claim this whole flow exists to stop making — on
 * the one surface a customer is most likely to believe, and most likely to
 * screenshot.
 *
 * `/book/confirmed/` is kept rather than repurposed, for two reasons: it is
 * live and may be linked, and BK-32's Stripe `success_url` needs a
 * post-payment landing page anyway. Reusing it there is the smaller diff and
 * leaves both URLs saying something true.
 */
export const BOOKING_RECEIVED_PATH = '/book/received/';

/**
 * Where a PAID booking lands. Both `noindex` and out of the sitemap.
 *
 * Since BK-23 this is reached from the payment redirect, not from the form.
 */
export const BOOKING_CONFIRMED_PATH = '/book/confirmed/';

export const BOOKING_AVAILABILITY_ENDPOINT = '/api/booking/availability/';
export const BOOKING_CREATE_ENDPOINT = '/api/booking/create/';
export const BOOKING_DRAFT_ENDPOINT = '/api/booking/draft/';
export const BOOKING_UPLOAD_ENDPOINT = '/api/booking/upload-token/';

/**
 * The customer-facing photo-upload page for a phone booking (BK-34a).
 *
 * Deliberately NOT under `/admin` — `src/middleware.ts` gates `/admin` and
 * `/api/admin` by prefix, and this page's authorization is the signed token it
 * carries. Putting it under the admin prefix would make it unreachable for the
 * one person it is for.
 */
export const APPOINTMENT_UPLOAD_PATH = '/upload/';

/**
 * The query parameter the token travels in.
 *
 * THE TOKEN IS IN THE QUERY STRING, NOT THE PATH, AND THAT IS LOAD-BEARING.
 * `astro.config.mjs` sets `trailingSlash: 'always'`, which makes the Vercel
 * adapter emit a PRE-FILESYSTEM route that strips the trailing slash from any
 * path whose last segment contains a dot:
 *
 *   { "src": "^/((?:[^/]+/)*[^/]+\\.\\w+)/$", "Location": "/$1", "status": 308 }
 *
 * A token is `a1.<id>.<uuid>.<ms>.<64 hex>` — its last segment always ends in
 * `.` + word characters — so `/upload/<token>/` 308'd to the unslashed form,
 * missed `^/upload/([^/]+?)/$` (which requires the slash), fell through the
 * filesystem phase and landed on `/404.html`. Every link, unconditionally.
 * Found in implementation review by simulating the generated route table; the
 * dev server does not have one, so `astro dev` smoke tests were green
 * throughout. See the Known trap in `/CLAUDE.md`.
 *
 * A query string is immune to the whole class rather than escaped around it:
 * Vercel's `src` patterns match the PATH only, and `/upload/` has no dot in any
 * segment. Escaping the dots instead (`.` → `~`, base64url) would have left the
 * next person to add a token-bearing route to rediscover this.
 *
 * `scripts/verify-appointment-upload.ts` asserts it against the real generated
 * route table, so this cannot regress silently.
 */
export const APPOINTMENT_UPLOAD_TOKEN_PARAM = 't';

export const APPOINTMENT_UPLOAD_ENDPOINT = '/api/booking/appointment-upload-token/';

/** `/upload/?t=<token>` — the whole capability is the token, so nothing else is in it. */
export function appointmentUploadUrl(token: string): string {
  return `${APPOINTMENT_UPLOAD_PATH}?${APPOINTMENT_UPLOAD_TOKEN_PARAM}=${encodeURIComponent(token)}`;
}

// ---------------------------------------------------------------------------
// Contact points and outbound mail
//
// These duplicate `BUSINESS` in `src/data/services.ts` on purpose. That module
// imports `.jpg` assets, so it cannot be loaded under `tsx` — putting these
// there would put the whole email builder out of reach of a verify script.
// ---------------------------------------------------------------------------

/** The number every customer-facing message tells people to call or text. */
export const SUPPORT_PHONE = '(780) 479-3285';

/** Same sender identity the contact form uses, so no new domain verification. */
export const BOOKING_EMAIL_FROM = 'YEG Restoration <noreply@yegrestoration.ca>';

/**
 * Where a reply to a confirmation lands. People *do* reply to booking
 * confirmations, which is the only thing that makes a `noreply` sender
 * acceptable above.
 */
export const BOOKING_EMAIL_REPLY_TO = 'info@yegrestoration.ca';

/** Who hears that a crew is expected somewhere. Settled with the user 2026-08-09. */
export const BOOKING_INTERNAL_TO = 'info@yegrestoration.ca';

/**
 * Where an Interac e-Transfer goes (BK-32, merged in 2026-08-18).
 *
 * A real payment route, not a fallback: the client offers it alongside the card
 * link, and the approval email names both. There is no inbox automation — the
 * office reads their own mail and marks the booking paid, which is deliberate
 * and is recorded as out of scope rather than as a gap.
 *
 * `null` would mean the client has not given one, and the approval message
 * would then have to rely on the card link alone. It is a constant rather than
 * an env var because it is a published address, not a secret.
 */
export const INTERAC_EMAIL: string | null = 'info@yegrestoration.ca';

// ---------------------------------------------------------------------------
// Calendar invites (BK-14)
//
// Here rather than in `booking-ics.ts` for the same reason as the addresses
// above: one place holds the identities, and a `tsx` script can import it.
// ---------------------------------------------------------------------------

/**
 * The right-hand side of every booking's iCalendar UID
 * (`booking-<id>@yegrestoration.ca`). The SERIAL id is the only reference this
 * system has; there is no human-facing reference column.
 */
export const ICS_UID_DOMAIN = 'yegrestoration.ca';

/** RFC 5545 §3.7.3 product identifier. Free text; it identifies who wrote the file. */
export const ICS_PRODID = '-//YEG Restoration//Booking//EN';

/**
 * `ORGANIZER:mailto:` takes a BARE ADDRESS, not the friendly-name form
 * `BOOKING_EMAIL_FROM` carries — and Gmail matches a CANCEL against the
 * organizer of the event it is cancelling, so the two must be byte-identical
 * across the lifecycle. That is why this is its own constant rather than
 * something derived from `BOOKING_EMAIL_FROM` at each call site: a derivation
 * is a place the two spellings can drift, and the failure is silent (the
 * CANCEL simply never clears the event).
 */
export const ICS_ORGANIZER = 'noreply@yegrestoration.ca';

/**
 * Total wall-clock budget for everything that happens AFTER the appointment row
 * is inserted: building the messages, sending both, and stamping the result.
 *
 * One budget for the whole block rather than one timer per send. Two serial
 * 5-second races would stack on top of the rate-limit query, two availability
 * queries and the insert; nothing in this repo raises the function limit
 * (`vercel.json` has no `functions` block, `astro.config.mjs` sets no adapter
 * `maxDuration`), so the platform default applies and blowing it returns a
 * platform 504 — which `mapCommitResponse` shows the customer as "something
 * went wrong", for a booking that committed. Sized against the lowest
 * documented Vercel default (10s); BK-11 confirms the plan's real limit.
 */
export const POST_COMMIT_BUDGET_MS = 5000;
