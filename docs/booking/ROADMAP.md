# Booking system — roadmap

Self-service appointment booking, replacing the contact form. Built on the existing
Neon + Vercel functions + Resend stack. Cal.com was evaluated and rejected on
2026-07-28: it brings its own DB, auth, and user model that sit badly beside the
single-password admin, and covers none of the custom needs (insurance toggle,
policy/claim fields, media upload, SMS).

Process rules are in `/CLAUDE.md`. Ticket files are in `tickets/`.

## Locked — do not relitigate

Reviewers and planners: treat this section as settled. Raise it only if a ticket
cannot be built without changing it.

**Scheduling** (client-confirmed 2026-07-31) — America/Edmonton. 30-minute
appointments with a mandatory 30-minute gap, which collapses to an hourly grid:
11:30, 12:30, 13:30, 14:30, 15:30. Last start 15:30, day ends 16:00. "Max 5/day"
falls out of the grid rather than being enforced separately. Open every day
**including Sunday, except Friday** (Friday is config, not a blackout row).
Booking window: 4 hours minimum notice, 14 days maximum. The public calendar is
**initial assessments only** — follow-ups and emergencies are phone-in and entered
manually via admin. Uploads: 100 MB/file, 10 files, 300 MB total, all enforced
when the token is minted.

**Data model** — `appointments`, `appointment_files`, `blackout_dates`,
`rate_limits`, `schema_migrations`. `leads` is untouched and coexists.

- `pipeline_stage` (assessment|mitigation|restoration) and `status`
  (booked|completed|cancelled|no_show) are independent columns. Neither derives
  from the other.
- Double-booking guard is a partial unique index: `UNIQUE(slot_start) WHERE status
  <> 'cancelled'`. Cancelling frees the slot but keeps the record. **Assumes a
  single crew**; becomes `(slot_start, technician_id)` if that ever changes.
- That index only catches *identical* start times, so admin entries must snap to
  the same grid, and `duration_minutes` carries `CHECK (duration_minutes = 30)`.
  A longer visit is two consecutive slots. Widening the CHECK requires real
  overlap detection (tstzrange + btree_gist exclusion constraint).
- `slot_end` is deliberately not a generated column — Postgres rejects
  `timestamptz + interval` as non-immutable in a generation expression.
- No `sms_consent` boolean. The presence of `sms_consent_at` *is* the consent (CASL).
- `policy_number` / `claim_number` are insurance-only and must never appear in an
  SMS body.
- `blackout_dates` PK column is `day`, not `date`.

## Known traps

- **`trailingSlash: 'always'` applies to API routes.** Generated Vercel patterns
  are `^/api/booking/draft/$`; the unslashed form 308-redirects. Client fetches and
  the vercel.json cron path must include the trailing slash. Constants exist in
  `booking-config.ts`. Pre-existing bug: `ContactForm.svelte` posts to
  `/api/contact` unslashed and eats a 308 — fixed in P5.
- **`onUploadCompleted` never fires on localhost.** Rows stay
  `upload_state = 'pending'` in dev, so the booking commit must claim files
  regardless of upload_state.
- **Migrations are not atomic** — Neon's HTTP driver has no cross-call transaction.
  Safe only because every statement is IF NOT EXISTS and the ledger row is written
  last.
- **The Blob store is private.** Admin viewing needs an authenticated function
  proxy (BK-09), not a direct URL.
- **Writing verification scripts target the Neon dev branch, never production.**
  `DATABASE_URL_DEV` in `.env` is the dev branch; `DATABASE_URL` stays
  production. A script that writes must refuse to run when `DATABASE_URL_DEV`
  is unset rather than falling back, and `--allow-production` is reserved for
  deliberate smoke tests. Set up as BK-02 step zero.
- Vercel Blob's 4.5 MB limit is the *function body* limit and applies to server
  uploads only. Client uploads bypass it and cost no data transfer.
- **`Lead` timestamp fields are typed `string` but the driver returns `Date`**
  (severity: doc-level — every consumer wraps them in `new Date(...)`, which
  takes either; found in BK-01, owner: BK-10, the next ticket that touches
  `leads`).

## Red-observed — back-catalog pass (2026-08-06)

One-time break-and-observe over the verify scripts that shipped green with no
recorded red runs (the Red-first rule in `/CLAUDE.md`, applied retroactively
after masjid-fundraiser's audit found the same exposure). For each line the
production target was broken, the script observed red, and the target restored;
both scripts re-ran green afterwards. All 15 failure modes went red — no fifth
instance of the never-fails class.

- `verify:slots` — wall clock (`zonedTimeToUtc` +30 min); DST (`zoneOffsetMs`
  frozen at MST); closed Fridays (`isClosedWeekday` → false); 4 h notice
  (dropped); horizon (+1 day); grid membership (`isSlotOnGrid` off by 1 ms).
- `verify:availability` — window shape (`bookableDateRange` one day short);
  notice boundary (`<` → `<=`); Friday / blackout / booked-slot rules (each
  dropped from `isSlotBookable`); empty days filtered out; query bounds
  (degraded to naive `now + 14×24h`); DST wall clock (`localTime` read UTC);
  determinism (randomized output). Frozen-offset break also seen red here
  ("window must span both offsets").
- `verify:availability:db` — **red pass deferred, NOT observed-red.** Do not
  cite this script as covered until BK-02 (scope item 5) runs its pass on the
  dev branch. It writes to whatever `DATABASE_URL` names — currently
  production — and deliberately breaking production targets while it hammers
  the live DB is what the dev-branch rule forbids.

## Phases

### P1 — Foundation ✅ complete

Schema, slot maths, upload token pipeline. Committed as `445c5cc` on
`booking/p1-foundation`. Migrations 001 and 002 are applied to Neon;
`BLOB_READ_WRITE_TOKEN`, `BOOKING_DRAFT_SECRET`, and `CRON_SECRET` are set.
Predates this process, so it has no ticket file.

### P2 — Availability and booking flow

| Ticket | Scope | Tier | Status |
| --- | --- | --- | --- |
| BK-01 | Availability computation + `GET /api/booking/availability/` | Standard | ✅ committed |
| BK-02 | Booking commit endpoint — validation, slot conflict, file claim | Heavy | draft — plan review |
| BK-03 | Booking form island — steps, picker, insurance toggle, upload, consent | Standard | not started |
| BK-04 | Confirmation page, success state, conversion event | Light | not started |
| BK-12 | Switch the typecheck gate to `astro check` | Light | not started — **must land before BK-03** |

BK-12 exists because `tsc --noEmit` never looks inside `.astro` or `.svelte`
files, so the current gate is blind to exactly what BK-03 delivers. Installing
`@astrojs/check` also makes `astro check` non-interactive.

**→ Retro checkpoint after P2.** Ten minutes: what in this process earned its
keep, and what gets trimmed for P3–P5? Agenda:

- Count, don't vibe: process lines vs code lines shipped, and which gates and
  review passes have defects to their name. Cut anything that has none.
- Is the tier split drawn in the right place?
- Generalize the `/CLAUDE.md` process section beyond `docs/booking/` — it is
  written as if booking is the only work this repo will ever see.
- Close with one line: anything here the sibling projects (digital-masajid,
  masjid-fundraiser) should hear?

Do not skip it.

### P3 — Notifications

| Ticket | Scope | Tier | Status |
| --- | --- | --- | --- |
| BK-05 | Customer confirmation email + internal notification (Resend) | Standard | not started |
| BK-06 | Reminder job at `REMINDER_LEAD_HOURS`, writes `reminder_sent_at` | Heavy | blocked — SMS provider undecided |

### P4 — Admin

| Ticket | Scope | Tier | Status |
| --- | --- | --- | --- |
| BK-07 | Appointments list + detail in `/admin` | Standard | not started |
| BK-08 | Manual entry (grid-snapped), status/stage edits, blackout dates | Heavy | not started |
| BK-09 | Authenticated proxy for private Blob files | Heavy | not started |

### P5 — Cutover

| Ticket | Scope | Tier | Status |
| --- | --- | --- | --- |
| BK-10 | Booking replaces the contact form; `leads` read-only; fix the 308 | Standard | not started |
| BK-11 | Production launch checks — env vars, cron secret, tracking | Light | not started |

## Open questions for the client

1. **SMS provider and budget** (blocks BK-06). Twilio is the default; a Canadian
   long code or toll-free number needs verification lead time. Email-only reminders
   are the fallback if SMS is not worth the cost.
2. **Confirmation and reminder wording**, including what the customer is told to
   have ready for an assessment.
3. **Cancellation/reschedule policy** — is there a self-service cancel link, or is
   cancelling a phone call? Affects BK-04 and BK-05.
