# Free-booking changeover — plan of record

**Opened 2026-09-01.** The client's 2026-09-01 decisions, costed.

> ⚠️ **"Nothing here is built" WAS TRUE ON 2026-09-01 AND IS FALSE NOW.**
> **BK-50** (the unreviewed-request safety net) and **BK-51** (T1's money half —
> the phantom-price fix) are **built, reviewed and committed, NOT pushed.** This
> document does not mention BK-51 anywhere else, and its decision-15 table below
> cites line numbers BK-51 moved. **Read `docs/booking/tickets/BK-51.md` and
> `ROADMAP.md`'s P12 table before treating anything here as unbuilt.** Read `ROADMAP.md`'s READ FIRST and `CONVERSION-2026-08-31.md`'s START
HERE first — this document assumes both.

---

## START HERE

**The client asked for four changes.** Drop payment at booking (review-then-
confirm instead), make photos optional, cancel the weekend 1.5×, and let the
office book at any time including over an existing customer's slot.

**Three of the four are fine. One should be refused as specified.** And the
first one is much larger than it looks.

### The fact that reframes the whole thing

**Live Stripe keys landed 2026-08-20 07:07 (`95cb48f`). The booking collapse
began 2026-08-16.** Real card payment did not exist for the first four days of
the collapse. **The payment gate cannot have caused it.**

Dropping prepay may still be right — but it is not a fix for the collapse, and
must not be sold to the client as one, or September will disappoint with no
explanation available.

### The second fact — ~~as first written~~ CORRECTED 2026-09-01

~~`booking-payment.ts:629` is the only place that writes `status = 'confirmed'`,
so the office physically cannot confirm a booking by hand. This is not "remove a
guard" — it is "build a confirm decision that does not exist yet".~~

**That was wrong, and it was the most expensive error in the first draft of this
document.** Half of it is true: `booking-payment.ts:629` *is* the only writer of
`status = 'confirmed'`. The conclusion drawn from it is false.

**`approveFree` already is the confirm seam** (`review.ts:694-781`). It walks
`pending_review → approved_awaiting_payment → confirmed` in a single POST by
calling `markPaid(…, { method: 'none', amountCents: 0 })`, and `review.ts:301`
routes to it whenever **`totalCents === 0`**. Under "the assessment is free",
that is *every* approval. The office can hand-confirm today, and has been able to
since BK-45.

**Consequence: T1 is much smaller than this plan first said.** It is not "build a
confirm decision" — it is *delete the two gates that stop `approveFree` firing on
a tier-less row, and change one fallback*. `markPaid('none')` still stamps
`paid_at`, so `editorMaySetStatus`'s invite-crossing rule is untouched, **BK-44's
192-transition matrix survives, and the 33 flipped coordinates this document
predicted do not happen.** The `confirmed_at` migration is also unnecessary —
`approved_at` and `paid_at` both stamp on the same request.

**The error's shape, recorded because it will recur:** "one function writes X"
was read as "there is no route to X". A single writer with several callers is
not a single route. Check the callers before concluding a path does not exist.

### Two pieces of good news

- **`pending_review` already IS the hold state the client asked for.** No new
  status is needed.
- **No status migration is needed.** See "Why there is no enum migration" below.
  This avoids repeating the 2026-08-18 index outage.

---

## THE CLIENT'S DECISIONS — FINAL, 2026-09-01

Answered over two rounds on 2026-09-01. **This is the specification.** Anything
elsewhere in this document that contradicts it is older and loses.

| # | Decision | Notes |
| --- | --- | --- |
| 1 | **The on-site assessment is FREE**, unconditionally, for everyone | Answered as option (a) of a three-way question. Not "free to book, invoiced later" |
| 2 | **ALL prices come off the website.** No tiers shown. **The customer is quoted after the visit** | Bigger than "drop Tier 1" — this is every price surface |
| 3 | **Review-then-confirm**: book → `pending_review` → office reviews, may call → confirm or decline → notify → visit | `pending_review` already is this state |
| 4 | **NO automatic cancellation, of any kind** | Deletes cron sweep 2. **New on 2026-09-01 and it removes a safety net** — see the stale-request problem below |
| 5 | **No review SLA** — "as soon as they can" | Client declined to name a time |
| 6 | **Photos optional** — recommended, not required | Currently mandatory since BK-22 |
| 7 | **No weekend surcharge** | Removes the 1.5× multiplier and six copy surfaces |
| 8 | **Flat $150 travel fee** outside **Edmonton / Spruce Grove / St. Albert / Beaumont / Leduc.** Told to the customer **verbally at confirmation**. Owed **only if they have the visit and then do not proceed.** **Handled entirely OUTSIDE the system** | No in-system charge, invoice or receipt *for now*. This keeps T2 possible — see the arithmetic section below |
| 9 | **Jobber-style quoting/invoicing deferred**, revisit after this batch | Was ~$39/mo, one ticket. Not now |
| 10 | Office wants to **book at any time from the admin panel**, including over an existing customer's slot, and to record work already done | The double-booking half is **countered**, not accepted — see `office_override` |

### DECISIONS ADDED 2026-09-02 — these correct the table above

**11 · STRIPE STAYS. It is NOT retired, NOT deleted, NOT dormant-by-removal.**
The user's words: *"i didnt ask to delete Stripe entirely… we will work on
implementing a workflow similar to jobber that covers improvements to quotes,
invoices, payments etc — stripe will be used there."* What was actually asked
for is only two things: **(a) do not show payment tiers to customers when they
book**, and **(b) booking must not require a payment.**

> **This answers "Blocking questions for the client" #3**, which asked *"Does
> the Stripe path stay alive, or is it retired?"* — and which was **NEVER
> ANSWERED before T2 was written against it.** T2, the plan's largest ticket,
> was specified on an open question. It is struck; see the ticket table.
> `verify-stripe-webhook.ts` and BK-33 are **reusable, not dead.**

**12 · THERE IS NO FIXED PRICING, for now.** The user, 2026-09-02: *"currently
pricing will be decided by the client, so, no fixed pricing at least for now"*
and *"lets leave it to the client to determine the pricing, split etc."*

> **This is larger than "hide the tiers."** `TIER_DEFAULT_CENTS`
> ($399/$699/$1,199) and `TIER_SERVICE_OVERRIDE_CENTS` now describe **no real
> price**. They must not be displayed, and — critically — **must not remain the
> value the office approves on by default.** `review.ts:227` and
> `[id].astro:1776` would charge a customer a figure that no longer exists as a
> concept. That raises the footgun from "wrong amount" to "invented amount".

**13 · ALL customer-facing prices come off — confirmed explicitly**, including
the surfaces outside the booking flow: the **homepage** terms box
(`ContactSection.astro:344-358`, the same box as `/book/`), the homepage eyebrow
*"Credited in full when you go ahead"* (`:287`), and **`/llms.txt:54`**'s
credited-in-full sentence — a price claim in words, with no dollar sign, which a
constant-driven sweep misses.

**14 · The insurance / private billing split is the client's to determine.**
Not assumed either way. Nothing in the quoting/invoicing direction may be built
on a guess about it. *(Production shows 2 of 15 appointments insurance-route,
but the panel is known to under-record — it is not evidence.)*

### ~~STILL OPEN~~ — ANSWERED 2026-09-02 · DECISION 15

**Do the three assessment TYPES survive as a customer choice, with no prices?**
**ANSWERED: YES, but OPTIONAL — and it is not a precondition of confirming.**

The user's words: *"Customer can choose the assessment type which will be
optional and will be available for the client to view as part of the information
provided, but will not be a mandatory thing to confirm a booking. again, client
may reach out to the customer over call/email and then decide whether to confirm
or cancel a booking."*

This is **none of the three readings the plan offered** — it is a fourth: keep
the picker, make it optional, show the answer to the office, and drop the tier
requirement from approval. Recorded because inventing options and then being
given a better one is the normal case, not a failure.

**What it means, concretely:**

> **⚠️ AND THEY RESOLVE AGAINST `bk51-gated`, NOT `main`** — BK-51's code is not
> on `main`, so on `main` these land on unrelated code while looking freshly
> verified. Check out `bk51-gated` before using them.
>
> **⚠ EVERY LINE NUMBER IN THIS TABLE WAS RE-DERIVED 2026-09-02 AFTER BK-51.
> Five of the original six were stale or dead.** BK-51 edited both `review.ts`
> and `[id].astro`, which is where every drifted citation in this whole document
> lives. Cite the symbol, then grep.

| # | Change | Site (re-derived 2026-09-02) | State |
| --- | --- | --- | --- |
| 1 | Tier picker **stays**, prices removed | `BookingForm.svelte:1137-1187` (picker), and prices sit in **four** places not one: `:1173` per-radio, `:1198-1215` the quote block, `:1115` the `FEE_TERMS_ITEMS` terms box, `:1150-1151` `AFTER_HOURS_NOTE` (*"1.5× the weekday price"* — a price claim with no dollar sign) | **not started** — belongs with the prices-off ticket |
| 2 | Tier becomes **optional** on the public door | `booking-payload.ts:285-287` *(still exact)*, `booking-form.ts:272-274` *(was `:273-274`)* | **not started** |
| 3 | Approval **no longer requires a tier** | `review.ts:220` *(was `:215`)* and `:263-264` *(was `:246`; **`:246` is now the travel refusal** — do not edit it by line number)* | **not started** |
| 4 | The panel must render **Approve** for a tier-less row | `[id].astro:1818` *(was `:1764`)*; the Decline-only arm is `:1928-1948` | **not started** |
| 5 | Amount defaults to **$0.00**, fallback to `0` | `[id].astro:1830`, `booking-review.ts:206-209` (`approvalAmountCents`) | ✅ **DONE by BK-51** — verify, do not redo |
| 6 | Travel-fee input deleted | `[id].astro:1841-1878` is now prose only; the route refuses a non-zero fee at `review.ts:245` | ✅ **DONE by BK-51.** ⚠ The original citation `:1804` was the **hint paragraph**; deleting it alone would have left the live input. See ROADMAP Known traps |

**⚠️ FOUND WHILE CONFIRMING THIS, AND IT DEFEATS THE STATED REQUIREMENT.**
The office's only view of the chosen type is
`[id].astro:806-859` (**re-derived 2026-09-02; was cited as `770-772`, which
drifted ~39 lines**), and it is **gated on `money && money.kind !== 'none'`** —
it renders the tier name *inside* the price block. Under a free assessment
`money.kind` is `'none'`, so **the type the customer chose stops being displayed
anywhere.** The decision says it must be *"available for the client to view as
part of the information provided."* Un-gate it from the money, or the change
delivers the opposite of what was asked. It is also **absent from the Upcoming
list entirely** (`index.astro`), which is the screen the office triages from.

**The tier copy carries no prices** — `ASSESSMENT_TIER_NAMES` and
`ASSESSMENT_TIER_DESCRIPTIONS` (`booking-copy.ts:565-587`) describe deliverables
only. So the picker survives price removal intact; only `FEE_TERMS_*` and the
computed figures go. One exception worth keeping: the `sketch` description's
*"lab results take 3–5 business days"* is a **client requirement from
2026-08-18**, not decoration.

**The three follow-ups, ANSWERED 2026-09-02 — this decision is now closed:**

1. **Customer chose nothing → show the office NOTHING.** Not "Not specified",
   not a blank row — **omit the Assessment field entirely.** So the render
   condition inverts cleanly: today it is gated on *money*, and it becomes
   gated on *the tier being present*. That is a smaller change than it looks
   and it is the whole fix for the price-gating defect above.
2. **Detail page is enough for now.** The type does **not** go on the Upcoming
   list. *(Contrast BK-50's Status column, which did belong there — status is
   what the office triages by; the assessment type is context they want once
   they have opened the row.)*
3. **Keep `Decline — at capacity` as the only decline reason for now.**
   Explicitly revisitable later. **Consequence to state plainly rather than
   leave implied:** an office member who cancels after a phone call — customer
   changed their mind, wrong service, outside the area — sends a message
   saying we are at capacity, which is untrue in every one of those cases. The
   client has accepted that for now. It is the same gap the retired
   `expiredRequestMessage` repoint would close, and it becomes more visible the
   day cron sweep 2 is deleted, because the office will then be declining
   requests they simply missed. **Do not treat this as settled forever — it is
   settled for now, by a client who said so.**

### DECISION 16, 2026-09-02 — THE CLIENT IS EXPERIMENTING, NOT SETTLING

**This reframes every ticket in this document and it was not written down until
2026-09-03.** The user's words:

> *"client is trying to understand what is working and what is not working... they
> started with free assessment, then they thought its a good idea to try paid
> booking, now they want to go back to free assessment, they feel like they are ok
> to handle one or two bad customer bookings which end up free, moreover they will
> be communicating well with customers on any bookings made and decide if its a
> good fit, again, this is not final, they may change again, but they wanted to
> experiment."*

**Four things follow, and they bind:**

1. **This is the THIRD pricing model in three weeks** — free → paid tiers → free.
   A fourth is explicitly possible. **Every ticket here should be costed on the
   assumption that it will be reversed**, not on the assumption it is permanent.
2. **"One or two bad bookings which end up free" is an ACCEPTED cost.** Do not
   design guards, gates or copy whose purpose is preventing a customer getting a
   free assessment they did not deserve. The client has priced that risk and
   taken it. *(This is why the free assessment is not a fraud surface and should
   not be reviewed as one.)*
3. **The office phone call is the qualifying step, by design.** The client will
   talk to every customer and judge fit. So the software's job is to **surface
   the request and get out of the way** — not to qualify, score or filter. It
   also means the office desk is now load-bearing — and briefing them is now an AGREED
   user commitment, recorded under `ROADMAP.md`'s "Operational items only the
   user can do".
4. **The owner does NOT want jobs-per-month analysis.** They asked to experiment
   and observe, not to model. `MEASURING-THE-FREE-CHANGEOVER.md` is the whole of
   the agreed measurement and it is deliberately one page.

**⚠️ The trap this decision creates:** an experiment that is expected to reverse
makes *deletion* expensive and *structure* valuable. See BK-53's "delete to a
boundary" section — the reversible thing is the structure, not the sentences,
because the sentences get rewritten on every flip anyway.

**⚠️ And the trap it does NOT remove:** free → paid → free is a **round trip**,
not a random walk. It may be a concluded experiment rather than an oscillation.
So do not build two-mode machinery on the assumption the $399/$699/$1,199 ladder
specifically returns — §5's evidence pointed at **$99–149**, not at that ladder.

### The standing context, and it changes how to build

**This is a NEW organisation, learning by doing. They expect to change their
minds as they learn.** Two 2026-09-01 answers already reversed earlier ones.

**Therefore: build for cheap change, not for permanence.** Prefer one constant
with many readers over a decision spread across files; prefer a config value over
a hard-coded rule; and **do not build the elaborate version of anything whose
shape is still being learned** — the waiver tracking, the quote object, the SMS
channel, the reminder system. The client will tell you what they need after a
month of real use. This is a deliberate instruction, not laziness.

**What that means concretely for decision 8:** the $150 stays out of the codebase
entirely. No column, no email block, no charge path. The only honest changes are
the office-facing hint that still says *"$1.15/km beyond 30 km"* and the Stripe
line item that says *"Round trip beyond the free radius"* — and the latter dies
with T2 anyway.

## Google Business Profile — checked 2026-09-01, read-only

First GBP evidence in this investigation. **Nothing was edited.**

| | |
| --- | --- |
| Status | **Verified. Not suspended.** Profile live, "You manage this Business Profile" |
| Reviews | **5.0 from 3 real Google reviews** |
| Calls (Apr–Sep 2026) | **53** |
| Monthly shape | Apr ~1 · May ~0 · Jun ~11 · **Jul ~23 (peak)** · Aug ~16 · Sep ~0 (1 day in) |
| Hours on profile | **Open 24 hours** |
| Areas served | Edmonton · Phone (780) 479-3285 (matches `SUPPORT_PHONE`) |

**What this settles.** A GBP suspension was a live hypothesis costing nothing to
check. **It is ruled out.** The profile is healthy and is a real channel — 53
calls in six months is material for this business.

**What it does not settle.** The granularity is **monthly**, so it cannot resolve
a 2026-08-16 break. GBP calls fell ~30% from July to August — a decline, not a
collapse, and July was the peak. **Do not read this as agreeing or disagreeing
with the Ads call data; the periods and the counting rules differ.**

**Two things it surfaced that belong to other work:**

- **The profile says "Open 24 hours".** The booking system offers **30 slots a
  week, 11:30–15:30, Fridays closed**. Both describe the same business. That
  contradiction is now published on Google.
- **Three real reviews now exist.** `TestimonialsSection.astro:2-4` and
  `seo.ts:132` both defer re-introducing reviews and `aggregateRating` *until
  real Google reviews exist*. **That precondition is now met** — it is a real,
  cheap trust win, and it is nobody's ticket yet.

---

## The four decisions, judged

| # | Decision | Verdict |
| --- | --- | --- |
| 1 | **Drop payment at booking** | **Directionally defensible, wrongly specified.** §5 of CONVERSION found a *free* diagnostic books **worse** than one priced $1–$49.99, and its lead recommendation was a **free triage lane + paid report**, or a **$99–149 deposit** — not blanket free. The client took half the recommendation and dropped the half carrying the evidence. ~~Re-open the number.~~ **STRUCK 2026-09-02 — decision 1 is FINAL and has been re-confirmed four times. Do not re-open it. This verdict was written before the client answered.** |
| 2 | **Photos optional** | **Unsupported, low value, sequenced wrong.** Mandatory photos were live during the best three booking days the form ever had (Aug 14–16 carried 6 of 9). The gate already leaks — it counts uploads that *failed*. Ship the tracking (W5) and the scroll fix (W18) first, or this deletes the only instrument that could show whether the file field ever blocked anyone. |
| 3 | **Cancel the weekend 1.5×** | **Approve.** Cheapest and safest of the four. 10 of 30 weekly slots carry it. Not a config flip: the multiplier plus **six surfaces that state it in words** — grep the *claim*, not `AFTER_HOURS_NOTE`. |
| 4 | **Office double-booking + back-dating** | **Refuse the double-booking half as specified.** See below. Back-dating already works and wants a different feature. |
| 5 | **Prices unchanged** | Contradicted by §5. Combined with #1, the price objection does not disappear — **it relocates to a phone call** the office must now win, on a desk that is already the constraint. |

### Why decision 4 is refused as specified

There is **exactly one** `INSERT INTO appointments` in the system
(`booking-commit.ts:88`), shared by the public form and the admin form, ending
`ON CONFLICT (slot_start) ... DO NOTHING`. That single clause is the only thing
preventing two customers holding one slot. The file's own comment: a
check-then-insert here reintroduces the race *"on the one table where losing it
means two crews at one address."*

Removing it is not a permission grant — it deletes the system's one scheduling
invariant, **from the code path that also serves the public**.

**The safe design instead — `office_override`:**

- Add `office_override BOOLEAN NOT NULL DEFAULT false`, set only by the admin
  form, never by the public route.
- Index predicate becomes `... AND NOT office_override`. **Not** `source =
  'admin'` — that would silently disable the guard for every ordinary phone
  booking too.
- **Fork the predicate, deliberately:** `SLOT_INDEX_PREDICATE` (index + arbiter)
  gains the exclusion; `SLOT_HOLD_PREDICATE` (availability + precheck) does
  **not** — an override booking still consumes crew capacity, so availability
  must keep showing the slot as taken. Comment why they must not be re-merged.
- The new predicate is **narrower**, so: deploy code first, rebuild index second,
  and the rebuild cannot fail on a duplicate.
- **ICS is safe by construction** — UID is `booking-<id>@…`, so two rows give two
  UIDs and a CANCEL for one cannot touch the other. But the **office calendar
  will show two overlapping events**, which `ROADMAP.md` already records as
  presenting like the orphan-invite bug. The override row's *office* invite needs
  a marker in its SUMMARY. The customer's copy must carry no such marker.

**Back-dating is a separate feature and is already 90% built** — `create.ts`
skips every window check by design, and `ADMIN_MIN_NOTICE_HOURS` is **read by
nothing**. What kills it is cron sweep 2 auto-declining any `pending_review`
inside 4h of its slot. Recording work already done is **W24 (mark-completed)**,
not an appointment row.

---

## Why there is no enum migration

The obvious path — drop the two dead statuses, narrow the CHECK, rebuild the
index — would recreate the **2026-08-18 outage**, and in a direction the
ROADMAP's own migration rule gets **backwards**.

Dropping `payment_expired` *widens* the index predicate. Postgres requires the
`ON CONFLICT` arbiter to imply the index predicate, so deploying wide code
against the old narrow index throws **42P10 on every booking, public and admin**.
The ROADMAP's rule ("migrations that narrow go after the deploy") is
direction-blind and wrong here. Worse, a *widening* rebuild can fail on a
duplicate row, and a failure between DROP and CREATE leaves the table with **no
double-booking guard at all**.

**So: retire the two statuses in code, not in the schema.** Stop producing them;
leave them in the type, the CHECK, and the index predicate as legacy-terminal
values. Zero migration, zero 42P10 window. Precedent: migration 008 kept
`'booked'` in the CHECK for exactly this reason.

Total migrations in this plan: **three, all cheap** — `confirmed_at` (additive,
before deploy), `office_override` (additive, before deploy), and the T8 index
rebuild (after deploy).

---

## The test suite: 2,113 assertion sites

> ⚠️ **THE NUMBERS BELOW ARE T2's COST AND T2 IS STRUCK (decision 11).**
> With Stripe retained, **~0 of these die.** `verify-stripe-webhook.ts` stays
> green at 91/91 — it needs no database, key or network, so nothing in the
> free-booking change can reach it. The real remaining cost is **T3's copy
> sweep** plus the tier-required arms (`verify-booking-payload.ts:302-321`,
> `verify-booking-form.ts:179-198`), and it must be re-counted against T3 alone.
> Treat every figure in this section as historical.

| | sites |
| --- | ---: |
| **Die outright** | **435** |
| Need rewriting | 159 |
| Fixture-only changes | 175 |
| Unaffected | 1,344 |

`verify-stripe-webhook.ts` goes 91 dead of 91. `verify-booking-admin-db.ts` loses
208. **33 of BK-44's 192 matrix coordinates flip verdict** — every one a refusal
becoming an allowance. Per CLAUDE.md's rule-rewrite trap, **all 33 must be
enumerated with reasons in T1's ticket.**

### The trap that would let a green suite lie

`verify-booking-email.ts:365` and `verify-cutover.ts:725` ban this pattern:

> *"paid … at the visit / at the end of the visit / on site / on the day"*

~~These were written to stop exactly the reversion the client now wants. They
must be inverted in the ticket.~~

**CORRECTED 2026-09-01: DO NOT INVERT THEM. KEEP THEM AS THEY ARE.** That
instruction was written while blocking question 1 was **unanswered**, and it is
correct only for the answer the client did *not* give. They chose **"the
assessment itself is free"**, so **nothing is paid at the visit** and the ban is
**still true**. Inverting it would remove a live, correct guard.

This is CLAUDE.md's rule-rewrite trap firing on this document: a case enumerated
under the old predicate flipped verdict when the predicate changed, and the row
would have survived unexamined because it still *looked* right.

**One real edge:** travel-fee copy saying *"payable at the visit"* fires this pin
within its 40-character bound — a legitimate red for the wrong reason. Handle it
with a **named allowlist entry**, never by loosening the regex. And note the pin
is shaped for the *assessment fee*; it covers no other money-at-the-visit claim.

**`BOOKED_CLAIM_SHAPES` also stays unchanged** — a submission still produces a
request in a hold state. The temptation to delete it is *stronger* now, because
"book your free assessment" and "you're booked" feel like one happy path. They
are not.

**Do not touch `BOOKED_CLAIM_SHAPES`** (`verify-cutover.ts:714-721`,
`verify-booking-email.ts:955-970`). It bans the *instant-confirmation* grammar
("you're booked", "confirmed on the spot"), which stays correct — a submission
still produces a request in a hold state. Deleting it is the natural, wrong edit.

---

## Tickets — REVISED 2026-09-01 after the client's answers

**The client answered:** the assessment is **free** (option a); **all prices come
off the website** and the customer is quoted after the visit; **flat $150 travel
fee** outside Edmonton / Spruce Grove / St. Albert / Beaumont / Leduc, disclosed
at confirmation and **waived if the job goes ahead**; and **no review SLA** —
"as soon as they can".

### THE ORDERING BUG IN THE FIRST VERSION OF THIS TABLE

The first order was `T4 → T5 → T1 → T2 → T3 → T10 → T6 → …`, which put **T6
three tickets after T2**. T2 retires Stripe; T6 moves the Ads conversion off the
Stripe session. The booking conversion fires **only** on `/book/confirmed/`
reached with a valid `cs_(test|live)_…` session id, so between T2 and T6 the
account would have had **no primary conversion at all** — `Request quote` has
been dark since Aug 11 — while a budget-capped PMax kept spending the full cap.
**T6 now ships WITH T2 or before it.**

**And T6 is not "small".** The honest new trigger is the office *confirm*, which
is server-side, and `booking-confirmation.ts:213-217` forbids a server-side
conversion path. Moving the event to `/book/received/` means **Ads bids on
requests rather than confirmed bookings** — a measurement-model change, in the
month the conversion collapse is still unexplained. Two assertions actively
forbid the fix and must be inverted in the ticket:
`verify-booking-confirmation.ts:285-287` and `:427-429`.

### Verdicts that CHANGED from the first version (rule-rewrite trap)

| Ticket | Was | Now | Why |
| --- | --- | --- | --- |
| **T1** | med, heaviest review, `confirmed_at` migration, 33 flipped matrix coordinates | **small–med, no migration, near-zero flipped coordinates** | `approveFree` already is the confirm seam — see the corrected second fact |
| **T3** | large | **the largest ticket in the plan** | all pricing dies, not just timing sentences; six pins invert, not two |
| **T5** | independent, small–med | **a strict subset of T3** — ship separately only to honour one-change-per-week | removing all pricing removes the multiplier by construction |
| **T6** | small, late | **medium, and a blocker shipping with T2** | see above |
| **T10** | blocker | **unnecessary if the $150 is disclosure-only; mandatory and the only GST surface if it is collected** | blocked on one client answer |
| **T11** | med, likely migration | **small, doc-only** | nothing is prepaid, so the forward half is deleted by T3 |
| Migrations | three | **one** (`office_override`) plus T8's index rebuild | `confirmed_at` not needed |

**REVISED ORDER, after the 2026-09-01 audit** — the previous line referenced a
`T13` that was never defined, and put T4 first against this document's own
verdict that instrumentation must precede any funnel change:

1. **W9 → W5/W6** — instrumentation. The island emits **zero** funnel events
   today. Nothing below is evidence-based without it. Let it settle a week.
2. **In parallel, non-funnel, no interference:** ~~cancel `#38`'s Sep 6 slot
   (W15)~~ — **DONE 2026-09-02; it was the user's own test booking, not a
   customer**; **resend `#36`'s `charge.refunded` BEFORE T2** — see the deadline
   below; the "since 2008" / `foundingDate` / postal-code / trust-claims
   cleanup; and **strike W20/W21 from the schedule** (see below).
3. **T1** — the confirm seam, plus the `review.ts:225-227` footgun.
4. **T2 + T6, same deploy.**
5. **T3, with T5 folded in.** Its own week, alone.
6. **T4** — after instrumentation, its own week.
7. **STOP. Measure a month.** Then reconsider T7/T8/T9 against what the office
   actually did. `#37` shows their real pain is **reschedule and
   mark-completed**, not double-booking.

**T10 is STRUCK** (decision 8 leaves no GST-bearing supply in the repo).
**T11 reduces** to T3 deleting the refund promise plus a one-off `#36` repair.
**T13 never existed** — the travel fee needs no ticket under decision 8.

### ⏰ ~~A DEADLINE: `#36` must be repaired BEFORE T2~~ — CAUSE VOID 2026-09-02

> **The stated cause is gone: T2 is struck and the webhook is NOT being
> retired** (decision 11), so "before T2" bounds nothing. **But do not close
> this as "no deadline" —** that would be the rule-rewrite trap, a case
> disappearing because its predicate changed. Stripe's own event-resend
> retention window is an external behaviour and must be read from Stripe's
> docs, never recalled. The refund was 2026-08-20. **Re-derive the real window
> and record the actual date.** The repair itself is still owed either way:
> `#36` states on production that money is ours which went back.

Booking `#36` states on production that money is ours which went back on
2026-08-20. The cheap repair — resending its `charge.refunded` to the live
endpoint — **works only while the webhook is live.** T2 retires it. Miss this
window and the row is repaired by hand, forever.

### W20/W21 are now BACKWARDS and are still scheduled

They exist to strike *"no obligation"* and *"free, no-obligation quote"* because
those were false under the credit model. Under decision 1 they are the **true and
best claims** for the in-zone majority. **Shipping them as written deletes the
new offer from the paid channel in the month it launches.** Strike them from the
schedule and re-derive inside T3.

**But do not simply invert them either:** "no obligation" is still false for an
out-of-zone customer, because the $150 is waived if they proceed — so **the only
person who ever pays it is the one who declined.** That is a decline fee wearing
a travel fee's name, and disclosure after commitment does not repair a general
impression formed before it.

| # | Ticket | Size | Migration | Depends |
| --- | --- | --- | --- | --- |
| T4 | Photos optional | small | — | — |
| T5 | Remove weekend 1.5× | small–med | — | before T3 |
| T1 | **The confirm seam** — new confirm route; drop `paid_at` check, **keep BK-33's refunded check**; add `confirmed_at`; re-derive all 33 flipped verdicts | med code, heaviest review | column | — |
| ~~T2~~ | ~~Retire Checkout, webhook, mark-paid; delete cron sweep 1~~ **STRUCK 2026-09-02 — decision 11. The client never asked for it, and it was written against unanswered blocking question #3.** `approved_awaiting_payment` **cannot** stop being produced: `markPaid` guards on it (`booking-payment.ts:668`) and it is the one confirmation path. `payment_expired` and cron sweep 1 go dormant with zero edits once totals are $0. Whatever remains folds into T1. | ~~largest~~ **~none** | none | — |
| T3 | Copy + email cutover — ~39 constants, 17 prose sites, 6 templates; invert the two pins | large | — | T2, T5 |
| T10 | GST receipt on the offline path (= W25, promoted to blocker) | med | likely | T2 |
| T6 | Move the Ads conversion off the Stripe session | small | — | T2 |
| T7 | Office override — column, forked predicate, arbiter gate | med | additive, **before** | T2 |
| T8 | Rebuild the index | tiny code, **highest risk** | index, **after** | T7 |
| T9 | Past-dated / same-day office entry | med | — | T1, T8 |
| T11 | Refund reconciliation; close the open HIGH trap | med | likely | T10 |

**T7 and T8 must be separate deploys.** That separation *is* the mitigation for
the 2026-08-18 failure. Once the index moves it is forward-fix only.

**T4 and T5 are independent and small — ship them while T1–T3 are still being
planned.**

### Do not start T3 until the client answers question 1

Its entire content is decided by the answer, and the two answers are different
products. Under "the assessment itself is free", the whole fee-terms block dies
and **BK-29's site-wide removal of ~51 "free assessment" claims partially
reverses** — a sweep that took its own ticket and still shipped with 18 claims
live. Building T3 against the wrong answer means writing the largest copy ticket
twice.

---

## THE STALE-REQUEST PROBLEM — decision 4's consequence

*(The decision table promised this section and the first version of this document
did not contain it. That hole was found by review on 2026-09-01.)*

### The good news first: removing the sweep costs ZERO slot availability

Sweep 2 only fires at `slot_start < now + 4h` — always **today**. `MIN_NOTICE_DAYS
= 1` means a slot inside today is never publicly bookable anyway. The suite says
so itself (`verify-booking-admin-db.ts:2389-2398`): *"an availability assertion
here would pass identically before and after the release."* **Do not argue "we
lose slots" — it is false.**

### What it actually cost, and what has to replace it

The sweep did two things nothing else does: it got an unanswerable row **out of
the office's way**, and it **told the customer the truth**. Both need replacing.

**1. `pending_review` holds its slot, and now nothing but a human releases it.**
It is absent from `SLOT_RELEASING_STATUSES`, so `SLOT_HOLDING_STATUSES` includes
it by construction. ~60 bookable slots are visible at once and each is now
holdable indefinitely.

**2. The office cannot see the state that now matters.** The Upcoming table
renders **Slot · Name · Phone · Service · City · Route · Files** — verified, and
there is **no Status column**. Under review-then-confirm, a `pending_review` row
is visually identical to a `confirmed` one on the only screen the office works
from. `statusClasses` exists and is called *only* from the Past table.

**3. Once the slot passes, the row leaves Upcoming for Past** — so a missed
request does not nag, it **disappears**, into a muted history table, correctly
labelled "Never reviewed" where nobody is looking.

**4. `approve` then refuses it.** `review.ts` rejects any slot at or before now
(`review: 'elapsed'`), and its comment says the auto-decline *"is what normally
makes this unreachable, and the two compose deliberately."* **Delete the sweep
and `elapsed` becomes the common case** — the office can neither approve nor
leave the row, only decline it by hand. That is an automatic cancellation
performed manually, which is what the client said they did not want. **Rewrite
that comment in the same commit**; leaving it is the stale-comment-becomes-
justification shape the ROADMAP already records three times.

### The minimum that makes "no auto-cancellation" safe rather than merely absent

1. **A Status column on the Upcoming table** — ~10 lines; `statusClasses` and
   `STATUS_LABELS` are already imported. **This is a blocker for shipping
   decision 4, not a nicety.**
2. **An "Unreviewed (N)" count**, mirroring the existing `warningCount`.
3. **Keep elapsed `pending_review` rows in Upcoming** (one line in
   `partitionAppointments`), ideally grouped as "Overdue — never reviewed".
   ⚑ *Client decision: do they want past-dated requests nagging them?*
4. **Request age on pending rows** — `formatAdminTimestamp` already exists.
5. **Add `RECEIVED_TIMING_LINE` to `BookingForm.svelte`'s fallback card.** That
   line — *"If you have not heard from us and the appointment is close, call or
   text us"* — is now the customer's **entire** safety net, and that one surface
   omits it.

**Do NOT delete `expiredRequestMessage` — repoint it.** Give the office a second
decline button, *"we did not get to this"*. Otherwise an office declining a
request they simply missed sends `DECLINED_LEAD` — *"we are at capacity"* — which
is exactly the tidy untruth the expired message was written to avoid. It converts
a deletion into a route change and keeps ~10 live assertions. ⚑ Confirm with the
client.

### ~~THE ONE QUESTION THE CLIENT STILL HAS TO ANSWER~~ — ANSWERED 2026-09-01

~~**When a request is never reviewed and its slot passes, what happens?**
(i) the slot is quietly released and the request marked lapsed, **with no email**
— probably what "no automatic cancellation" actually meant; or (ii) nothing at
all, and the office cleans up by hand.~~

**ANSWERED 2026-09-01: option (ii), in its strongest form. The slot is simply
LOST.** No automatic cancellation, no email, no lapse marker — **the business
absorbs it.** Decision 4 means what it says.

**The three safety conditions the client attached, and they are conditions
rather than nice-to-haves:**

1. a **Status column** on the Upcoming table,
2. an **unreviewed count**,
3. **`RECEIVED_TIMING_LINE`** on `BookingForm.svelte`'s fallback card.

**These are `BK-50`, and BK-50 must land BEFORE cron sweep 2 is deleted.** It is
that deletion's safety net; shipping the deletion first leaves a real customer
holding a slot nobody will look at, with no email and no in-product signal to
the office.

**Two items from the minimum list above are deliberately NOT in BK-50** —
item 3 (keep elapsed `pending_review` rows in Upcoming) and item 4 (request age).
Item 3 is still ⚑ **a client decision**, and the plan flagged it as one before
this answer arrived. **It carries a cost worth stating: with the narrow count,
the unreviewed number drops to zero at the exact moment the slot passes — it
stops nagging when the failure completes.** That is the argument for asking.

**Still unrewritten, deliberately:** `approve`'s comment block at
`review.ts:250` (the sentence is at `:252`) — *"Task 4's auto-decline at
slot-4h is what normally makes this unreachable"* —
becomes false the day the sweep dies and is **true today**. It belongs to the
commit that deletes the sweep, not to BK-50. Recorded in ROADMAP Known traps.

## The $150 travel fee arithmetically breaks the free path

**This is the finding that decides whether T2 can happen at all.**
`review.ts:301` routes to the free path on **`totalCents === 0`**, and
`totalCents = base + travel + GST`. A $150 travel fee makes it
`0 + 15000 + 750 = 15750 ≠ 0`, so the booking **falls through to the paid
path** — Checkout Session, payment link, 12-hour deadline, expiry cron, the lot.

**Charging the $150 through the booking system resurrects every single thing T2
exists to retire.** So:

- **Disclosure-only. CONFIRMED by the client 2026-09-01: handled entirely
  outside the system.** The fee is spoken at confirmation and lands on the
  office's final invoice, outside this repo. **No migration. T10 is struck, not
  deferred** — decision 8 leaves no GST-bearing supply in the repo.

  ⚠️ **~~Reuse `travel_fee_cents` as the disclosed figure with
  `total_amount_cents = 0`.~~ CORRECTED — that does not work.** `amountsFrom`
  (`review.ts:225-231`) computes `totalCents = base + travel + gst` **from the
  form fields**, and `review.ts:301` routes on that total. Typing 150 into
  `travel_fee` sends the booking to the **paid** path — Checkout Session,
  deadline, expiry cron, all of it. `approveFree` does write `travel_fee_cents`,
  but it is only *reachable* when travel is zero. **Keep the fee out of the
  codebase entirely, exactly as the decision table says.**

  **Three changes are still mandatory, none optional:**
  1. **Delete the travel-fee input.** `[id].astro:1804` still tells the office
     *"$1.15/km round trip beyond 30 km"* — and **any non-zero value typed there
     opens a Checkout Session on a free assessment.** Replace with a static line
     naming the five municipalities and the flat $150, marked *"spoken at
     confirmation — do not type an amount here."*
  2. **`review.ts:225-227`'s fallback must become `0`** — see the footgun below.
  3. **`booking-payment.ts:288`'s Stripe line** (*"Round trip beyond the free
     radius"*) describes the retired rule. Dies with T2; wrong in the interim if
     T2 slips.

  ⚑ **Client decision: should the five municipalities live in code at all?** Right
  now the boundary exists only in a conversation. One array in
  `booking-config.ts` beside `CLOSED_WEEKDAYS`, rendered into that hint, is the
  whole implementation — and this is a new organisation whose service area will
  change.
- **Collected in-system.** T2 cannot retire Checkout; the Interac mark-paid path
  must survive as the collection route; and the $150 becomes **the only
  GST-bearing supply in the system**, making T10 mandatory.

**Nothing tracks "waived because the job went ahead", and nothing should** —
there is no job, invoice or contract entity in this schema, and the decision
arrives weeks later from outside every code path here.

**Also: `150` / `15000` appears in zero assertions anywhere in the suite.** The
new fee has no test coverage of any kind, and neither did the old one — nothing
reads `TRAVEL_FEE_CENTS_PER_KM` or `TRAVEL_FEE_FREE_RADIUS_KM` outside their own
definition and one admin hint. **This change reddens nothing; its gate must be
written from scratch and seen red.**

## A live footgun the changeover must close

`review.ts:225-227`: an **empty** `assessment_amount` field falls back to
`suggested.baseCents` — the tier price. Under a free assessment, an office
member who tabs past that field and hits Approve **charges the customer $399 and
opens a Checkout Session**. The fallback must become `0`, in the same commit
that makes the assessment free.

## Blocking questions for the client

> ⚠️ **QUESTIONS 1, 3 AND 5 IN THIS LIST ARE ANSWERED. They are struck below and
> kept as history. Do not put them to the client again — 1 and 5 are the same
> question and it has now been asked four times.**

1. ~~**What does "free" mean** — free to *book* with $399 invoiced at the visit, or
   is the assessment itself free?~~ **ANSWERED: the assessment ITSELF is free,
   unconditionally (decision 1).**
2. **"Book at any time"** — off-grid start times, or any date at the five
   existing grid times? *(The first is a `btree_gist` schema project; the second
   is nearly free.)*
3. ~~**Does the Stripe path stay alive** for collecting after the visit, or is it
   retired?~~ **ANSWERED 2026-09-02: IT STAYS (decision 11).** `verify-stripe-webhook.ts`
   and BK-33 are **reusable, not dead**. ⚠️ **This question went UNANSWERED while
   T2 — the plan's largest ticket — was written against it, and T2 is now struck
   as a result. That is the most expensive mistake in this document: a ticket
   built on an open question nobody noticed was open.**
4. **What replaces the refund promise?** `FEE_TERMS_REFUND` promises every
   customer a full refund; nothing is prepaid to refund. *(See the open HIGH
   trap in ROADMAP Known traps.)*
5. ~~**Will they accept a deposit instead of $0**, and at what number?~~ **ANSWERED
   AND CLOSED — the client chose free, unconditionally, and has re-confirmed it.
   Do not ask again.** §5's evidence (free books worse than $1–$49.99) is real
   and is recorded; it is not a licence to re-litigate a settled decision.
6. **Who reviews free bookings, in what committed time, including Sat/Sun?**
   (Both are open days.) And **what does a declined customer get?** — under free
   bookings there is no money to return as an apology.
7. **Is the firm's establishment date 2026?** Confirm the legal entity, and
   separately substantiate **"BBB Accredited"**, **"IICRC Certified Firm"** and
   **"Licensed & Insured"** — nothing in this repo evidences any of the three.
8. **Which is true — "Open 24 hours" or 30 slots a week, 11:30–15:30, Fridays
   closed?** Both are currently published.

**~~Worth re-asking, previously declined~~ — AGREED BY THE USER 2026-09-03.**
The carrier's **call detail record** for
August. It is free, needs no deploy, and is the only thing that separates "demand
fell" from "we were on a job site and did not answer." GBP's 53 calls do not
substitute — they are monthly and cover only the Google channel.

---

## Do these regardless of any client answer

1. ~~GBP read-only check~~ — **DONE 2026-09-01. Verified, not suspended.**
2. **Ads Policy Manager, read-only.** A disapproved asset leaves no
   change-history row, so "no changes after Aug 9" does not cover it.
3. ~~**W15**~~ — **DONE 2026-09-02.** `#38` was the user's own end-to-end test,
   cancelled through the admin panel as required. Probably no money to return (`payment_reference`
   empty) — prove it with an Interac inbox search for **$658.88 dated Aug 31**.
4. **"Since 2008"** — 15 source sites + 18 built files + `/llms.txt`. Site only;
   **do not edit GBP.** Delete `foundingDate` rather than correct it.
5. **The placeholder postal code** `T5J 0N3` in `seo.ts` — a shipped LAUNCH
   BLOCKER, live in structured data, telling Google the wrong address.
6. **W1** — the stale client artifact, and the unauthorised second copy.

---

## Out-of-scope defects found while planning

Recorded per CLAUDE.md; **not fixed here.**

1. **`booking-email.ts:938` — office-only copy ships to a customer.** The
   payment-expired email's **plaintext** body opens with `PAYMENT_ATTENTION_RULE`
   — *"issue any refund by hand in the Stripe dashboard"* — and is sent
   `to: input.email`. The HTML arm does not carry it; the misaligned indent on
   the next line is the paste. Three negative pins run over that body and none
   match "Stripe dashboard". Probably never fired (the cron has never run on a
   real row) and it dies with T2, **but it is live today.** Owner: T2.
2. **`booking-commit.ts:62-64` states the arbiter/index implication backwards**
   relative to migrations 008/009 and the live probe. Doc-only, and it is the
   first comment a future index change will read. Owner: T7/T8.
3. **`ROADMAP.md`'s migration rule is direction-blind** — see above. Owner: T7/T8.
4. **`verify-booking-admin-db.ts:2005`** claims "every door refuses a past slot";
   untrue of `parseAdminEntry`. Owner: T9.
5. **`BookingConfirmation.svelte:24`** imports `EMAILED_LINE` and never renders
   it — one character from CLAUDE.md's copy-inventory trap.
6. **Three real Google reviews now exist**, satisfying the precondition
   `TestimonialsSection.astro:2-4` and `seo.ts:132` set for re-introducing
   reviews and `aggregateRating`. Owner: nobody — needs a ticket.

---

## One process commitment worth extracting before anything ships

August was made unreadable by **four changes in five days at ~19 clicks/day**.
This plan plus the W-items is **six or more changes in thirty days** on the same
traffic. Decide the order now, write it down, and ship **no more than one
funnel-affecting change per week** — or September will be unreadable too, and
this time by choice rather than by accident.

At ~19 clicks/day, September needs somewhere between **6 and 17 bookings** to be
"significant" — the threshold is choosable because the post-collapse baseline is
a single event. September can be simultaneously "much better than August" and
"90% below the pre-collapse rate", both true. **Say this to the client before the
month starts, not after.**
