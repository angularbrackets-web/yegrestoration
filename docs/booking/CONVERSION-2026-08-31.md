# START HERE — read this before anything else (last updated 2026-08-31)

**What this file is.** Not a ticket. The evidence, the corrections and the
decisions that must be made before any ticket is written. It was produced in one
day, and **six conclusions were asserted and then withdrawn inside that day** —
each corrected by a reviewer or the user, never by the author. Assume the same
failure mode is available to you.

## The state, in one paragraph

Web bookings collapsed on 2026-08-16 (9 in Aug 10–16 → 1 in Aug 17–31,
P ≈ 8×10⁻⁸). **Why is not established and is NOT RECOVERABLE** — four site changes
landed in five days at ~19 clicks/day, and the candidate causes are collinear or
in the same commit. Paid traffic did **not** fall; on the same paid clicks
**both** bookings and phone calls fell at the same significance, so the phone is
not a control and the site is neither exonerated nor convicted. §3D then changed
the frame entirely: the Interac ledger shows **twenty customer payments (13 in
August) against ZERO recorded in `appointments`** — the company kept trading and
the software recorded almost none of it. **No policy and no code have been
changed.**

**Act on cause-independent work and forward measurement. Do not try to recover
the cause. Do not reopen the ranking war.**

## Settled — do not re-argue, do not re-run

1. **The collapse is real** — bookings and message leads both, p < 0.01.
2. **"Calls held flat" is WITHDRAWN** — denominator error. Calls fell 64%/click.
3. **The call tag did NOT break** — verified live in production, and it recorded
   30 conversions last firing Aug 31. A broken tag records zero.
4. **Desk behaviour explains ~0%.** Booking rows, message leads and phone calls
   are all created by the public with no office involvement.
5. **"36 of 39 leads unworked" is WITHDRAWN as an inference.** `#37` proves the
   panel under-records reality.
6. **`#37` is CLOSED** — lead Aug 20, booked Aug 23, recorded `declined`, **job
   completed**, paid Aug 25 and Aug 30.
7. **"More work arrived after Aug 16" is WITHDRAWN** — 7 of ~11 payers pay in
   instalments; payments cannot date demand.
8. **"Rain stopped ~Aug 15" is MEASURED FALSE** (§3E, three ECCC gauges). The
   regime broke ~**Jul 28**; the three best booking days ever were **0.0 mm**
   days. **Do not re-run the rainfall test.**
9. **Bookings-per-lead (p ≈ 0.32) is null.**
10. **The client's three proposals are already built** — photos mandatory, hold
    state, and no customer was ever stopped by the payment gate.
11. **The statistics in §5's "Evidence hygiene" list are FABRICATED.** Never
    repeat them.

## Measured vs asserted

**Measured:** the Ads figures (§3A, reconciled to the cent); the rainfall series
(§3E, ECCC); §3C's pixel heights (re-verified across four builds in Chromium
**and WebKit**); the DB row counts — which are a **FLOOR**, never ground truth.

**Asserted / pending an artifact:** that `Assessment booked` ever fired for a
known booking (9 DB bookings vs 7 Ads conversions is unexplained); that Ads is
click-dated (inferred from a contradiction); that BK-48's GST number reaches a
real receipt — **`#38` was Interac, so no Stripe receipt exists**; whether the
**customer** confirmation email delivers at all.

## Discipline rules — R1–R4 (§3). They bind you.

- **R1** — one row per causal atom; a new sub-mechanism gets a bullet, never a rank.
- **R2** — **date-fit is NEVER evidence.** Every candidate was *found* by searching
  around Aug 16, so "right date" is the search key.
- **R3** — nothing is "leading" while it is pending an artifact.
- **R4** — rank lives in ONE table. **⚠ That table numbers atoms 1, 2, 4, 5 —
  there is no atom 3.** Prose elsewhere still uses the OLD seven-item numbering
  where "explanation 3" = Ads drift, "explanation 4" = post-storm demand,
  "explanation 6" = ad↔page mismatch. **"Explanation 4" ≠ "atom 4".** Trust the
  table.

## Safe to do now

**§7's W-list, in order. W0 IS DONE** — BK-49, committed `22418dc` 2026-08-31.
Do not re-do it. Its consequence for everything below: **`verify-booking-admin-db.ts`
is now measured by `(exit code, summary line)` and never by a count of `✗`
markers** — 0 passed, 1 failed *or* aborted on wreckage *or* refused a dirty
pre-sweep, 2 crashed, 3 `--reset` ran nothing, 130 interrupted. **Exit 1 is
overloaded**, so a red-first must read the summary line to tell a genuine red
from an abort. Clear stranded rows with
`npm run verify:booking:admin:db -- --reset`.

**W16 and W17 are also DONE — 2026-09-01.** W16 corrected every stale
"not deployed" claim across `ROADMAP.md` and three ticket `Status:` lines
(BK-44/45/46 shipped 2026-08-20; BK-33 shipped 2026-08-22 and is **still open,
pending an artifact**). W17 verified the confounds against Google's Search
Status Dashboard and **struck one that does not exist** — there is no August
2026 core update; only the **August 2026 spam update (18 Aug, 2d 16h)**, now
recorded in the clean window's standing caveats.

**W15 is DONE — 2026-09-02.** `#38` was the user's own end-to-end test, cancelled
through the admin panel. It was never a real customer; the "real Sep 6 slot"
framing in earlier drafts of this file was wrong. Next: the
read-only health checks — **W2 (GBP) IS DONE: `PREPAY-PLAN-2026-09-01.md`'s
"Google Business Profile" section IS the W2 artifact, read-only, 2026-09-01,
verified/not-suspended. DO NOT RE-RUN IT** — W2's own body warns that editing a
service-area GBP can trigger suspension, so re-entering that surface for an
answer already in hand is a live risk. **Only W3 remains**, then instrumentation
(W5–W7), then compliance, then the surface defects.

## Blocked, and on what

- **W18 (mobile scroll fix)** — after W5/W6, so there is a baseline to measure it against.
- **W20/W21 (copy + ad)** — atomic, same day; and **nothing touching the call
  channel or conversion counts may share their window** (that bars W13 *and* W7).
- **W26 (reminders)** — after W23 (reschedule), or you tell real customers the
  wrong appointment time.
- **W5/W6 verification** — needs W9 (GA4 MCP returns `invalid_grant`).
- **Pricing, deposits, the free triage lane, photos, hours, the weekend 1.5×** —
  named client decisions, §8.

## Traps most likely to bite

- **This file's §7/§8/§10 were written before §3D and §3E existed** and were
  corrected on 2026-08-31, but **re-derive anything you are about to act on
  against §3A–§3E first.** The original failure was appending corrections as new
  sections and never propagating them — CLAUDE.md's copy-inventory trap firing on
  this document.
- **§3A's headline −81% row uses 7/106 and 1/81** — the 7 is the Ads count the
  same section calls non-authoritative, and the **1 is a developer rehearsal.**
  Marked with † there. Do not quote it alone.
- **Every §7 checkbox may be unticked regardless of status.** Read the item body.
- **NOTHING here is reproducible** for the database queries, the Gmail Interac
  ledger, the admin screenshots, or §3C's pixel measurements — no scripts, no
  paths, no raw data were preserved. The Ads daily rows **were** preserved (§3A).
  If you need the others, re-derive them and **say that you did.**
- **Also read `docs/booking/ROADMAP.md`** (CLAUDE.md requires it). ~~Its BK-44
  entry is stale — it says "not yet deployed"; it shipped in `6ff41e2`.~~
  **CORRECTED 2026-09-01 (W16), and it was wrong twice.** The stale
  "not deployed" claim spanned **two tickets across a dozen sites**, not one
  entry — BK-44/45/46 *and* BK-33 — plus three ticket-file `Status:` lines. And
  **`6ff41e2` is the rollout DOCUMENTATION commit** (it touches one file,
  `ROADMAP.md`); the code shipped in **`7114aa5` + `77ad0f6`** (BK-44),
  `e5c2d9d` (BK-45) and `e04ba21` (BK-46), deployed 2026-08-20 by fast-forward
  to `8854dd7`. BK-33 deployed 2026-08-22 (`4a9b548`) and is **still open,
  pending an artifact**. All sites are now corrected.

**Client-facing artifact — STALE**, carries the withdrawn "calls held flat"
reading. **Do not send until republished (W1):**
<https://claude.ai/code/artifact/c495c16e-dca9-4bea-941a-9d16d331a7db>

*(A second artifact, `d8e790b6-6380-471f-8cde-7fada17ef11d`, was published by a
subagent without authorisation and is also stale. Delete or rewrite before use.)*

---

# Conversion investigation — why bookings collapsed

**Opened 2026-08-31.** Triggered by a client meeting: *"the number of bookings has
reduced significantly."* The client asked for a review of the booking process and
the terms around it, and proposed: keep bookings in a hold state, make
photos/video mandatory, have the office phone the customer, and **drop payment as
a requirement for booking.**

This is not a ticket. It is the evidence, the corrections, and the decisions that
have to be made before any ticket is written. **Read this before touching the
booking funnel, the terms copy, the pricing, or the Google Ads account.**

Published report (client-facing) — **STALE as of 2026-08-31: last synced before
§3A, so it still carries the withdrawn "calls held flat" reading. Do not send it
to the client until it is republished.**
<https://claude.ai/code/artifact/c495c16e-dca9-4bea-941a-9d16d331a7db>

---

## THE ONE-LINE STATE

**Bookings really did collapse, on 2026-08-16. What is NOT established is why.**
The 2026-08-31 Google Ads pull (§3A) narrowed it without settling it: paid
traffic did **not** fall, and on the same paid clicks **both** channels fell
together — bookings −81%, phone calls −64%, at the same significance. That kills
a form-only mechanism such as price-at-step-3 as the whole story, and it means
**the phone did not act as a control and the site is neither exonerated nor
convicted.** An earlier draft of §3A claimed "calls held flat"; that was a
denominator error and is withdrawn. No policy has been changed. No code has been
changed. The next step is still measurement, not building.

**A second correction, same day.** An earlier draft called "36 of 39 leads never
actioned" the largest finding of the day. **Withdrawn as an inference (§3B):**
`#37` was recorded `declined` and the job was *completed*, so the panel
under-records reality and cannot support a claim about an unworked queue. What
survives is narrower and still important — **the system does not capture how this
business actually works**: it has no one-click way to reschedule, to mark an
Interac payment with a compliant receipt, or to mark a job completed. `#37` is
the proof, and that is a software gap in a young organisation, not a desk
failure.

**And the distinction that keeps the diagnosis honest:** a booking *row* is
created by a member of the public with no office involvement, and **no office
behaviour can suppress one.** The off-system work explains the *lifecycle* fields
— statuses, payments, reschedules — and therefore invalidates conclusions drawn
from them. It does **not** explain the fall in row creation, in message leads, or
in phone calls. Those three are the collapse.

**Two site sub-mechanisms shipped in `df53210` (Aug 16 10:23)** — both are
sub-bullets of **atom 4** in §3's rank table, not ranks of their own (R1):

- **Bookings — §3C.** BK-27 took step 3 from **502px to 1,082px**, past the point
  where the browser stopped rescuing the scroll position, turning the mobile form
  into a **silent dead end**. Independently re-verified; note the first draft's
  figures (price radios, ~1,800px, 1,889px) described **Aug 19**, not Aug 16.
- **Calls and message leads — BK-29.** The primary CTA on every page changed from
  **"Free Assessment"** to **"Book Assessment"**, and the contact form's own line
  from *"book a free on-site assessment"* to *"book an on-site assessment"* —
  while the live Google ad still promises *"a free, no-obligation quote"*.

**Neither is proven, and after referee review the honest headline is that no
single cause is likely to be found.** §3 now ranks **four causal atoms**, and the
highest-confidence entry is **"several causes at once" (~70%)**: a real demand
fall — the client reports Edmonton rain ending ~Aug 15, untested — landing on a
site that got worse the same week, measured by instruments that also degraded.

**The cause is structurally unrecoverable.** The rain reportedly stopped Aug 15
and `df53210` deployed Aug 16 10:23; price-shock and the mobile defect are the
same commit on the same step; BK-29's on-page change and the ad mismatch are the
same commit. **No observational data can separate any of those pairs at ~1.3
bookings/day.** The remaining free tests narrow the prior; none identifies.
**Act on expected value and forward measurement, not on diagnosis.**

**And the frame has changed (§3D).** The Interac ledger shows **20 payments,
13 of them in August**, and the `appointments` table records **one** — a developer
test. So this document's row counts describe **the web funnel, not the company**;
the company kept trading throughout. **`#37` is closed** — Peter Harvey paid on
Aug 25 and Aug 30 against a row that says `declined`. **The ledger cannot date
demand**, because 7 of ~11 payers pay in instalments and three span July into
August, so post-storm decay (explanation 4) **remains live and unsized**. **The
emergency it does establish is records and GST: twenty customer payments, one
recorded.**

---

## 1. THE CLIENT'S PROPOSAL IS AIMED AT THREE THINGS THAT ARE NOT THE PROBLEM

Verified in code, all three:

- **Photos/video are already mandatory** — BK-22, live since 2026-08-13
  (`BookingForm.svelte:1001`, enforced server-side at `create.ts:133-146`). The
  client proposed this as the fix. It was live during the best three days the
  form ever had.
- **The hold state already exists.** Every public booking lands in
  `pending_review` (`booking-commit.ts:84`) and already reserves the slot. The
  office can already phone before approving. "Hold → call → confirm" is
  substantially shipped.
- **No customer has ever been stopped by the payment gate.** Zero rows have ever
  reached `payment_expired`; nothing sits in `pending_review`. **But read §5 —
  this is an empty set, not a measurement, and it cuts both ways.**

A fourth correction, from the abuse review: **the photo requirement filters
almost none of the abuse the client described.** The free-estimate shopper and
the insurance-documentation harvester both have real damage and real photos. It
stops bots and wrong-service bookings, which is real but narrow.

And the gate leaks by design: `attachmentCount` counts attachments whose status
is `done` **or `failed`** (`BookingForm.svelte:227`), and the server counts
`appointment_files` rows that exist from token-mint time with no `upload_state`
filter (`booking-commit.ts:148`). Picking a file and tapping "Skip" produces an
accepted booking with zero bytes uploaded. Both choices are deliberate and
well-reasoned — a stalled 100 MB video must not trap the customer, and gating on
`upload_state` would reject real customers on webhook lag. **"Photos are
mandatory" means "attaching a file is mandatory; the file arriving is not."**

---

## 2. THE PRODUCTION DATA

Read-only queries against the production Neon database, 2026-08-31. **Five** rows
are developer test bookings and are excluded: **#22, #23, #35, #36** — and, from
2026-08-31, **#38** (Aug 31, Interac, the end-to-end test), five in all, though
#38 falls outside both windows and changes no cell below. (All name prefix
`Mo`, outlook/gmail). **#36 is the live Stripe rehearsal (`cs_live_…`); #35 is TEST mode
(`cs_test_…`, Aug 19 23:45) — see §3A.**

| Window | Days | Real bookings | Per day | Message leads |
| --- | --- | --- | --- | --- |
| 10–16 Aug | 7 | 9 | 1.29 | 15 |
| 17–31 Aug | 15 | 1 | 0.07 | 4 |

Real bookings by day: **Aug 10 (2), 12 (1), 14 (2), 15 (3), 16 (1)**, then
**Aug 23 (1)** — `#37`, which the system records as `declined` **and which was
in fact completed after a reschedule the system never captured** (§3B). No
further *rows* since. **Business volume in that window is higher than the rows
suggest — `#37`, the `declined` row, was completed and paid — but it CANNOT be
sized from the Interac ledger, because payments arrive in instalments weeks after
the work (§3D).**

Statistics (from the red-team, and they hold):
- Bookings: under the earlier rate you expect ~19.3 in the second window.
  P(X≤1) ≈ 8×10⁻⁸. **Real.**
- Leads: expect ~14.1, observed 4. p ≈ 0.003. **Real.**
- **Bookings-per-lead 0.60 → 0.25: p ≈ 0.32. NULL.** This was used in the first
  draft to place the loss at conversion rather than traffic. **It cannot carry
  that argument and has been withdrawn.**

**Leads keep arriving and they are genuine** — Aug 20, 25, 29, 30, all real
restoration enquiries, several explicitly asking for a quote or an assessment.
Demand has not vanished.

---

## 3. WHAT SHIPPED WHEN — THE TIMELINE IS THE ARGUMENT

The single most important correction to the first analysis: **2026-08-16 was not
one change.**

| Date | Change | Note |
| --- | --- | --- |
| Aug 10 | `/book/` live | Launch. Novelty-spike risk on the early numbers. |
| **Aug 11** | BK-10 cutover (`1f5f41f`) | Quote CTAs → `/book/`; contact form demoted; `message` becomes required. **The site stops firing the retired Ads form conversion** (`env.d.ts:8-10`); the replacement action had been created in the account on **Aug 9** with **zero history** (§3A — nothing changed in the account on Aug 11). |
| Aug 13 | BK-22 | Mandatory email + ≥1 photo/video. |
| **Aug 16** | **BK-27 + BK-29** (`df53210`) | **Two mechanisms.** BK-27 put $399/$699/$1,199 + GST and a mandatory terms checkbox into the form. BK-29 (`1de17d0`) removed ~51 "free assessment" claims — **including the navbar label, `/book/`'s `<title>`, the schema `name`, `Layout.astro`'s default meta description, and every service page's metaTitle/metaDescription.** |
| Aug 17 | BK-42, BK-39, BK-38 | **The homepage booking CTA had been rendering at `opacity: 0` and was fixed here.** Discoverability improved as bookings went to zero. |
| **Aug 19** | BK-23 / Deploy 2 | **Instant confirmation ends. `MIN_NOTICE_DAYS = 1` removes same-day booking** (`booking-config.ts:63`) — a product change for a company whose hero promises a crew in about an hour. |
| **Aug 19** | BK-31 + BK-36 (`befce39`) | **A SECOND layout regression, added 2026-08-31 (§3C).** The tier radios land (`e476798`, Aug 18) and the terms box grows **508px → 1,776px**, taking step 3 from 1,082px to **2,390px** and the off-screen blocking error from −505px to **−1,813px**. |
| Aug 20 | Live Stripe keys | Prepay. **Four days after the fall began.** |

**Why the two Aug 16 mechanisms matter:** the price appears only in the booking
form. It does not appear on `/contact/` at all. **Only the search-surface change
can explain the message form falling too.** BK-29's own ticket concedes the
trade: *"The lost keyword is a real cost and it is accepted."*

### Competing explanations — FOUR causal atoms, not seven

**Restructured 2026-08-31 after referee review.** The previous list of seven was
the vehicle by which every newly-arrived idea got its own promotion. Four of the
seven were not separable candidates but **sub-mechanisms of a single commit**:
price-shock and the mobile step-3 defect are the *same ticket* (BK-27) on the
*same step of the same form*; BK-29's on-page copy and the ad↔page mismatch are
the *same ticket* viewed from two sides. **No data can ever apportion between
them.** Collapsed to causal atoms, with two additions the old list omitted:

**⚠ NUMBERING WARNING.** This table numbers **atoms 1, 2, 4, 5 — there is no
atom 3** (it merged into 2). **Prose elsewhere in this file still uses the OLD
seven-item numbering**, in which "explanation 3" = Ads delivery drift,
"explanation 4" = post-storm demand and "explanation 6" = the ad↔page mismatch.
**"Explanation 4" and "atom 4" are DIFFERENT THINGS.** Trust this table, not the
prose. (R4: rank lives here and nowhere else.)

**Confidence = the share of the ~95% booking / 73% lead / 64% call fall this
would carry, on today's evidence.**

| # | Atom | Cannot explain | Confidence |
| --- | --- | --- | --- |
| **1** | **Several causes at once** — a real demand fall onto a site that got worse the same week | nothing (its strength and its weakness) | **~70% that no single atom carries >60%** |
| **2** | **The catastrophe tail ended** — atoms 2 and 3 MERGED 2026-08-31 (§3E), because they are one mechanism seen from two ends. **Edmonton's wettest summer on record — Blatchford July = 264.7 mm, ~5× normal; ~$230M insured damage since May** — with `/book/` launching **Aug 10, inside the claims tail**. Preferred-vendor networks regain capacity and reabsorb the queue, so overflow can end as a **step** | **the Aug 16 timing.** Measured: the rain regime broke **~Jul 28**, Aug 1–15 was an ordinary half-month, and **the three best booking days ever fell on 0.0 mm days**. Correlation null in the clean window at every lag | **~30–45%, as a slow LEVEL shift only. The one-day-lag timing fit is struck (measured false).** The baseline-is-catastrophe-overflow half stands and is the stronger half |
| **4** | **`df53210`, the Aug 16 deploy**, as one atom (price block + terms + the §3C mobile dead end + "free" stripped from every landing page) | **a fall to ZERO** — §3C is mobile-only, so ~5–7 desktop bookings should still have arrived and at most 1 did (P≈0.02) | **~25–35% combined. Lower than this document previously weighted it** |
| 5 | **Ads delivery-mix drift** — PMax, budget-capped at 99.6%, signal-starved since Aug 11 | the Aug 16 break itself (CTR *rose* to 5.77% in the clean window) | **<10% as a cause; high as ongoing waste from ~Aug 21** |
| — | ~~Off-system routing / desk behaviour~~ | **all three channels** | **~0%. SETTLED — a records and GST emergency, not an explanation.** A booking row, a message lead and a phone call are all created by the public with no office involvement |
| — | ~~The call tag broke rather than the calls~~ | — | **REFUTED 2026-08-31, see below** |

**Atom 2's baseline problem, in the document's own numbers.** Total conversions per click ran
**17.3% (Aug 1–9) → 20.8% (Aug 10–16) → 7.1% (Aug 17–31)**, and Aug 1–9 is itself
inflated by `Request quote`, which stopped firing Aug 11. Net that out and **the
baseline week converted at roughly 2.5× the week before it, on the same channel
mix.** Every p-value in this document is conditioned on "the Aug 10–16 rate is the
true rate". **If that is wrong the p-values do not shrink — they become
meaningless.** §6.6 rejected only the *clustering* form of this objection, which
is a different objection. **The day-level `Assessment booked` split settles it and
is one segment away in the same UI.**

**Atom 4's fatal residual.** At a 65–75% mobile share, a mobile-only defect cannot
produce zero bookings; desktop should have continued. **The device split of the 9
baseline bookings has never been pulled** and would materially move this row.

### The call-tag hypothesis — tested and refuted, 2026-08-31

The referee raised a serious challenge: `Website call` is **our own** number-swap
tag (`Analytics.astro:29-35`), BK-29 edited markup across the site on Aug 15, and
if that degraded the tag then "calls fell" is an artifact and the form-only
mechanisms return. **Tested on production the same day:**

- `AW_CALL_LABEL = "9JJKCOny1MwcELKqhZBE"` — **set** (this also closes the
  memory-index item that had it PENDING in Vercel prod)
- `gtag('config', 'AW-18287252786/9JJKCOny1MwcELKqhZBE', { phone_conversion_number: "(780) 479-3285" })`
  — **present in `dataLayer`, fired**
- the display number renders as **plain text** on the service page, which is the
  swap's stated precondition

**And the decisive argument needs no page load at all: `Website call` recorded 30
conversions in August and last fired Aug 31. A broken tag records zero, not
thirty.** It fell 42%; it did not go dark. **The pillar holds: both channels
really did fall.**

### Discipline rules, adopted 2026-08-31

Because four conclusions were asserted and withdrawn in a single day — "calls held
flat", "36 of 39 leads unworked", "more work arrived after Aug 16", and the
database as ground truth:

- **R1 — One row per causal atom.** If two explanations cannot be separated by any
  data that exists or could be collected, they are **one row** with sub-bullets. A
  new sub-mechanism gets a bullet, never a rank.
- **R2 — Date-fit is NEVER evidence.** Every candidate here was found by searching
  around Aug 16, so "right date" is the search key, not a finding. Struck from
  every entry, §3C's included.
- **R3 — Nothing is "leading" while it is pending an artifact.** CLAUDE.md's BK-48
  trap, extended from items to explanations. Weather is pending Environment
  Canada. Atom 4 is pending one mobile error event or a device split.
- **R4 — Rank lives in exactly ONE table, and superlatives may appear nowhere
  else.** Before any rank change,
  `grep -niE 'best|strongest|leading|highest-value|carries the collapse'` across
  this file and reconcile every hit. **This is the copy-inventory trap firing on
  the investigation document itself** — the previous draft had "best account",
  "best-fitting single mechanism" and "strongest candidate" on four surfaces,
  promoted independently.

### The identifiability problem — the finding nobody wanted

**These pairs can NEVER be separated by observational data.** Not with more
analysis, not with a longer window, not with better statistics:

1. **Weather vs. `df53210`** — collinear in *date*. **Note the specific
   "rain stopped Aug 15" claim is measured FALSE (§3E): the regime broke ~Jul 28.
   What remains is a slow level shift from a record July, which is collinear with
   everything and sized by nothing.**
2. **Price shock vs. the mobile defect** — same commit, same step, same instant.
3. **BK-29 on-page vs. the ad↔page mismatch** — same commit; the mismatch *is* the
   on-page change seen from the ad side.
4. **Aug 16's deploy vs. Aug 17's opacity fix vs. Aug 19's two changes vs. Aug 20's
   live keys** — four changes in five days at 19 clicks/day, where 15 days barely
   reaches p≈0.03.

**Therefore: the cause of the 2026-08-16 collapse is not recoverable. Stop trying
to recover it.** This is a confounded natural experiment with n≈9 in the baseline
arm. The team acts on **expected value and forward measurement**, not diagnosis.
The remaining free retrospective tests — rainfall, Search Console, the day-level
split, the device split — **narrow the prior; none of them identifies.** Run them
because they are cheap, then stop, and **do not let their results reopen the
ranking war.**

---

## 3A. THE GOOGLE ADS PULL (2026-08-31) — WHAT IT SETTLES, AND WHAT IT DOES NOT

Read-only pull from account **673-094-6254** (angularbrackets.web@gmail.com).
**Nothing in the account was changed.** The 31 daily rows were pulled in five
≤7-day chunks and **transcribe faithfully**: they sum to the UI month total
exactly on impressions (11,710), clicks (526) and conversions (66.00), and to
**CA$1,716.95 against a displayed CA$1,716.94** — a one-cent daily-rounding
artifact. That checks transcription, **not** that the figures are like-for-like.

### What this pull is authoritative for — and what it is not

**Ads is authoritative for traffic:** impressions, clicks, cost, CTR, CPC.

**Ads is NOT authoritative for bookings.** Its conversion counts (a) include
**developer rehearsals**, (b) cover only **ad-attributed** sessions, and (c) are
**click-dated, not conversion-dated** — the daily table records **0 conversions
on both Aug 19 and Aug 20**, while `Assessment booked`'s own detail page reports
its **last conversion on Aug 20**. Both can only be true if the table attributes
to the *click* and the detail page to the *conversion*. **Booking counts below
therefore come from the production database, not from Ads.**

### The campaign
One campaign, **Water Damage Restoration**, Performance Max, started
**Jul 3 2026**. Budget **CA$56.70/day**, status *Eligible (Limited) — Limited by
budget*. Bid strategy **Maximize conversions (Target CPA)** at **target CPA
CA$25.27**. Edmonton; Leduc; +8 more · English · all day · all devices.

### Change history, Aug 1–31: five entries, none after Aug 9

| When (MT) | Change |
| --- | --- |
| Aug 9, 09:00:49 | Conversion "Assessment booked": value → *Always use* |
| Aug 9, 08:59:33 | Conversion "Assessment booked": count → *One* |
| Aug 9, 08:59:04 | Renamed *Book appointment* → *Assessment booked* |
| Aug 9, 08:50:45 | Conversion created; *Book appointments (Website)* added to account-default goals |
| Aug 5, 23:46:56 | Terms and conditions accepted; customer identity created |

**No human change was recorded after Aug 9** — no budget, bidding or
conversion-configuration edit on Aug 11, 16, 19 or 20. This closes *"did someone
change the campaign"*. It does **not** close *"did the campaign change"*: PMax
reallocates across inventory continuously and logs nothing, which is exactly the
successor mechanism in explanation 3.

### Conversion actions — all five are Primary. There are no Secondary actions.

| Action | Source | Status | Count | Window | Aug | Last fired |
| --- | --- | --- | --- | --- | --- | --- |
| Website call | Website | Active | One | 30d | 30.00 | Aug 31 |
| Calls from ads | Call from Ads | Active | Every | 30d | 15.00 | Aug 31 |
| Assessment booked | Website | **Misconfigured** | One | 90d | 8.00 | **Aug 20** |
| Request quote | Website | **Misconfigured** | One | 30d | 13.00 | **Aug 11** |
| Local actions – Directions | Google hosted | Awaiting conversions | Every | 30d | 0.00 | — |

Total 66.00 conversions / 71.20 value. Both misconfigured actions report
*"Conversion has not received tag pings in the last 7 days."* **Enhanced
conversions is not configured on either.** `Website call` counts calls **≥30 s**
to (780) 479-3285; `Calls from ads` counts calls **≥60 s**. These are connected
calls, not `tel:` clicks.

**`Website call` is our own tag, not an independent control.**
`src/components/Analytics.astro:29-35` configures Google's number-swap itself and
depends on `PUBLIC_AW_ID` + `PUBLIC_AW_CALL_LABEL` being set in Vercel
production. It is **30 of the 45** August call conversions. BK-10 (Aug 11) and
BK-29 (Aug 15) both edited `Layout.astro`, `Navbar.svelte`, `ContactSection.astro`
and every service page. **A deploy could have degraded this measurement without
leaving a trace**, and an env-var change in Vercel would not appear in Ads change
history at all. Only `Calls from ads` is genuinely deploy-independent, and its
Aug 10–16 baseline is **n = 3**, which establishes nothing.

### Traffic — Ads authoritative

| Window | Impr | Clicks | Clicks/day | Cost/day | CTR | CPC |
| --- | --- | --- | --- | --- | --- | --- |
| Aug 1–9 (9d) | 2,214 | 139 | 15.4 | CA$52.07 | 6.28% | CA$3.37 |
| Aug 10–16 (7d) | 2,147 | 106 | 15.1 | CA$50.88 | 4.94% | CA$3.36 |
| Aug 17–20 (4d) | 1,405 | 81 | 20.3 | CA$79.29 | **5.77%** | **CA$3.92** |
| Aug 17–31 (15d) | 7,350 | 281 | 18.7 | CA$59.48 | 3.82% | CA$3.18 |

**Traffic did not fall.** Clicks/day rose and spend rose. But see explanation 3:
under a budget cap spent to 99.6%, that is close to arithmetically forced and
excludes far less than it appears to.

### The correction that matters: put both channels on the same denominator

The first draft of this section compared **bookings per click** against **calls
per day** and concluded "calls held." That was a denominator error — clicks/day
rose 24%, so the per-day framing absorbed the very degradation the per-click
framing exposes. On the same denominator, over the same window:

| Aug 10–16 → Aug 17–20 | baseline | window | fall | P |
| --- | --- | --- | --- | --- |
| Bookings / paid click † | 7/106 = 6.60% | 1/81 = 1.23% | **−81%** | 0.030 |
| Calls / paid click | 11/106 = 10.38% | 3/81 = 3.70% | **−64%** | 0.032 |

**† Read this row with two known defects.** Its numerator is the **Ads**
`Assessment booked` count (7), not the database's 9 — which contradicts this
section's own rule that booking counts come from the database; and the **"1" is a
developer rehearsal, not a customer** (see below). The −81% is therefore a
tag-based figure carrying the tag's problems (click-dating, 90-day truncation,
dev rows). **It has never been reconciled and should not be quoted alone.**

Over the full Aug 17–31 stretch, calls/click give **P(X≤19) = 0.031** — also
significant. **The withdrawn "calls held flat (p = 0.20)" was an artifact:** that
per-day test only reaches p<0.05 at ≤15 calls, i.e. it could not have detected
anything short of a **36%** fall, and the observed point estimate was 19%.

**Both paid channels fell, at the same significance, in the same window.** The
phone did not act as a control, and **the site is not exonerated or convicted by
this pull.**

### The discriminating test was run, and it did not discriminate

**Ran 2026-08-31**, same session, Aug 1–16 vs Aug 17–31, segmented by conversion
action. The design: `Website call` is Google's number-swap **configured by our own
landing page** (`Analytics.astro:29-35`) and so requires a page visit;
`Calls from ads` is the ad's own call asset and **never touches the website**.
BK-29 changed only the website. So *"`Calls from ads` holds while `Website call`
falls"* would indict the on-page / ad-mismatch mechanism, and *"both fall"* would
indict demand.

| Action | Aug 1–16 | Aug 17–31 | change | P |
| --- | --- | --- | --- | --- |
| `Website call` / click | 18/245 = 7.35% | 12/282 = 4.26% | **−42%** | 0.028 |
| `Calls from ads` / click | 8/245 = 3.27% | 7/282 = 2.48% | −24% | **0.30** |
| `Calls from ads` / impression | 8/4,361 = 0.183% | 7/7,362 = 0.095% | **−48%** | 0.041 |

**The answer depends on the denominator, so there is no answer.** Per *click*,
the site-dependent series fell significantly and the site-independent one did not
— which favours the on-page mechanism. Per *impression*, the site-independent
series fell 48% and significantly — which favours demand. Impressions are the
natural exposure base for a call asset, but impressions **inflated ~69% on
Display drift** over exactly this window, so the per-impression denominator is
contaminated by the inventory shift and its fall is partly mechanical.

**Verdict: inconclusive, as pre-registered.** The test was flagged in advance as
weak-powered (n = 8 and 7), with a null uninformative and only a *hold* counting
as a positive. It did not produce a hold. **It does not move the ranking of
explanations, and it must not be quoted as if it did.** What it does add: the
site-dependent call series fell **harder** than the site-independent one on the
common denominator, which is a weak directional hint toward the site and nothing
more.

### Row counts, from the database — a floor, not ground truth

**`appointments` records web-originated bookings only, and `#37` proves a
terminal status can misstate the outcome. Every count here is a LOWER BOUND and
every fall computed from it an UPPER BOUND.** The leak is one-directional: the
office booking by phone and settling by Interac removes real jobs from these
counts and can never add one.

| Window | Real bookings | Ad clicks |
| --- | --- | --- |
| Aug 10–16 | 9 (`#20 #21 #25 #26 #27 #28 #29 #30 #32`) | 106 |
| Aug 17–20 | **0** | 81 |

The only appointment rows in Aug 17–20 are **`#35` (Aug 19, 23:07) and `#36`
(Aug 20, 15:53)** — both `Mohamm`, both the developer Stripe rehearsals §2
already excludes. **So the "1" in the Ads column above is a rehearsal, not a
customer.** At the Aug 10–16 rate, expect **3.86** real bookings in Aug 17–19;
observed **0**; **P(X=0) = 0.021**.

The **9 database bookings against 7 Ads conversions** in Aug 10–16 is unexplained
and unremarked until now. Most likely two were organic rather than ad-attributed;
possibly the tag under-fired. **`Assessment booked` has never been verified
firing against a known booking** — it is *asserted* correctly-instrumented from
its config state, which is CLAUDE.md's "pending an artifact" pattern.

### NEW, 2026-08-31: the Interac blind spot

`#38` (Aug 31, 13:12; paid 13:49) is the end-to-end booking §7 Phase 0 (formerly "Step 1") asked for.
It was made by the developer and **the payment was marked received via Interac in
the admin panel**. The row records `payment_method = interac`,
`paid_amount_cents = 65888`, and **no `stripe_session_id`, no
`stripe_payment_intent_id`, an empty `payment_reference`**.

Two consequences, both structural rather than incidental:

1. **No Ads conversion fired, and none could.**
   `booking-confirmation.ts` states the conversion "is reached only from the
   Stripe redirect" and is **keyed on the checkout session id**. An admin marking
   Interac received produces no redirect and no session. **Therefore every
   booking paid by Interac or on-site is invisible to Google Ads** — permanently,
   not as a lag. This compounds explanation 3: even when bookings resume, tCPA
   will not see the ones paid off-Stripe.
2. **BK-48 is still pending its artifact.** §7 claimed this booking would
   discharge "BK-48's GST number on a real receipt". **It did not** — a Stripe
   *receipt* was never generated, because Stripe was never used. This is the
   BK-48 failure pattern recurring exactly as §9 warns: money taken outside
   Stripe leaves no Stripe artifact to carry the registration number. Whether the
   system's own confirmation email carried it for a non-zero Interac amount is
   **unchecked**. BK-33's flag branch and BK-46's travel-fee header may still be
   discharged; **BK-48 is not.**

Note the travel fee did appear here: `assessment_amount_cents = 57750` against
`total_amount_cents = 65888` implies a **CA$50 travel fee** plus GST — the fee §4
records as never shown to the customer before approval.

### The cutover boundary — Aug 20 was never pre-prepay

`2eab1c8` **Aug 19 23:02** *"Deploy 2 is live"* (prepay after review); `95cb48f`
**Aug 20 07:07** *"live keys in"*. The database agrees: **`#35` carries a
`cs_test_…` session** (Aug 19 23:45 — test mode, so §3's timeline is right that
live keys land on the 20th), while **`#36` carries `cs_live_…`** (Aug 20 16:04)
and is the true live rehearsal. **Aug 20 is a fully post-cutover day** and
contributed 15 of the 81 clicks above. The pre-prepay window is **Aug 17–19**
(bar the last hour of the 19th). The first draft called Aug 17–20 "entirely
before the payment requirement existed" — **false, and withdrawn.**

Note also that the boundary rule was applied in the flattering direction twice:
**Aug 16** is also a split day (BK-27 + BK-29 deployed `df53210` **10:23 MT**)
and sits in the *baseline*, while Aug 20 sat in the *treatment* window.

### Standing caveats on the clean window

- **A Google spam update runs through three of the window's four days.** The
  **August 2026 spam update** began **18 Aug 2026** and ran 2 days 16 hours,
  completing ~21 Aug — so it covers **Aug 18, 19 and 20 of the Aug 17–20 clean
  window**, leaving only Aug 17 clean of it. Verified 2026-09-01 against Google's
  Search Status Dashboard
  (<https://status.search.google.com/products/rGHU1u87FJnkP6W2GwMi/history>);
  see "ONE Google update landed inside the measurement window". **Direction and
  size unknown** — no organic-traffic series has been pulled for these dates, so
  this is an unsized confound, not a correction to apply. It sits on top of every
  caveat below, and it means the clean window is **not clean of algorithmic
  change**; it is only clean of *our own* deploys. **Added 2026-09-01 (W17):
  this section named neither confound until then, which is why W18/W20/W21 could
  read these caveats and not know.**
  *(The "August 2026 core update from Aug 26" that this document previously
  carried does not exist and has been struck — do not reinstate it.)*
- **Post-hoc.** The window and its baseline were chosen after seeing the data.
  Eight of 31 days carry zero conversions and the window contains two.
- **Truncation bias, direction known.** `Assessment booked` has a **90-day**
  click window. Aug 10–16 clicks had a live tag for 4–10 days afterwards; Aug
  17–20 clicks had 0–3 days, and after the cutover the action can only fire on a
  Stripe payment that no real customer has made. **Any late-converting Aug 17–20
  click is structurally uncountable while its baseline counterpart was counted.**
  This *inflates* the measured booking effect by an unknown amount.
- **Baseline concentration.** **Aug 10 alone carries 8 of the 22 conversions in
  its window, from 26 clicks (30.8%)**, and §6.6 rejects only the *database-side*
  cluster objection — which does not transfer, because Ads attributes by click
  date. Holding Aug 10 out moves P(X≤1) from 0.007 to **0.088** depending on how
  much of the 7 it carries. **The day-level `Assessment booked` split is one
  segment away in the same UI and has not been pulled.**

### Loose end — real, but not the cause

**Aug 21 drew 2,632 impressions against a ~275/day median** (Aug 25: 849; Aug 24:
598), and CTR fell 4.94% → 3.82% between the two windows while **impressions/day
rose ~1.6×** (306.7 → 489.9; ~1.3× excluding Aug 21 — *not* "tripled", as the
first draft said). That is the Display-drift shape §4 predicted for a
budget-limited, signal-starved PMax. **It begins five days after the break, and
CTR inside the clean window was above baseline, so it is not the cause.** It is
live waste and it will worsen while both website conversions stay dark.

### The 31 daily rows

Retained here because CLAUDE.md assumes the session dies mid-flight. Columns:
date · conv.value · conversions · conv.rate · cost/conv · impr · clicks · CTR · cost.

```
Sat Aug  1 | 3.80 | 3.00 | 21.43% | 12.51 |   167 | 13 | 7.78% |  37.54
Sun Aug  2 | 4.21 | 3.00 | 15.79% | 23.79 |   296 | 18 | 6.08% |  71.36
Mon Aug  3 | 3.80 | 3.00 | 16.67% | 18.27 |   293 | 17 | 5.80% |  54.81
Tue Aug  4 | 4.00 | 4.00 | 22.22% | 13.99 |   271 | 18 | 6.64% |  55.97
Wed Aug  5 | 4.41 | 4.00 | 28.57% | 15.93 |   166 | 14 | 8.43% |  63.71
Thu Aug  6 | 0.00 | 0.00 |  0.00% |  0.00 |   237 | 17 | 7.17% |  50.22
Fri Aug  7 | 5.40 | 5.00 | 33.33% | 13.12 |   296 | 15 | 5.07% |  65.60
Sat Aug  8 | 1.00 | 1.00 | 10.00% | 26.43 |   205 |  9 | 4.39% |  26.43
Sun Aug  9 | 1.00 | 1.00 |  5.26% | 42.97 |   283 | 18 | 6.36% |  42.97
Mon Aug 10 | 9.18 | 8.00 | 28.57% | 12.09 |   522 | 26 | 4.98% |  96.69
Tue Aug 11 | 1.39 | 1.00 |  8.33% | 47.77 |   232 | 12 | 5.17% |  47.77
Wed Aug 12 | 4.00 | 4.00 | 20.00% | 17.63 |   316 | 20 | 6.33% |  70.50
Thu Aug 13 | 0.00 | 0.00 |  0.00% |  0.00 |   279 |  7 | 2.51% |  24.46
Fri Aug 14 | 6.00 | 6.00 | 18.75% | 13.56 |   426 | 30 | 7.04% |  81.37
Sat Aug 15 | 2.00 | 2.00 | 28.57% | 11.97 |   165 |  6 | 3.64% |  23.95
Sun Aug 16 | 1.00 | 1.00 | 14.29% | 11.39 |   207 |  5 | 2.42% |  11.39
Mon Aug 17 | 3.00 | 3.00 | 11.54% | 36.12 |   431 | 26 | 6.03% | 108.36
Tue Aug 18 | 1.00 | 1.00 |  5.26% | 82.79 |   381 | 19 | 4.99% |  82.79
Wed Aug 19 | 0.00 | 0.00 |  0.00% |  0.00 |   390 | 21 | 5.38% |  63.48
Thu Aug 20 | 0.00 | 0.00 |  0.00% |  0.00 |   203 | 15 | 7.39% |  62.51
Fri Aug 21 | 2.00 | 2.00 |  3.77% | 24.20 | 2,632 | 50 | 1.90% |  48.40
Sat Aug 22 | 0.00 | 0.00 |  0.00% |  0.00 |   193 | 14 | 7.25% |  33.34
Sun Aug 23 | 1.00 | 1.00 | 14.29% | 19.07 |   168 |  7 | 4.17% |  19.07
Mon Aug 24 | 3.00 | 3.00 | 10.00% | 37.61 |   598 | 29 | 4.85% | 112.82
Tue Aug 25 | 0.00 | 0.00 |  0.00% |  0.00 |   849 | 23 | 2.71% |  46.95
Wed Aug 26 | 4.00 | 4.00 | 23.53% | 16.01 |   313 | 17 | 5.43% |  64.05
Thu Aug 27 | 2.00 | 2.00 | 20.00% | 27.14 |   141 | 10 | 7.09% |  54.28
Fri Aug 28 | 0.00 | 0.00 |  0.00% |  0.00 |   441 | 13 | 2.95% |  53.04
Sat Aug 29 | 0.00 | 0.00 |  0.00% |  0.00 |   187 | 17 | 9.09% |  43.51
Sun Aug 30 | 1.00 | 1.00 | 14.29% | 27.17 |   144 |  6 | 4.17% |  27.17
Mon Aug 31 | 3.00 | 3.00 | 21.43% | 24.15 |   278 | 14 | 5.04% |  72.44
```

---

---

## 3B. THE ADMIN PANEL AND THE INBOX (2026-08-31) — WHAT IS HAPPENING AT THE DESK

Screenshots supplied by the user on 2026-08-31: `/admin/` (Leads),
`/admin/appointments/`, and a Gmail search for `"NEW REQUEST #"`.

### 36 of 39 leads sit unactioned IN THE PANEL — and the panel is wrong

The Leads screen reads **"39 total"** with **"36 new"**. Exactly **one** lead is
marked `replied` (Peter Harvey, Aug 20) and **one** `read` (Jennifer, Aug 11).
Every other lead in the list — including the four most recent, **Jay Patel
(Aug 30), Mathieu Trudel (Aug 29), Joan Guindon (Aug 25)** and the Aug 20 one —
sits in `new`.

Those four dates are precisely the *"Aug 20, 25, 29, 30, all real restoration
enquiries"* §2 records as proof that demand had not vanished. **Demand did not
vanish; whether it was worked is not something this panel can tell us.**

**`#37` is a confirmed instance of the panel being wrong in exactly that
direction** — recorded `declined`, actually completed after an off-system
reschedule (new facts, 2026-08-31). The panel's one testable case failed. So the
36 `new` rows are evidence of **tool adoption in a young organisation**, not
evidence of an unworked queue, and must not be put to the client as the latter.

**This looked like §8's question 6 answering itself. It does not — see the
withdrawal below.**
§8 states the stake plainly: *"If surviving demand is being turned away at the
desk, no funnel work matters."*

**The caveat, and it is a real one.** `new` is an *admin-panel* status. The office
may well be phoning these people without ever opening the record — the panel has
no reason to know. **This is evidence of an unworked queue in the tool, not proof
of an unworked queue in the business**, and it must be put to the client as a
question, not an accusation. It is a question about **what the software fails to capture**, not about the
desk.

### The one real booking in the collapse window — recorded declined, actually completed

`#37` **Peter Harvey** appears in both screens: a lead on **Aug 20** (the single
`replied` row), then a booking on **Aug 23** for a **Mon Aug 24, 3:30 p.m.** slot,
status **Declined**. **~~So the only real customer who both messaged and booked
after Aug 16 was turned away at the desk.~~ WITHDRAWN 2026-08-31: the work was
done.** The decline appears to have been a scheduling conflict, after which the
appointment was rescheduled by other means and never captured. **He was not
turned away; he was served.** §2 already flagged that `#37` was
declined and that its provenance was unconfirmed; the lead row confirms it was a
real enquirer who had contacted the business three days earlier.

### Appointments

**15 total; 1 upcoming** — `#38`, Sun Sep 6, 3:30 p.m., *Private pay*, 1 file:
the developer's own end-to-end test (§3A). Every other row is past. The Aug 15–17
cluster (Kay-Dee Black, Shelly Francis Dahl ×2, Bryan, Ken Hannah, Tyler Edgson)
are the Aug 10–16 bookings seen by *appointment slot* rather than creation date,
and several read `Elapsed` — i.e. the slot passed with no terminal status set,
which is its own desk-side signal.

### The office notification email

A Gmail search for `"NEW REQUEST #"` returns **exactly four**: `#35` (Aug 19),
`#36` (Aug 20), `#37` (Aug 23), `#38` (today). All four are Deploy-2-era or later
— `#35` was created **five minutes after** `2eab1c8` went live — so the most
likely reading is that **Deploy 2 introduced this subject line**, and the nine
Aug 10–16 bookings were notified under a different one.

**This is not evidence of a delivery failure**, and it partly answers §10's
*"whether Resend is still delivering the office notice"*: for the current format
it is **4 for 4**, including today. **What it does mean** is that there is **no
`NEW REQUEST #` email artifact for the Aug 10–16 bookings**, so this search
cannot be used to audit that window. Searching the pre-Deploy-2 subject is
untried and is the obvious next check.

---

## 3C. THE MOBILE WIZARD BECAME A SILENT DEAD END ON AUG 16

**Independently re-verified 2026-08-31** against four built states of the repo —
`2adc752` (Aug 13, pre-BK-27), `1de17d0` (the Aug 16 deploy), `befce39` (Deploy 2,
Aug 19) and HEAD — in **both Chromium and WebKit** (iOS Safari's engine).
**The claim survives. Three of the four facts the first draft rested on were
wrong and are corrected below.** It now stands on evidence the first draft did
not have.

### The mechanism, correctly stated

Step 2's Continue button sits ~1,150px down, and `goTo()` never changes scroll
position, so **the visitor always lands ~1,150px into step 3.** That was harmless
until Aug 16 for a reason nobody guessed: **step 3 used to be 502px tall, so the
document shrank on the step change, the browser clamped the scroll back up, and
the visitor landed with all of step 3 in view — uploader included.**

On Aug 16 step 3 crossed the threshold where clamping stops rescuing it.

| Build | Step 3 height | Terms box | Photo error on failed submit |
| --- | --- | --- | --- |
| Pre-BK-27 (`2adc752`, Aug 13) | **502px** | — | **+103px — VISIBLE** |
| **Aug 16 deploy (`1de17d0`)** | **1,082px** | 508px | **−505px — off-screen** |
| Deploy 2 (`befce39`, Aug 19) | 2,390px | 1,776px | −1,813px |
| HEAD | 2,390px | 1,776px | −1,813px |

### The decisive test: the realistic path, on WebKit, on the Aug 16 build

Chromium and WebKit diverge because **Blink implements scroll anchoring and
WebKit does not** — so "lands at the bottom of step 3" is a *Chrome* artifact and
**must not be said to the client.** On WebKit the visitor lands mid-terms. What is
in view: the terms checkbox, the SMS checkbox, Back, and **Confirm booking**.
**It looks like a complete, finished form.**

Tick the terms box — the only thing being asked — and tap Confirm booking:

> **scrollY does not move (1785 → 1785), and the sole error renders 443px above
> the fold. The screen is pixel-identical except that the terms error
> disappears.**

Same path on the Aug 13 build: the error renders **+103px, in view.** Everything
works. **A silent dead end, newly created by `a1eedc9` and shipped in `df53210`
at Aug 16 10:23, reproducing on the engine iPhones actually use.**

Nothing mitigates it: no `scrollIntoView`, no `focus()`, no `autofocus`, no
`aria-live`, `scroll-behavior: auto`, and the form is `novalidate` (line 708) so
there is no native constraint bubble either. `formMessage` — the only message
rendered near the button — is set **only** from server responses, never from
client-side validation.

### Corrections to the first draft of this section

- **"BK-27 added the price radios" — REFUTED.** No radio in `a1eedc9`;
  `booking-copy.ts` at that commit says so itself: *"There is no tier picker on
  the form yet — that is BK-31."* **The radios landed `e476798` (Aug 18),
  deployed `befce39` Aug 19** — three days after the collapse begins.
- **"~1,800px of fee-terms prose" — REFUTED for Aug 16.** The terms box was
  **508px** on Aug 16; 1,776px is today's figure. The extra 1,268px is BK-31 +
  BK-36, **Aug 19**.
- **"a second mandatory checkbox" — wording wrong, substance right.** It was the
  **first** blocking checkbox on step 3; SMS consent does not block
  (`booking-form.ts:60`: *"Unlike `smsConsent`, this one blocks."*). Blocking
  failure modes went **1 → 2**.
- **"1,889px above the fold" → 1,813px**, and **"no error in view" is overstated
  for TODAY's build**: two errors land near the viewport top, one occluded by the
  fixed 77px navbar, but **the terms error at yVp 116 is genuinely visible.**
  Today the visitor sees one red line naming the wrong requirement. **On the
  Aug 16 build "no error in view" is literally true.**

**So the magnitudes for Aug 16 are roughly 3× smaller than first written, and
Aug 19 carries a second, worse regression** — the same day instant confirmation
ended. **Aug 19 deserves its own line in §3's timeline for the layout change, not
only for `MIN_NOTICE_DAYS`.**

### What it explains, and what it does not

**Explains:** a *step* on Aug 16, in the booking form, on mobile, invisible to
every gate (typecheck, build and all 25 verify scripts run headless with no
layout), and leaving no trace because the island fires no funnel events.

**Does NOT explain** the message-lead fall or the phone-call fall. **Neither
channel touches this form.** It is at most the booking half.

### No retrospective proof exists — August is gone

The only database trace of "opened the uploader" is orphaned `appointment_files`
rows, and the hourly `cleanup-uploads` cron deletes them at
`UPLOAD_ORPHAN_TTL_HOURS = 24`; `rate_limits` windows are pruned by the same
cron. **There is nothing left to query.**

### The cheapest proof going forward is ONE event, not five

Fire **`booking_submit_blocked` with the failing field** from the
validation-failure branch of `handleSubmit` (~line 508) — **that branch already
computes `found` and `target`, so it is a single `gtag` line.** Its count *is*, by
construction, the number of people who tapped the commit button and got nothing.
**If it fires at a rate comparable to completed bookings, the mechanism is proven
live without needing a pre-Aug-16 baseline that no longer exists.**

**Note for the fix:** because Chromium's scroll anchoring and WebKit's lack of it
produce *different* landings, the fix must **set scroll position explicitly** on
step change and scroll the first error into view on failed validation. Relying on
either engine's default is what produced the divergence in the first place.

## 3D. THE INTERAC LEDGER — TWENTY PAYMENTS, ONE RECORDED

**Supplied by the user 2026-08-31**: a Gmail search for
`"Interac e-Transfer: You've received"`, returning **20 payments** (Jul–Aug),
**13 of them in August**. This supersedes the earlier statement of "at least two
Interac payments" everywhere it appears.

### August, split at the break

| | Payments | Distinct payers |
| --- | --- | --- |
| Aug 1–16 | **4** | 3 (Alexander Dufour, Treena Alspach, Kyo Hyun Shim ×2) |
| Aug 17–31 | **9** | 5 (2668100 Alberta Ltd., Leon Lam Thai, Lorraine ×3, Peter Anthony Harvey ×2, Sharon L Breitkreuz ×2) |

**More money arrived after the break than before it, from more customers —
BUT SEE THE CORRECTION IMMEDIATELY BELOW BEFORE USING THIS.** Payment dates
cannot date jobs, so this line is NOT evidence that new work arrived.

### The correction that must be read before those numbers are used

**A payment date is not a job date, and this ledger proves it against itself.**
Restoration work is invoiced in instalments, and **7 of ~11 distinct payers appear
more than once** — three of them spanning July into August:

| Payer | Instalments | Gap |
| --- | --- | --- |
| Alexander Dufour | Jul 15, Aug 6 | ~3 weeks |
| Kyo Hyun Shim | Jul 23, Aug 12, Aug 13 | ~3 weeks |
| Leon Lam Thai | Jul 28, Aug 20 | ~3.5 weeks |

**So a payment landing Aug 20–30 may well be for work originating before Aug 16 —
including the nine bookings of Aug 10–16, whose appointment slots fell Aug 15–17.**
The "9 after vs 4 before" split is therefore **consistent with the pre-Aug-16
pipeline settling** and is **NOT evidence that new work arrived after the break.**

**Withdrawn on those grounds:** the claim that "more work arrived after the break",
and the conclusion that post-storm demand decay is weakened by it. **Explanation 4
is restored to live and remains unsized.**

**What still stands from the split:** money kept arriving throughout, and
**`#37` is the one case whose origination is unambiguously post-Aug-16** — lead
Aug 20, booked Aug 23, paid Aug 25 and Aug 30. That is one real customer sourced
after the break, not a trend.

**This makes the decisive client ask jobs *with their dates*, not payments.**
Only a job list can date demand; the ledger cannot.

### What this settles

- **The company kept trading through the break** — but *how much* of that is new
  work rather than the earlier pipeline settling is **not established** (see the
  correction above). What is established is narrower and still important: the
  client's report of "bookings reduced significantly" describes **the software**,
  and this document's row counts describe the web funnel, **not the company.**
- **`#37` is closed.** **Peter Anthony Harvey paid on Aug 25 and again on
  Aug 30**, against a booking the system records as `declined`. The job was done
  and paid twice over. §10's "#37's provenance is unknown" is resolved.
- **Explanation 4 (post-storm demand decay) is NOT weakened by this ledger.**
  An earlier draft of this section claimed it was; that claim assumed payment
  dates could date demand, and the instalment evidence above refutes it. **The
  ledger is silent on when the work originated, so it is silent on demand.**

### What this makes worse

- **The GST exposure is 20 payments, not 2.** §10 and Phase 2 were scoped to
  "the twenty Interac payments (§3D)". **Rescope both.** Whether any compliant
  artifact exists for any of these is unchecked, and only `#38` — a developer
  test — was ever marked paid in the admin panel.
- **The record gap is near-total.** Twenty customer payments; the `appointments`
  table records **one** Interac payment, and it is the developer's own test.
  Phase 5 (reschedule, mark-completed, receipt on the Interac path) moves from
  "worth building" to **the thing standing between this company and a set of
  books.**
- **The Ads blind spot is fully realised.** Every one of these paid jobs fired
  **no conversion** (§3A). tCPA has been optimising against a business it cannot
  see, all month.

### What it does NOT explain

Nothing here explains why **web bookings, message leads and phone calls** all
fell on Aug 16 — those are customer actions on customer surfaces, upstream of any
payment. §3C and explanation 2 remain the candidates. **What changes is the
stakes: this is a measurement and compliance emergency sitting on top of a
funnel problem, not a company in trouble.**

---

## 3E. THE OUTSIDE WORLD — CHECKED, NOT RECALLED (2026-08-31)

**External facts with sources, found on the last pass of the day. These change
the frame more than anything found inside the codebase.**

### Edmonton had a once-in-a-century flood summer

- **~$230M insured damage in the Edmonton area since May** — ~$80M in
  late-May/early-June, ~$150M on June 20–21, with **mid-July claims still being
  tallied** (Insurance Bureau of Canada, via Canadian Underwriter / CBC).
- **June 2026 was Edmonton's wettest June in 112 years**; **2026 became the
  wettest summer on record**; **15 storm days in June and 19 in July**
  (Global News).

**This is not "the client remembers rain." It is a catastrophe of record.**

**And it demolishes the baseline, which is a bigger problem than it sounds.**
`/book/` launched **Aug 10 — deep inside the tail of the wettest summer in
Edmonton's recorded history.** The 1.29 bookings/day "baseline" that every
p-value in this document is conditioned on is **catastrophe overflow, not a
market rate.**

**It also defeats this document's own objection to the demand explanation.**
§3 previously held that a rainfall rolloff predicts a *gradient* while the data
shows a *step*. **Surge overflow ends as a step**, because the franchise and
preferred-vendor networks (First General, On Side, Winmar, Paul Davis; ClaimsPro,
Crawford, Sedgwick) regain capacity and **reabsorb the queue**, and independents
lose the overflow at once. **Atoms 2 and 3 are therefore not independent — they
are one mechanism seen from two ends**, and combined they are considerably
stronger than either was rated separately.

### The rainfall test was RUN with real gauge data. The timing claim is false.

**Environment and Climate Change Canada bulk daily climate data**, three Edmonton
stations carrying 2026: **Blatchford (Climate ID 3012209 — the in-city gauge,
primary)**, Edmonton Intl A (3012216), Edmonton International CS (3012206).
August 2026 values are preliminary.

**The July half of the client's account is corroborated and understated.**
Blatchford July 2026: **264.7 mm**, against a 2021–25 July mean of ~54 mm — ~5×.
The **Jul 25 supercell is independently documented** (>30 mm in one hour, 94 km/h
winds, flash flooding on Whitemud and Yellowhead, the Commonwealth Stadium show
cancelled), and Blatchford recorded **30.0 mm that day**. Leads referencing "the
25 of July major storm" describe a real, severe event.

**The "until about Aug 15" half is contradicted by all three gauges.**

| Week (2026) | Blatchford | Edm Intl A |
| --- | --- | --- |
| Jul 15–21 | **114.4 mm** | 39.8 |
| Jul 22–28 | 54.9 | 21.9 |
| Jul 29–Aug 4 | 21.5 | 22.1 |
| Aug 5–11 | 9.7 | 20.6 |
| Aug 12–18 | 2.4 | 8.9 |
| Aug 19–25 | **0.2** | 0.0 |

A single-changepoint scan over Jul 1 – Aug 31 puts the strongest break **before
July 28** (10.86 → 1.23 mm/day) — **not mid-August**. **Aug 1–15 was an ordinary
half-month**: 33.3 mm at Blatchford against a 2021–25 mean of 24.4 mm. The last
measurable city rain before the collapse was **2.1 mm on Aug 13**, which does not
flood basements.

**Four findings that cut hardest against the one-day-lag story:**

1. **The three best booking days the form ever had — Aug 14 (2), Aug 15 (3),
   Aug 16 (1), six of the nine — recorded 0.0 mm at all three gauges.** Bookings
   peaked on the driest days in the series.
2. **Correlation is null inside the clean pre-deploy window** (Aug 1–16, where the
   site never changed): r = +0.01 / +0.22 / −0.07 / +0.27 / −0.46 at lags 0–4,
   signs flipping, permutation p = 0.97 / 0.46 / 0.83 / 0.40 / 0.11. Over the full
   month the best lag gives r = +0.34, but corrected for searching 8 lags
   **p ≈ 0.082**, and **partialling out the Aug-16 step drops it to r = +0.23,
   p = 0.22** — the apparent correlation *is* the step.
3. **The largest rainfall in the whole Aug 12–31 stretch fell on Aug 17**
   (7.0–7.6 mm at the airports) — **the day after the collapse.**
4. **Mould is one of four services and lags water by weeks.** A record-wet July
   should be pushing mould enquiries **up** through late August — the opposite
   direction to the observed fall. This document had not made that argument.

**And a bone-dry second half of August is climatology, not an event:** Blatchford
Aug 16–31 read 22.0 / 4.8 / 37.3 / 30.2 / 3.3 / **2.0** mm in 2021–26. It happens
in three years of six.

**A shape argument that partly cuts through the collinearity.** Weather and
`df53210` cannot be separated on *date*. But they differ in *shape*: the deploy is
a step at one timestamp, the demand series is a step (P(X≤1) ≈ 8×10⁻⁸ for
bookings), and **the rainfall series is a three-week ramp that broke on July 28
and had decayed to drizzle by Aug 5–11.** A ramp does not generate a step in a
series that was still setting records on the last three dry days before it.

**Disposition.** **The specific "rain stops Aug 15, bookings stop Aug 16" fit is
measured and false — struck.** What survives is narrower: a **slow, unsized,
level-shifting** background effect from a once-in-125-year July, which §3D's
instalment evidence still prevents anyone from sizing. **This does not promote the
site hypotheses; it removes a rival the timing never supported.**

**Still worth asking, and cheap:** the **service mix** of the Aug 10–16 leads
versus the Aug 20/25/29/30 leads — a real discriminator nobody has requested — and
**monthly job-origination counts Jun 2025 – Aug 2026**, the only thing that can
establish trade seasonality, since `/book/` launched Aug 10 2026 and no prior-year
demand series exists anywhere.

### ONE Google update landed inside the measurement window — not two

**Verified 2026-09-01 (W17) against Google's Search Status Dashboard**, which is
the authoritative log. Both dates were previously stated here with **no cited
source**, and CLAUDE.md forbids taking external behaviour from recall. Checking
them changed the answer.

- ✅ **August 2026 spam update — CONFIRMED. Start 18 Aug 2026, duration 2 days
  16 hours**, so it ends on **21 Aug** if it began in the morning and on the
  **20th** if late in the day; either way it runs through the whole of Aug 18,
  19 and 20. **It runs INSIDE the Aug 17–20 "clean
  window"** on which §3C's clean-window comparison rests — covering **three of
  its four days** (Aug 18, 19, 20). It does not begin on Aug 16, so it is not
  the cause of the collapse; it is a **confound on the clean window**, and the
  clean window is what §3C's comparison rests on.
  Source: <https://status.search.google.com/products/rGHU1u87FJnkP6W2GwMi/history>

- ❌ ~~**August 2026 core update: began Aug 26**~~ — **STRUCK. THERE IS NO SUCH
  UPDATE.** Google's dashboard lists the complete 2026 sequence as: February
  Discover update, March spam update, March core update, May core update, June
  spam update, August spam update. **No August 2026 core update, on either the
  summary page or the full history**, and an in-progress rollout would still be
  listed. Checked 2026-09-01.
  **The likely contamination:** the entry immediately below August 2026's on the
  same dashboard is the **August 2025 spam update, start 26 Aug 2025**. An
  August update beginning on the 26th exists — it is a *spam* update, in *2025*.
  **How to re-check this negative claim** (it is the strongest external claim in
  this document and rests on one read, made **2026-09-01**): open the history
  URL above and read the 2026 entries. The claim fails if an "August 2026 core
  update" appears. Google backfills the dashboard when it confirms an update
  late, so a *later* appearance would not mean this read was wrong — it would
  mean the confound is new. Re-check before any September before/after test.

**Consequence, and it matters more than the correction.** This section was about
to hand W18/W20/W21 a confound that does not exist. A September before/after
test discounted against a phantom core update would have explained away real
movement. **There is no September core-update contamination on the record as of
2026-09-01** — if one is announced later, it is a new confound with a new date,
not this one.

This is the failure mode this document already lists against itself at settled
item 11 ("the statistics in §5's Evidence hygiene list are FABRICATED"), and it
survived here because a date with no source reads exactly like a date with one.
**Cite the dashboard, or do not record the confound.**

### Insurance vs self-pay — the split that decides whether $399 is a product

On an insured loss the homeowner pays a deductible and the restorer bills the
insurer. **An insured claimant will not pay $399 out of pocket** when their
insurer will send an approved vendor at no upfront cost. Early in a catastrophe
adjusters let claimants pick anyone because preferred vendors are saturated; once
capacity clears, claims route back through the vendor programs and independents
get only the **uninsured residue** — overland flood without the endorsement,
exhausted sewer-backup sublimits, mould exclusions. **Those are the most
price-sensitive customers in the market, and they are the ones meeting the $399
gate.**

**Twenty Interac e-transfers is itself the tell: insurers do not pay by
e-transfer.** The ledger may be saying this business runs almost entirely on
**self-pay** work. Nobody has stated that, and it bears directly on §8's pricing
questions.

### Being busy suppresses the call metric — a measurement hole with a free fix

**Both Ads call actions count connected calls of ≥30 s and ≥60 s. They count
conversations, not attempts.** A small crew doing extraction and demolition all
day cannot answer a ringing phone — and **August was, by the Interac ledger, the
company's busiest field month.** A fall in *answer rate* is **indistinguishable**
in Ads data from a fall in *demand*, and neither Ads nor the site records calls
that rang out. **The carrier's call detail record settles it, is free, is
deploy-independent, and has never been asked for.**

### Channels nobody has looked at at all

- **Google Business Profile.** For a local emergency trade the map pack is
  normally the largest single source of calls. This document contains **zero** GBP
  evidence — no impressions, no calls-from-listing, no direction requests, no
  reviews, no suspension check. **GBP Performance gives calls, direction requests
  and website clicks by day for six months, free** — i.e. **the pre-August
  baseline this entire investigation lacks.** Failure modes that give a
  step-shaped drop with no code change: **suspension** (common for service-area
  businesses with no storefront, and frequently triggered by *editing* the
  profile), a ranking loss, or review filtering. Corroborating repo evidence that
  nobody has ever connected it: no GBP link, no reviews, no `aggregateRating`, no
  `sameAs` (`seo.ts:132-134`, `Footer.astro:54`, `TestimonialsSection.astro:2-5`),
  and **§3A's own table shows `Local actions – Directions` at 0.00,
  "Awaiting conversions"** — never read as evidence by anyone.
- **Every lead marketplace that is not Google** — HomeStars, Yelp, BBB, Nextdoor,
  Kijiji, 411. **None appears in the repo or this document.** A lapsed listing or
  a declined card on ~Aug 15 is a step-shaped loss on a channel nobody watches.
- **Offline marketing with a natural end date** — a wrapped van parked at flood
  jobs *is* the advertising; when the jobs end, so does it. Yard signs, flyer
  drops in hit neighbourhoods, community Facebook groups.
- **Ads Policy Manager and billing status** were never opened — only change
  history. **A disapproved asset or a limited-serving policy action produces no
  change-history row**, and the live ad promising a "free, no-obligation quote"
  for a $399 page is the exact shape that draws a **misrepresentation** action.

### The reframe nobody had written down

**There is no company-level baseline anywhere in this document.** Everything is
measured against seven days of a six-day-old booking system. The Interac ledger
names roughly **eleven payers across two months — that may be the entire
company.** At that volume, **one referral source, one week away, or one storm is
the whole signal**, and a statistical apparatus is being applied to single-digit
monthly job counts. **Nobody has asked how many jobs a month this business
normally does.**

### The three to chase first

1. **Google Business Profile — Performance data and account status.** Ten
   minutes, one login, six months of day-level history on the non-paid phone and
   map channel. Highest information density left anywhere.
2. **The job list with dates, June–August, split insured vs self-pay.** §3D proved
   payments cannot date demand; only jobs can. It sizes the catastrophe tail
   against a market rate, dates the July storm wave against the Aug 15/16 break,
   and tells us whether $399 is a coherent product for the customers who remain.
3. **The carrier's call detail record for August.** The only measurement that can
   separate *"demand went away"* from *"we were on a job site."* **The plan has
   been asking the client to describe this; ask for the file.**

## 4. FINDINGS NOBODY WAS LOOKING FOR

- **`src/pages/[service].astro:79` says "About 30 minutes, no obligation"** — live
  on all six service pages, which are the Google Ads landing pages, on the
  primary CTA. False under the credit model. `ContactSection.astro:59-69` already
  argues this in the repo's own words; the argument never reached this file.
  Same Competition Bureau general-impression exposure BK-29 existed to close.
  **This is the copy-inventory trap in CLAUDE.md firing again.**
- **The live Google ad says "Call now for a free, no-obligation quote."** Asset
  last updated **2026-07-03**, still enabled, pointing at a page that charges
  $399. Ad-level misrepresentation exposure plus destroyed landing-page
  relevance.
- **Since the Aug 20 cutover the Ads conversion fires only after a Stripe
  payment.** `/book/received/` fires nothing, deliberately
  (`booking-confirmation.ts:185`). Zero real customers have paid **through
  Stripe**; **at least twenty Interac payments have been received, 13 in August (§3D)** (2026-08-31),
  off-system and invisible to Ads — see §3A's Interac blind spot. **Before the
  cutover it fired on the booking itself — 8 times in August (§3A) — so this
  bullet is a statement about the post-Aug-20 regime only.** It is also keyed on
  the Stripe checkout session, so **an Interac or on-site payment fires nothing
  at all** (§3A, "the Interac blind spot"). The campaign is **Performance Max**, which has no keywords and steers
  almost entirely on conversion feedback, **"Limited by budget" at CA$56.70/day**.
  Budget-constrained plus signal-starved is the classic small-budget PMax failure
  mode: it drifts to cheap Display inventory.
- **Nothing has ever reminded a customer of an appointment.**
  `REMINDER_LEAD_HOURS = 3` (`booking-config.ts:127`) **is read by nothing.** No
  reminder cron (`vercel.json` has only `cleanup-uploads` and `expire-payments`),
  no SMS provider in `package.json`, no reminder email — yet `sms_consent_at` is
  collected, `reminder_sent_at` is a column, and the admin page renders it at
  `[id].astro:1036`.
- **The travel fee is never shown to the customer.** `assessmentQuote` defaults it
  to zero and only uses what an admin types at approval. The terms copy admits
  this in a comment: it avoids claiming the form price is final *"because that is
  false for a job beyond 30 km."* A customer past 30 km sees one price on the
  form and a larger one in the approval email. **Unticketed.**

---

## 5. THE OUTSIDE VIEW (five fresh agents, run independently)

### Industry practice
Of **ten restoration brands** checked page by page: **zero take payment online,
zero require a photo.** BELFOR alone offers an optional 5 MB upload. Nine of ten
are phone-first with a lead form as backup.

**ServiceTitan, 1M+ residential service jobs** — the booking-rate-optimal
diagnostic fee is **~$89**, and a *free* diagnostic books **worse** than one
priced 1¢–$49.99. This is the strongest number found and it cuts both ways.

No-show controls, by evidence quality: **reminders** (NHS trial 11.1%→8.4%;
paediatric RCT 38.1%→23.5%) > card-on-file > small deposit > **full prepay**,
which is the least evidenced and most expensive in conversion. A Danish
orthopedic RCT found a €34 fine made no significant difference and 79% of fines
went uncollected.

### Edmonton pricing — the client's "competitive as per the market" is not supported

| Provider | Service | Price |
| --- | --- | --- |
| Tru Air (Edmonton) | Visual inspection | **$50** |
| Tru Air | Whole-home air quality test | **$199** |
| Tru Air | Complete Package — 4 lab mould tests + air quality + thermal/moisture + radon | **$725** |
| Tru Air | Hourly rate | **$85/hr** |
| Xplortek | Full home inspection, two inspectors | **$250–600** |
| Mold & Bacteria Consulting | 1 room, lab analysis + report | **$182** |

Local competitors advertise the entry visit as **free** (Unified Restore "Free
Edmonton Estimate"; WINMAR "FREE site inspection"; Restoration Canada *"we don't
believe in charging you a fee simply to assess the damage"*). **No Canadian
restoration company charging a credited assessment fee was found.**

**The structural problem:** independent mould inspectors do sustain $250–700, but
their premium is *"I don't do the remediation, so I have no reason to find more
of it."* **This business is the remediator.** It is priced above the independents
while structurally disqualified from the reason they get paid.

**The packaging problem:** `/book/` says the assessment is *"About 30 minutes."*
$399 for 30 minutes reads as **$798/hour** against a company publishing $85/hr in
the same city. Paid inspectors never mention duration — they enumerate the
artifact (page count, moisture readings with reference ranges, spore counts in
spores/m³, named lab accreditation, turnaround in business days). **The $399 tier
sells a visit; it should sell a report.**

### Two flags for professionals, not for us
- **Alberta prepaid contracting licence.** Taking money before work is done on
  private dwellings may require a licence (~$75/yr + ~$10,000 security). The
  read is that an online-booked *inspection* probably falls outside — but the
  assessment fee being credited against a restoration contract signed at the
  kitchen table could bind the two. **Lawyer.**
- **GST on deposits.** CRA treats a true deposit differently from a partial
  payment, and forfeiture has its own rule. Primary CRA pages returned 403; a
  figure circulating online uses the superseded 7% rate. **Accountant.**

### Evidence hygiene — do NOT repeat these to the client
Checked against primary sources and found to be fabricated or unsourceable: the
salon/med-spa deposit and no-show percentages; the Unbounce form-field conversion
curves; "Baymard: 34% won't book with a deposit" (absent from Baymard's actual
page); the Formstack multi-step conversion figures; **any** optimal-deposit
percentage; and **any** measurement of file-upload-field abandonment — that study
does not exist in public research.

---

## 6. CORRECTIONS TO THE FIRST ANALYSIS

Recorded so nobody rebuilds on them:

1. **Bookings-per-lead is statistically null** (p ≈ 0.32) and has been withdrawn
   as evidence for locating the loss at conversion.
2. **Aug 16 carried two mechanisms**, and only the search-surface one explains
   the message form falling.
3. **The deposit proposal is NOT a no-code change.** The admin approval field
   already accepts $0–$10,000 (`booking-review.ts:97-118`), but the number an
   abandoning customer *sees* is fixed in `FEE_TERMS_ITEMS`
   (`booking-copy.ts:401-405`) at step 3. Changing what they see is a copy change
   and a client decision.
4. **"Request as a secondary Ads conversion" — the premise was wrong.
   Superseded by §3A.** There are **no Secondary actions in this account**: all
   five are Primary, and `Request quote` has been Primary since 6/30/2026. The
   live problem is not its tier, it is that the action **stopped firing on
   Aug 11**. The general claim (secondary actions are observation-only) still
   holds; it simply never applied here.
5. **Signal loss began Aug 11, not Aug 20 — now dated exactly.** `Request quote`
   last fired **Aug 11**; `Assessment booked` last fired **Aug 20** (§3A). Both
   now read *Misconfigured — no tag pings in 7 days*. Since Aug 20 the account's
   only live conversion input is the telephone.
6. **Rejected:** the red-team argued the 9 bookings were a 3-day cluster making
   the daily rate an artefact. They fall on Aug 10, 12, 14, 15 and 16 — spread,
   not spiked. Launch-novelty risk remains, that specific version does not.
7. **No *human* change was recorded in the Ads account after Aug 9.** Five
   change-history entries in all of August (§3A). This closes "did someone change
   the campaign". It does **not** close "did the campaign change" — PMax
   reallocates across inventory continuously and logs nothing.
8. **The "exhausted budget or declined card on the 16th" theory is dead**, but
   not for the reason first written here. Spend *rose* across the break — however
   August spend was **99.6% of the monthly budget cap** with "Limited by budget"
   showing all month, so under a spent cap a higher back-half cost/day is close
   to arithmetically forced. Cost excludes the declined-card story; it does
   **not** independently exclude delivery decay (§3, explanation 3).
9. **Google Ads' phone-call series is NOT an independent control.** `Website
   call` is 30 of the 45 August calls and is **our own tag**
   (`Analytics.astro:29-35`), dependent on Vercel env vars and on markup that
   BK-10 and BK-29 both edited; only `Calls from ads` is deploy-independent, and
   its baseline is n = 3 (§3A). **The client's switchboard log remains the only
   deploy-independent control channel and is still the highest-value item.**
10. **A fifth competing explanation has been added** (ad ↔ landing-page
   message-match break) and **explanation 4 (post-storm demand) has been restored
   to live** after the denominator error was corrected. See §3.

---

## 7. THE PLAN — THE CAUSE-INDEPENDENT WORK LIST (W0–W27)

**Rewritten 2026-08-31 after verification review.** Every item below was checked
against the repo, not taken from earlier drafts. **Cause-independent means correct
under EVERY live hypothesis** — a defect, a false statement, a compliance
exposure, or instrumentation. Anything that is only worth doing *if* a particular
explanation is true is in §7B, not here.

**Two items were missing from every previous version of this plan: W0 and W7.**

### Hard constraints — read before ordering anything

1. **W0 precedes every red-first gate in this list — DISCHARGED, and SCOPED.**
   This constraint applies to red-first evidence taken **against
   `verify-booking-admin-db.ts`**, which is what the sentence below is about.
   Read unqualified it would void every red row in the repository, which is not
   what it means and not what anyone checked. W5–W7, W18, W20 and W23–W26
   all red-first against `verify-booking-admin-db.ts`, whose fixture strands rows
   on any interrupted run and then crashes the next one **silently** — CLAUDE.md's
   crashed-script trap, failing in the reassuring direction. **Every "red-observed"
   logged before W0 is worthless evidence.**
2. **W5/W6 precede W18.** Not because of §3C's falsifiability — the cause is
   declared unrecoverable — but because **W18 is the only item with a measurable
   forward effect on the funnel, and without events live there is no baseline.**
3. **W3 precedes W21.** Editing an ad asset can clear or change its policy state.
   **Read the policy/billing status first or you destroy the evidence.**
4. **W2 is READ-ONLY and must stay read-only.** Editing a service-area GBP
   frequently *triggers* suspension (§3E).
5. **W20 + W21 ship the same day, atomically** — the mechanism is the *gap*
   between ad and page. Within W20, the copy edit and the `verify-cutover.ts` pin
   are **one commit**: pin first and the build goes red; copy first and there is
   an unpinned window.
6. **Nothing that moves the call channel or the conversion counts may land in
   W20/W21's window.** That bars W13 **and W7** — W7 changes Ads conversion
   *counts*, the exact series W20/W21 are read on. **Ship W7 well before, and let
   it settle.**
7. **W23 precedes W26.** Reschedules happen off-system; a reminder on a
   phone-rescheduled slot tells a real customer the wrong time.
8. **W1 precedes W4** — the client reads them together.
9. ~~**W15 is time-boxed** — `#38` holds a real **Sep 6** slot.~~ **DONE
   2026-09-02, and the premise was false: `#38` was the user's own test, not a
   customer. Cancelled through the panel.**
10. **W9 precedes W5/W6's verification artifact** (GA4 DebugView).

### Tier 0 — method integrity

- [ ] **W0 · Make `verify-booking-admin-db.ts` idempotent against its own
      wreckage.** Cleanup predicate at 393/4384; the fixed probe literal
      `cs_test_cronprobe0001` at 2069 causes the exact 23505 collision CLAUDE.md
      records. **Light** (harness only — say so in the ticket, since it gates
      public write paths). **Ticket: yes** — the ROADMAP already says "owner
      unassigned" twice. **Artifact:** two consecutive full runs from a dirty
      database, both exiting 0 and both printing the summary line — **never a
      marker count.**

      **DONE — BK-49, committed `22418dc` on 2026-08-31** (implementation review
      0 blockers / 5 should-fix / 6 nits, all resolved); 8 red rows; typecheck 0,
      build clean, 23/23 verify scripts green. **Committed and PUSHED — LIVE.** *(This read "not pushed" until 2026-09-02; verify with `git branch -r --contains 22418dc`, never from this line.)* — no
      production code, so it rides with the next release. **The box is left
      unticked deliberately: this file's own rule is that a box is read by its
      body, and the body below is what a next session must act on.** Four
      corrections to this item as written:

      1. **One fixed literal was named; there are nine**, and the collision is
         only the third-worst of the five findings.
      2. **The artifact above is not sufficient and was replaced.** Two runs from
         ONE dirtying passes for the wrong reason — the first run consumes the
         wreckage (it expires the strays, and a `payment_expired` row cannot be
         swept twice), so the second is green regardless. Each failure mode is
         now dirtied separately, and the summary line carries a **check count**
         so a truncated run is visible even when it exits 0.
      3. **The defect was live, not latent.** The dev branch held **34** stranded
         rows from two interrupted runs; a full suite ran over them, exited 0,
         printed `✓ admin write-path checks passed`, and left all 34 — while its
         own leftover check said `0 seeded row(s) survived cleanup`, because that
         check reads the same predicate the cleanup deletes by.
      4. **A crash now exits 2, not 1.** Previously a crash and a failure were
         the same code and a crash printed no summary at all — so exit code alone
         could not separate them either. Any harness reading this script must
         read `(exit code, summary line)`.

### Tier 1 — false statements and live-channel health (read-only or near-zero risk)

- [ ] **W1 · Republish or retract the stale client-facing artifact.** It carries
      the **withdrawn** "calls held flat" reading to a client. **Reviewed**
      (client-facing). **Artifact:** the republished page read back — not the
      publish call succeeding.
- [ ] **W2 · Google Business Profile: Performance (6 months, day-level) + account
      / suspension status. READ-ONLY.** A suspended or de-ranked profile is a
      live revenue defect **now**, regardless of Aug 16. Repo corroborates it was
      never connected: no GBP link, no `sameAs`, no `aggregateRating`
      (`seo.ts:132-134`, `Footer.astro:54`, `TestimonialsSection.astro:2-5`), and
      §3A's `Local actions – Directions` sits at 0.00 / "Awaiting conversions".
      **Take the health check as cause-independent; the six-month baseline it also
      yields is diagnostic and must not reopen the ranking war (R4).**
- [ ] **W3 · Open Ads Policy Manager and billing status. READ-ONLY. Before W21.**
      A disapproved asset or limited-serving action leaves **no change-history
      row**, so §3A's "no human change after Aug 9" does not cover it.
- [ ] **W4 · One client message — records half only.** All twenty Interac payment
      **dates and amounts**; **jobs actually completed** Aug 1–31 against the 15
      rows; whether the Aug 15–17 `Elapsed` rows misstate outcomes as `#37` did;
      whether `#38`'s **customer** confirmation arrived. *(The switchboard log,
      the insured/self-pay split and the service mix are business inputs to §8 —
      ask for them as that, or they will be read as diagnosis.)*

### Tier 2 — instrumentation (must precede any funnel change)

- [ ] **W5 · `booking_submit_blocked` with the failing field.**
      `BookingForm.svelte:506-515` already computes `found` and `target` — **one
      `gtag` line.** The island currently emits **zero** funnel events (verified).
      **Reviewed** (public write path; an Ads conversion on an unpaid booking is
      irreversible). **Artifact: a real event in production GA4 DebugView.** A
      green `astro dev` discharges nothing.
- [ ] **W6 · The other five funnel events.** Same file, tier, artifact. **One
      event name only — do not ship both `booking_submit_blocked` and
      `booking_validation_error`.**
- [ ] **W7 · Fix the Interac / on-site conversion blind spot. MISSING FROM EVERY
      PREVIOUS PLAN.** The Ads conversion is keyed on the Stripe checkout session
      and reached only from the Stripe redirect, so **every Interac or on-site
      payment fires nothing, permanently.** With twenty Interac payments and zero
      real Stripe payments this is **the largest live signal loss in the account —
      larger than the two dark actions W8 re-arms.** **Reviewed** (irreversible;
      must not fire on an unpaid row). **Artifact:** `Assessment booked`'s "last
      fired" moving after a real admin Interac mark-paid — which also discharges
      §10's "has it ever fired for a known booking".
- [ ] **W8 · Re-arm `Request quote` + `Assessment booked`; configure Enhanced
      conversions; record the defect in the ROADMAP's Known traps.** `Request
      quote` went dark **Aug 11 — before the collapse.** **Verified: the
      Known-traps entry §7 instructed does NOT exist — that obligation is
      undischarged.** **Artifact:** the action leaving *Misconfigured* **and** a
      tag ping recorded. **Re-arming is a configuration change and is not evidence
      of its own effect** — do not close on the config screen.
- [ ] **W9 · Re-authorise GA4** (`invalid_grant`). Blocks W5/W6's artifact.
- [ ] **W10 · Confirm `expire-payments` executes — from Vercel cron logs, not row
      counts.** "Zero `payment_expired` rows" is load-bearing in §1. Check
      `cleanup-uploads` while there.
- [ ] **W11 · Verify the CUSTOMER confirmation email delivers, end to end.**
      Under prepay the funnel runs submit → office → **email with payment link** →
      pay; degraded deliverability kills it **with no row and no complaint.** §3B
      established the *office* notice is 4/4; the customer side never was.
      **Reviewed** (PII). **Artifact:** a real message in a real non-Gmail inbox,
      headers included.
- [ ] **W12 · Exercise the photo-upload handshake on a REAL DEPLOY.** Photos gate
      every booking (`create.ts:133-146`) and the token handshake has never been
      exercised. **CLAUDE.md's BK-34a trap applies directly** — the URLs carry a
      token and a filename, and `astro dev` does not exercise the Vercel route
      table. **Artifact: a preview-deploy `curl` of a real token URL, or a real
      file landing in Blob from a real phone.**

### Tier 3 — compliance and records

- [ ] **W13 · Open the artifact: does `#38`'s confirmation email carry the GST
      registration line for its non-zero Interac amount?** Code says it should
      (`booking-email.ts:413` → 564/623), **but per BK-48 a code reading closes
      nothing. Open the email.**
- [ ] **W14 · Determine whether ANY GST-compliant artifact exists for the twenty
      Interac payments.** *Determination only* — retroactive remediation is a
      client + accountant decision (§7B). **Artifact:** a per-payment table —
      payer, date, amount, artifact-or-none.
- [x] **W15 · DONE 2026-09-02 — and its premise was wrong.** The user cancelled
      `#38` through the admin panel, as required. **`#38` was the USER'S OWN
      end-to-end test, not a real customer** — so the framing carried by this
      item and by three other places in these documents ("a *real* Sep 6 slot",
      "time-boxed", "money to return") was false. **No customer was affected and
      there is no money to return**, which also retires the *"prove it with an
      Interac inbox search for $658.88 dated Aug 31"* instruction attached to
      this item elsewhere.
      **Artifact: NOT captured** — the ICS recipient was the user, and the slot
      is their own. Per CLAUDE.md this item is therefore *closed on the user's
      direct report*, not on an observed artifact; recorded plainly rather than
      logged as though an artifact existed.
- [x] **W16 · Correct the stale "not deployed" claims — DONE 2026-09-01.**
      As written this item described **one** entry and named the **wrong**
      commit. Both were undercounts, and the item is recorded here in corrected
      form so the next session does not re-derive the original scope.
      **The claim spanned two tickets across a dozen sites**, all now fixed:
      `ROADMAP.md`'s BK-44 Known-trap entry and its retired operational
      workaround; the BK-44/45/46/BK-33 rows of the P9 ticket table; the "BK-45
      … alongside BK-44" line; three paragraphs of the P9 rollout prose
      ("BK-45 is in the same state", "Neither is deployed either"); the "What is
      still TEST MODE" paragraph and the "a real live booking has never been
      made" item, both of which contradicted text a few lines below them; the
      BK-33 Known-trap entry and its "inert in production" half; and the
      `Status:` lines of `tickets/BK-44.md`, `BK-45.md` and `BK-46.md`, which
      CLAUDE.md makes the canonical record.
      **Commits:** code shipped in `7114aa5` + `77ad0f6` (BK-44), `e5c2d9d`
      (BK-45), `e04ba21` (BK-46), deployed 2026-08-20 by fast-forward to
      `8854dd7`. **`6ff41e2` is the rollout DOCUMENTATION commit** — it touches
      only `ROADMAP.md` — and both places in this file cited it as the code.
      BK-33 deployed 2026-08-22 (`4a9b548`) and remains **open, pending an
      artifact**; its entry now says deployed and not-closed in one sentence.
      **Method note for the next session:** the four line numbers this file and
      the READ FIRST block enumerated had all drifted ~13 lines and none
      resolved. **Grep the claim, not the entry, and cite sections not line
      numbers.**
- [x] **W17 · Record the dated confounds — DONE 2026-09-01, and there is ONE,
      not two.** Verified against Google's Search Status Dashboard, because
      **neither date had a cited source** and CLAUDE.md forbids taking external
      behaviour from recall.
      **Confirmed:** the **August 2026 spam update**, start **18 Aug 2026**,
      2 days 16 hours, completing ~21 Aug — covering **three of the Aug 17–20
      clean window's four days**. Now recorded in "Standing caveats on the clean
      window", which is what W18/W20/W21 actually read; recording it only in its
      own section was the propagation half this item would otherwise have missed.
      **STRUCK:** the "August 2026 core update from **Aug 26**" **does not
      exist** — no such update on the dashboard summary or its full history,
      which lists 2026 as Feb Discover, Mar spam, Mar core, May core, Jun spam,
      Aug spam. The nearest real thing is the **August 2025 spam update, start
      26 Aug 2025**. **There is therefore no known September contamination for
      W18/W20/W21 to discount against** — do not reinstate it, and if a core
      update is announced later it is a new confound with a new date.
      Source: <https://status.search.google.com/products/rGHU1u87FJnkP6W2GwMi/history>

### Tier 4 — defects on the surfaces

- [ ] **W18 · Scroll to step top on change; scroll first error into view on failed
      submit.** A form that swallows its only error is a defect regardless of
      cause; reproduces on **WebKit**, the engine iPhones use. **Light ONLY if it
      changes no validation or step-routing logic — and `firstErrorAnchor()` does
      not exist yet, so extracting it IS touching that code. Expect Reviewed.**
      *(a) the gate:* `firstErrorAnchor()` in `booking-form.ts`, asserted in
      `verify-booking-form.ts` to return the **files** anchor, not `terms_ack`;
      **log the exit code and summary line, never a marker count.**
      *(b) the pixel half — NOT a gate:* a real **390×844 WebKit** before/after
      screenshot pair. "A scroll call was added" is a configuration change.
      **Folds in §10's "has anyone ever booked on a phone".** Confound sign:
      **increases** bookings.
- [ ] **W19 · `.cta-secondary` tap target** (`global.css:268-271` — verified: no
      padding, ~20px vs the 44px minimum). **Own commit, multi-page visual check**
      — §10 records BK-42 changing a sitewide rule and verifying only the homepage.
- [ ] **W20 · Remove "no obligation" from `[service].astro:79` AND add that file
      to `verify-cutover.ts`'s banned list, pinning `/no[\s-]obligation/i` — ONE
      ticket, ONE commit.** False under the credit model on six paid landing
      pages. **Verified: the sitewide grep in both grammars returns exactly one
      live surface**, and the existing pin's two-file scope
      (`verify-cutover.ts:469`) excluded the paid pages — **copy-inventory trap,
      fourth instance.** **Reviewed.** Confound sign: **cannot affect clicks**
      (clicks happen on the ad); it affects conversions per click.
- [ ] **W21 · Strike "free" / "no-obligation" from the two Ads description assets.
      Same day as W20, nothing else touched.** A broader creative rewrite is out
      of scope — it restarts PMax asset learning.
- [ ] **W22 · Disclose that a travel fee may apply beyond 30 km, before payment.
      UNTICKETED until now.** `#38` proves it is real (57750 → 65888 = CA$50 +
      GST); the terms copy's own comment concedes the form price is *"false for a
      job beyond 30 km."* **Disclosing that a fee may apply needs no client
      decision; naming the amount does.** **Reviewed.**

### Tier 5 — what the office actually does (the records emergency)

- [ ] **W23 · Admin reschedule.** Reissues an ICS under the same UID; touches
      `UNIQUE(slot_start)` and §9's shared invite guard
      (`booking-status.ts:353-368` — **one block protecting two rules; the natural
      edit reopens BK-33's refund hole**). **Reviewed.** Blocks W26.
- [ ] **W24 · Admin mark-completed.** No such status exists — which is why `#37`
      reads `declined`. **Reviewed.**
- [ ] **W25 · A compliant receipt on the existing Interac mark-paid path.**
      Mark-paid exists (BK-32); the **receipt** is the gap. **Do NOT route through
      `approveFree`** — §9's trap, BK-48's exact pattern. **Reviewed.**
- [ ] **W26 · Appointment reminder email — after W23 only.** `REMINDER_LEAD_HOURS`
      is read by nothing, yet `reminder_sent_at` renders at `[id].astro:1036`.
- [ ] **W27 · Decide the SMS consent checkbox: build the channel or stop asking.**
      `sms_consent_at` is collected as CASL consent and **no SMS provider exists in
      `package.json`.** Collecting consent for a channel that does not exist is a
      false implicature. **Leaving it as-is is not a neutral option.**

## 7B. NOT CAUSE-INDEPENDENT — and what each waits on

| Item | Waits on |
| --- | --- |
| **Re-deriving the switchboard decision rule** | **Nothing — it is DEAD.** Pure cause-recovery, superseded by §3's "the cause is not recoverable". Delete it, do not schedule it |
| `created_at` to the hour vs `df53210` | Pure diagnosis; identifiability item 4 says it is permanently inseparable. Cheap, but not work |
| Google Trends, Search Console, the day-level `Assessment booked` split, the device split of the 9 | Pure diagnosis. **Rainfall is DONE — do not re-run.** R3/R4: narrow the prior, then **stop** |
| Retroactive receipts for the twenty payments | Client + accountant. **The determination (W14) does not wait** |
| The travel-fee **amount/schedule** | Client decision. **The existence disclosure (W22) does not wait** |
| Call bar on `/book/` | **Not a defect — `/book/` already carries two `tel:` links** (`book.astro:86`, `:155`). An EV bet that confounds the call channel; waits on W20/W21's window closing |
| $399/$699/$1,199; deposit; free triage lane; photos required-vs-requested; hours; the weekend 1.5× | §8 client decisions. **Do not pre-build** — §9's `approveFree` trap |
| `PAYMENT_WINDOW_HOURS` 3:58 a.m. deadlines | Client decision |
| Alberta prepaid-contracting licence; GST on deposits | Lawyer; accountant |
| Ads bidding / budget / tCPA; broad creative rewrite; BK-47 | DO-NOT list unchanged. BK-47 is **outranked by Tier 5, not blocked** |
| Job list split insured/self-pay; carrier call record; service mix | Valuable — **as business inputs to §8's pricing, not as diagnosis.** Say so, or they reopen the ranking war |

---

## 8. OPEN QUESTIONS — CLIENT

1. **Is $399 / $699 / $1,199 staying?** Their "competitive as per the market"
   belief does not survive §5. They said they are flexible and asked for a
   recommendation.
2. **Deposit instead of the full fee, and at what number?** ~$99–$149. Note it is
   a copy change, not a config change (§6.3).
3. **A free triage lane?** *Free 20-minute visit + one-page findings sheet, paid
   documentation package if they need the real document.* This is the client's
   own "we'll call them" idea in a stronger shape, and it is the **lead
   recommendation** — it restores the free entry point the market expects,
   keeps the paid product for the buyer who needs a document, and at 30 empty
   slots a week it costs almost nothing to run.
4. **Photos: required, or requested?** Correct their belief that it is not built.
5. **Weekday hours and the weekend 1.5×.** 11:30–15:30, Fridays closed = 30
   slots/week, a hard ceiling. The grid routes the customers most able to pay
   into the most expensive price. Inspection trades do not use a 50% multiplier
   on a pre-booked daytime slot.
6. **How much of the work is happening outside the panel, and what should the
   system be recording?** The panel shows **39 leads, 36 marked `new`**, and shows
   `#37` as `declined` — **but `#37` was completed.** The panel under-records
   reality, so this is a question about **what the software fails to capture**,
   not an accusation about the desk. Ask: which of these were phoned; what were
   the twenty Interac payments were for (§3D dates them); and what did the reschedule of
   `#37` look like? **The three actions the office performs daily and the system
   cannot record — reschedule, mark paid by Interac with a compliant receipt, and
   mark a job completed — are a software gap, and `#37` is the proof.**
7. **Do any Edmonton competitors they respect charge for an assessment?**

Also still open from before, unchanged: partial refunds cancelling bookings,
Interac/on-site refunds recorded nowhere, `PAYMENT_WINDOW_HOURS` landing
deadlines at 3:58 a.m., and the insurance-credit wording.

---

## 9. IMPLEMENTATION TRAPS

- **`verify-cutover.ts`'s `ONSITE_PAYMENT_SHAPE` will go red** on any "balance
  payable at the visit" wording — it was written across five surfaces
  specifically to prevent this reversion, with the failure message *"the
  pre-prepay claim, which must not survive the flip by even one deploy."*
  Re-scope it in a ticket; do not quietly edit. Then grep the claim across
  `src/` in **both** grammars, per CLAUDE.md's copy-inventory trap.
- ⚠ **PARTLY WITHDRAWN 2026-09-02 — see `ROADMAP.md` Known traps for the full
  resolution. The mechanism below is right; the conclusion no longer binds.**
  Decision 1 makes the assessment free, so no money is taken at the visit for it,
  and job billing is deferred entirely to the future quotes/invoices workflow
  (decision 9), outside this repo. **The half that DOES still bind: revenue views
  read zero.** BK-51 has made `approveFree` the default and shipped (committed,
  not pushed). ~~**Do not make `approveFree` ($0 approval) the default** no-payment path.~~ Every
  such row records `payment_status='paid'`, `paid_amount_cents=0` — revenue views
  read zero — and the GST registration line is suppressed when there are no
  amounts (`booking-email.ts:557-566`). If money is then taken at the visit,
  **the system produces no GST-compliant artifact for a supply over $30.** This
  is BK-48's exact failure pattern.
- **The invite guard is one block protecting two rules**
  (`booking-status.ts:353-368`). The `paid_at` check and BK-33's refunded check
  live together. Deleting the block to relax prepay also reopens the refund
  hole — dispatching a crew on money already returned. **The natural edit is the
  wrong one.**
- **Copy changes are Reviewed-tier**, touching public write paths and
  customer-facing pricing. Tickets, gates and fresh-agent review — not `sed`.

---

## 10. UNVERIFIED / STILL UNCHECKED

Named honestly so nobody treats them as done:

- Whether the `expire-payments` cron is **actually executing**. "Zero
  `payment_expired` rows" may be a statement about the cron, not about customers.
- Whether Resend is still delivering the customer confirmation and the office
  notice. **Partly answered 2026-08-31 (§3B): the office notice is 4 for 4 under
  its current `NEW REQUEST #` subject, including today.** The customer
  confirmation is still unverified, and the Aug 10–16 window cannot be audited by
  that search because the subject line appears to predate Deploy 2. Under prepay the funnel is submit → office → **email with payment
  link** → pay. Degraded deliverability kills it silently with no row and no
  complaint.
- Whether a photo upload **completes** today. Endpoints answer
  (`/api/booking/draft/` 200, `/api/booking/upload-token/` reaches Blob), but the
  full client-token handshake was not exercised.
- Whether anyone has completed a booking **on a phone**. Most emergency
  restoration traffic is mobile; the form is a three-step wizard with a file
  picker.
- How "developer test row" was decided — the Aug 10–16 count depends on it, and
  since §3A so does the clean-window comparison. ~~**#37's provenance is
  unknown**~~ — **RESOLVED 2026-08-31 (§3D): a real enquirer (lead Aug 20), a real
  booking (Aug 23), a COMPLETED job, paid Aug 25 and Aug 30. The `declined` status
  is wrong.** ~~The ROADMAP still flags it as unconfirmed; update it there
  too.~~ **DONE 2026-09-01 (W16)** — `ROADMAP.md`'s `#37` entry now records the
  confirmed provenance, and notes that the decline path remains untested in
  production because the outcome the row states did not occur.
- **Whether `Assessment booked` ever fired for a known booking.** Nine database
  bookings against seven Ads conversions in Aug 10–16 (§3A) is unexplained.
- **Whether Ads conversions are click-dated or conversion-dated** in each surface.
  §3A infers click-dating from a contradiction between the daily table and the
  action detail page; it is inferred, not documented.
- **The click-to-booking lag distribution** for the 9 known bookings — needed to
  size §3A's truncation bias.
- **The day-level `Assessment booked` split**, one segment away in the same UI,
  which would settle how much of the baseline rests on Aug 10 alone.
- **Whether the confirmation email for a non-zero Interac payment carries the GST
  registration line** (§3A, the Interac blind spot).
- **Whether ANY GST-compliant artifact exists for the twenty Interac payments (§3D).**
  **This is compliance exposure, not measurement** — BK-48's pattern recurring
  with real customer money. Escalate; it need not wait for Step 1.
- **How many August jobs have no `appointments` row at all**, and whether the
  Aug 15–17 `Elapsed` rows also misstate their outcomes the way `#37` did.
- ~~The dates and amounts of the two Interac payments~~ **RESOLVED 2026-08-31
  (§3D): there are TWENTY, 13 in August, and the ledger dates them. What remains
  unknown is which JOB each belongs to and whether any produced a GST-compliant
  artifact.**
- **`created_at` to the hour for the Aug 16 booking**, against the `df53210`
  deploy at 10:23 MT. Now more important, not less: if it landed after 10:23, six
  further commits from that evening enter scope (see §3).
- Whether BK-42's fix broke anything else. It changed `.cta-primary`'s
  `transition-property` in `global.css` — a sitewide rule — and was verified on
  the homepage only.

---

## 11. TOOLING STATE (2026-08-31)

- **Claude in Chrome is broken.** Every `navigate` returns *"Could not verify this
  site's safety category."* — including `example.com`, so it is not per-site.
  `tabs_context_mcp` works, so the bridge is alive. Verified by curl that
  `api.anthropic.com/api/web/domain_info/browser_extension` **is reachable and
  returns HTTP 401 demanding an OAuth bearer token** — so this is an auth failure
  on the classification call, not an outage and not a network block. The
  extension's side panel authenticates fine. Unconfirmed contributor: the MCP tab
  group may live in a different Chrome profile from the signed-in one (extension
  storage is per-profile; this machine has ~40 profiles). Feedback drafted.
- **Playwright now works, headed.** The `--headless` removal took effect; a
  visible Chrome (verified by process inspection — no `--headless` flag) drove
  the whole Ads pull on 2026-08-31. Its profile is persistent
  (`~/Library/Caches/ms-playwright/mcp-chrome-6dfe619`), so the sign-in should
  survive.
- **Google Ads profile: settled.** The account is owned by
  **angularbrackets.web@gmail.com** (`Profile 3`). The `Profile 29` /
  "YEG Restoration" ambiguity is closed.
- **Three Google Ads UI traps, for whoever pulls next.** (a) The **Day** segment
  is silently *disabled* on the campaigns table for ranges longer than ~7 days —
  no message, the menu item is just greyed. The month was pulled in five ≤7-day
  chunks and summed. (b) **Changing the date range drops the active segment**, so
  the segment must be re-applied after every range change. (c) Toast banners
  intercept clicks on the date control and must be removed from the DOM first.
  **Report editor is a Dart/canvas app and cannot be scraped at all.**
- **CDP fallback:** Chrome 151 refuses `--remote-debugging-port` against the
  default user-data-dir (Chrome 136+ security change). That route needs the
  profile copied to a separate directory first.
- **GA4 MCP** returns `invalid_grant` — needs re-auth.
