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

/** A slot must start at least this far in the future to be publicly bookable. */
export const MIN_NOTICE_HOURS = 4;

/** The public calendar shows at most this many days ahead. */
export const MAX_ADVANCE_DAYS = 14;

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

/** Draft tokens expire this long after being issued — an upper bound on how long a form sits open. */
export const DRAFT_TOKEN_TTL_HOURS = 6;

/** Draft tokens a single IP may request per hour. Gates the whole upload funnel. */
export const DRAFT_RATE_LIMIT_PER_HOUR = 20;

/**
 * Bookings a single IP may commit per hour. Generous next to five slots a day —
 * it exists to stop a script, not to ration a household or an office behind one
 * NAT. Must stay above the concurrency hammer's request count in
 * `scripts/verify-booking-commit.ts`, or the hammer's expected 409s arrive as 429s.
 */
export const BOOKING_RATE_LIMIT_PER_HOUR = 30;

// ---------------------------------------------------------------------------
// Endpoints
//
// The trailing slashes are required. astro.config.mjs sets
// trailingSlash: 'always', so the unslashed form answers with a 308 redirect
// rather than running the function.
// ---------------------------------------------------------------------------

export const BOOKING_AVAILABILITY_ENDPOINT = '/api/booking/availability/';
export const BOOKING_CREATE_ENDPOINT = '/api/booking/create/';
export const BOOKING_DRAFT_ENDPOINT = '/api/booking/draft/';
export const BOOKING_UPLOAD_ENDPOINT = '/api/booking/upload-token/';
