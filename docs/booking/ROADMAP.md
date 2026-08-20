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
Booking window: **next-day earliest** (no same-day web bookings), 14 days
maximum — client 2026-08-18, superseding the 4-hour rule this line carried and
the 24-hour value P9 first recorded; BK-23 implements it. The 4-hour floor
survives only as `ADMIN_MIN_NOTICE_HOURS`, and the admin path bypasses the
window entirely anyway. The public calendar is
**initial assessments only** — follow-ups and emergencies are phone-in and entered
manually via admin. Uploads: 100 MB/file, 10 files, 300 MB total, all enforced
when the token is minted.

**Data model** — `appointments`, `appointment_files`, `blackout_dates`,
`rate_limits`, `schema_migrations`. `leads` coexists and **stays writable
indefinitely** — it is the message inbox, not an archive. Migration 004 made
`leads.service` nullable, because a message form cannot demand a service.

- `pipeline_stage` (assessment|mitigation|restoration) and `status` are
  independent columns. Neither derives from the other. `status` is
  booked|completed|cancelled|no_show until BK-23, which renames `booked` to
  `confirmed` and adds `pending_review`, `approved_awaiting_payment`,
  `declined` and `payment_expired`.
- Double-booking guard is a partial unique index: `UNIQUE(slot_start) WHERE status
  <> 'cancelled'`. Cancelling frees the slot but keeps the record. **Assumes a
  single crew**; becomes `(slot_start, technician_id)` if that ever changes.
  BK-23 widens the predicate to the deny-list
  `status NOT IN ('cancelled','declined','payment_expired')`. **Whatever it
  says, the `ON CONFLICT` predicate in `insertBooking` must match it
  byte-for-byte** — Postgres resolves the arbiter by matching predicates, and a
  mismatch is error 42P10 on every booking, not a subtle drift.
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

- **Deleting an appointment row does not retract a calendar invite already
  issued for it.** Observed 2026-08-19: two test rows were deleted directly from
  the database, and one of them had already sent a `REQUEST` ics under the
  pre-P9 auto-confirm flow. The customer's calendar kept the entry, so the next
  real booking in that slot showed **two** overlapping invites — one for the live
  appointment and one for a booking that no longer exists in any table.
  The product's own cancel path is correct and sends a `CANCEL` under the same
  UID; a hard `DELETE` bypasses it, because there is no row left to send from.
  **Therefore:** cancel through the admin panel, never by deleting the row — and
  if a row must be deleted, the invite has to be cleared out of the recipient's
  calendar by hand. Severity: low, but it presents as a double-booking, which is
  the one thing this system's index exists to prevent, so it will be misread as
  a serious bug by whoever sees it first. **Owner: nobody — no ticket, because
  no product path does a hard delete today.**

- **The admin status dropdown can perform an approval, which is the one thing
  the review route was split out to prevent.** `review.ts`'s header states the
  design: *"Folding that into the editor would mean the editor's dropdown could
  also perform it, which is exactly what must not happen: an office member
  setting the status to `approved_awaiting_payment` by hand would approve a
  booking with no amount, no deadline and no email."* **`[id].astro:1267`
  renders all eight `APPOINTMENT_STATUSES` on every row and `update.ts` has no
  transition guard**, so that is one dropdown selection away on any
  `pending_review` row.

  Two consequences, the second worse than the first:

  - `-> approved_awaiting_payment` by hand is the scenario the comment forbids
    verbatim: slot held, no clock, no amount, customer never told.
  - `-> confirmed` by hand crosses the calendar-invite boundary, so `update.ts`
    **sends the customer a confirmation email and an ICS invite with no payment
    taken** — against P9's locked *"PAYMENT ALWAYS PRECEDES DISPATCH. NO
    EXCEPTIONS."*

  **`update.ts:266`'s comment is stale and is part of how this survived:** it
  says the dropdown *"is currently the ONLY route to `confirmed`"*, which was
  true before BK-32 and is false now — BK-32 shipped **"Mark as paid — Interac"**
  as the sanctioned manual confirm. The dropdown is now an unguarded duplicate
  of it that skips the money.

  **Found 2026-08-19 by the user, within minutes of first real use of the review
  screen** — they asked which of the two panels accepts a booking, which is the
  right question and evidence that the ambiguity is a trap rather than a
  theoretical hole. Not found by any of the 23 gates, because every one of them
  tests the routes and none tests whether two routes overlap.

  **Severity: high — it silently defeats the deploy's central rule, and the
  wrong option sits alphabetically beside the right ones in a dropdown the
  office uses for ordinary edits.** Requires a deliberate wrong selection by an
  authenticated user, which is the only reason it is not a release blocker.

  **Owner: BK-44 — FIXED IN CODE 2026-08-20, NOT YET DEPLOYED.** The rule is
  `editorMaySetStatus` in `booking-status.ts`: the dropdown may not create
  `approved_awaiting_payment`, and may move a row **into** the invite-holding
  set only if that row has been paid. `update.ts` enforces it in the WHERE
  clause of its own UPDATE; the dropdown renders from the same function.
  **Until the branch is deployed the operational rule below still stands.**

  Two things this cost that are worth carrying forward. **Guarding `confirmed`
  alone would not have fixed it** — `couldHoldCalendarInvite` covers `completed`
  and `no_show` too, and `update.ts` mails on the boundary rather than on the
  status name, so `pending_review -> completed` sends the same "Your assessment
  is confirmed" and ICS for an unpaid job. And **`paid_at` is never cleared**,
  so a row re-approved after a previous payment carries a stale stamp; an
  approved row's crossing is refused outright for that reason.

- **The recorded webhook health check gives a FALSE ALARM unless it sends
  `Content-Type: application/json`.** This file records the live probe as
  *"the Stripe webhook answers `400 {\"error\":\"No signature\"}` to an unsigned
  POST"*, which is the response that proves the route exists and both secrets
  are readable. A bare `curl -X POST` sends no content type, Astro's
  `checkOrigin` treats it as a cross-site FORM submission, and the answer is
  **"Cross-site POST form submissions are forbidden"** — which reads exactly
  like a broken webhook to whoever runs it. Observed 2026-08-20 while smoke-
  testing the BK-44/45/46 deploy, and it cost a minute of thinking production
  was broken.

  **Stripe is unaffected**: `checkOrigin` only guards the form content types,
  and Stripe posts `application/json`. Verified immediately with
  `-H "Content-Type: application/json"`, which returns the documented
  `400 {"error":"No signature"}`. **Therefore:** always send the header when
  probing that route, and do not treat the CSRF message as a failure.
  Severity: none technically, moderate operationally — it is a health check that
  lies in the alarming direction. **Owner: nobody — the probe is documentation,
  not code.**

- **Stripe's receipt gives the customer a different email address and a
  different phone number than every other surface.** Observed on live booking
  #36's receipt, 2026-08-20: it closes with *"contact us at
  `yegrestoration@gmail.com` or call us at `+1 780-720-8856`"*, while
  `SUPPORT_PHONE` is `(780) 479-3285` and the reply-to on every message this
  system sends is `info@yegrestoration.ca`.

  So a customer replying to their receipt reaches a Gmail account nothing in
  this system watches, and calling that number does not reach the line the site
  promises answers 24/7 — on the one document they keep. It is also the only
  customer-facing surface with contact details **no code can change**: they come
  from Stripe's own business/public details settings.

  **Fix is a Dashboard step, not a ticket**: Stripe → Settings → Business
  details / Public details, set to match `booking-config.ts`. Severity:
  moderate — nothing breaks, but it is a support channel nobody is watching.
  **Owner: nobody — configuration, recorded so it is not rediscovered by a
  customer.**

- **A refund issued in Stripe does not reach this system, and BK-46 just made
  that visible.** There is no refund code anywhere — `refunds.create` appears
  nowhere in `src/`, and the webhook handles no refund event — so a refund taken
  in the Stripe dashboard leaves `payment_status = 'paid'`, `paid_at` stamped
  and `paid_amount_cents` unchanged. **The appointment screen therefore states
  "Payment received — Paid by card" on a booking that was refunded in full.**

  This is not new, but its severity changed on 2026-08-20: until BK-46 those
  columns were rendered by nothing, so the screen was silent rather than wrong.
  Giving them their first reader also gave the stale state its first voice.
  Observed while planning the refund of live test booking #36.

  **Operationally**, until BK-33 lands: a refunded booking must be cancelled
  through the admin panel as well, and the office should treat "Payment
  received" on a `cancelled` row as meaning *money was taken at some point*,
  not *money is still ours*. **Refund in Stripe FIRST, then cancel** — the
  cancellation email says "nothing further is needed from you" and mentions no
  money, so cancelling first tells a customer their booking is off while the
  refund is still unstarted.

  Severity: moderate, and it is a record-truth failure rather than a money one —
  the money is correct in Stripe, which is the system of record for it.
  **Owner: BK-33**, which already scopes the reconciliation webhook.

- **RESOLVED 2026-08-20 by BK-46 — kept for the shape, not as open work.**
  **A column written by a proven route and read by no surface passes every test
  in the suite.** `markPaid()` writes `paid_at` and `payment_method` — the
  shared path for both the Stripe webhook and the Interac button — and
  **nothing renders either one.** After a successful payment the appointment
  screen shows a badge reading "Confirmed", a panel headed "Amount settled *at
  approval*", and a **stale "Payment due by …" line**, because `payment_due_at`
  is never cleared and the due line is conditional on that column being
  non-null rather than on the row still owing money. So the office cannot see
  when a booking was paid, or whether the money arrived by card or by
  e-Transfer — which is also the fact that decides whether a refund is issued
  in Stripe or at the bank. The settled panel's own comment describes this
  failure one step earlier in the flow — *"the office could approve an amount
  and then have no screen anywhere that showed what it was"* — and the same
  sentence is true today with "approve" replaced by "take payment".
  Severity: moderate, and it is a dispute-handling failure rather than a
  transactional one — the money is correct, the record of it is not.
  **Owner: BK-46.**

- **RESOLVED 2026-08-20 by BK-46.** **The appointment header's total omits the
  travel fee, structurally and at every status.** `[id].astro:87` calls `assessmentQuote({tier, service,
  slotStart})` and does not pass `travelFeeCents`, which defaults to zero
  (`booking-pricing.ts:188`). The header's *"$606.38 total incl. GST"* is
  therefore base + GST, while the "Amount settled at approval" panel below it
  reads the BK-32 snapshot columns and includes travel. **The user confirmed
  2026-08-20 that travel is the figure the office adjusts most often**, so the
  two numbers disagree on any out-of-radius booking, both are labelled in
  dollars, and neither says which one the customer was charged.

  The same call is also the *chronic* half: it recomputes from today's prices
  rather than reading the snapshot, and the page's own comment predicted
  exactly that and was left standing — *"BK-32 adds one, snapshotted at
  approval, and at that point this display should read the snapshot instead"*.
  BK-32 shipped; the display did not follow. **Third instance of the
  stale-comment-becomes-justification shape** after `update.ts:266` and
  `booking-email.ts:629`. Severity: moderate-high — it is the screen read
  during a dispute about the amount. **Owner: BK-46.**

- **PARTLY FIXED 2026-08-20 by BK-46, and the remainder is bigger than the
  label.** **The Notifications panel reported a "Customer confirmation" that is
  really the request acknowledgement.** `booking-commit.ts:185` stamps
  `confirmation_sent_at` when the booking-*received* email goes out, and the
  detail page renders that column under the label **CUSTOMER CONFIRMATION**. A
  `pending_review` row therefore states that a confirmation was sent to a
  customer who has been told only that their request arrived. Same class as
  `c346fce` (the office email headed "New booking" under a subject reading "NEW
  REQUEST") and the same audience: the person deciding what to say on the
  phone. The Resend button is correctly hidden here and `resend.ts:84` refuses
  any non-`confirmed` row, so this is a labelling failure and **not** a second
  route to an unpaid confirmation. Severity: moderate.

  **What BK-46 fixed:** the field is now "Request / confirmation email" and
  carries a line naming the senders it does not record.

  **What BK-46 could NOT fix, and this is the real defect:**
  `confirmation_sent_at` has two writers — `booking-commit.ts` and
  `sendConfirmationAndStamp` — while **at least five other customer emails stamp
  nothing**: the payment link, the decline, both expiry messages, the
  post-payment confirmation `markPaid` sends, and the cancellation/restore
  notices. So the column cannot answer *"has this customer heard from us"*, and
  `customerStampState` can render **"Never sent"** for a customer who received
  three emails. The list page has the same badge from the same column
  (`index.astro`'s "No confirmation sent").

  BK-46's first attempt relabelled it *"Last customer email"*, which was a
  STRONGER version of the same lie and was caught at implementation review.
  Making it true means stamping per message type — a schema and write-path
  change across five senders. **Owner: unassigned, needs a ticket.**

- **Three surfaces still speak pre-P9, and none of them had a constant to
  follow the rename.** The appointment header labels `created_at` as
  **BOOKED** and the source as **Booked online** on unpaid `pending_review`
  rows — the exact word `booking-status.ts` retired because *"'booked' was the
  word for the thing that had not happened yet"*. The Notifications panel
  renders **Reminder — Not sent** on every row for a Twilio-gated feature that
  does not exist until deploy 4, which reads as a delivery that failed. And the
  confirm step leaves the full "Review this request" form live directly beneath
  "Confirm the amount", so two amber panels about the same money are on screen
  with nothing saying which is the pending step. Severity: low, office-facing
  only. **Owner: BK-47.** Note for whoever builds it: `verify-cutover.ts`'s
  `BOOKED_CLAIM_SHAPES` covers five surfaces and should have covered this one —
  it is a claim in a field label, which is precisely the shape CLAUDE.md's
  copy-inventory trap says a constant-based inventory misses.

- **The decision is the second-to-last panel on the screen the office opens to
  make it.** On a `pending_review` row, "Review this request" renders after
  Visit, Customer, Notifications, Files and Get photos; the Payment panel sits
  equally deep on `approved_awaiting_payment`. **The user confirmed 2026-08-20
  that the office arrives from the Appointments list and opens one booking to
  act on it**, so every decision costs five panels of scroll. Not a
  correctness defect and not a cause of BK-44 — but it is the other half of
  the same complaint, and BK-44 fixing *which* control is the decision while
  leaving it below the fold would be a half-fix. Severity: low.
  **Owner: BK-47.**

- **Two method traps from BK-44 were PROMOTED to `CLAUDE.md`'s "Known traps in
  the process itself" on 2026-08-20, and live there rather than here** — *a fix
  that turns EXISTING assertions red is a question about the assertions* (seven
  arms in `verify-booking-admin-db.ts` reached `confirmed` through the dropdown,
  so the suite needed the hole open), and *a rule rewrite invalidates every case
  enumerated under the old rule* (BK-44's revision silently dropped a forbidden
  transition and it was a live hole). Promoted because neither is
  booking-specific and this file is the booking area's; a future
  `docs/<area>/ROADMAP.md` would never see them. **Kept as a pointer, not a
  copy** — two statements of one rule is the drift this repo has paid for more
  than once. Read them in `CLAUDE.md`.

- **RESOLVED 2026-08-20 by BK-46** — `internalNotification` reads the snapshot
  where there is one, so the two copies of one booking name one total. **The
  office's copy of a confirmed booking states a DIFFERENT figure from the
  customer's, and BK-45 made the gap visible rather than creating it.**
  `internalNotification` (`booking-email.ts`) renders `assessmentSummary`, which
  calls `assessmentQuote({tier, service, slotStart})` with **no
  `travelFeeCents`** — so it defaults to zero — and recomputes from today's price
  table. BK-45 moved the CUSTOMER's confirmation onto the row's snapshot
  (`assessment_amount_cents` + `travel_fee_cents` + `gst_cents` +
  `total_amount_cents`), and deliberately did not touch the office message. So on
  any booking with a travel fee or an edited amount, the two messages about one
  appointment now name different totals. **Nothing new ships broken** — the
  office notification is not sent on the payment path at all — but it is the
  third instance of the recompute-versus-snapshot shape after the appointment
  header and the email, and it should be fixed in the same pass as the header.
  Severity: low today, moderate the moment anything sends that message.
  **Owner: BK-46.**

- **One office-facing flash still says `booked` where the status is
  `confirmed`.** `[id].astro`'s `EMAIL_MESSAGES.refused` reads *"A confirmation
  is only sent for a booked appointment with an email address"*. It predates
  BK-45 and was not falsified by it, so it was recorded rather than fixed inline
  — BK-45 rewrote only the claims its own change made false. Same class as the
  header's **BOOKED** label and **Booked online** already listed above, and it
  belongs in the same pass so the word is retired from the admin surface in one
  commit rather than three. Severity: low, office-facing only.
  **Owner: BK-47.**

  (`resend.ts`'s header carried the same staleness and **was** fixed under
  BK-45, because that ticket's own change made the rest of that comment false
  and half-correcting a paragraph is worse than either state. Recorded so BK-47
  does not go looking for a string that is no longer there.)

- **`approve` and `rollBack` never clear `paid_at` or `payment_method`, so a
  re-approved booking carries the previous cycle's payment.** Nothing in the
  system clears either column, and `booking-payment.ts:608-618` even stamps
  `paid_at` on a `cancelled` / `declined` / `payment_expired` row when money
  arrives late, without moving the status. A booking that is paid, walked back
  to `pending_review`, and re-approved at a corrected amount therefore sits at
  `approved_awaiting_payment` with a live unpaid Checkout Session AND a
  non-null `paid_at` describing the old money. BK-44 guards the editor against
  reading that as "paid", but the staleness itself is untouched. **It becomes
  visible the moment BK-46 renders those columns** — the screen would show a
  payment date and method belonging to a cycle that was refunded or superseded.
  Severity: moderate, and it is a record-truth failure rather than a money one.

  **BK-46 CLOSED THE DISPLAY HALF ONLY, 2026-08-20, and the split is
  deliberate.** `paymentReceipt` gates on `payment_status` — the column the
  payment path actually maintains — so a re-approved row reports no payment
  rather than the previous cycle's. **The prediction above came true exactly as
  written**, and BK-46's plan review caught it before it shipped.

  **The columns are still never cleared.** That is a change to `approve` and
  `rollBack` — a write path, on a system taking live card payments — separable
  from a display fix and deliberately not done inline. It remains a record-truth
  defect: a query over `paid_at` still returns rows that were not paid on that
  cycle. **Owner: unassigned, needs a ticket.** Whoever writes it decides whether
  re-approval clears the columns or whether that history is worth keeping
  somewhere else.

- **BK-47 inherits a copy dependency it will break.** The Update panel says
  approving is *"in “Review this request” above"*, and that is true only because
  the Review and Payment panels render before the Update form. **BK-47's whole
  job is moving panels.** The sentence is derived per status, so it will not go
  stale on state — only on order. Severity: low, but it is a claim with a shelf
  life and the shelf is BK-47's. **Owner: BK-47**, which should re-read
  `decisionPanelNote` in `[id].astro` before moving anything.

- **A pin whose MESSAGE describes the claim while its ASSERTION covers half of
  it.** `verify-booking-email.ts` asserted *"the office subject says REQUEST,
  not \"New booking\""* — and checked only the subject. The office email's BODY
  heading was hardcoded `New booking` in both arms, ten lines from the string
  the message names, so every office notification for a `pending_review` request
  was titled "NEW REQUEST #35" and opened with "New booking". The one audience
  that has to act on the distinction was told both things in one email.
  **Found by the first real end-to-end booking on production (#35, 2026-08-19),
  not by any of the 23 gates.** Fixed the same day with both arms pinned, and
  with the mirror pinned too — a fix that made the heading unconditionally
  "New request" would have broken the confirmed message identically.
  **The lesson is about the assertion's message, not its logic:** wording a pin
  as though it covers the claim is how the claim stops being checked, because
  the next reader greps the message and believes it. Severity: low impact, high
  recurrence — this is the tenth member of the family this repo records.


**`verify:booking:commit` is at the ceiling of its slot supply (found 2026-08-18,
BK-31; severity: low, owner: unassigned).** The script draws bookable slots from
the 14-day window minus Fridays — about 60 — and `nextSlot()` spends one per
CALL, including on the many arms that deliberately 422 or 409 and therefore book
nothing. By the end of a run the cursor has walked off the end of a pool that is
still largely unbooked, and **any new arm needing a real slot aborts the whole
script mid-run**. Its own error message said "raise SLOTS_NEEDED", which cannot
help: that is a precondition check, not the supply.

BK-31 worked around it with `recycleSlot()`, which asks the database which slots
are actually free rather than trusting the cursor, and corrected the error
message. **The underlying waste is untouched** — the cursor still burns a slot
on every failed arm. The real fix is for `nextSlot()` to stop advancing when a
request did not commit, which means it has to know the outcome, which is a
rework of every call site. Not worth doing until the next ticket needs slots.


- **`npm run typecheck` was red from the day BK-23 shipped until BK-32 opened,
  and BK-23's gate table recorded it as "pass — 0 errors" (found 2026-08-19).**
  Migration 008 added ten columns to `appointments`, and
  `admin/appointments/[id].astro` reads five of them — but `Appointment` in
  `src/lib/db.ts` was never widened, and `adminAppointmentPath` was used at
  `:961` without being imported. Eight `astro check` errors, all in one file,
  all present at `444135a`.

  **The reason it was reported green is the interesting half.** `npm run build`
  passes with all eight: Vite strips TypeScript without checking it, so the
  build gate is structurally incapable of failing on a type error. Two gates ran
  and only one of them could see this, and the one that could was the one whose
  output was mis-copied. **A build is not a typecheck, and "gates green" has to
  name which gate.**

  It is also the BK-35 lesson one column-family later, from the other end: that
  entry says a ticket which changes what a column STORES must grep for
  assertions on it. This says a ticket which ADDS a column must widen the row
  type in the same commit — the migration and the TypeScript record of the
  schema are one change, and nothing in the process pairs them. Severity:
  **medium** — a permanently red gate stops being read, and the next real type
  error hides behind eight known ones. Fixed in BK-32's opening fixup
  (`Appointment` widened with 008's columns and their reasoning, missing import
  restored); BK-32's own migration-010 columns land on the same type with the
  rest of that ticket.
- **A GSAP `from()` tween cannot reveal an element that has a CSS transition on
  the property being tweened.** The tween sets the start state, then re-reads the
  element to learn its destination; on a transitioning element that read lands
  mid-transition and records the START value as the destination, so the tween
  runs `0 -> 0` and the element never appears. **The homepage booking CTA was
  invisible on production for exactly this reason** — `.cta-primary` carried
  `transition-all duration-200` and was the only one of the reveal stagger's
  eight children with a non-zero transition duration. Found by production
  testing, not by a gate. **Therefore:** never give an animated element
  `transition-all`; name the properties `:hover` actually changes. And because
  that alone still strands `transform` (which CTAs legitimately transition for
  the hover scale), every reveal tween in `ContactSection.astro` ends with
  `clearProps` so the final state is the stylesheet's whatever the tween
  recorded. Pinned by `npm run verify:reveal`, which reads the BUILT css because
  the hazard is `transition-all` in source and `transition-property:all` in the
  artifact. Severity: **high** — it silently deletes the page's primary
  conversion element while every gate stays green; owner: fixed in BK-42.
- **A ticket whose subject is UI needs at least one assertion about the RENDERED
  result, not only about the data behind it.** BK-39 shipped six red rows, all
  of them true, all of them about `booking-preview.ts`; its live check confirmed
  the CTA's label string was in the DOM. The string was in the DOM. The element
  was at `opacity: 0`. **A string is in the DOM long before a visitor can see
  it**, and "verified live" meant "found the text", which is the weakest reading
  of the phrase. Severity: **medium**; owner: none, this entry is the fix.
- **The "assertion that cannot fail" family has a sixth instance, and this one
  was written BY the process rather than caught by it.** Found repairing
  `verify-booking-admin-db.ts` during BK-40. The repair compared the stored
  `admin_notes` against `appendUntickedNote(MARKER)` — the very function the
  route calls to produce that value. Breaking the function moves **both sides of
  the comparison together**, so the check stayed green through two deliberate
  breaks (the line not appended at all, and the line overwriting the office's
  own note). It now spells the expectation out: `UNTICKED_NOTE` is data, the
  separator is a literal, and only the joining logic is under test.
  **The general rule, which the earlier five instances only implied: an
  assertion must never call the function it is asserting about.** A helper
  shared between the production path and the test is a helper that cannot go
  red. Severity: **medium** — it silently converts a gate into decoration;
  owner: none, this is the fix.
- **`verify:booking:admin:db` was red from the day BK-35 shipped until BK-40
  found it.** BK-35 made an admin entry append an audit line to `admin_notes`
  when send-confirmation is unticked, and `entryFields()` in that script sends
  no `send_confirmation` — so `admin_notes === MARKER` became false immediately.
  BK-35's ticket records "gates green"; this script was not among the gates it
  ran. **The lesson is not "run more scripts" — it is that a ticket which
  changes what a column STORES has to grep for assertions on that column**, and
  neither typecheck nor build nor the ticket's own verification can find them.
  Severity: **medium**, because a permanently red gate stops being read and the
  next real regression hides behind it. Fixed in BK-40's sibling commit.
- **A new admin POST endpoint must not be a sibling of a dynamic route.**
  `src/pages/api/admin/files/[id].ts` generates `^/api/admin/files/([^/]+?)/$`,
  so `/api/admin/files/delete/` is the same URL shape as
  `/api/admin/files/7/` — and the generated Vercel config emits **no route at
  all** for the delete path, meaning the form would POST at a proxy that only
  exports `GET`. BK-40 put its endpoint at
  `/api/admin/appointments/file-delete/` instead and asserts the generated
  pattern in `verify-booking-smoke.ts`. Same family as the CLAUDE.md trailing-
  slash trap: the dev server resolves it, the route table decides it.
  Severity: **medium** (silent 405/404 on a mutation); owner: none, this is the
  fix.
- **`appointment_files` soft deletes never reclaim Blob storage.** BK-40's
  `deleted_at` hides a row from the admin list, the file proxy and the upload
  caps, but the object stays in the store — deliberately, so a mis-click is
  recoverable. A store that accumulates deletions therefore grows without
  bound. **Severity: low** — deletions are exceptional and the per-appointment
  caps still bound live files. **Owner: none**; the natural home is the existing
  `cleanup-uploads` cron sweeping blobs for rows deleted more than N days ago,
  and it must not be a default.

- **`/api/booking/upload-token/`'s byte cap can be bypassed by re-declaring a
  smaller size, and `size_bytes` is never corrected to the truth.** Found in
  BK-34a's implementation review, on the appointment route, and fixed there;
  this is the untouched twin on the draft route (`upload-token.ts:95-122`).
  Two facts combine. First, `size_bytes` is only ever the size the CLIENT
  declared — `onUploadCompleted` receives no size from Vercel, so migration
  002's comment that it is "overwritten with the true size when the
  upload-completed callback fires" (`scripts/migrations/002-booking.ts:97-98`)
  is **not true**, and never has been. Second, the totals query excludes the
  current pathname so a retry does not consume a slot, and the upsert does
  `SET size_bytes = EXCLUDED.size_bytes`. So: declare 100 MB, upload 100 MB,
  re-mint the same pathname declaring 1 byte, and the row is rewritten downward
  while the object stays. Ten rounds put ~1 GB in the store against a 300 MB
  cap. The **file-count** cap still holds at 10 rows, so this is a ~3.3×
  storage-cost overrun, not unbounded, and it needs no authentication beyond a
  draft token — which is itself unthrottled at the upload-token route (the
  standing trap below). **Severity: medium** — cost, not correctness or
  disclosure. **Owner: BK-11** (the upload-hardening ticket). The fix that
  landed on the appointment side is
  `SET size_bytes = GREATEST(appointment_files.size_bytes, EXCLUDED.size_bytes)`,
  which keeps honest retries working and makes the budget monotonic; the
  migration comment should be corrected in the same pass.
- **"Payment before dispatch" makes an email address mandatory for a phone
  booking, and the client's P7 exemption says it is not.** The payment link is
  emailed. No email → no link → no payment → no dispatch, so a phone booking
  without one cannot be completed at all. SMS delivery of the link is BK-34b,
  which is blocked on the Twilio number, so there is no second channel today.
  P7's exemption ("if we enter ourselves we will ask them to text
  pictures/videos") was written when an admin entry was confirmed on save; it
  did not contemplate a payment step. **Severity: blocking for BK-23/BK-32** —
  not a nice-to-have, because the office will hit it on the first phone booking
  from someone who does not use email. Three ways out, none of them the
  implementer's to pick: make email required on the admin form (overturns the
  exemption), hold such bookings until BK-34b lands (couples the flip to
  Twilio), or let the office take payment by a means outside this system
  (currently out of scope, and would need a `payment_method = 'onsite'` path
  that the client has just ruled out). **Raised with the client 2026-08-16, as
  a forced consequence of their own decision rather than a new question.**
- **A 2am emergency auto-expires within 15 minutes unless the pay-now branch
  exists.** `payment_due_at = min(approved_at + 12h, slot_start − 4h)` is
  already in the past for a booking made at 02:00 for 03:00, so BK-32's expiry
  cron cancels it on its next pass. The 24h web notice floor does not save this
  — admin entries keep the 4h floor and emergencies bypass even that, which is
  the whole point of the phone path. The pay-now branch (P9 decisions above)
  is what makes "payment always precedes dispatch" survivable for the jobs the
  client most cares about. **Owner: BK-32**, and it is not optional.
- **The Resend idempotency prefix will silently eat every P9 email after the
  first.** `booking-notify.ts:186` and `:244` both call
  `createResendSender(apiKey, \`booking-${plan.bookingId}\`)`, and
  `createResendSender` sends `Idempotency-Key: ${keyPrefix}:${message.to}`
  (`:117`). Today one booking sends the customer exactly one message, so a
  fixed per-booking prefix is correct. Under P9 one booking sends the same
  address up to four — request-received, payment link, confirmation, and
  decline-or-expiry — all with the byte-identical key
  `booking-<id>:<their@email>`. Resend collapses everything after the first
  into a duplicate of the first **and returns success**. The customer gets "we
  have your request" three more times and never sees the payment link.
  **Severity: critical, and invisible twice over** — `BOOKING_NOTIFY_DISABLED`
  mutes the sender entirely in dev, and a collapsed send logs nothing in
  production. This is the same defect class BK-16 already fixed on the calendar
  side; `inviteIdempotencyPrefix` (`booking-ics.ts:156`) exists precisely
  because a fixed prefix collapsed CANCEL into REQUEST. **Owner: BK-23, and it
  is the first task of Deploy 2** — the prefix must carry the transition.
- **The "assertion that cannot fail" family has a SEVENTH instance, and it was
  found by logging a red row rather than by a review.** BK-23's should-fix S6
  asked only that the arbiter and hold/release assertions get red rows, since
  they had none. Driving one of the breaks — adding `'completed'` to
  `LIVE_STATUSES` — produced **no failure at all**. The reason:
  `verify-booking-admin.ts` built its upcoming/past expectation as
  `LIVE_STATUSES.includes(status)`, reading the same constant
  `partitionAppointments` reads to make the decision under test. Both sides moved
  together, so putting finished jobs into the office's *upcoming* column kept
  every assertion green.

  The sixth instance's rule already covered it — *an assertion must never call
  the function it is asserting about* — and this widens it by one word:
  **never call the function OR READ THE CONSTANT it is asserting about.** A
  shared list is a shared function with the parentheses left off.

  The expectation is a literal now, `LIVE_STATUSES` is deliberately not imported
  there, and a completeness check fails loudly if a status is added to the enum
  and to neither list. **The transferable part is the method, not the fix:**
  every one of the seven was found by breaking the production target and
  watching, and this one was invisible to two fresh-agent reviews that read the
  code. Severity: **medium** — it silently converts a gate into decoration;
  owner: fixed in BK-23's should-fix pass.

- **A bare `npm run migrate` meant PRODUCTION, and on 2026-08-18 it took the
  booking funnel down.** `scripts/migrate.ts` read `DATABASE_URL` with no
  argument; `DATABASE_URL_DEV` was only ever reached by scripts that opted into
  it. A migration intended for the dev branch was applied to production, which
  renamed 10 live rows and rebuilt `appointments_slot_unique` on the new
  deny-list predicate while the deployed code still arbitrated on
  `status <> 'cancelled'`. **Postgres resolves an `ON CONFLICT ... WHERE`
  arbiter by proving it implies the index predicate, and that relation is
  directional** — the wider old arbiter does not imply the narrower new
  predicate, so every booking, public and admin, raised 42P10. Restored by hand:
  index predicate reverted, `confirmed` → `booked` on 10 rows, default and CHECK
  restored, the three `schema_migrations` rows deleted. The added columns were
  deliberately left in place — `main` never names them, they all default, and
  `ADD COLUMN IF NOT EXISTS` re-adds them cleanly.

  **Three fixes, all landed:** `migrate.ts` now requires `--target dev|prod`
  with no default, proves the dev host differs from production before touching
  anything, and prints the resolved host on every run including `--status`; the
  rollout instruction in the build order above was rewritten (it prescribed the
  order that caused this); and `verify:booking:commit` carries a permanent
  both-arbiter probe so the directional rule is an assertion rather than
  something relearned from an outage.

  **The lesson worth keeping is about the guard, not the command.** The
  comparison that would have caught this already existed — `verify-booking-smoke.ts`
  has always proved dev ≠ prod before writing a row, and the ad-hoc reset script
  written minutes earlier that day made the same check and refused correctly.
  **A guard that lives on the paths someone was already being careful about is
  not a guard.** It belongs in the tool everything goes through. Severity:
  **high** (live outage, manual recovery); owner: fixed here.

- ~~**The admin Resend button still collides with the booking-time
  confirmation.**~~ **CLOSED in BK-32 — and the diagnosis above was wrong, which
  is the part worth keeping.** This entry claimed `resend.ts:90` collided with
  "the payment-time confirmation" because `planForAppointment` defaults
  `messageType` to `'confirmed'`. Checked at BK-32's plan review, against the
  code rather than against this paragraph:

  - `markPaid()` sends the payment-time confirmation through
    `sendCalendarInvite` → `inviteIdempotencyPrefix(id, kind, now)`, which has
    carried a clock since BK-16. It never produces `booking-<id>-confirmed`.
  - Since BK-23 both create paths pass `messageType: 'request'` explicitly
    (`api/booking/create.ts:223`, `api/admin/appointments/create.ts:132`).

  So `resend.ts` was the **only** producer of that key in the whole codebase,
  and there was nothing for it to collide *with*. The real defect was one step
  simpler and just as bad: **clicked twice inside Resend's 24-hour window, the
  button delivers once and reports "sent" both times** — on the office's only
  manual recovery for a message that went missing.

  Fixed by `notifyIdempotencyPrefix` gaining an attempt component
  (`booking-<id>-<type>-<epoch s>`), mirroring `inviteIdempotencyPrefix`. The
  same clause closes BK-23's S2, which was real as written.

  **The transferable part is not the fix.** This entry was written from a
  reading of the code and was wrong about which pair of things collided; it then
  survived into two tickets' plans as a premise nobody re-derived, and BK-32's
  first plan restated it verbatim. **A Known trap is a claim with a shelf life,
  and one that names specific call sites should be re-checked against them
  before it is inherited** — the codebase moved underneath this one twice
  (BK-16, then BK-23) and the paragraph did not.

- **`update.ts`'s ICS boundary is keyed on the literal `'cancelled'`, and P9
  gives it three exits instead of one.** `update.ts:209-213` computes
  `wasCancelled` / `isCancelled` and derives the ICS kind from them. With
  `declined` and `payment_expired` also releasing the slot, the rule has to
  become "leaving a slot-holding status", not "entering `cancelled`" — else a
  `confirmed → payment_expired` edit leaves a live invite on two calendars with
  nothing to clear it. **The decline and expire branches are no-ops by
  construction today** and that is deliberate, not an omission: invites only
  issue at payment-confirmed, so a row that reaches `declined` from
  `pending_review` never had one. The guard is "was an invite ever issued",
  which is what makes the branch correct rather than dead. **Owner: BK-23.**
- **A `GST_REGISTRATION_NUMBER` env var cannot put the number on a Stripe
  receipt.** Stripe renders business and tax info on Checkout receipts from
  Dashboard settings (or through Stripe Tax / Invoicing), not from anything
  passed into the session. The receipt needs a Dashboard configuration step
  that no amount of code will cover. **(That sentence is the one this entry got
  wrong. The Dashboard step exists, was taken, and did nothing for this path —
  code covered it. See the BK-48 note below.)** **Severity: low technically, high
  operationally** — it is the kind of thing found at go-live, by an accountant.
  **Owner: BK-32**, recorded as a rollout task rather than an implementation
  one.

  **CLOSED 2026-08-20 AND RE-OPENED THE SAME DAY BY THE FIRST REAL RECEIPT.**

  The Dashboard step was taken (`CA GST/HST 775654577RT0001`, under Settings →
  Billing → **Invoices** → "Invoice tax information") and this entry was marked
  closed on the strength of it. **The receipt from live booking #36 shows no
  registration number anywhere.** Observed, not inferred: the emailed receipt
  lists `On-site restoration assessment × 1 — CA$598.50` and
  `GST (5%) × 1 — CA$29.93`, and the payment page states **"No tax rate
  applied."**

  **Why the Dashboard step did not do it**, and the distinction is the whole
  lesson: that field governs **invoices**. A Checkout Session produces a
  **receipt**, which is a different artifact, and our GST is a hand-built line
  item rather than a Stripe Tax rate — so Stripe has no tax registration to
  render on it and does not.

  **The sentence this entry carried was therefore wrong in BOTH halves.** It
  said Stripe renders tax info on Checkout receipts from Dashboard settings (it
  does not, for this shape), and that after the Dashboard step "the number
  appears on Stripe's receipt and nowhere else" (it appears nowhere at all).

  **The method failure is the one to carry forward: this was marked CLOSED on a
  configuration step, with the entry's own text saying the only proof was a real
  receipt, and the receipt not yet in hand.** A configuration change is not
  evidence of its own effect. Nine hours later the receipt arrived and
  contradicted it.

  **Severity: HIGH and live.** A GST registrant must give the registration
  number on a receipt for a supply over $30 so the customer can claim an input
  tax credit. Every live receipt from 2026-08-20 onward lacks it.

  **The fix was code, not configuration** — the line item NAME is ours and it is
  what receipts render. **FIXED 2026-08-20 by BK-48**: the GST line is named
  `GST (5%) — Reg. 775654577RT0001`, and our approval email and paid
  confirmation carry the registrant too — which matters because an Interac payer
  never receives a Stripe receipt at all.

  **SUPERSEDED BY BK-48, 2026-08-20.** Everything from here down is the record
  of what was believed before the first real receipt existed, kept because the
  belief was reasonable and wrong in an instructive way. Two of its sentences
  are now false and both are corrected above: no code read
  `GST_REGISTRATION_NUMBER` (a CONSTANT of that name is now read by
  `booking-payment.ts` and `booking-email.ts`), and Stripe's receipt is NOT
  where the number appears — BK-48 put it in the line item name because Stripe
  put it nowhere.

  **Corrected 2026-08-19.** This entry used to add *"the env var correctly
  drives our emails"*, and BK-32's own rollout note says the same. **It is not
  true: no code reads `GST_REGISTRATION_NUMBER`, anywhere.** Verified by grep
  over `src/` and `scripts/` after BK-36. Our emails itemize the GST *amount*
  (`booking-email.ts`'s approval table) and print no registration number, so
  after the Dashboard step the number appears on Stripe's receipt and nowhere
  else. That is very likely sufficient — Stripe's receipt is the tax receipt —
  but the sentence claiming otherwise was the kind a next reader would rely on
  while setting an env var that does nothing. **Not a Deploy 2 blocker.** If the
  client wants the number on *our* approval email too, that is a small ticket
  and it does not exist yet.
- **RESOLVED 2026-08-16 by BK-29 — kept for the lesson, not as open work.**
  "Free assessment" was claimed unconditionally in 51 places across 22 files.
  The 2026-08-14 credit model made the claim FALSE rather than merely
  conditional: every customer pays at the visit and only gets it back by going
  ahead, so nobody gets a free assessment at the point of sale. Swept and
  deployed with BK-27; a live check across 12 pages plus `llms.txt` returns 0.

  **Three things worth carrying forward:**

  1. **A source-level grep of the page files would have passed.** `<Navbar />`
     put the phrase into 16 built files — including `404.html` and
     `blog/index.html`, which appear in no source inventory because they inherit
     it from a layout. The gate that holds this now reads `dist/`, after the
     build, in `verify-cutover.ts`. Any future claim-sweep needs the same shape.
  2. **`llms.txt` needs its own assertion.** It is neither `.html` nor `.js`, so
     the glob misses it, and it is the surface an AI assistant quotes with no
     page around it to qualify anything.
  3. **The first version of that gate matched `free` ADJACENT to `assessment`,**
     so `/book/confirmed/`'s "Your free on-site restoration assessment is
     booked" stayed green — and it had looked covered in the first red run only
     because the Navbar string was still on the page. Two shapes now, for the
     claim's adjectival and predicative grammars. See BK-29's implementation
     notes; this was the fifth instance in P8 of an assertion written against a
     token instead of a claim.

- **A Blob/upload-token failure now kills the booking with no phone fallback
  and no funnel event.** BK-22's Q2 names two live causes of "photos are
  impossible to attach": the draft route's 429, and *a Blob/env
  misconfiguration*. Only the first reaches `failPhotoUpload()` — the branch
  that says "call or text us and we'll book it for you" and raises
  `booking_photo_upload_unavailable` — because Scope 10 scoped the remedy to
  `mintDraft`, and `/api/booking/draft/` never touches Blob (it rate-limits and
  signs a token, nothing else). A Blob misconfiguration therefore fails one
  layer down, at `/api/booking/upload-token/` or the PUT, where the island's
  only response is `entry.status = 'failed'` with "That upload didn't finish."
  The client counts `{done, failed}`, so step 3 lets the visitor submit; the
  server counts `appointment_files` rows, of which there are none (the row is
  written at token-mint time, and the mint is what failed); the 422 sends them
  back to step 3 reading "Add at least one photo or video" beside an attachment
  they can see. Retry is the only exit and it fails again if the cause is the
  deploy. **Severity: medium** — it needs a broken deploy to trigger, but when
  it triggers the whole public booking funnel is dead *and* the one event that
  would reveal it does not fire, so the client's "did the new filter cost me
  jobs" question is unanswerable in exactly the case it matters. **Owner:
  none** — a small follow-up (surface the hard notice + event from the upload
  path too, not just the mint path). Found during BK-22's implementation
  review, 2026-08-13; not fixed inline because the implementation matches the
  approved Scope and the gap is in the ticket.
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
  `DRAFT_RATE_LIMIT_PER_HOUR` scales this linearly. **That raise has now
  landed** — BK-22 took it 20 → 50 (user decision), so the ceiling this note
  describes is 50 × 10 unthrottled `onBeforeGenerateToken` calls per IP per
  hour. Severity unchanged: still low, still bounded by the per-draft caps.
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
| BK-22 | Mandatory email + ≥1 photo/video on the public form — server-enforced at commit, form UX, admin exempt | Reviewed | **committed** 2026-08-13 — implementation review passed (no blockers; 3 nits, 1 Known trap) |
| BK-23 | Review lifecycle core — migration (pending/declined + index — **006**; BK-27 took 005), public bookings land pending, received-your-info page + email (no invite), admin Approve/Decline, approve → BK-16's confirmation+invites, decline → at-capacity email, 24h minimum notice | Reviewed | not started |
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

### P8 — Fee terms + homepage availability (client change request 2026-08-13)

> **⚠ P8's payment narrative is SUPERSEDED by P9 (2026-08-16/18).** The fee
> figures, the three tiers and the credit stand. "Paid at the end of the visit",
> "nothing is charged at booking", "tell the tech on the day" and blanket
> non-refundability do not — see P9 below and `prepay-flow-spec.md` §6 item 4,
> which recorded this marker as outstanding. **BK-36** rewrote the copy.

Client decisions relayed 2026-08-13: (1) new assessment fee conditions — free
when the customer proceeds with us; otherwise $699 for a cause-of-loss report
and estimate, or up to $1,200 including an insurance sketch/diagram — shown on
the homepage booking section AND on `/book/` with a required acknowledgment
checkbox, recorded in the DB, echoed in the confirmation email, admin exempt
(user decisions, same day); (2) the homepage booking section gains an
availability preview (next few slots, deep-linked into `/book/`).

The client also asked to apply BK-22's conditions "to quote requests as well" —
**no ticket**: since BK-10 the quote path *is* the booking form, so the
conditions already apply everywhere a quote can be requested. Confirmation
message drafted for the user to send; if the client turns out to mean the
contact/message form, that becomes a new decision (and note the contact
endpoint's standing gaps: no rate limit, no spam protection — Known-trap
material if it ever gains requirements).

| Ticket | Scope | Tier | Status |
| --- | --- | --- | --- |
| BK-27 | Assessment fee terms — `booking-copy.ts` constants (**five**: heading, intro, three tiers, outro), step-3 required ack, `terms_acked_at` column (**migration 005**, applied to dev), public-only enforcement via the `entry` seam, both booking surfaces reworded + pinned against "free assessment", confirmation-email echo | Reviewed | **DEPLOYED 2026-08-16** (`a1eedc9`; migration 005 applied to production first). Two fresh-agent rounds: the mechanism 2026-08-14 (2 blockers / 4 should-fixes / 3 nits) and the copy revision 2026-08-15 (0 blockers / 4 should-fixes / 3 nits). **All folded in, nothing refused, nothing disputed.** The revision brought the credit model, three tiers ($399 / $699 / $1,199 + GST), `FEE_TERMS_OUTRO` (nothing-charged-at-booking + the non-refundable disclosure), five render surfaces and three pins in `verify-cutover.ts`. 19 red rows logged (l–ad). The re-review's sharpest catch: `stripForUse` was deleting the template after every `https://`, so the "free assessment" pin passed green while the phrase rendered into `dist/`. Plan review skipped on the user's instruction (recorded in the ticket). Verified live: `/book/` serves all three tiers, the terms box, the credit and the non-refundable line; the smoke test confirms both stamp columns write without a type error |
| BK-28 | Homepage availability preview — pure `booking-preview.ts` + `AvailabilityPreview.svelte` island (`client:visible`, zero-CLS skeleton), `?slot=` prefill hardened (grid check + extracted reconcile helper) | Reviewed (narrow — `?slot=` feeds the public write path; LCP/CLS) | draft — same session plan; implement after BK-27 (shared files) |

**The pricing model changed on 2026-08-14, after BK-27 was built and reviewed.**
Every customer now pays at the visit and the fee is credited against the final
invoice if they proceed; three tiers ($399 / $699 / $1,199, all + GST), chosen at
booking, non-refundable, no time limit on the credit, paid on site only. The full
decision record — including the insurance-route recommendation, the replacement
copy, and what is still open — is in `tickets/BK-27.md` under **"Client pricing
model — FINAL, 2026-08-14"**. Read it before touching booking copy.

**Applied to the code the same day** — see BK-27's "Copy revision — applied
2026-08-14". The tiers now live in `booking-copy.ts`, `book.astro`'s `<title>`
and schema `name` are the only "free assessment" strings left on the two booking
surfaces, and they are BK-29's.

Two consequences for the phase:

| Ticket | Scope | Tier | Status |
| --- | --- | --- | --- |
| BK-29 | Remove "free assessment" site-wide (~50 places: every service page, `data/services.ts` SEO copy + FAQs, `about`, `insurance-claims`, `Navbar`, `Layout`'s default meta description, `BlogLayout`, 3 blog posts, `llms.txt`, `TestimonialsSection`, `ServiceHero`, `VideoReel`, `ContactForm`, `contact.astro`) — **plus `book.astro`'s `<title>` and WebPage schema `name`**, which BK-27's revision deliberately left for this ticket so the search surface changes in one commit | Light (copy) | **DEPLOYED 2026-08-16** (`1de17d0`) — Light tier, no reviews by design; gates green, 7 red rows. Swept all 51 claims across 22 files; **0 now reach the browser** (was 18 built files). New gate in `verify-cutover.ts` reads `dist/`, not source — `<Navbar />` alone put the phrase into 16 built files including `404.html` and `blog/index.html`, which no source inventory listed. Figures stayed in `booking-copy.ts`: marketing surfaces dropped the claim rather than restating the price, and "free" was replaced by "written scope", already claimed site-wide. Also removed a surviving "no obligation" on `insurance-claims.astro`. **Shipped with BK-27; live sweep confirms 0 claims across 12 pages plus `llms.txt`** |
| BK-31 | Assessment tier selection at booking — form control, `assessment_tier` column, validation, both emails, admin display + edit for upgrades. Non-binding by design: the form must say the choice can change on the day | Reviewed | proposed — ships after BK-27 + BK-29 |

Recommended sequence: **BK-27 (new copy) + BK-29 ship together**, then BK-31.
That puts the accurate pricing and the removal of the "free" claim live quickly
— the part with actual exposure — without waiting on the picker. The interim is
honest: the box states three prices and the customer tells the tech which they
want. Recording payments is NOT in this phase; it belongs to the
quote → work order → invoice workflow (`workflow-options.md`).

Ordering vs P7: BK-27 lands **before BK-23** (its confirmation-email echo is
an at-submission artifact; BK-23 inherits a recorded handoff to move it into
the received-your-info email when the emails split). BK-28 has no coupling to
BK-23 and follows BK-27 only for clean diffs. BK-18 must preserve BK-28's
`?slot=` preselect + reconcile helper when it eventually replaces the step-1
UI.

Related, not a ticket: the quote/booking → work order → invoice workflow the
client floated is documented as an options report at
`docs/booking/workflow-options.md` (integrate vs build vs self-hosted OSS,
with recommendation); awaiting the client's direction before any tickets
exist.

**SUPERSEDED IN PART BY P9 (2026-08-16).** Three P8 statements are dead:
"nothing is charged at booking", "paid on site only", and "tell the tech on the
day which of these you want". The client moved to prepay-after-approval on
2026-08-16. BK-27 shipped and is not being reverted — its terms constants are
rewritten by BK-36, and the sentence about BK-31 being "non-binding by design"
is deleted, not softened. Read P9 before touching booking copy or the fee
terms; BK-27's "Client pricing model — FINAL, 2026-08-14" block is now
history, not direction.

### P9 — Prepay after review (client change request 2026-08-16)

**A web booking is a request until the office approves it AND the customer
pays.** This completes the reversal P7 began: P7 made a booking an application,
P9 makes payment the thing that confirms it. Client-confirmed 2026-08-16;
audit, mechanism spec and draft copy in `docs/booking/prepay-flow-spec.md`,
which is the long form of everything below and should be read before any P9
ticket is implemented.

```
submit request ──▶ pending_review ──▶ approved_awaiting_payment ──▶ confirmed ──▶ completed
   (photos req'd)      │  hold             │  hold                     │  hold        │ hold
                       ├─▶ declined        └─▶ payment_expired         ├─▶ cancelled  └─▶ no_show
                       │   (release)           (release)               │   (release)      (hold)
              request-received email     payment-link email     confirmation + ICS + SMS
              (no ICS, no "booked")      (deadline stated)      reminder eligibility starts
```

**Decisions (client, 2026-08-16 — final, do not relitigate):**

- **Status rename `booked` → `confirmed`**, in the same migration that adds the
  new statuses. Under prepay, "booked" is the word for the thing that has not
  happened yet. All three enum sites move together: `db.ts`'s
  `AppointmentStatus`, the DB `CHECK`, and `APPOINTMENT_STATUSES` in
  `booking-admin-entry.ts` (what the admin edit dropdown renders *and*
  validates against).
- **Slot hold is a deny-list**: `WHERE status NOT IN ('cancelled', 'declined',
  'payment_expired')`. `pending_review`, `approved_awaiting_payment`,
  `confirmed`, `completed` and `no_show` all hold. Deny-list deliberately, not
  `status IN (...)`: a status added later and forgotten then *holds*, and a
  slot that looks busy is a bug someone notices, where a silently released one
  is two crews at one address.
- **Minimum notice 4h → 24h for web.** This is the client's own 2026-08-12
  decision (P7) finally being applied, not a new rule — it was assigned to
  BK-23 and BK-23 never started. Admin/phone entries keep the 4h floor; they
  are exempt from the whole gate.
- **Payment deadline** = `min(approved_at + 12h, slot_start − 4h)`.
- **Timers, all three** — auto-decline stops being slot−24h and becomes
  submission- and escalation-relative. **Split across two deploys, 2026-08-19:**
  | Trigger | Action | Ticket / deploy |
  | --- | --- | --- |
  | unreviewed 2h after submission | owner SMS (Twilio-gated; email until then) | BK-25, Deploy 3 |
  | still unreviewed at slot−12h | second escalation | BK-25, Deploy 3 |
  | still `pending_review` at slot−4h | **expire: release the slot + apology email** | **BK-23 Task 4, Deploy 2** |
  The last one is forced rather than arbitrary: past slot−4h the payment
  deadline has expired, so a confirmation can no longer complete. **It moved
  into Deploy 2 on 2026-08-19** because it is the only automatic exit from
  `pending_review`, which holds its slot — and BK-23's review added a guard
  refusing to approve an elapsed slot, so without the sweep a lapsed request is
  stuck in a slot-holding status with its only transition out blocked. It lands
  in BK-32's cron handler as a second sweep rather than a second schedule. The
  two *alert* timers stay in Deploy 3: they want Twilio, and nothing breaks
  without them.
- **ICS: customer AND office invites both move to payment-confirmed.** The
  admin panel is the pending view; the calendar only ever shows money-confirmed
  work. CANCEL goes out on decline/expire/cancel **for any invite already
  issued** — see the Known trap below on why those branches are no-ops today.
- **PAYMENT ALWAYS PRECEDES DISPATCH. NO EXCEPTIONS** (client, 2026-08-16,
  answering what were open questions #5 and #9). Emergencies and office-created
  phone bookings included; **phone customers pay by link** like web customers.
  This closes the hold that an earlier draft of this section placed on
  dispatch/payment ordering — that hold is withdrawn, and the status quo it
  preserved is now wrong.

  Consequences, none of them optional:

  - **Admin entries stop landing at `confirmed`.** They land at
    `approved_awaiting_payment` — the office creating the row *is* the
    approval — and reach `confirmed` only through the same webhook a web
    booking does. `payment_status` defaults to `pending`, not
    `not_required`; that value survives only for rows predating BK-32.
  - **No confirmation email and no ICS at admin-entry time.** Both move behind
    payment, exactly as on the web path. `api/admin/appointments/create.ts`
    currently fires both at `:103-115`.
  - **Near-term bookings need a pay-now branch** — see the Known trap below.
    The deferred-deadline formula cannot be applied to a 2am emergency.
  - **Emergency flag: still not built, and now for a better reason.** It would
    have keyed a payment exemption that no longer exists. What replaces it is a
    *timing* branch keyed on proximity to the slot, not on a flag anyone ticks.
- **Review SLA stays internal.** "Almost right away, max 1 hour" is not
  published — it would turn an operational intent into a screenshot-able
  commitment.
- **GST** is charged as a separate Stripe line item, and the receipt must show
  the registration number. **BK-48 (2026-08-20) made it a CONSTANT, not an env
  var** — `GST_REGISTRATION_NUMBER` in `booking-config.ts`, beside
  `INTERAC_EMAIL` and for the same reason. The env var was chosen when the
  number was unknown; an env var unset in Vercel means silently absent from
  every receipt, which is the defect BK-48 was filed for.
- **Service-area FSA list** ships with a proposed Edmonton-metro default behind
  config. Client signs off later; not a blocker.

**Settled in planning, without the client (assumptions, overturnable):**

- **The pay-now branch is keyed on time-to-slot, not on a flag.** When
  `slot_start − now < PAY_NOW_THRESHOLD_HOURS` at approval, the deferred
  deadline is skipped: the link is sent immediately, no `payment_due_at` is
  computed from the formula, and the expiry cron leaves the row alone. Propose
  `PAY_NOW_THRESHOLD_HOURS = 8`. Keying on proximity rather than on an
  `is_emergency` checkbox means nobody has to remember to tick anything, and a
  near-term *web* booking gets the same correct treatment for free.
- `PAYMENT_WINDOW_HOURS = 12` and `ESCALATION_LEAD_HOURS = 12` are
  business-feel numbers the client may move; they are constants, not literals.
- The FSA zone renders `unknown` when no postal code was given or the FSA is
  not in the table — never `out-of-area`. A missing postal code must not read
  as grounds to decline.

**Amendments — client answers 2026-08-18 (WhatsApp), and the external-spec merge**

An independently-written spec (`deploy-2-prepay-spec.md`, authored outside the
repo, dropped 2026-08-18) was audited against the codebase before any of it was
adopted. **P9 is authoritative wherever the two conflict** — the user's
instruction, 2026-08-18. Two of its items were genuinely new and are folded in
below (Interac e-Transfer, the refund baseline); five of its assumptions were
wrong about this codebase and were corrected rather than adopted. The full
audit and the merge record are in `prepay-flow-spec.md` section 8.

**New client answers, all final, all merged into the tickets below:**

- **Minimum notice becomes NEXT-DAY EARLIEST for web** — not the "4h to 24h"
  wording the 2026-08-12 decision was recorded in above. **These are different
  rules and the difference is real:** 24 rolling hours would block a Wednesday
  11:30 slot for a customer booking Tuesday at 15:00; next-day-earliest allows
  it. Next-day-earliest is the looser of the two and it is what the client
  asked for on 2026-08-18, so it is what ships. The 2026-08-12 decision is
  superseded in its *value*, not in its intent — the intent was always "no
  same-day web bookings", which both rules satisfy.

  Consequence, and the reason this is safe: the worst case under
  next-day-earliest is a booking made at 15:29 for the next day's 11:30, which
  is ~20h of notice but can leave only ~30 minutes between an 07:00 approval
  and the `slot - 4h` deadline. **That case is already handled** by the pay-now
  branch (`PAY_NOW_THRESHOLD_HOURS = 8`, settled in planning above): at
  approval, if `slot_start - now < 8h` the deferred deadline is skipped
  entirely and the link is sent to be paid immediately. No new mechanism is
  needed; the constant simply now earns its keep on the web path too, not only
  on 2am emergencies.

  Admin/phone entries keep their existing total bypass — same-day allowed.
  Implemented as a **calendar-day** rule, not an hours rule: BK-23 replaces
  `MIN_NOTICE_HOURS` with `MIN_NOTICE_DAYS = 1` and makes
  `isWithinBookingWindow` compare date keys. `earliestBookableInstant` stays as
  the single chokepoint both the picker and the availability filter already
  read, so the change lands in one function rather than at every call site.

- **Mould gets its own tier prices** (client: "we have to be a bit more
  competitive with mold estimation"). The pricing table is therefore keyed
  **`(tier, service) -> amount_cents`**, with a default row per tier and a
  mould override row per tier — *not* `service_type -> amount` as the external
  spec assumed, and not a flat per-tier table as BK-31 originally specified.

  | Tier | Default | `mold` override |
  | --- | --- | --- |
  | `standard` | $399 + GST | **$385 + GST** |
  | `report` | $699 + GST | **$645 + GST** |
  | `sketch` | $1,199 + GST | **$1,185 + GST** |

  "For now" per the client — so the override table is a literal map with one
  entry, and a price move stays a one-line change. Every other service falls
  through to the default row; a service with no override is not a special case
  in the code.

- **After-hours multiplier: 1.5x, and it applies to ordinary weekend bookings
  made online** (client: "Yes weekend is extra"). Saturday and Sunday are
  already open — `CLOSED_WEEKDAYS = [5]` closes Fridays only — so this is a
  live path, not a hypothetical. **The form must show the multiplied price
  before the customer sends the request**, which makes price display a BK-31
  deliverable rather than a BK-32 one.

  **Stat holidays are out of scope for the online form in v1** (deferred, not
  forgotten): the client can blackout the date or take the booking by phone.
  Recorded as a deferred item on BK-31 so the next reader does not mistake the
  omission for an oversight.

- **Travel fee: $1.15/km round trip, beyond 30 km from the office.** Shown to
  the admin at review time as a *suggestion* only — **never auto-charged**.
  There is no distance API anywhere in this infrastructure today (confirmed by
  audit: no maps key, no geo code, no billed third party), and the client's
  instruction is explicitly not to block on adding one. So v1 ships the
  constants and the field, computes nothing, and leaves a TODO. The admin types
  the number, which the adjustable-amount control below already accepts.

- **Admin-adjustable amount at approval** (new scope, small, and it absorbs a
  lot). The approval screen pre-fills the amount from the pricing table
  including the weekend multiplier; the admin may edit it before the Stripe
  Checkout Session is created. This is what makes travel fees, extra lab
  samples and case-by-case pricing work with no extra calculators anywhere.

  Two fields, not one, because the approval email has to **itemize
  `base + travel + GST = total`** and a single edited number cannot be
  itemized: `assessment_amount_cents` (pre-filled, editable) and
  `travel_fee_cents` (default 0, editable). GST is computed, never typed.

  **The public write path is unchanged by this and must stay unchanged:** the
  customer's payload carries a tier *key* and never an amount, and the server
  recomputes from the table. The override is an authenticated admin action at
  approval time, on the server, after the request exists. A verify assertion
  pins that a posted amount is ignored.

- **Refund baseline — fills BK-36's placeholder, answering open question #4:**
  *full refund if cancelled 24+ hours before the appointment; no refund within
  24 hours of it.* Case-by-case exceptions stay manual in the Stripe dashboard;
  **no refund code changes** — BK-33's mechanism is unaffected, it just stops
  rendering `[PLACEHOLDER]`.

- **Interac e-Transfer, manual path (new scope, from the external spec).**
  Folds into BK-32's `markPaid()` seam as a **second entry point to the same
  `approved_awaiting_payment -> confirmed` transition** — one confirmation code
  path, two callers. The approval email offers the Stripe link and the Interac
  address with the booking number as the message. Admin gets a
  "Mark as paid — Interac" action on approved rows. `payment_method` records
  which. A Stripe payment landing on an already-Interac-confirmed row is the
  race: the second attempt **no-ops** (the guarded update returns zero rows)
  and the row is flagged for a manual refund. **No inbox parsing, no
  auto-matching** — deliberately deferred.

- **All three tiers stay bookable online** (client-confirmed). Tier 3's copy
  **must state that lab results take 3-5 business days** — BK-31 and BK-36.

- **GST registration number: ANSWERED 2026-08-20 — `775654577RT0001`.** No
  longer a placeholder and no longer an env var; see BK-48.

**Corrections applied to the external spec rather than adopted from it** (each
verified against the code on 2026-08-18; see `prepay-flow-spec.md` section 8):

| The external spec assumed | Actual, and what ships |
| --- | --- |
| Next-day notice already live | `MIN_NOTICE_HOURS = 4`; same-day web booking is possible today. BK-23 implements the rule. |
| A client "Yes" email creates the calendar event | No such flow exists. Booking auto-confirms at commit and mails two ICS-bearing emails. There is nothing to repoint — approve/decline is built from nothing. |
| Google Calendar API (service account / calendar id) | **None.** Calendar events are `.ics` attachments on emails. Confirmation is ONE send carrying a `REQUEST` ics; cancellation is a `CANCEL` ics under the same UID with a byte-identical `ORGANIZER`; decline/expiry must never have sent a `REQUEST` in the first place. Reuse `inviteIdempotencyPrefix`. |
| Pricing keyed `service_type -> amount` | Prices are **assessment tiers**, orthogonal to service, and no customer can pick one yet. Keyed `(tier, service)` per the mould answer above. |
| Manual booking respects blackout dates | It bypasses blackouts, Fridays, the horizon and the notice rule — deliberately, documented at `api/admin/appointments/create.ts:34-38`. **Keep as-is** (user, 2026-08-18). |

Nothing in the external spec's "out of scope" list is honoured where it
conflicts with the above: it put minimum-notice changes out of scope, and the
minimum-notice change is a prerequisite for its own payment deadline.

| Ticket | Scope | Tier | Status |
| --- | --- | --- | --- |
| BK-43 | **Resend idempotency prefix carries the message type** — `booking-<id>:<to>` becomes `booking-<id>-<type>:<to>`. Split out of BK-23 on 2026-08-18 so the build order does not need one ticket to span two commits. No migration | Reviewed | ✅ **implemented 2026-08-18** — gates green, 4 red rows; awaiting review |
| BK-31 | Assessment tier selection at booking — radio group in the terms box, `assessment_tier` column (**migration 007**), **`(tier, service)` price table with the mould override**, **1.5x weekend multiplier shown live on the form**, `entry`-seam validation, both emails, admin display + edit | Reviewed | ✅ **implemented 2026-08-18** — gates green, 12 red rows; awaiting review |
| BK-23 | Review lifecycle + payment handoff — statuses + rename + index (**migrations 008 expand / 009 contract**), **next-day-earliest notice**, request-received page/email, admin Approve/Decline, decline email, **approval screen with pre-filled adjustable amount + confirm step**, approve → payment link, **stale-request expiry sweep (Task 4)**, service-area badge, ICS boundary rewrite | Reviewed | ⚠️ **reviewed 2026-08-18, blockers fixed** — Tasks 1/2/3/7 built, reviewed and gated. Review: 3 blockers / 6 should-fix / 5 nits, **all resolved** (2 moved to BK-32). **Task 4 respec'd into Deploy 2 and BUILT 2026-08-19** — it ships inside BK-32's cron handler, gated and red-observed, awaiting implementation review with BK-32. Tasks 5, 6 remain Deploy 3+. Not deployable alone |
| BK-32 | Stripe — Checkout Session at approval, webhook-driven `confirmed`, three-layer idempotency, payment columns + `stripe_events` (**migration 010**), GST line item, **expiry cron carrying TWO sweeps — payment expiry (its own) and BK-23 Task 4's stale-request expiry**, **`markPaid()` seam + Interac "mark as paid" second entry point** | Reviewed | ✅ **implemented 2026-08-19** — plan-reviewed first (4 blockers / 10 should-fix / 8 nits, all accepted). 23 gates green, 49 red rows, migration 010 on dev only. **Reviewed 2026-08-19** (2 blockers / 7 should-fix / 7 nits, all resolved) — the review covered BK-23 Task 4's cron in the same pass. Inherited S2 (the prefix now carries an attempt) and N5 (the conversion is the payment, keyed on the Stripe session id) both closed. Awaiting implementation review |
| BK-44 | **The admin status dropdown can perform an approval** — `[id].astro` renders all eight statuses on every row and `update.ts` has no transition guard, so `-> approved_awaiting_payment` approves with no amount/deadline/email and `-> confirmed` mails a confirmation and an ICS **with no payment taken**, against P9's locked "payment always precedes dispatch". Found by the user 2026-08-19 in first real use. Client answer 2026-08-20: no hand-confirm. | Reviewed | ✅ **committed 2026-08-20** on `deploy-2-prepay` — plan review (2 blockers) and implementation review (2 blockers) both passed after fixes; 12 red-first rows; all 23 verify scripts green. **Not deployed.** |
| BK-45 | **The post-payment email carries none of the terms the customer accepted** — `markPaid` sends the calendar-boundary builder, not `customerConfirmation`, so no fee terms, no have-ready list, no chosen tier. Two different messages are both called "the confirmation" and Resend sends the other one. Found by the first real payment 2026-08-19 | Reviewed | ✅ **implemented 2026-08-20** — plan review (5 blockers / 8 should-fix / 3 nits) and implementation review (3 blockers / 3 should-fix / 6 nits) both passed after fixes; merged on the payment path per the user's six decisions; 13 red-first rows; typecheck 0, build clean, all 23 verify scripts green. **Not deployed.** |
| BK-46 | **The appointment screen does not tell the truth about money or mail** — the header total omits the travel fee structurally (`assessmentQuote` called without `travelFeeCents`) and recomputes from today's prices instead of the BK-32 snapshot, so two dollar figures on one screen disagree on any booking with travel; `paid_at` and `payment_method` are written by `markPaid` and rendered nowhere; "Payment due by …" survives the payment; and the Notifications panel labels the request acknowledgement "Customer confirmation". Found 2026-08-20 reviewing the screen against booking #35 | Reviewed | ✅ **implemented 2026-08-20** — plan review returned 6 blockers, all fixed; `appointmentMoney` replaces the header's own derivation; the due line asks whether the row owes; a Payment received panel gives `paid_at`/`payment_method` their first reader; the mail label tells the truth. 10 red-first rows. **Not deployed.** |
| BK-47 | **The appointment screen buries the decision and still speaks pre-P9** — "Review this request" renders after five reference panels on the screen the office opens to decide; the confirm step leaves a second live amount form beneath it; the header labels an unpaid request "BOOKED"; "Reminder — Not sent" advertises a deploy-4 feature. Copy, order and layout only. Build after BK-46 — both edit the header block | Light | draft — see `tickets/BK-47.md` |
| BK-33 | Refund mechanics — `refunds.create`, company-cancel refund in one action, reconciliation webhook. **Customer-cancel policy values are now answered (24h), so only the mechanism is left** | Reviewed | draft |
| BK-34a | Photos for phone bookings — appointment-scoped upload token, public `/upload/<token>/` page, admin fallback file input, per-appointment rate limit | Reviewed | ✅ **DEPLOYED 2026-08-16** (`f6e40b5`) — reviewed, all findings resolved; verified live end to end including a real upload landing in admin. Amended by BK-37 and BK-40 |
| BK-34b | SMS the upload link from the admin create form | Reviewed | blocked — Twilio number |
| BK-35 | Admin entry hardening — email strongly-encouraged warning, send-confirmation audit line | Reviewed | ✅ **DEPLOYED 2026-08-16** (`5a2fe4a`) — reviewed, all findings resolved. Left `verify:booking:admin:db` red (see Known traps); repaired 2026-08-16 |
| BK-36 | Terms rewrite — `FEE_TERMS_OUTRO` split into PAYMENT/REFUND/CREDIT, five renders, terms moved below the picker on `/book/`, `dist/`-reading pins for "deductible" and insurer-billing shapes. **Refund placeholder filled (24h rule) plus the walk-away term; tier 3 states lab results take 3-5 business days; weekend surcharge disclosed; standard-rates sentence reconciles the mould and weekend prices** | Reviewed (copy) | ✅ **implemented and REVIEWED 2026-08-19** — plan-reviewed first (4 blockers / 8 should-fix / 4 nits), then implementation-reviewed (3 blockers / 4 should-fix / 7 nits). **All 30 findings accepted, none refused, all resolved.** 23 gates green, 36 red rows. Also discharges **BK-31's refused blocker B3** and three sibling claims the constant-based inventory could not see: `/contact/`'s hero, `/llms.txt`, and the island's own post-submit card |

**Build order — grouped by DEPLOY, not by commit.** Several tickets must land
together or the site tells a lie between deploys.

1. **Deploy 1 — unblocked prep, no flow change, no migration.** BK-35, then
   BK-34a. Delivers the client's photo problem immediately, without Twilio and
   without touching the booking flow.
2. **Deploy 2 — the flip.** **BK-43 first** (the idempotency prefix — it is a
   blocker on every new email in this deploy and it is invisible in dev), then
   BK-31 → BK-23 → BK-32 → BK-36.

   **Progress, 2026-08-19.** BK-43, BK-31 and BK-23's Tasks 1/2/3/7 are
   implemented, **reviewed by fresh agents, and their blockers fixed** — 7
   blockers, 11 should-fix and 8 nits across the three tickets; one blocker
   (BK-31 B3) refused in writing as BK-36's, two should-fix handed to BK-32.
   The branch is `deploy-2-prepay`.

   **Deploy 2 is CODE-COMPLETE as of 2026-08-19.** Everything below is built,
   reviewed by fresh agents, and has every finding resolved. What remains is the
   user's rollout, in the recorded order — see ROLLOUT below.

   **The record of what was built:**

   | | |
   | --- | --- |
   | **BK-32** | ✅ **implemented 2026-08-19** — Checkout Session at approval (transition first, then Stripe), webhook with a three-layer claim, `markPaid()` with its two callers, the Interac admin action, migration 010, the conversion moved onto the payment, and `verify:stripe:webhook` simulating the generated route table. 23 gates green, 49 red rows. **The open item is closed:** the expiry sweep now cancels the Checkout Session of every row it expires. **Reviewed 2026-08-19** together with the Task 4 cron commit — 2 blockers / 7 should-fix / 7 nits, all resolved |
   | **BK-36** | ✅ **implemented and REVIEWED 2026-08-19** — the release gate is discharged. `FEE_TERMS_OUTRO` split into PAYMENT/REFUND/CREDIT across five renders; the terms moved below the picker on `/book/`; BK-31's refused blocker B3 gone. The Saturday-mould case is closed by one sentence saying the listed figures are standard rates and pointing at the form. Two review rounds, 30 findings, all accepted and resolved. **The three the constant-based inventory could not see are worth recording:** `/llms.txt` published *"confirmed instantly"* AND *"paid at the end of the visit"* in one sentence, `/contact/`'s hero said *"you're confirmed on the spot"*, and the island's own fallback card said *"You're booked"* under a checkmark for a `pending_review` row. None is a constant; all three are now pinned by claim shape rather than by constant name |
   | **BK-23 Task 4** | ✅ **built and REVIEWED 2026-08-19** — the stale-request expiry sweep, in BK-32's cron handler. Reviewed inside BK-32's implementation review, which confirmed every item on Task 4's "Verification it owes" table is delivered, including its amendment |

   BK-23's Tasks 5 and 6 stay out of Deploy 2; both are additive UI and nothing
   built depends on them. Commit separately, one ticket per commit; deploy as one
   release.

   **ROLLOUT — THREE STEPS, AND THE ORDER IS NOT BK-27's.** This paragraph used
   to read "migrations 007/008/009 apply to production first, in order, before
   the code ships", copying BK-27's shape. **That instruction was wrong and it
   caused a production outage on 2026-08-18** — see Known traps. Migration 008
   rebuilt the slot index, and the code then live could not resolve its
   `ON CONFLICT ... WHERE status <> 'cancelled'` against the new predicate, so
   every booking raised 42P10 until the schema was restored by hand.

   BK-23 therefore split its migration into an **expand** half and a **contract**
   half, and the deploy goes between them:

   | # | Step | Why it is safe here and nowhere else |
   | --- | --- | --- |
   | 1 | `migrate --target prod --only 007-assessment-tier,008-review-lifecycle,010-payments` | Additive and widening only. 008 does NOT touch the unique index and does NOT move the column default, so the code still live keeps working unchanged. Its CHECK permits `booked` *and* the new statuses precisely so the old code can keep inserting during the window |
   | 2 | **Deploy the code** | The new arbiter is strictly narrower, so it resolves against the index 008 left standing. This is the direction that works, and `verify:booking:commit`'s deploy-window probe is what keeps it true |
   | 3 | `migrate --target prod` (bare — 009 is all that is left) | Rebuilds the index, moves the default, drops `booked` from the CHECK. Only the new code can survive this, which is why it runs last. Re-runnable: it re-sweeps any `booked` row the window produced |

   **ROLLOUT STATE, 2026-08-19 end of session — steps 1-4 done, step 5 part-way,
   step 6 not started.**

   | Step | State |
   | --- | --- |
   | 1 · migrations 007/008/010 to prod | ✅ done, verified |
   | 2 · deploy the code | ✅ done (`befce39`, then `c346fce`) |
   | 3 · migration 009 | ✅ done, verified |
   | 4 · register the webhook | ✅ done — `booking-payments-test`, **test mode**, `https://www.yegrestoration.ca/api/stripe/webhook/`, 4 Checkout events, Snapshot payload. `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` in Vercel, **Production only** |
   | 5 · test-mode run end to end | ✅ **DONE 2026-08-19 — the whole chain is proven on production.** Booking #35: request → office review → confirm-the-amount step → approve ($606.38, deadline Thu Aug 20 11:39 a.m.) → approval email with Pay button and Interac option → Stripe Checkout (itemized: $577.50 assessment + $28.88 GST) → test card → `/book/confirmed/` → **webhook fired, `markPaid` ran, status went to `confirmed`** → customer confirmation with ICS → office calendar invite. Mould + weekend pricing correct at every surface |
   | 6 · swap live keys | ✅ **done 2026-08-20.** Live mode, a NEW webhook registered in live mode with its own `whsec_`, both Vercel vars updated (Production only), redeployed after. Verified from outside: webhook answers `400 {"error":"No signature"}` (both secrets readable), production deploy is newer than the env update, availability 200 / 59 slots, `/book/` 200, deployed commit matches `origin/main`. **⚠ The MODE itself is not verifiable from outside** — the endpoint behaves identically on test or live credentials. Only a real charge distinguishes them |

   **Two defects were found by that hands-on test, both of which all 23 gates
   missed, and the pattern matters more than either bug:**

   - the office email called a request a *"New booking"* while its own subject
     said *"NEW REQUEST"* — fixed and deployed (`c346fce`);
   - the admin status dropdown can perform an approval, which is the one thing
     `review.ts` was split out to prevent — **recorded as BK-44, not fixed.**

   **A third came out of the payment run itself: BK-45.** `markPaid` sends
   `planFirstConfirmationEmail`, a calendar-boundary message that is heading +
   lead + a 4-row table + calendar line + phone line. **The email a paying
   customer keeps carries no assessment terms, no have-ready list and no "You
   chose".** `booking-email.ts` states the opposite intent in the block BK-36
   edited — *"the confirmed message carries it because it is the one the
   customer keeps after paying"* — but that reasoning is about
   `customerConfirmation`, which nothing on the payment path sends. It is what
   the **Resend confirmation** button sends, so the office can mail a
   materially different, fuller message under a different heading than the one
   the customer originally received. Moderate severity, not a blocker: the
   terms went out in the request email and `/book/confirmed/` shows the
   have-ready list. See `tickets/BK-45.md`.

   **BK-45 IS NOW FIXED IN CODE AND NOT DEPLOYED (2026-08-20), alongside BK-44.**
   `markPaid` sends `customerConfirmation` — the same builder the Resend button
   uses, so the two are one message by construction — carrying the have-ready
   list, the assessment terms and **what the row says was charged**, itemised
   from the BK-32 snapshot rather than recomputed. The merge was not free: the
   plan review found that `customerConfirmation`'s confirmed arm would have told
   a customer who had just paid that *"we email you a secure payment link"* and
   that we *"may release the time"* if they did not pay, because the fee-terms
   block is written in pre-payment tense and renders on both arms. Three
   sentences are now request-only. **The two builders were NOT collapsed** —
   `update.ts`'s late-payment inward crossing still sends the thinner message,
   because its snapshot carries no tier and no amounts.

   **Both are route-relationship or screen-legibility failures, and the suite
   tests neither.** Every verify script exercises one route in isolation; none
   asks whether two routes overlap, or how a screen reads to the person using
   it. That is a gap in the method, not a gap in coverage, and it is why the
   first real booking found two things 23 green scripts did not.

   **A deliberate read of the same screen on 2026-08-20 found five more, and
   that is the finding that matters.** Asked to review
   `/admin/appointments/[id]` end to end against screenshots of #35 rather than
   to fix BK-44 alone, one pass produced: the header total omitting the travel
   fee at every status; the header recomputing prices the settled panel
   snapshots; `paid_at` and `payment_method` written by `markPaid` and rendered
   by nothing; a "Payment due by …" line that survives payment; and the request
   acknowledgement labelled "Customer confirmation". None is a route defect and
   the suite could not have caught any of them by testing routes harder — four
   are two surfaces disagreeing, and one is a column with a writer and no
   reader. **Recorded as BK-46 (Reviewed) and BK-47 (Light); see Known traps.**
   The method correction this argues for is a pin that asserts a RELATIONSHIP
   between two surfaces rather than a sixth per-route script. **BK-46 answered
   it differently and the answer is worth recording:** it did not assert "header
   total equals settled total", because it made the two ONE derivation, and an
   equality between two readings of one function cannot fail. What it asserts
   instead is the function's own answers, plus a source pin that the page holds
   no second derivation — which is the same claim, stated where it can still
   break.

   **ROLLOUT — STEPS 1, 2 AND 3 ARE DONE. DEPLOY 2 IS LIVE (2026-08-19).**

   All ten migrations are applied to production and the code is merged to `main`
   and deployed (`befce39`). Verified live after 009: the slot index is rebuilt
   to the three-status deny-list, the column default is `'pending_review'`,
   `'booked'` is gone from the CHECK, and the funnel serves — availability 200
   with 60 bookable slots across 15 days, `/book/`, `/book/received/`,
   `/book/confirmed/` and `/book/payment-cancelled/` all 200, and the Stripe
   webhook answers `400 {"error":"No signature"}` to an unsigned POST, which is
   the response that proves the route exists AND both secrets are readable in
   production.

   **THE CODE CAN NO LONGER BE ROLLED BACK.** 009 rebuilt the index to a
   predicate the pre-P9 arbiter cannot resolve against, so a Vercel instant
   rollback would raise 42P10 on every booking. Forward-fix only.

   **What is still TEST MODE:** `STRIPE_SECRET_KEY` is `sk_test_`, and the
   webhook `booking-payments-test` is registered in test mode at
   **`https://www.yegrestoration.ca/api/stripe/webhook/`**. Real card payment is
   NOT live. The live-key swap needs its own webhook registration and its own
   `whsec_`, and both env vars are scoped **Production only** — deliberately, so
   the value swap cannot put live credentials on a preview.

   **STILL OUTSTANDING as of 2026-08-20 — the rollout is complete, these are not:**

   1. **A real live booking has never been made.** The live keys are wired but
      unproven. The check is a real card on the cheapest weekday tier ($399 +
      GST = $418.95, no weekend multiplier), watching for **`cs_live_`** rather
      than `cs_test_` in the Stripe URL, then refunding in the dashboard and
      cancelling the row. Until that runs, "live" is a configuration claim, not
      an observed fact.
   2. **NOT DONE — RE-OPENED 2026-08-20 by the first live receipt. The number is
      on the account and NOT on the receipt.** See the Known trap: the Dashboard
      field governs invoices, and a Checkout Session issues a receipt. Marked
      done earlier the same day on the configuration step alone; the receipt
      disproved it. Original note follows.

      **The account-level record (still true, and still not sufficient):**
      `CA GST/HST 775654577RT0001`, added as a Tax ID under Settings → Billing →
      Invoices, confirmed by the user from the Dashboard. Real receipts had been
      issuing since the live-key swap earlier the same day, so the exposure
      window was hours rather than days.

      **THIS PARAGRAPH WAS WRONG AND BK-48 FIXED WHAT IT MISSED.** It said no
      code changed and none was needed, on the belief that Stripe renders tax
      info on Checkout receipts from Dashboard settings. It does not, for this
      shape. BK-48 (2026-08-20) reads a `GST_REGISTRATION_NUMBER` **constant**
      in `booking-payment.ts` and `booking-email.ts`. The original text follows.

      No code changed and none was needed — see the Known trap: nothing in
      `src/` or `scripts/` reads `GST_REGISTRATION_NUMBER`, and Stripe renders
      tax info on Checkout receipts from Dashboard settings alone. Our own
      emails itemize the GST *amount* and print no registration number, which
      is very likely sufficient because Stripe's receipt is the tax receipt.
      If the client ever wants the number on our approval email too, that is a
      small ticket and it still does not exist.

      **Not verified from outside, and cannot be:** the only proof is a real
      receipt from a real charge, which is outstanding item 1 below.
   3. **The office has not been briefed on the new workflow.** A real customer
      booking now produces a REQUEST that does nothing until someone approves
      it, and BK-23 Task 4 expires it at `slot − 4h` with an apology email if
      nobody does. That is a live operational risk from the moment the flip
      landed, and it is a people problem rather than a code one.
   4. **DEPLOYED 2026-08-20 — BK-44, BK-45 and BK-46 are on production
      (`8854dd7`), merged fast-forward from `deploy-2-prepay` into `main`.**
      The dropdown hole is closed, the paying customer's confirmation carries
      the terms and what they paid, and the appointment screen states one total
      instead of two. **The operational rule below no longer describes a
      workaround — it describes what the code now enforces**, which is the
      point of the ticket rather than a note about it.

      **This deploy CAN be rolled back**, unlike the 2026-08-19 one: no
      migration, no new env var, no new route, and `main`'s previous commit
      (`95cb48f`) is already post-009 code. A Vercel instant rollback returns to
      it safely. That is worth recording because the "forward-fix only" warning
      above is about the P9 cutover and does not apply to everything after it.

      **What was true until it shipped**, kept for the record: BK-44 was fixed
      in code but not deployed, so the rule for the admin panel was use
      "Review the amount →" and "Mark as paid — Interac" only, never the STATUS
      dropdown. That hole
      cost nothing in test mode and costs a free crew dispatch now. The fix is
      committed on `deploy-2-prepay`; deploying it is a rollout step and has
      not been taken.

      **BK-45 is in the same state** — fixed in code on `deploy-2-prepay`,
      not deployed. Until it ships, every customer who pays receives the thin
      calendar-boundary confirmation with no terms, no have-ready list and no
      record of what they were charged, and clicking **Resend confirmation**
      sends them a materially different, fuller message under a different
      heading. That is a customer-facing inconsistency rather than a money
      defect, and it is live on production now.

      The same pass produced **BK-46** and **BK-47** from a deliberate read of
      the appointment screen — see Known traps. Neither is deployed either.

      **BK-44, BK-45 and BK-46 shipped together on 2026-08-20. BK-47 is still a
      draft and is the only P9 ticket not on production.** It is layout and copy
      on the same admin screen BK-46 just changed, so it is safe to leave.

      **Two defects were deliberately shipped rather than fixed**, both recorded
      in Known traps with owners and neither visible to a customer: nothing
      clears `paid_at` on re-approval (the display is guarded, the column still
      lies to a query), and `confirmation_sent_at` cannot answer "has this
      customer heard from us" because five senders stamp nothing.
   5. **`DATABASE_URL` is shared between Preview and Production**, which is why
      no preview deploy can be used to test this flow.

   **ROLLOUT PROGRESS — step 1 DONE, 2026-08-19.** `007`, `008` and `010` are
   applied to production; `009` is correctly still pending. Verified immediately
   after: the slot index is untouched (`status <> 'cancelled'`, so the live
   code's arbiter still resolves), the column default is still `'booked'`, and
   the new CHECK permits `'booked'` **and** the seven new statuses — the three
   properties the deploy window depends on. 008's rename moved 8 past rows from
   `booked` to `confirmed`. The live funnel was smoke-tested read-only
   afterwards: `/api/booking/availability/` 200 with real slots, `/book/` 200.

   Two test appointments (ids 31, 33 — the user's own, "123 Test" / "1 test",
   both Sun 2026-08-23) were deleted first, on the user's instruction and by
   explicit id, taking the table 13 → 11. **No future-dated rows remain**, which
   is why 008's rename had no operational effect at all: the admin panel's
   `Upcoming` list is built from `status === 'booked'` on the live code, so a
   future-dated row would have dropped into `Past` with a blank status badge for
   the length of the window.

   **STEP 4'S URL CARRIES `www.`** — see BK-32. The apex 307-redirects, and
   Stripe treats any redirect as a delivery failure.

   **`--only` IS NOT OPTIONAL IN STEP 1, and this was found during the rollout
   itself on 2026-08-19.** `migrate.ts` applies every pending migration in
   order and had no way to apply a subset — so a bare `--target prod` at step 1
   would have applied **009 as well**, which is the contract half, under the
   old code. That is the 2026-08-18 outage, reproduced by following this table.
   The flag was added for exactly this and refuses unknown names rather than
   silently applying nothing.

   **BK-32's migration (now 010) has no such constraint** — it only adds columns
   and a table — so it goes with step 1. The general rule this replaces the old
   one with: **a migration that only ADDS may go before the deploy; a migration
   that RENAMES, NARROWS a CHECK, or REBUILDS an index that live code names must
   go after it.** BK-27's "production first" was correct for BK-27 because 005
   only added a column.

   `insertBooking` names `status` explicitly rather than leaning on the column
   default, which is what makes step 2 sit between the halves at all — during
   the window the default is still the pre-P9 one.

   The fix was BK-23's until 2026-08-18. It moved to its own ticket because the
   build order needed it committed *before* BK-31 while BK-23 lands *after* —
   one ticket spanning two commits either side of another ticket is exactly the
   shape the one-ticket-per-commit rule exists to prevent.
3. **Deploy 3 — safety net and office UX.** BK-25 (the two **alert** timers per
   the table above — the slot−4h expiry left for BK-23 Task 4 in Deploy 2 on
   2026-08-19), BK-24 (one-click approve/decline), BK-33, plus BK-23's Tasks 5
   (service-area badge) and 6 (photo gallery + unseen-files badge).
4. **Twilio-gated.** BK-34b; BK-06 with the reminder query filtered to
   `status = 'confirmed'`; escalation transport swaps email → owner SMS.
5. **Independent, pull in anytime.** BK-26, BK-28.

Dependency edges: `BK-32 → BK-31` (needs a tier to charge), `BK-32 → BK-23`
(needs `approved_awaiting_payment` to transition out of), `BK-36 → BK-32` (the
copy describes the link), `BK-33 → BK-32` (needs a payment intent),
`BK-34b → BK-34a`, `BK-24 → BK-23`, `BK-31 → BK-43`, `BK-23 → BK-43` (every
new email in the deploy needs the prefix fixed first).

**Locked lines P9 moves, and who moves them.** "Booking window: 4 hours minimum
notice" is BK-23's to rewrite when it lands, to **next-day earliest** (client,
2026-08-18 — see the amendments above; the 4h floor survives only on the admin
path).
The data-model bullets on `status` and on the partial unique index are BK-23's
too. `assessment_tier` is BK-31's to add; the payment columns are BK-32's.
Nothing else in Locked moves — the grid, Fridays, phone-in cancellation and the
PII rules all stand.

**Amendments to earlier phases:**

- **BK-24** — mechanism unchanged, but Approve now means "approve and send the
  payment link". Its POST-not-GET rule matters more, not less.
- **BK-25** — owns the two **alert** timers in the table above (+2h and
  slot−12h), not P7's slot−24h auto-decline, which is withdrawn, and **no longer
  the slot−4h expiry**: that became BK-23 Task 4 and moved into Deploy 2 on
  2026-08-19. What is left here is notification only, which is why it can wait
  for Twilio.
- **BK-06** — acceptance criterion added while blocked: the reminder query
  filters `status = 'confirmed'`, never `status <> 'cancelled'`. A
  `pending_review` or `approved_awaiting_payment` row must never be reminded of
  a visit that is not happening.
- **BK-28** — unchanged, but its slot list must read the new hold predicate.
- **BK-31** — the "non-binding by design; the form must say the choice can
  change on the day" clause is **deleted**. The tier is what gets charged.

### P10 — Office and widget UX (production testing of Deploy 1, 2026-08-16)

**Deploy 1 shipped and the client used it. This is what using it surfaced.**
Seven items, none of which changes the booking flow: they are the admin
panel's photo workflow, the day strip's vocabulary, and one homepage CTA.
Deliberately **not** P9 Deploy 2 — nothing here touches statuses, terms
wording, wizard steps, or anything BK-23/31/32/36 owns, and two items that
border that territory were folded into those tickets' specs instead of built.

Three of the seven items, as first stated, contradicted shipped code. All
three were flagged to the user before implementation and re-decided
(2026-08-16); the decisions are recorded in each ticket's Assumptions log.

| Ticket | Scope | Tier | Status |
| --- | --- | --- | --- |
| BK-37 | Upload link: copy button, `navigator.share` on mobile with a `wa.me` desktop fallback, and the link's absolute expiry stated on the page | Light | ✅ committed |
| BK-38 | Day strip: `Closed` for closed weekdays and `Call us` for an elapsed day, both distinct from `Full`; month header above the strip, month on a boundary chip | Light | ✅ committed |
| BK-39 | Homepage booking CTA relabelled, plus a live next-opening teaser above it | Light | ✅ committed |
| BK-40 | Appointment files: uploaded-at and provenance per row, plus soft delete with an audit line (**migration 006**) | Reviewed | ✅ **reviewed** 2026-08-16 — no blockers; 4 should-fix + 3 nits folded in. Gates green, 21 red rows. **Migration 006 is applied to PRODUCTION** — `npm run migrate:status` against `DATABASE_URL` (host `ep-young-sea…`, which is not the dev `ep-steep-scene…`) lists `006-file-provenance` as applied, checked 2026-08-17. The earlier "production pending" note was stale and is corrected here rather than left to worry the next implementer. |
| BK-41 | HEIC — findings and options **only**, nothing built pending the client's choice | — | ✅ report delivered 2026-08-16 — awaiting the client's choice; the recommended first step is a 2-minute test on a real iPhone |
| BK-42 | The homepage booking CTA was rendering at `opacity: 0` on production — a GSAP `from()` tween against `.cta-primary`'s `transition-all` | Light | ✅ committed 2026-08-17 — found by client testing after Deploy 1.5; gates green, 4 script red rows + 2 behavioural, verified against the real built bundle |

**BK-42 is an eighth item and does not come from the same place as the other
seven.** They came from the client using Deploy 1; BK-42 came from the client
using **Deploy 1.5 itself** and finding that the CTA BK-39 had just relabelled
was invisible. The defect predates BK-39 and would have hidden the old label
equally — what is new is that a batch shipped with every gate green over a
homepage whose primary conversion element was not on the screen. Both halves of
that are in Known traps.

**Migration numbering moved.** BK-40 takes **006**, so BK-31 → **007**,
BK-23 → **008**, BK-32 → **009**. Mechanical, but the numbers are load-bearing
for the next implementer and are quoted in three ticket files as well as here.
This is the second time P9's numbering has shifted (the spec's §6 item 12 was
the first); the lesson is that a migration number is worth nothing until it is
applied, and the ROADMAP row is the only place it is real.

**Third shift, 2026-08-18: BK-32 → 010.** BK-23's migration 008 was split into
an expand half (008) and a contract half (**009**) after the rollout outage, so
BK-32's payment migration moves to **010**. The lesson above holds and gained a
corollary: a number is worth nothing until applied, and **an applied number is
not worth reusing** — 007/008/009 were briefly applied to production and rolled
back by hand, and the reason it was safe to re-number afterwards is that the
`schema_migrations` rows were deleted in the same operation.

**Deployed as "Deploy 1.5"** — after Deploy 1, before the Deploy 2 flip, with
no coupling to either. BK-40's migration applies to production first, matching
BK-27's and Deploy 2's rollout shape.

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

### Open — P9 prepay (raised 2026-08-16, unanswered)

These are the client's to answer and **must not be resolved in planning or by a
fresh agent.** Each names what it blocks, so nothing waits on an answer it does
not actually need.

4. ~~**Refund values** — the customer-cancel cutoff and whether a no-show
   forfeits.~~ **ANSWERED 2026-08-18: full refund if cancelled 24+ hours before
   the appointment; no refund within 24 hours of it.** Exceptions stay manual in
   the Stripe dashboard — no refund code. BK-36's terms copy therefore ships
   **without** `[PLACEHOLDER]` markers for customer cancellation. No-show is not
   separately addressed by the client's answer; it falls under the within-24h
   rule (no refund), and BK-36 says so in those words rather than using the term
   "forfeit".
5. ~~**Office-created bookings: does the crew dispatch before payment?**~~
   **ANSWERED 2026-08-16: payment always first, no exceptions — emergencies and
   office-created phone bookings included.** Folded into the P9 decisions above.
   The hold on dispatch/payment ordering is withdrawn. Two consequences went
   straight into Known traps rather than being resolved in planning: the email
   requirement this forces on phone bookings, and the pay-now branch a 2am
   emergency needs.
6. **Insurance credit settlement** — confirm "credited against your final
   invoice" matches how an insurance job actually settles, i.e. that the credit
   comes off the customer's share. Blocks nothing mechanical; it decides
   whether BK-36's closing sentence is true.
7. ~~**GST registration number** for Stripe receipts.~~ **ANSWERED AND BUILT
   2026-08-20 — `775654577RT0001`, shipped by BK-48 as a constant.** The note
   this item carried was right and understated: the number alone was not
   sufficient, and neither was the Dashboard step — that field governs
   invoices, and a Checkout Session issues a receipt. It took a code change to
   put the registrant in the line item NAME, which is what a receipt renders.
8. **FSA service-area list sign-off.** A proposed Edmonton-metro default ships
   meanwhile; not a blocker.
9. ~~**Phone customers: pay by link, or exempt?**~~ **ANSWERED 2026-08-16: pay
   by link, same as web.**

10. **Stat holidays and the after-hours multiplier.** The 1.5x weekend rule is
    answered; whether a stat holiday is also 1.5x online is **deferred out of
    v1** by the client's own route (blackout the date, or take it by phone).
    Not a blocker, and not a question anyone is waiting on — recorded so the
    gap in the form is legible as a decision rather than an oversight.

**Still open after 2026-08-20: #6 (insurance credit settlement), #8 (FSA list),
#10 (stat holidays, deferred). #7 closed 2026-08-20 by BK-48.** **None of them block
Deploy 2.** #7 was to ship as a placeholder; it shipped as the real number
(BK-48, 2026-08-20);
#8 ships with the Edmonton-metro default; #6 decides only whether BK-36's
closing sentence is true, and the client has not disputed it.

**Answered 2026-08-18 (WhatsApp), all folded into P9's amendments:** #4 above,
plus next-day-earliest minimum notice, mould tier prices, the 1.5x weekend
multiplier, the $1.15/km travel fee, admin-adjustable amounts at approval,
Interac e-Transfer as a payment path, and all three tiers staying bookable
online with tier 3 disclosing 3-5 business days for lab results.
