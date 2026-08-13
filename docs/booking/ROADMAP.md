# Booking system — roadmap

Self-service appointment booking. It replaces the contact form **as the quote
path** — the form itself survives, demoted to a general "send us a message"
channel on `/contact/` (client decision, 2026-08-11, recorded in BK-10). One
door per intent: quote → `/book/`, question → the message form, emergency →
the phone. Built on the existing
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
`rate_limits`, `schema_migrations`. `leads` coexists and **stays writable
indefinitely** — it is the message inbox, not an archive. Migration 004 made
`leads.service` nullable, because a message form cannot demand a service.

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

- **The `Photos/video` count in the internal email does not distinguish
  uploaded from pending.** `booking-email.ts:358` and `:389` print a bare
  number; the admin detail page *does* distinguish
  (`admin/appointments/[id].astro:364,378` — "upload not confirmed"). The row
  is written at token-mint time, before any bytes exist, so "Photos/video: 1"
  can mean zero bytes on disk. **Severity: low today (cosmetic), medium once
  BK-23 lands** — the office will approve or decline *from that email*, which
  makes the number decision material. **Owner: BK-23** (or BK-24, which owns
  the email's buttons). Found during BK-22's plan review, 2026-08-12.
- **`/api/booking/upload-token/` has no rate limit of its own.** `draft.ts` is
  the only throttled end of the funnel, on the stated theory that "without a
  draft there are no uploads, and each draft is independently capped at 10
  files / 300 MB" (`draft.ts:28-31`). One draft token is therefore worth 10
  unthrottled `onBeforeGenerateToken` calls, each running two SQL statements,
  for `DRAFT_TOKEN_TTL_HOURS = 6`. **Severity: low** — the per-draft caps bound
  the damage. **Owner: none.** Recorded because BK-22 raises the value of a
  draft token by making one mandatory to book, and any raise of
  `DRAFT_RATE_LIMIT_PER_HOUR` scales this linearly.
- **`verify-booking-commit.ts:573-586` ("Database failure") reaches its 500
  through a different path than its comment claims.** `consumeRateLimit`
  (`create.ts:49`) is awaited **outside** the route's `try` (which opens at
  `:72`), so an unreachable database throws there rather than being caught at
  `:144`. The assertion passes today for a reason other than the one it
  states. **Severity: low** — same status either way. **Owner: none**; worth a
  glance from whoever next edits that script for BK-22's item 13.
- ~~**Admin login is a redirect loop in production — `/admin` has been
  unreachable since ~2026-07-04.**~~ **Fixed in BK-07** (`ef6d76e`, deployed
  2026-08-10): `GET /admin/login/` answers 200 where it 302-looped, and every
  protected path redirects there in one hop. The cause, kept because it is the
  general shape of the trap: `middleware.ts`'s `PUBLIC_PATHS` held unslashed
  paths (`/admin/login`) while production 308-normalizes every request to the
  slashed form, which then failed the exact-match lookup and 302'd back to the
  unslashed form — an infinite GET loop, with the login POST 308ing into the
  middleware's 401. **Path matching against a literal is a trailing-slash bug
  waiting to happen**; `isPublicAdminPath` in `src/lib/auth.ts` is now the one
  place that comparison is made, it normalizes exactly one trailing slash
  before an exact match, and `scripts/verify-booking-admin.ts` pins both it
  and the middleware call site (reverting either is red).
- ~~**The leads pages still link unslashed, and each click eats a 308.**~~
  **Closed in BK-10.** `ADMIN_LEADS_PATH`, `adminLeadPath(id)` and
  `ADMIN_REPLY_ENDPOINT` joined `booking-admin.ts`, and every site now builds
  its URL from them: the list page's row link, the detail page's back link,
  the reply form's action, and **all four** of `api/admin/reply.ts`'s
  `Location` headers — the note here said three, and the fourth
  (`Location: '/admin'` for a lead that no longer exists) is exactly the kind
  of site a count taken by eye misses.
  **The scan that now enforces it had to be widened first, and that is the
  part worth remembering:** `verify-booking-admin.ts`'s regex excluded `?`
  and `#` from the path body and required at least one character after
  `/admin`, so `href="/admin"`, `'/admin?error=validation'` and
  `` `/admin/leads/${id}?success=1` `` were all invisible to it — the exact
  literals this ticket fixed. The ROADMAP's claim that BK-10's fix was "a
  one-line addition to that list" was therefore wrong: adding the files
  without extending the regex would have produced a green scan over
  unslashed paths. Both halves were red-observed.
- ~~**`appointment_files.size_bytes` is typed `number` but the driver returns a
  string.**~~ **Closed in BK-09.** `db.ts`'s `AppointmentFile.size_bytes` is now
  `string | number | null`, which is what the `BIGINT` column actually
  deserializes to — a bigint does not fit a JS number, so
  `@neondatabase/serverless` hands back a string the way `pg` does, and the old
  type let `size_bytes / 1024` typecheck into an `NaN`. Both halves of the claim
  are now pinned: `verify-booking-admin-db.ts` asserts the *driver's* behaviour
  against a real dev-branch row, and `verify-booking-files.ts` carries a
  compile-time tie (`const _: AppointmentFile['size_bytes'] = '5242880'`) so
  narrowing the type back stops `npm run typecheck` rather than going quietly
  wrong. The runtime assert alone could never have gone red — it pins Postgres,
  not this repo.
- **Two more of the "assertion that cannot fail" family, both found by BK-14's
  red pass and both fixed there.** They are recorded because neither is
  specific to calendar invites — each is a technique this repo uses in several
  scripts.
  1. **`ics.includes(SENTINEL)` is unfailable on a folded line.** An iCalendar
     content line folds at 75 octets with a CRLF and a leading space, and every
     DESCRIPTION this system builds is longer than that — so a policy number
     placed past the boundary is split across two lines and a substring search
     on the raw text does not see it. The BK-14 break that planted the policy
     number in DESCRIPTION left `verify:booking:admin:db` GREEN for exactly
     this reason. Every PII assertion over an ICS now checks the unfolded text
     as well as the raw one. **Any future assertion over a folded format needs
     the same treatment.**
  2. **A source pin is satisfied by the import line.**
     `source.includes('sendCalendarInvite')` stayed green after the call was
     deleted out of the route, because the import above it still names the
     symbol — which makes the pin green for precisely the "never wired" case it
     exists to catch. `verify-booking-ics.ts` now strips comments and imports
     before scanning and requires each route's send helper to appear at least
     twice (defined and called). The same shape bit a second time in the same
     pass: `create.ts`'s `slotStart: payload.slotStart` pin also matched
     `slotStart: payload.slotStart.toISOString()` in the JSON response
     twenty lines away, so it now reads only the plan's argument block. Both
     are the general lesson that **a source pin must be read against the code
     with imports and comments removed, and anchored to the construct it is
     about** (severity: medium — it silently converts a pin into decoration;
     owner: none, this is the fix).
- **`AbortSignal.timeout()` does not keep the Node event loop alive.** Its
  timer is unref'd by design, so a `tsx` script whose only pending work is a
  promise waiting on that signal exits with "Detected unsettled top-level
  await" instead of failing — which turns a red-first break into a *silent
  pass*. `verify-booking-files.ts` therefore races its abort assertion against
  a deliberately ref'd watchdog. Found while red-observing BK-09's
  `BLOB_ISSUE_TIMEOUT_MS` (severity: low, but it is the "assertion that cannot
  fail" shape this project keeps paying for; owner: none, documented here).
- ~~**The leads pages render dates with bare `toLocale*` and no `timeZone`**~~
  **Closed in BK-10.** All three sites (`created_at` on the list page,
  `created_at` and `replied_at` on the detail page) go through
  `formatAdminTimestamp`, and both pages joined the zone scan in
  `verify-booking-admin.ts` — which is what stops the next one being written.
  **Still open, deliberately: the blog pages' bare `toLocale*` dates.** They
  are prerendered and date-only, so the server's zone is the build machine's
  and the value never moves after deploy (severity: low, cosmetic at worst;
  owner: none, recorded here by BK-10 as out of its scope).
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
- ~~**13 pre-existing `svelte-check` a11y warnings**~~ **Down to 4 in BK-10.**
  `ContactForm.svelte` had **5** label warnings, not the 4 recorded here — the
  count was taken by eye and was wrong, which is its own small lesson about
  counts in prose. All five are fixed with `for`/`id` pairs; `Navbar.svelte`'s
  two are fixed by moving the drawer's key handling to `<svelte:window>` and
  giving the dialog a `tabindex`; `VideoReel.svelte`'s panel is now keyboard
  reachable (`role="button"`, `tabindex`, Enter/Space, `onfocus`).
  **The remaining 4 are `BrandLogo.svelte`'s `state_referenced_locally`**, in a
  file BK-10 does not touch (severity: low, and it is a correctness smell
  rather than an a11y one; owner: none, recorded here).
  `astro check` still reports ~24 hints, almost all `is:inline` on JSON-LD
  `<script>` tags plus an unused import in `blog/[slug].astro`. The deprecated
  `z.string().email()` hint is gone — `api/contact.ts`'s schema moved to
  `contact-message.ts` and uses `z.email()` (severity: low; owner: none).
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
- ~~**`PUBLIC_AW_BOOKING_LABEL` is unset, so booked assessments report to GA4
  but not to Google Ads.**~~ **Resolved 2026-08-08**: the user created the
  "Assessment booked" conversion action in the client's Ads account and set
  `PUBLIC_AW_BOOKING_LABEL` (with the rest of `PUBLIC_AW_*`) in Vercel,
  Production-only, verified as real values in the dashboard. The Ads-side
  conversion count stays 0 until a real ad click books — that is correct, not
  a misfire; the action's status reads "Misconfigured"/"No recent conversions"
  until then and only matters if it persists 24–48 h *after* ad traffic
  resumes. BK-11 still owns the final launch check.
- **`import.meta.env.PUBLIC_*` must be read as a literal expression, never
  through a helper.** Vite substitutes these at build time by matching the
  source text, so `readEnv('PUBLIC_AW_ID')` or `env[name]` compiles to a lookup
  on an object that does not exist in the client bundle, and the value silently
  becomes `undefined` in production while working in dev. This is the *opposite*
  of the BK-12 rule for server-side vars, and the two are easy to confuse:
  `readEnv` for anything the server reads, bare `import.meta.env.PUBLIC_X` for
  anything the browser reads. Verified in BK-04 by building with a test value
  and finding it inlined in `dist/client/_astro/booking-form.*.js` (severity:
  low as long as nobody "tidies" it; owner: none, documented here).
- **`verify:booking:smoke` would mail the client, and the obvious mute does not
  work.** It commits a real booking every run; the customer address is
  `smoke@example.com` (undeliverable by design) but `BOOKING_INTERNAL_TO` is
  `info@yegrestoration.ca`, a real inbox. Today it is inert only by accident —
  `.env` has no `RESEND_API_KEY` and `.env.local` has it as `""` — and
  `.env.example` invites putting a real key in `.env`. **Removing** the key from
  the spawned dev server's environment cannot mute it: `readEnv` falls back to
  `import.meta.env`, which Vite populates from the dotenv files *inside* that
  process, where the parent has no reach. The mute is therefore a positive
  signal, `BOOKING_NOTIFY_DISABLED=1` in the child's `process.env`, which wins
  because `readEnv` checks `process.env` first — the same mechanism as the
  `DATABASE_URL` swap. The flag is fail-open (unset = send) so no production
  misconfiguration can silence mail by omission, and only `1`/`true` trip it so
  `=0` cannot silence it by accident. Never "simplify" this back to deleting a
  key (severity: **high** if reintroduced — it mails the client on every test
  run; owner: none, this is the fix).
- **The Resend SDK never throws on a failed send — it *resolves* with
  `{ data: null, error }`.** Confirmed against the installed source in BK-05
  (`resend@6.17.1`, `dist/index.mjs` → `fetchRequest`): a non-2xx response and a
  network failure both come back as a resolved value, and `CreateEmailResponse`
  is a `{data, error}` union. So `try { await resend.emails.send(…) } catch`
  catches nothing. The one place the SDK *does* throw is `new Resend(key)` with
  a falsy key — and it silently falls back to `process.env.RESEND_API_KEY`
  first, which under `astro dev` is empty exactly when `import.meta.env` holds
  the value.
  **The SDK fact stays here permanently; the two call sites that got it wrong
  were fixed in BK-10.** `api/contact.ts` returned `{ ok: true }` on the line
  after an unchecked send, so a bounced key reached the visitor as "message
  sent"; `api/admin/reply.ts` stamped `status = 'replied'` there, so a failed
  reply marked the lead answered and showed the office `?success=1`. Both now
  go through `createResendSender` in `booking-notify.ts` — **the only place in
  the codebase that calls `resend.emails.send`** — which reads the error off
  the resolved value and takes the key through `readEnv`. Keep it that way: a
  fresh `new Resend(...)` anywhere else is the whole trap coming back.
- **`npm run migrate:status` reports production and nothing else.**
  `scripts/migrate.ts` reads `DATABASE_URL` only, and `.env.local`
  (production) wins over `.env`, so there is no flag that aims it at the dev
  branch — it takes a prefix: `DATABASE_URL="$DATABASE_URL_DEV" npm run migrate
  -- --status`. Anyone checking "is the migration applied?" after running the
  bare command has checked one branch and will believe they checked both.
  Found in BK-02, recorded only in that ticket's finding table until BK-05
  promoted it here (severity: **low**, it misleads rather than breaks).
- ~~**`Lead` timestamp fields are typed `string` but the driver returns `Date`**~~
  **Closed in BK-10.** `created_at` is `Date` and `replied_at` is `Date | null`,
  which is what `@neondatabase/serverless` actually returns for `timestamptz` —
  and the pages now hand the column straight to `formatAdminTimestamp(instant:
  Date)` instead of re-parsing a lie. `Lead.service` became `string | null` in
  the same change (migration 004).

- **A phone number no one recognized shipped in customer email for months.**
  All five reply templates in `src/lib/reply-templates.ts` told customers to
  call **(780) 244-4747**; the client does not recognize that number and the
  advertised line is (780) 479-3285. Every admin reply sent since the
  templates shipped carried it. Fixed in BK-10, which imports `SUPPORT_PHONE`
  from `booking-config.ts` rather than typing the digits. The general trap,
  and the reason this is recorded rather than just fixed: **copy that states a
  contact detail — phone, email, address, hours — must be checked against
  `BUSINESS`/`booking-config.ts`, never written from memory or carried over
  from a template.** It is the same class as a fabricated constant, and
  nothing in the type system or the gates can catch it (severity: **medium**,
  it reached real customers and cost real calls; owner: none, this is the
  fix).
- **`booking_availability_error` / `booking_availability_empty` count
  attempts, not visitors.** Both re-fire on every retry/refetch inside one
  session, by design — they are diagnostics, not conversions. Anyone reading
  their GA4 counts as "N visitors hit a full calendar" is overcounting
  (severity: low, a reading hazard not a defect; owner: **BK-11**, which
  reads the numbers. Found by BK-10's implementation review as a
  scope-call).
- **The ICS insurer-name PII sentinel checks only the unfolded text**, where
  the POLICY/CLAIM sentinels beside it check raw *and* unfolded (the folded
  format's includes() trap, above). Unfolded-only is the half that actually
  catches the fold-split case, so nothing is currently uncatchable — the
  asymmetry is a consistency hazard for the next person copying the pattern,
  not a hole (severity: **low**; owner: none — whichever ticket next touches
  the ICS PII sentinels evens it up. Found by BK-16's implementation review,
  pre-existing from BK-14).

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
| BK-04 | Confirmation page, success state, conversion event | Light | ✅ committed |
| BK-12 | Typecheck gate covers `.astro` and `.svelte` | Light | ✅ committed |

BK-12 existed because `tsc --noEmit` never looks inside `.astro` or `.svelte`
files, so the gate was blind to exactly what BK-03 delivers. `astro check`
turned out to close only half of that — it does not read `.svelte` either — so
the gate is `astro check && svelte-check`. See Known traps.

**→ Retro checkpoint after P2 — done 2026-08-09.** The count: ~7,800 code lines
against ~2,000 ticket/roadmap lines (≈1:4); ticket files double as spec and
review record, so the pure-process core is the ~30 lines in `/CLAUDE.md`.
Defect ledger: plan review 5 blockers across 3/3 reviewed tickets;
implementation review caught two would-have-shipped bugs (BK-02) plus 9
should-fixes (BK-03); red-first found real bugs in the verification itself on
3/5 tickets; the disputed-blocker tiebreaker never fired (~40 findings, zero
disputes) and stays because it costs nothing and plausibly deters disputes.
Changes made: Heavy/Standard collapsed into one *Reviewed* tier (prompt weight
had no catches to its name; Standard reviews out-caught Heavy's), and the
`/CLAUDE.md` process section generalized beyond `docs/booking/`. Considered and
rejected: ticket-size cap (BK-03's 655 lines correlate with its highest review
yield) and loosening Light (n=2, and P3–P5 barely contains Light-eligible
work). Line for the sibling projects: fresh-agent reviews with input isolation
plus red-first verification caught 5 plan blockers and several
would-have-shipped bugs across 5 tickets at ~1 process line per 4 code lines —
port those two practices; skip prompt-weight tiers and standing third reviews.

### P3 — Notifications

| Ticket | Scope | Tier | Status |
| --- | --- | --- | --- |
| BK-05 | Customer confirmation email + internal notification (Resend) | Reviewed | ✅ committed |
| BK-06 | Reminder job at `REMINDER_LEAD_HOURS`, writes `reminder_sent_at` | Reviewed | blocked — Twilio number **(780) 720-8856** in verification (user, 2026-08-11) |

**→ /book/ went live on production — 2026-08-10.** The merge hold ended with
BK-05: booking is on `main`, deployed, and migration 003 is applied to
production (`migrate:status`: 001–003 all ✓). Verified end to end with a real
test booking, #19 (mold, insurance route, ZZTEST fixture policy/claim, Sun
Aug 23 15:30): the confirmation page showed the slot, reference number, and
emailed-copy line; the customer confirmation reached a real Outlook inbox
carrying the full settled copy list and **no** policy or claim number (the
locked PII rule, checked against production, not just the verify script); the
internal notification reached `info@yegrestoration.ca` carrying insurer,
policy, and claim; and the production row had both `confirmation_sent_at` and
`internal_notified_at` stamped. The test row was then deleted (0
`appointment_files`, no stray ZZTEST rows, production back to 0 appointments).
This is go-live for the booking page, **not** the P5 cutover — the contact
form still exists until BK-10. The booking conversion reports to GA4; the
Ads-side count stays 0 until real ad-click traffic books (see the resolved
`PUBLIC_AW_BOOKING_LABEL` entry in Known traps).

### P4 — Admin

| Ticket | Scope | Tier | Status |
| --- | --- | --- | --- |
| BK-07 | Appointments list + detail in `/admin`; fix admin login loop | Reviewed | ✅ committed |
| BK-08 | Manual entry (grid-snapped), status/stage edits, blackout dates | Reviewed | ✅ committed |
| BK-09 | Authenticated proxy for private Blob files | Reviewed | ✅ committed |

### P5 — Cutover

| Ticket | Scope | Tier | Status |
| --- | --- | --- | --- |
| BK-13 | Soft launch — navbar CTA (desktop + drawer) points at `/book/` | Light | ✅ committed |
| BK-10 | Cutover: booking = the quote path; form demoted to messages (client-amended 2026-08-11 — `leads` stays writable); fix the 308s | Reviewed | ✅ committed |
| BK-11 | Production launch checks — env vars, cron secret, tracking | Light | not started |

### P6 — Post-launch enhancements

| Ticket | Scope | Tier | Status |
| --- | --- | --- | --- |
| BK-14 | Calendar invites — bookings land on the office Google Calendar (ICS over Resend; cancel clears) | Reviewed | ✅ committed |
| BK-15 | Booking widget overflow — fieldset `min-content` default escapes the card | Light | ✅ committed |
| BK-16 | Customer calendar lifecycle — invite on confirmation; cancellation/restore email + ICS on the boundary | Reviewed | ✅ committed (`1162b9d`) |
| ~~BK-20~~ | ~~Fridays open outside Jummah~~ | — | **cancelled — client reverted 2026-08-12; Fridays stay closed** |
| BK-21 | Internal email Reply-To fallback + loud "no email" line — replies to noreply@ bounce (found 2026-08-12: office reply to a no-email booking's notice bounced 550); covers all three internal notices, contact form included | Light | ✅ committed (`90c65a9`) |
| BK-17 | Admin entry: taken slots visible/disabled in the time dropdown | Reviewed | deferred behind P7 — "taken" must include `pending` once P7 lands |
| BK-18 | Public picker redesign — Calendly-style month calendar + time list | Reviewed | deferred behind P7 — build against the review-before-confirm flow, not the auto-confirm one |
| BK-19 | Admin week-calendar view (additional view beside the list) | Reviewed | deferred behind P7 — pending rows need distinct rendering |

BK-14: client-requested 2026-08-11. Level 1 of three offered: invites, not API
sync (level 2, the recorded upgrade path) and not calendar-blocks-availability
(level 3, declined — blackout dates cover it for one crew).

BK-15–19: client-approved 2026-08-12 from his BK-14 post-deploy test pass, in
this order.

**BK-20 is cancelled — the client reverted it the same day it was raised
(2026-08-12), and Fridays remain completely closed.** It briefly proposed
opening Fridays outside Jummah hours (a 13:00–16:00 Edmonton blocked-hours
window, leaving 11:30/12:30 bookable), which would have amended the locked
Friday rule. It does not: **the Locked section's "Open every day including
Sunday, except Friday" stands unchanged**, `CLOSED_WEEKDAYS = [5]` stays, and
no ticket owns a Friday change. Recorded rather than deleted because the row
was in this table for part of a day and BK-16/BK-18 were sequenced around it —
BK-18's picker redesign is therefore built against the *existing* slot model,
not a pending one. Anyone reading a BK-20 reference elsewhere should read it as
withdrawn.

Decisions recorded from that same conversation, all still standing: **the customer gets a
cancellation email when the row has an email address** (phone-in cancellation
stays the only way to cancel — the email is written confirmation of it, and
it carries the calendar CANCEL so a customer who added the invite gets their
calendar cleared too); the widget work is split hotfix-now (BK-15) /
redesign-later (BK-18); the admin calendar view is approved but sequenced
last.

### P7 — Review-before-confirm (client change request 2026-08-12)

**The client is drowning in time-waster bookings and wants two things: harder
requirements to book, and a human review before anything is confirmed.**
Decided over WhatsApp 2026-08-12 (Abdul, ferried by the user), follow-up
Q&A same day. This phase reverses P6's "confirm instantly" posture on
purpose: a public booking is now an *application* until the office approves
it. All client answers below are decisions, not proposals, except the one
marked **proposed**.

**Decisions (client, 2026-08-12):**

- **Mandatory on the public form:** phone (already), **email**, and **at
  least one photo/video**. 100 MB/file limit stays ("should be fine for
  now"). Admin/phone-in entries are exempt — "if we enter ourselves we will
  ask them to text pictures/videos. It won't go to review process."
- **Customer checklist, optional**, on the public form — the client's
  scoping list (levels, rooms, dimensions, wall build-up, mechanical
  proximity) translated into plain customer language; answers surface in the
  internal email and admin detail. It exists "so the client can know more
  information about the job in hand."
- **Review flow:** submission → `pending`, customer sees / is emailed "we
  received your information and will get back to you after reviewing" (no
  calendar invite yet). Office reviews — SLA stated: "almost right away, max
  1 hour." **Approve** → confirmation email + customer invite + office
  invite (the BK-16 machinery, moved to the approval moment). **Decline** →
  a diplomatic email; the client's exact framing: **"we're at capacity at
  this time"** — one standard message, no reason menu.
- **Approve/Decline buttons live in the internal "new booking" email** plus
  the admin page. Client said YES to this replacing the calendar-RSVP idea —
  which cannot work: Gmail's Yes/No mails an iTIP REPLY to the ORGANIZER
  (`noreply@`, send-only stack, see BK-21). Nobody re-proposes RSVP capture
  without inbound-mail infrastructure.
- **Minimum notice moves 4h → 24h** ("change to 24 hours").
- **Everything goes through review** — "everything urgent brother, all jobs
  need to follow the same process." No emergency bypass.
- **Proposed, client's to overturn (pinned 2026-08-13):** reminder to the
  office if a booking is still pending 24h after submission; auto-decline
  (with the at-capacity email) if still pending **24h before the slot**.
  "24 hours after submission" was rejected in planning: it would decline a
  two-weeks-out booking over one day of inattention.

**Settled in planning, without the client (assumptions, overturnable):**

- `pending` **holds** the slot (else two applicants race for it during
  review); `declined` **frees** it — the partial unique index becomes
  `WHERE status NOT IN ('cancelled', 'declined')`, migration territory.
  `status` gains `pending` and `declined`; `source='web'` starts `pending`,
  `source='admin'` starts `booked` (the exemption above).
- BK-16's cancel/restore boundary logic applies to rows that reached
  `booked`; a declined application gets no CANCEL ICS (no invite ever
  existed for it).
- **One-click email buttons must not mutate on GET.** Mail scanners and
  link-prefetchers (Outlook SafeLinks, security proxies) follow links in
  email — a GET that approves is a booking approved by a robot. The link
  lands on a minimal signed page whose button POSTs. Tokens are signed,
  single-purpose, expire, and answer idempotently ("already handled") on
  re-use.
- The Ads conversion keeps firing at submission — the ad produced the lead;
  review is our filter, not the ad's. Revisit only if the client asks why
  conversions exceed confirmed jobs.
- Checklist and all new copy: implementer drafts, client edits later (the
  standing rule); the checklist wording additionally goes past the client
  before launch because it is customer-visible vocabulary.

| Ticket | Scope | Tier | Status |
| --- | --- | --- | --- |
| BK-22 | Mandatory email + ≥1 photo/video on the public form — server-enforced at commit, form UX, admin exempt | Reviewed | approved — plan-reviewed, ready to implement |
| BK-23 | Review lifecycle core — migration (pending/declined + index), public bookings land pending, received-your-info page + email (no invite), admin Approve/Decline, approve → BK-16's confirmation+invites, decline → at-capacity email, 24h minimum notice | Reviewed | not started |
| BK-24 | One-click Approve/Decline from the internal email — signed tokens, POST-confirm page (no GET mutation), expiry, idempotent re-use | Reviewed | not started |
| BK-25 | Pending timers — office reminder at +24h unactioned, auto-decline at slot−24h (cron) | Reviewed | not started |
| BK-26 | Customer checklist — optional plain-language fields, stored on the row, rendered in internal email + admin detail | Reviewed | not started |

The Locked section's "4 hours minimum notice" line is **BK-23's to rewrite
when it lands** (client decision 2026-08-12), the same arrangement BK-20
briefly held over the Friday line. Nothing else in Locked moves: the grid,
Fridays, phone-in cancellation, and the PII rules all stand.

Sequenced BK-22 → 26 (BK-21 lands first, before any of them — see its row).
Each ticket is independently shippable: BK-22 filters immediately while
confirmation is still instant; BK-23 flips the flow with admin-page buttons;
BK-24 adds the client's one-tap UX; BK-25 the safety net; BK-26 is
independent and can be pulled earlier if the client pushes. BK-17/18/19
resume after P7 with the amendments noted in their rows.

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
