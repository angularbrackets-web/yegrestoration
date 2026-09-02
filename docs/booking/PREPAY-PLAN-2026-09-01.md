# Free-booking changeover — plan of record

**Opened 2026-09-01.** The client's 2026-09-01 decisions, costed. Nothing here is
built. Read `ROADMAP.md`'s READ FIRST and `CONVERSION-2026-08-31.md`'s START
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
| 1 | **Drop payment at booking** | **Directionally defensible, wrongly specified.** §5 of CONVERSION found a *free* diagnostic books **worse** than one priced $1–$49.99, and its lead recommendation was a **free triage lane + paid report**, or a **$99–149 deposit** — not blanket free. The client took half the recommendation and dropped the half carrying the evidence. Re-open the number. |
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

**Order: T4 → T1 → T2 + T6 (same deploy) → T3 → T7 → T8 → T9 → T13 → T11**
(T5 foldable into T3; T10 only if T13 = collected.)

| # | Ticket | Size | Migration | Depends |
| --- | --- | --- | --- | --- |
| T4 | Photos optional | small | — | — |
| T5 | Remove weekend 1.5× | small–med | — | before T3 |
| T1 | **The confirm seam** — new confirm route; drop `paid_at` check, **keep BK-33's refunded check**; add `confirmed_at`; re-derive all 33 flipped verdicts | med code, heaviest review | column | — |
| T2 | Stop producing `approved_awaiting_payment` / `payment_expired`; retire Checkout, webhook, mark-paid; delete cron sweep 1 | **largest** | **none** | T1 |
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

## The $150 travel fee arithmetically breaks the free path

**This is the finding that decides whether T2 can happen at all.**
`review.ts:301` routes to the free path on **`totalCents === 0`**, and
`totalCents = base + travel + GST`. A $150 travel fee makes it
`0 + 15000 + 750 = 15750 ≠ 0`, so the booking **falls through to the paid
path** — Checkout Session, payment link, 12-hour deadline, expiry cron, the lot.

**Charging the $150 through the booking system resurrects every single thing T2
exists to retire.** So:

- **Disclosure-only (recommended, and it matches what the client described).**
  The fee is spoken at confirmation and lands on the office's final invoice,
  outside this repo. Reuse `travel_fee_cents` as the *disclosed* figure with
  `total_amount_cents = 0` so the free path still fires — and comment that
  semantic change loudly, it is the same hazard class as forking the slot
  predicate. **No migration. T10 unnecessary.**
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

1. **What does "free" mean** — free to *book* with $399 invoiced at the visit, or
   is the assessment itself free? *(Blocks T3, scopes T10, swings ~200
   assertions.)*
2. **"Book at any time"** — off-grid start times, or any date at the five
   existing grid times? *(The first is a `btree_gist` schema project; the second
   is nearly free.)*
3. **Does the Stripe path stay alive** for collecting after the visit, or is it
   retired? *(Decides whether `verify-stripe-webhook.ts` and BK-33 are dead or
   reusable.)*
4. **What replaces the refund promise?** `FEE_TERMS_REFUND` promises every
   customer a full refund; nothing is prepaid to refund. *(See the open HIGH
   trap in ROADMAP Known traps.)*
5. **Will they accept a deposit instead of $0**, and at what number? §5 says free
   books worse than $1–$49.99; §8 proposes $99–149.
6. **Who reviews free bookings, in what committed time, including Sat/Sun?**
   (Both are open days.) And **what does a declined customer get?** — under free
   bookings there is no money to return as an apology.
7. **Is the firm's establishment date 2026?** Confirm the legal entity, and
   separately substantiate **"BBB Accredited"**, **"IICRC Certified Firm"** and
   **"Licensed & Insured"** — nothing in this repo evidences any of the three.
8. **Which is true — "Open 24 hours" or 30 slots a week, 11:30–15:30, Fridays
   closed?** Both are currently published.

**Worth re-asking, previously declined:** the carrier's **call detail record** for
August. It is free, needs no deploy, and is the only thing that separates "demand
fell" from "we were on a job site and did not answer." GBP's 53 calls do not
substitute — they are monthly and cover only the Google channel.

---

## Do these regardless of any client answer

1. ~~GBP read-only check~~ — **DONE 2026-09-01. Verified, not suspended.**
2. **Ads Policy Manager, read-only.** A disapproved asset leaves no
   change-history row, so "no changes after Aug 9" does not cover it.
3. **W15** — cancel `#38`'s Sun 2026-09-06 3:30 p.m. slot **through the admin
   panel, never a row delete.** Probably no money to return (`payment_reference`
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
