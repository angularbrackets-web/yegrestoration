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
- **The Blob store is private, and enforces it at the store level.** Admin
  viewing needs an authenticated function proxy (BK-09), not a direct URL.
  Confirmed in BK-03: an unauthenticated GET of an uploaded blob URL answers
  **403**, and uploading with `access: 'public'` fails outright with "Cannot use
  public access on a private store." So although `onBeforeGenerateToken` cannot
  constrain `access` (it is a client-set header the handleUpload route never
  sees), a hostile client still cannot publish anything.
- **Writing verification scripts target the Neon dev branch, never production.**
  `DATABASE_URL_DEV` in `.env` is the dev branch (`br-broad-dream-ap0sdq6f` on
  project `purple-bar-39114890`, live since 2026-08-07); `DATABASE_URL` stays
  production. A script that writes must refuse to run when `DATABASE_URL_DEV`
  is unset rather than falling back, and `--allow-production` is reserved for
  deliberate smoke tests. Because `getDb()` reads only `DATABASE_URL`, a script
  must also *swap* it and then dynamically import the route — the guard alone
  protects nothing. See BK-02 step zero.
- Vercel Blob's 4.5 MB limit is the *function body* limit and applies to server
  uploads only. Client uploads bypass it and cost no data transfer.
- **`clientIp` trusts the leftmost `x-forwarded-for`, which the caller sets.**
  `rate-limit.ts` prefers that header over `x-real-ip` and `clientAddress`, both
  of which are platform-set. If Vercel appends the real address rather than
  replacing the header, a script rotating `x-forwarded-for` gets unlimited
  buckets and the booking rate limit is bypassed. Exploitability is
  **unconfirmed** — it needs Vercel's actual append-vs-replace behaviour from a
  primary source, which is why BK-02 recorded it rather than guessing. The
  defensive ordering (`clientAddress` → `x-real-ip` → *rightmost* forwarded
  entry) is correct regardless (severity: medium if exploitable, the limit is
  what stands between a bot and the appointments table; owner: BK-11).
- **`vercel env pull` writes sensitive variables back as empty strings.** In
  `.env.local`, `ADMIN_PASSWORD`, `RESEND_API_KEY`, `CRON_SECRET`,
  `BOOKING_DRAFT_SECRET`, `PUBLIC_AW_ID`, `PUBLIC_AW_CALL_LABEL`,
  `PUBLIC_AW_FORM_LABEL` and the whole `POSTGRES_*` family are all `""`. The key
  being present therefore proves **nothing** about whether production has a
  value — only the Vercel dashboard does. Local dev needs its own values in
  `.env` (severity: medium, it invites false "it's configured" conclusions;
  owner: BK-11, the launch-checks ticket).
- ~~**`process.env.X ?? import.meta.env.X` throws a TypeError under plain
  Node.**~~ **Cleared in BK-12.** All three sites (`draft-token.ts`, `db.ts`,
  and `cleanup-uploads.ts` — the third was not in the original note) now go
  through `readEnv` in `src/lib/env.ts`, and `npm run verify:env` holds the
  line under plain Node. Do not reintroduce the `??` spelling: it reads as
  defensive and is the opposite.
- **`astro check` does not look inside `.svelte` files.** Proved in BK-12: a
  component with a planted type error, imported *and rendered* from a page,
  left `astro check` green. `npm run typecheck` therefore runs `astro check &&
  svelte-check` and both halves are red-observed. Anyone tempted to simplify
  that script back to one command is removing the only checker that reads the
  booking island.
- **13 pre-existing `svelte-check` a11y warnings and 23 `astro check` hints.**
  Warnings, so they do not fail the gate — which is exactly why they will rot.
  `ContactForm.svelte` (4 labels with no associated control), `Navbar.svelte`
  (a `<nav>` with mouse/keyboard handlers, a `dialog` role with no tabindex),
  `VideoReel.svelte` (a static `<div>` with a mouseenter handler); hints are
  mostly `is:inline` on JSON-LD `<script>` tags, plus an unused import in
  `blog/[slug].astro` and a deprecated `z.string().email()` in `api/contact.ts`
  (severity: low, real a11y defects on live pages but none in the booking flow;
  owner: BK-10, the ticket that already rewrites `ContactForm.svelte`).
- **A real value in `.env` does not reach `astro dev` when `.env.local` has the
  same key as `""`.** Vite merges the two into one `import.meta.env` with
  `.env.local` winning, so the blank shadows the real value *before* `readEnv`
  ever sees it — `readEnv`'s empty-string rule cannot help, because it is handed
  the merged result. BK-02's assumption that "a local `BOOKING_DRAFT_SECRET` in
  `.env` makes token signing work locally" holds for `tsx` scripts (whose own
  `loadEnv` skips empty values and writes `process.env`) but **not** for the dev
  server: `POST /api/booking/draft/` 500s under a plain `npx astro dev`
  (severity: low, dev-only and it fails closed with the right message; owner:
  BK-11).
- **Third-party SDKs read `process.env`, which `astro dev` never populates.**
  Vite fills only `import.meta.env`, so `@vercel/blob`'s
  `BLOB_READ_WRITE_TOKEN` lookup finds nothing and `/api/booking/upload-token/`
  400s in local dev even though `.env.local` has a real token. Vercel populates
  `process.env` in production, so this is dev-only. Same family as the entry
  above and the same owner (BK-11).
  **Both are already handled by `npm run verify:booking:smoke`**, which loads
  both files into `process.env` and passes that environment to the dev server it
  spawns — so the scripted gate is the reproducible path, and a hand-started
  `npx astro dev` is the one that needs `export`s.
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
- `verify:availability:db` — **debt cleared in BK-02.** The script now defaults
  to the dev branch and refuses rather than falling back, and its red pass ran
  there: the dev-branch guard was observed red (made to fall back to
  `DATABASE_URL`, refused correctly when restored), and the query-bounds
  assertion now reports itself inert rather than failing on days when the
  window's last day is closed.

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
| BK-02 | Booking commit endpoint — validation, slot conflict, file claim | Heavy | ✅ committed |
| BK-03 | Booking form island — steps, picker, insurance toggle, upload, consent | Standard | ✅ committed |
| BK-04 | Confirmation page, success state, conversion event | Light | not started |
| BK-12 | Typecheck gate covers `.astro` and `.svelte` | Light | ✅ committed |

BK-12 existed because `tsc --noEmit` never looks inside `.astro` or `.svelte`
files, so the gate was blind to exactly what BK-03 delivers. `astro check`
turned out to close only half of that — it does not read `.svelte` either — so
the gate is `astro check && svelte-check`. See Known traps.

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
| BK-06 | Reminder job at `REMINDER_LEAD_HOURS`, writes `reminder_sent_at` | Heavy | blocked — Twilio number in verification |

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

All three were answered on 2026-08-08. Kept here as decisions rather than
deleted, because BK-04/05/06 are written against them.

1. **SMS provider — settled: Twilio.** Number verification is running in
   parallel. BK-06 stays blocked *only* until the number is live; the provider
   choice is no longer open. Email-only reminders are no longer the fallback.
2. **Confirmation and reminder wording — settled: the implementer drafts it,
   the client edits later.** Constraints, which are not the implementer's to
   change:
   - Confirmation carries date/time in America/Edmonton, the address, that the
     visit runs about 30 minutes, and a "have ready" list: access to the
     affected areas, photos or a list of the damage, insurance policy and claim
     numbers if filing, someone 18+ on site, pets secured.
   - Reminder carries date/time, the address, and the reschedule phone number.
     Nothing else.
   - **Locked rule:** `policy_number` and `claim_number` never appear in an SMS
     body. The confirmation may *ask* the customer to have them ready; it may
     never print them. This restates the Locked data-model rule at the copy
     level so a copy edit cannot quietly break it.
3. **Cancellation — settled: phone-in at launch.** No self-service cancel link.
   Confirmation and reminder both say "call or text to cancel or reschedule".
   Freeing the slot is an admin status edit (BK-08). Self-service is deferred
   until volume justifies it, so BK-04 ships no cancel token and BK-05 embeds
   no cancel URL.
