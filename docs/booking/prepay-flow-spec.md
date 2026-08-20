# Prepay flow — audit and spec (client direction, 2026-08-16)

**Status: audit-and-spec, folded into the ROADMAP and the tickets.** This
document is the audit output for the client-confirmed flow change. It supersedes
P7 and P8 decisions where they conflict; every conflict is named in §6 rather
than silently resolved.

**Read §8 first.** On 2026-08-18 a second, independently-written spec arrived
from outside the repo and was merged in, together with a batch of new client
answers. §8 records what changed and what in the sections below is now stale.
**Where this document and `ROADMAP.md` §P9 disagree, the ROADMAP wins** — it
carries the later decisions.

**The target flow:**

```
submit request ──▶ pending_review ──▶ approved_awaiting_payment ──▶ confirmed ──▶ completed
   (photos req'd)      │  hold             │  hold                     │  hold        │ hold
                       │                   │                           │              │
                       ├─▶ declined        └─▶ payment_expired         ├─▶ cancelled  └─▶ no_show
                       │   (release)           (release)               │   (release)      (hold)
                       │                                               │
              request-received email          payment-link email    "you're booked" + ICS + SMS
              (no ICS, no "booked")           (deadline stated)     reminder eligibility starts
```

---

## 1. Audit — current state vs. target

### 1.1 Status model

| | Value | Where |
| --- | --- | --- |
| **Live today** | `booked` \| `completed` \| `cancelled` \| `no_show` | `db.ts:52`, CHECK in `002-booking.ts:40`, `booking-admin-entry.ts:53` |
| **BK-23 planned** | adds `pending`, `declined` | ROADMAP P7, migration 006, not started |
| **Target needs** | `pending_review`, `approved_awaiting_payment`, `confirmed`, `completed`, `cancelled`, `no_show`, `declined`, `payment_expired` | — |

Three places hold the enum and all three must move together:
`db.ts`'s `AppointmentStatus`, the DB `CHECK`, and
`APPOINTMENT_STATUSES` in `booking-admin-entry.ts` (which is what the admin
edit dropdown renders and validates against).

**Recommendation: rename `booked` → `confirmed` rather than reuse it.** Under
prepay, "booked" is the word for the thing that has *not* happened yet — a
request is booked-looking to the customer and unpaid to us. Leaving the old
value in place invites exactly the confusion the flow exists to remove. The
rename is a one-time `UPDATE appointments SET status='confirmed' WHERE
status='booked'` inside the same migration that swaps the CHECK. Nothing keys
off the literal `'booked'` in a way that survives the rename un-audited —
`update.ts`'s boundary logic keys on `'cancelled'`, not on `'booked'`.

`P7`'s `pending` becomes `pending_review` and its `declined` carries over
unchanged.

### 1.2 The partial unique index — which statuses hold a slot

Live today: `CREATE UNIQUE INDEX appointments_slot_unique ON appointments
(slot_start) WHERE status <> 'cancelled'` (`002-booking.ts:74`).

**Decision (proposed, needs no client input — operational):**

| Status | Holds slot | Why |
| --- | --- | --- |
| `pending_review` | **hold** | Else two applicants race for the same slot while the office reviews. P7 already settled this. |
| `approved_awaiting_payment` | **hold** | The whole point of a deadline is that the slot is reserved until it lapses. |
| `confirmed` | **hold** | — |
| `completed` | **hold** | Past visit. Releasing it would let a new booking overwrite history at that instant. |
| `no_show` | **hold** | Same: the crew went, the slot was consumed. |
| `declined` | **release** | Office said no; the time is for sale again. |
| `payment_expired` | **release** | Deadline lapsed; the time is for sale again. |
| `cancelled` | **release** | Unchanged. |

Predicate: `WHERE status NOT IN ('cancelled', 'declined', 'payment_expired')`.

**Deny-list, deliberately, not `status IN (...)`.** A status added later and
forgotten defaults to *holding* under a deny-list — the failure is a slot that
looks busy, which someone notices and nobody gets hurt by. Under an allow-list
the same omission silently *releases*, and the failure mode is a double-booked
crew. Write this reasoning into the migration comment; it is the kind of thing
a later "tidy-up" reverses.

**Four sites must change in lockstep, and one of them will hard-fail if
missed:**

| Site | Current | Note |
| --- | --- | --- |
| `002`→new migration | index predicate | drop + recreate |
| `booking-commit.ts:74` | `ON CONFLICT (slot_start) WHERE status <> 'cancelled' DO NOTHING` | **Postgres requires the `ON CONFLICT` predicate to match the index predicate for the arbiter to resolve.** A mismatch is error 42P10 on *every* booking, not a subtle drift. |
| `create.ts:103` | availability precheck | courtesy check; drift = wrong message, not wrong data |
| `availability.ts:47` | public calendar query | drift = offering a held slot |

Plus five verify scripts that assert against the literal (`verify-booking-smoke`,
`verify-booking-commit`, `verify-booking-admin-db` ×3, `verify-availability`).
Extract the predicate into one exported SQL fragment or one documented constant
so the next change has one site, not nine.

### 1.3 Terms wording — every render surface

One source: `src/lib/booking-copy.ts`, constants `FEE_TERMS_HEADING`,
`FEE_TERMS_INTRO`, `FEE_TERMS_ITEMS`, `FEE_TERMS_OUTRO`, `FEE_TERMS_ACK_LABEL`.

Four files, five surfaces:

| File | Surface |
| --- | --- |
| `src/pages/book.astro` | `/book/` terms box |
| `src/sections/ContactSection.astro` | homepage booking section |
| `src/components/BookingForm.svelte` | step 3 terms box + required ack checkbox |
| `src/lib/booking-email.ts` | confirmation email, HTML **and** plaintext arms (two renders, one file) |

Pinned by `scripts/verify-cutover.ts:311–478` (constant-usage pins, a
"no obligation" contradiction pin, and two "free assessment" grammar pins) and
by `scripts/verify-booking-email.ts` (asserts the figures and `+ GST` survive).

**Everything in the fee block is invalidated by prepay — this is a rewrite, not
a patch:**

| Constant | Current text | Why it dies |
| --- | --- | --- |
| `FEE_TERMS_INTRO` | "paid at the end of the visit" | False. Paid before the visit, on a link. |
| `FEE_TERMS_OUTRO[0]` | "Nothing is charged when you book. Tell the tech on the day which of these you want." | Both halves false — a charge is coming, and the tier is chosen on the form (BK-31). |
| `FEE_TERMS_OUTRO[1]` | "It is not refundable if you decide not to go ahead." | Becomes a policy placeholder, **and** it currently ends the block on a forfeiture clause, which the new direction forbids. |
| `FEE_TERMS_ITEMS[1..2]` | tier descriptions | $699/$1,199 need the adjuster-documentation framing. |
| `FEE_TERMS_ACK_LABEL` | "I understand the assessment terms above." | The ack now covers a real charge; say so. |

**Two more surfaces outside the fee block are also invalidated,** and neither is
in BK-27's inventory:

- `src/pages/book/confirmed.astro:8` — meta description "Your on-site
  restoration assessment is booked."
- `src/components/BookingConfirmation.svelte:59` — `<h1>You're booked</h1>`

Both render at *submission* time. Under the new flow submission produces a
request, not a booking. `BOOKING_CONFIRMED_PATH = '/book/confirmed/'`
(`booking-config.ts:160`) becomes a misnomer; keep the URL (it is live and may
be linked) and change what the page says, or add `/book/received/` and leave
`/book/confirmed/` for the post-payment landing. Recommend the second: the
Stripe `success_url` needs a landing page anyway, and reusing the existing
confirmed page for it is the smaller diff.

`CALENDAR_ATTACHED_LINE` must not appear in the request-received email.

### 1.4 Calendar invite / ICS — must move to confirmation time

Today the ICS is built and attached at commit, in two places inside
`planBookingNotifications`:

- `booking-email.ts:308` — customer confirmation, `buildBookingIcs(..., 'request', ..., icsCustomer(email))`
- `booking-email.ts:440` — internal notification, `buildBookingIcs(..., 'request', ..., ICS_OFFICE)`

Both are reached from `create.ts:215` on the commit path. The cancel/restore
invites (`booking-admin-notify.ts`, `update.ts`'s cancelled-boundary logic) are
separate and stay where they are.

**Customer ICS moves to the payment-confirmed moment.** Non-negotiable — an
invite for an unpaid slot is the exact "you're booked" claim the flow removes.

**Office ICS: recommend it moves too.** If it stays at request time the office
calendar fills with slots that may be declined or never paid, and the CANCEL
that would clear them has no trigger on the decline/expire paths (declined rows
never had a booking, so P7 already decided they get no CANCEL ICS). The office
sees pending requests in the admin queue and in the internal email; the
calendar should carry only real visits. **This is a change to P7's implied
behaviour — flagged in §6.**

The internal "new request" email still fires at submission, without an invite.
That is the message the office reviews from, and BK-24 hangs its
Approve/Decline buttons on it.

### 1.5 ⚠ Resend idempotency prefix will silently eat the new emails

`booking-notify.ts:186` and `:244` both do
`createResendSender(apiKey, \`booking-${plan.bookingId}\`)`, and
`createResendSender` sends `Idempotency-Key: ${keyPrefix}:${message.to}`
(`:117`).

Under the current flow one booking sends the customer exactly one message, so a
fixed per-booking prefix is correct. **Under the new flow one booking sends the
same address up to four messages** — request-received, payment link,
confirmation, and decline-or-expiry — all with the byte-identical key
`booking-<id>:<their@email>`. Resend collapses every message after the first
into a duplicate of the first and returns success. The customer gets
"we have your request" three more times and never sees the payment link, and
nothing in any log says so.

This is the same defect class BK-16 already caught and fixed on the calendar
side — `inviteIdempotencyPrefix(id, kind, now)` at `booking-ics.ts:156` exists
precisely because a fixed prefix collapsed CANCEL into REQUEST. **The
notification path needs the same treatment**: the prefix must carry the
lifecycle transition, e.g. `booking-<id>-request` / `-payment` / `-confirmed` /
`-declined` / `-expired`. Retries within one transition still collapse, which is
what the key is for.

Treat as a blocker on BK-23, not a follow-up. It is invisible in dev
(`BOOKING_NOTIFY_DISABLED` mutes the sender entirely) and invisible in
production logs.

### 1.6 Reminder SMS cron — does not exist yet

There is no SMS code in the repo. `grep -rn "twilio\|sendSms"` over `src/` and
`scripts/` returns nothing. What exists is the column `reminder_sent_at`
(migration 003) and `REMINDER_LEAD_HOURS = 3` (`booking-config.ts:41`).
`vercel.json` declares one cron: `/api/cron/cleanup-uploads/`, hourly.

So "filter reminders to confirmed only" is a **constraint to write into BK-06**
(Twilio-blocked on number verification), not a change to shipped code. Record it
as an acceptance criterion there now so it cannot be missed when the number goes
live: the reminder query's `WHERE` clause is `status = 'confirmed'`, never
`status <> 'cancelled'`.

Note the interaction: `REMINDER_LEAD_HOURS = 3` sits *inside* the proposed
payment deadline of slot−4h. A row still unpaid at slot−4h is auto-cancelled
before the reminder window opens, so the two never collide — but only because
of the specific numbers. If either moves, re-check.

### 1.7 Phone bookings — photos genuinely never attach

Confirmed. `src/pages/admin/appointments/new.astro` has no file input. The
entire upload path is draft-scoped: `/api/booking/draft/` mints a signed
`draftId`, `/api/booking/upload-token/` writes an `appointment_files` row with
`appointment_id NULL` under that draft's pathname prefix, and `insertBooking`
claims those rows by `draft_id` at commit time.

A phone booking runs the other way — the appointment row exists first, so there
is no draft to claim. The upload token needs a second shape scoped to an
appointment id. Spec in §4.

The Blob store is private and enforces at store level; reads go through
short-lived presigned URLs (`booking-files.ts`). That property must survive the
new path — an SMS'd upload link authorizes *writes* to one appointment's prefix
and must never confer reads.

### 1.8 Admin form — current defaults

- Email: `<input type="email" name="email">` at `new.astro:140`, optional, no
  warning. `parseBookingPayload` requires email only when `entry === 'public'`
  (`booking-payload.ts:186`); `parseAdminEntry` hard-codes `entry: 'admin'` and
  the type forbids callers overriding it (`booking-admin-entry.ts:214`). The
  exemption is structural and correct — it just has no nudge attached.
- Send-confirmation: `<input type="checkbox" name="send_confirmation" value="1"
  checked>` at `new.astro:236` — **already defaults ON**. Read via
  `checked(raw.send_confirmation)`; unticking is currently silent.
- SMS consent: unchecked by default, deliberately (CASL — the stamp *is* the
  consent). Do not touch.

### 1.9 Service-area / distance in the review UI

Nothing exists. No geo code, no distance calc, no FSA table. `seo.ts:70` still
carries a placeholder postal code marked LAUNCH BLOCKER. Spec in §3.

---

## 2. The payment deadline, and the near-term collapse

**Rule as given:** deadline = `min(slot_start − 4h, approved_at + N h)`.

**The collapse:** live minimum notice is `MIN_NOTICE_HOURS = 4`
(`booking-config.ts:35`). A booking made at the floor has `slot_start − 4h` in
the past at the moment of submission, before the office has even opened the
email. The deadline is already lapsed when it is computed.

**Recommendation — raise web minimum notice to 24h, which is a decision the
client already made.** ROADMAP P7 records, verbatim from 2026-08-12:
*"Minimum notice moves 4h → 24h"*, assigned to BK-23. It was never implemented
because BK-23 never started. Implementing it now removes the collapse entirely
rather than papering over it: at 24h notice the deadline is at worst
`slot − 4h` = 20h after submission, which is ample for a one-hour review SLA
and a payment link.

Phone/admin entries keep the 4h floor (they are exempt from the whole gate).

So:

- `MIN_NOTICE_HOURS` → 24 for `entry: 'public'`; a separate
  `ADMIN_MIN_NOTICE_HOURS = 4` for the admin grid.
- `PAYMENT_WINDOW_HOURS` (the `N`) — **propose 12**. Approve at 9am, pay by 9pm.
  Long enough for someone at work, short enough to recycle a slot. Client's to
  overturn; it is a business-feel number, not a technical one.
- Floor guard, belt-and-braces: if the computed deadline is less than 60 minutes
  from `approved_at` (only reachable if someone lowers the notice constants
  later), clamp to `approved_at + 60min`; if *that* crosses `slot_start − 1h`,
  do not send a link — flag the row in admin as **call to collect** and let the
  office handle it by phone. One branch, and it means no future constant change
  can produce a dead link.

**The alternative, if the client refuses to move off 4h notice:** near-term
bookings pay immediately at submission, skipping both the deferred link and the
approval gate — because you cannot take money and then decline. That trades the
office's filter away on exactly the bookings the client is most worried about,
and it creates a refund-on-decline path as a routine operation rather than an
exception. Recommend against; documented here so the trade is on the record.

---

## 3. Updated ticket specs

Migration numbering: **005 is applied to production** (BK-27). ROADMAP currently
assigns 006 to BK-23; that changes — see the table.

**Superseded 2026-08-16: 006 went to BK-40 (P10, Deploy 1.5), so the numbers in
this section are all one higher now — BK-31 takes 007, BK-23 008, BK-32 009.**
The ROADMAP's P9 and P10 tables are authoritative. This is the second renumber
(§6 item 12 was the first), and the lesson both times is that a migration
number is worth nothing until it is applied: the only real one is the row in
`schema_migrations`.

### BK-31 — Assessment tier selection at booking · **prerequisite, was "planned"**

Prepay cannot ship without it: the payment link charges an amount, and the
amount comes from the customer's choice. **The "non-binding by design / the
choice can change on the day" clause in the current BK-31 row is deleted** —
the tier is binding at booking because it is what gets charged.

Scope:

- Radio group on step 3 of `BookingForm.svelte`, inside the terms box, above the
  ack checkbox (the ack label's "terms above" is a claim about page order —
  keep it true). Required; no default selection, so a customer cannot be charged
  a tier they never looked at.
- `assessment_tier TEXT CHECK (assessment_tier IN ('standard','report','sketch'))`,
  nullable — NULL is correct and permanent for admin entries and for every row
  before the migration, on the same reasoning as `terms_acked_at`.
- **Prices live server-side only**, in `booking-config.ts`, keyed by tier:
  `ASSESSMENT_TIERS = { standard: 39900, report: 69900, sketch: 119900 }` in
  cents, ex-GST. The form posts a tier *key*, never an amount. This is the
  whole defence against a tampered payload paying $1 for the sketch tier.
- Validation in `booking-payload.ts` behind the existing `entry` seam:
  required when `'public'`, optional when `'admin'`. Same shape as the
  `terms_acked_at` gate at `:249`.
- Renders: internal email, customer email, admin detail page, admin edit form
  (the office must be able to change a tier when a customer upgrades on site).
- Upgrade path: changing the tier on a `confirmed` row does **not** re-charge.
  The delta is collected on site or added to the invoice — out of scope here,
  and the admin edit must say so beside the control rather than implying a
  charge follows.

Tier: **Reviewed** (public write path, money). Migration **006**.

### BK-23 — Review lifecycle + payment handoff · **scope extended**

Was: statuses, request-received page + email, admin Approve/Decline, decline
email, 24h notice. Now additionally owns:

**(a) The payment-link step after approval.** Approve no longer sends the
confirmation — it sends the payment link. The transition is
`pending_review → approved_awaiting_payment`, and the email carries the tier,
the amount incl. GST, the deadline as an absolute Edmonton wall-clock time, and
what happens if it lapses. Confirmation + ICS move behind the Stripe webhook
(BK-32).

**(b) Escalation — owner alert on an unreviewed request as the slot
approaches.** Trigger: `status = 'pending_review'` AND
`slot_start − now < ESCALATION_LEAD_HOURS` (propose **12h**, so it fires before
the auto-decline and leaves room to approve *and* be paid — see §6 item 6, which
re-spaces all three slot-relative timers together). Fires once — needs `escalated_at TIMESTAMPTZ` as the guard, same idiom as
`reminder_sent_at`.

**Channel: email now, SMS when Twilio lands.** SMS to the owner is the client's
ask, and SMS does not exist (§1.6). Building the trigger against an email send
today means the escalation is live immediately and BK-06 swaps the transport
later. Do not block this on the number.

Note the interaction with P7's existing auto-decline timer (§6, item 6): two
timers now run against `pending_review` and they must not both fire.

**(c) Service-area / distance visibility in the review UI.** The office is
deciding approve/decline partly on "is this even in our area", and today the
admin detail page shows a raw address string.

Recommendation — no API, no key, no cost, no PII leaving the box:

1. A curated FSA table in-repo (`src/lib/service-area.ts`): the first three
   characters of the postal code → zone label (`in-city` / `metro` /
   `out-of-area` / `unknown`). Edmonton FSAs are `T5*`/`T6*`; surrounding
   (St. Albert `T8N`, Sherwood Park `T8A/T8B/T8C/T8H`, Leduc `T9E`, Spruce
   Grove `T7X`, Fort Saskatchewan `T8L`, Beaumont `T4X`) are metro. **The exact
   in-area list is the client's to confirm** — ship with this default and a
   comment saying so.
2. A coloured zone badge on the admin list *and* detail page, plus the FSA
   itself so a human can sanity-check it.
3. A "directions from shop" link — a plain `https://www.google.com/maps/dir/?api=1&destination=<urlencoded address>`
   anchor. No key, no request from our server, exact drive time one tap away.
4. `unknown` (no postal code given, or an FSA not in the table) renders as
   *unknown*, never as *out-of-area*. A missing postal code must not read as a
   reason to decline.

Deliberately **not** Distance Matrix: it needs a billed key, it puts a customer
address into a third-party request on every admin page view, and the marginal
value over "which FSA + a maps link" is small for a single-city operator.

**(d) Slot hold/release per status** — §1.2, including the `ON CONFLICT`
predicate trap.

Also in scope: the idempotency-prefix fix (§1.5) and the `/book/confirmed/`
copy split (§1.3).

Tier: **Reviewed**. Migration **007** (statuses + index + `escalated_at`,
`approved_at`, `declined_at`).

### BK-32 — Stripe Checkout + webhook · **new**

**Mechanism.**

Session creation, server-side, at the moment of approval:

- `mode: 'payment'`, `currency: 'cad'`, one line item built from
  `ASSESSMENT_TIERS[row.assessment_tier]` — never from anything in the request.
- `expires_at` set to the computed payment deadline (Stripe permits 30min–24h
  from creation; clamp, and if the deadline is beyond 24h let our own cron own
  the expiry rather than Stripe's).
- `client_reference_id: String(appointment.id)` and
  `metadata: { appointment_id, tier }`.
- `success_url: <site>/book/confirmed/?session_id={CHECKOUT_SESSION_ID}`,
  `cancel_url: <site>/book/payment-cancelled/`.
- Stripe `Idempotency-Key: appointment-<id>-approval-<approved_at epoch>` — a
  double-click on Approve reuses the session instead of minting a second one.

**GST.** The figures are ex-GST and the customer must be charged the tax.
Options: `automatic_tax: { enabled: true }` with Stripe Tax configured, or an
explicit second line item at 5%. Recommend Stripe Tax only if the client is
already registered in it; otherwise the explicit line item, which is simpler and
auditable. **Needs the client's GST number for receipt compliance — §7.**

**Webhook** — `src/pages/api/stripe/webhook.ts`, `prerender = false`:

- Signature verified against `STRIPE_WEBHOOK_SECRET` over the **raw body**
  (`await request.text()`; never `request.json()` first, which re-serializes and
  breaks the signature).
- Events: `checkout.session.completed` (the confirm),
  `checkout.session.async_payment_succeeded` (delayed methods),
  `checkout.session.expired`, `checkout.session.async_payment_failed`.
- Returns 200 on anything it chooses not to handle. A non-2xx makes Stripe retry
  for days.
- **Never authenticated by the admin session** — exclude explicitly from any
  auth middleware.

**Idempotency, three layers, because Stripe redelivers by design:**

1. `stripe_events (event_id TEXT PRIMARY KEY, type TEXT, received_at TIMESTAMPTZ)`.
   `INSERT ... ON CONFLICT DO NOTHING RETURNING event_id` as the first statement;
   zero rows returned = already processed, return 200 and do nothing.
2. The status transition is a guarded update, the same idiom `update.ts` already
   uses: `UPDATE appointments SET status='confirmed', payment_status='paid',
   paid_at=$now WHERE id=$1 AND status='approved_awaiting_payment' RETURNING ...`.
   Zero rows = not our transition to make; do not send mail.
3. The confirmation email + ICS send **only** when layer 2 returned a row, under
   a transition-carrying idempotency prefix (§1.5).

**Columns** (migration 008, on `appointments`):

| Column | Type | Note |
| --- | --- | --- |
| `payment_status` | `TEXT NOT NULL DEFAULT 'not_required' CHECK (IN ('not_required','pending','paid','refunded','partially_refunded','failed'))` | `not_required` is the correct permanent value for admin entries |
| `payment_method` | `TEXT CHECK (IN ('link','onsite','none'))` | **the Terminal seam** — see below |
| `assessment_amount_cents` | `INTEGER` | snapshot at approval; prices change |
| `stripe_session_id` | `TEXT UNIQUE` | |
| `stripe_payment_intent_id` | `TEXT` | needed for refunds |
| `paid_at` | `TIMESTAMPTZ` | |
| `payment_due_at` | `TIMESTAMPTZ` | the computed deadline, stored not derived — the constants may change under a live row |

**Auto-cancel cron** — `/api/cron/expire-payments/`, added to `vercel.json`.
Every 15 minutes: `status='approved_awaiting_payment' AND payment_due_at < now()`
→ `payment_expired`, release the slot, email the customer (polite, with the
call-us line and an invitation to rebook), notify the office. Guard with the
same conditional-update idiom so a webhook landing in the same minute as the
cron cannot both confirm and expire. Order matters: **the webhook's guard names
`approved_awaiting_payment`**, so if the cron wins the race the payment lands on
an expired row — that case must refund automatically or alert loudly. Recommend:
alert the office and mark `payment_status='paid'` with a `needs_attention` note
rather than auto-refunding money silently.

**On-site payment / Terminal — out of scope, not architected against.** No card
reader work here. Two cheap things keep the door open: `payment_method` exists
as a column from day one, and the confirm transition lives in **one** function,
`markPaid(appointmentId, { method, amountCents, ref })`, which the webhook calls
and a Terminal handler can later call unchanged. No branch in the email layer,
no second status path.

Tier: **Reviewed** (money, public write path, irreversible). Migration **008**.

### BK-33 — Refund mechanics · **new**

Mechanism only. **Every policy value is a placeholder** pending §7.

- `stripe.refunds.create({ payment_intent, amount?, reason })`, idempotency key
  `refund-<appointment_id>-<attempt>`.
- **Company-cancel refund must be one action.** Admin sets a paid row to
  `cancelled` → a *Refund in full* checkbox, defaulted ON when the office
  selects a company-side reason. This is the path that must be impossible to
  forget.
- Amount parameter kept even if policy turns out all-or-nothing; partial refunds
  cost nothing to support now and a schema change later.
- Columns: `stripe_refund_id TEXT`, `refunded_amount_cents INTEGER`,
  `refunded_at TIMESTAMPTZ`; `payment_status` gains the values above.
- Webhook handles `charge.refunded` and `refund.updated` to reconcile — a refund
  issued from the Stripe dashboard by the office must reach our row too.
- Policy constants, placeholders, in `booking-config.ts` with a comment naming
  them as unanswered:
  ```
  REFUND_COMPANY_CANCEL          = 'full'      // certain
  REFUND_CUSTOMER_CANCEL_HOURS   = null        // TBD — cutoff before slot
  REFUND_CUSTOMER_CANCEL_AFTER   = null        // TBD — full | partial | none
  REFUND_NO_SHOW                 = null        // TBD — forfeiture?
  ```
  `null` must render as "call us" in the terms, never as a guessed number, and
  must block nothing in the mechanism.

Tier: **Reviewed** (money, irreversible).

### BK-34 — Photos for phone bookings · **new, split**

**BK-34a — upload-by-link mechanism + admin fallback (unblocked).**

- New token purpose in `draft-token.ts`: an appointment-scoped token, HMAC over
  `appointment-<id>.<issuedAt>`, TTL 72h (a customer texted at 4pm looks at it
  that evening or the next morning). Distinct version byte so an
  appointment token can never verify as a draft token or vice versa.
- Public page `/upload/<token>/`: shows the appointment date and the customer's
  first name for orientation, nothing else — **no address, no phone, no policy
  or claim number**. Anyone with the link has the link.
- `POST /api/booking/appointment-upload-token/` mints Blob client tokens under
  prefix `appointments/<id>/`, reusing every existing constraint —
  content-type whitelist, `maximumSizeInBytes` from the declared size, the
  10-file / 300 MB caps counted against `appointment_id` instead of `draft_id`.
  `parseUploadPathname` gains the second prefix shape.
- Rows written with `appointment_id` set directly; no claim step, so no cleanup
  ambiguity. Note the existing Known trap: `upload-token` has no rate limit of
  its own — this route is reachable with a 72h token, so **it needs one**
  (per-appointment, not per-IP).
- **Admin fallback**, for agents who already have the photos by email: a plain
  multipart file input on the admin appointment detail page, uploading to the
  same prefix through an admin-authenticated route. This is the one that works
  on day one with no SMS at all.

**BK-34b — the SMS send (Twilio-blocked).** "We'll take a look — send us photos
here: <link>" from the admin create form, one tap. Gated on the same number
verification as BK-06. Until then the office copy-pastes the link into their own
texting app; the link itself works.

Tier: **Reviewed** (public write path, private file store).

### BK-35 — Admin entry hardening + emergency path · **new**

- **Email strongly encouraged.** Inline warning, rendered live when the field is
  empty and on the server-side round-trip: *"No email means this customer gets
  no written terms and no confirmation."* A warning, not a block — the exemption
  is a client decision and stays.
- **Send-confirmation stays default ON** (already is). Unticking now writes an
  audit line: `console.warn` plus an `admin_notes` append, so "the customer says
  they were never told" is answerable.
- **Explicit emergency path.** A checkbox on the admin create form:
  *"Emergency — skip photo requirements and review."* Sets
  `is_emergency BOOLEAN DEFAULT false` and drops the row straight to
  `confirmed` (not `pending_review`). This is honest about what already happens
  — the office creating a row *is* the approval — and makes it visible in the
  admin list and internal email rather than an invisible property of
  `source='admin'`.
- Emergency rows also skip the 24h notice floor and the payment gate; whether
  they pay by link or on site is **open, §7**.

Tier: **Reviewed** (touches the write path and the review gate).

### BK-36 — Terms rewrite · **new**

The text is §5. Ships in the **same deploy** as BK-23 + BK-31 + BK-32 — the
terms describe a payment link, so they must not reach the browser before the
link exists, and the current terms ("paid at the end of the visit") must not
survive the flip by a single deploy.

Scope: rewrite the `booking-copy.ts` constants, update the five render surfaces,
update the `verify-cutover.ts` constant pins (the constant *names* change —
`FEE_TERMS_OUTRO` splits into `FEE_TERMS_PAYMENT`, `FEE_TERMS_REFUND`,
`FEE_TERMS_CREDIT`), update `verify-booking-email.ts`'s figure assertions, and
add two new pins:

- **no "deductible"** anywhere in `dist/` — §5's hardest constraint, and the one
  most likely to be reintroduced by a well-meaning copy edit.
- **no "billed to your insurer" / "your insurance pays"** shapes on the booking
  surfaces.

Both read `dist/` after the build, per BK-29's lesson.

Tier: **Light** by the process rules (copy), but the content is pricing and
near-legal. Recommend **Reviewed** on the copy alone — one fresh agent against
the constraint list in §5.

### BK-06 — reminders · amended while blocked

Add the acceptance criterion now: the reminder query filters
`status = 'confirmed'`, never `status <> 'cancelled'`. A `pending_review` or
`approved_awaiting_payment` row must never receive a reminder for a visit that
is not happening.

### BK-24, BK-25, BK-26, BK-28 — carried

- **BK-24** (one-click Approve/Decline from email) unchanged in mechanism, but
  Approve now means "approve and send the payment link". Its POST-not-GET rule
  matters more, not less: a link-prefetcher that approves a booking now also
  charges nothing and confuses a customer with a payment link.
- **BK-25** absorbs the escalation timer from BK-23(b)? **No** — put escalation
  in BK-23 (it is part of the review loop) and leave BK-25 owning the P7
  auto-decline timer, which now needs reconciling against the payment expiry
  cron (§6, item 6).
- **BK-26** (checklist) unchanged, independent.
- **BK-28** (homepage availability preview) unchanged, but its slot list must
  read the new hold predicate.

---

## 4. Proposed build order

Grouped by **deploy**, not by commit — several tickets must land together or the
site tells a lie between deploys.

**Deploy 1 — unblocked prep, no flow change** (safe to start immediately)

1. **BK-35** — admin form hardening + emergency flag. No schema beyond
   `is_emergency`. Independent.
2. **BK-34a** — appointment-scoped upload token, `/upload/<token>/` page, admin
   fallback file input. Independent. Delivers the client's photo problem
   *today* without Twilio.

**Deploy 2 — the flip** (four tickets, one deploy; migrations go **expand →
deploy → contract**, NOT all-before-the-code — see ROADMAP §P9's rollout table.
The "production first, in order" wording this line used to carry caused a live
42P10 outage on 2026-08-18)

3. **BK-31** — tier picker (006). Must precede BK-32, which charges the tier.
4. **BK-23** — lifecycle, statuses + index, request-received page/email,
   approve/decline, escalation, service-area badge, idempotency-prefix fix (007).
5. **BK-32** — Stripe session, webhook, expiry cron (008). Depends on 31 + 23.
6. **BK-36** — terms rewrite. Depends on all three being in the same deploy.

Implement in the order 31 → 23 → 32 → 36; commit separately (one ticket per
commit, per process); deploy as one release. Migrations 007/008/009 apply
production-first, matching BK-27's rollout shape — `insertBooking` will name the
new columns, so new code against the old schema 500s every booking.

**Deploy 3 — the safety net and the office's UX**

7. **BK-25** — P7 timers, reconciled with the payment expiry cron.
8. **BK-24** — one-click approve/decline from the internal email.
9. **BK-33** — refund mechanics. Can precede BK-24 if the client answers the
   refund policy questions early; the mechanism does not need the policy, but
   the terms copy does.

**Unblocked when Twilio lands**

10. **BK-34b** — SMS the upload link.
11. **BK-06** — reminders, `status = 'confirmed'` only; escalation transport
    swaps from email to owner SMS.

**Independent, pull in whenever**

12. **BK-26** — customer checklist. **BK-28** — homepage availability preview.

Dependency edges worth stating outright: `BK-32 → BK-31` (needs a tier),
`BK-32 → BK-23` (needs `approved_awaiting_payment` to transition out of),
`BK-36 → BK-32` (the copy describes the link), `BK-33 → BK-32` (needs a payment
intent), `BK-34b → BK-34a` (needs the link), `BK-24 → BK-23`.

---

## 5. Draft terms text

Constraints honoured, in order of how easily each is broken:

- **The word "deductible" appears nowhere.** Deductible rebating by contractors
  is explicitly illegal in several US jurisdictions and reads as claims-fraud
  territory to Canadian insurers. The credit is against *our invoice*, and the
  copy never names what the customer's share is called.
- **Nothing states or implies the assessment is billed to the insurer.** The
  $699/$1,199 language describes documentation the customer receives and can
  hand to their adjuster. It never says who pays.
- **The block ends on the credit.** The refund and forfeiture language sits in
  the middle; the last thing read is the good news.
- **$699/$1,199 are reframed around the report,** because on an insurance job
  the deliverable is the customer's benefit, not the credit.

```ts
export const FEE_TERMS_HEADING = 'Assessment terms';

export const FEE_TERMS_INTRO =
  'Choose your assessment below. We review every request before confirming it. ' +
  'Once we approve yours, we email you a secure payment link — and your ' +
  'appointment is confirmed as soon as the payment goes through.';

export const FEE_TERMS_ITEMS: readonly string[] = [
  '$399 + GST — the on-site assessment and a written scope of the damage',
  '$699 + GST — adds a written cause-of-loss report and a repair estimate: the documentation your adjuster works from if you are filing a claim',
  '$1,199 + GST — adds a measured sketch and diagram of the affected areas, alongside the report and estimate',
];

export const FEE_TERMS_PAYMENT: readonly string[] = [
  'Nothing is charged when you send your request. You pay the assessment you picked here, on the link we email you after we approve it.',
  'The link has a deadline, and we state it in that email. If it is not paid by then, the time is released and you are welcome to book again.',
];

export const FEE_TERMS_REFUND: readonly string[] = [
  'If we cancel or cannot make the appointment, you get a full refund.',
  '[PLACEHOLDER — customer cancellation]',   // pending client decision
  '[PLACEHOLDER — missed appointments]',      // pending client decision
  `To cancel or reschedule, call or text ${SUPPORT_PHONE}.`,
];

export const FEE_TERMS_CREDIT =
  'Whichever assessment you choose, the full amount comes off your final ' +
  'invoice when you go ahead with the restoration work.';

export const FEE_TERMS_ACK_LABEL =
  'I understand the assessment terms above, including the amount I will be asked to pay.';
```

Render order on every surface, without exception:
`HEADING → INTRO → ITEMS → PAYMENT → REFUND → CREDIT → [tier radios] → [ack checkbox]`.

The tier radios and the ack checkbox come **last**, below `FEE_TERMS_CREDIT`,
because the label says "terms above" — that ordering is a claim the label makes
about the page, and `verify-cutover.ts` should pin it the way it already pins
the terms-above-checkbox relationship today.

Two notes on the wording:

- `FEE_TERMS_INTRO` deliberately does **not** promise a review SLA. The client
  said "almost right away, max 1 hour" internally; publishing that turns an
  operational intent into a public commitment on a page a customer can screenshot.
  If the client wants it public, the sentence is *"We usually review requests
  within an hour."* — their call, flagged in §7.
- The placeholders must render as an explicit "call us" line if the client has
  not answered by build time. They must never be guessed and must never be
  silently dropped — a refund section that omits customer cancellation entirely
  reads as "fully refundable" to a customer and as "non-refundable" to us, which
  is the dispute this whole block exists to prevent.

---

## 6. Contradictions found — flagged, not resolved

1. **Minimum notice: 4h live, 24h decided, 4h assumed by the new rule.**
   `MIN_NOTICE_HOURS = 4` is what production runs. P7 records a client decision
   on 2026-08-12 moving it to 24h, assigned to BK-23 and never built. The new
   direction's deadline rule ("4 hours before slot start") reads as though 4h
   notice still stands. §2 recommends implementing the 24h decision, which
   dissolves the collapse — but the client should be told that their earlier
   24h decision is being *used*, not that a new one is being made.

2. **Emergency bypass: P7 says no, the new direction says yes.** P7 quotes the
   client directly: *"everything urgent brother, all jobs need to follow the
   same process"* — explicitly no emergency bypass. The new direction asks for
   emergencies to skip photos and approval. These are partly reconcilable —
   emergencies are phone-in and admin-created, and admin entries were *already*
   exempt from photos and review under the same P7 decision — so BK-35's
   emergency flag arguably formalises existing behaviour rather than reversing
   the decision. But it does put an explicit "skip the gate" control on a screen
   the client said should not exist. Worth one sentence back to the client.

3. **BK-31's "non-binding by design" is dead.** The current ROADMAP row states
   the form *must say* the choice can change on the day. Under prepay the choice
   is what gets charged. Deleted, not softened.

4. **Three locked P8 statements are superseded**, all traceable to BK-27's
   "Client pricing model — FINAL, 2026-08-14" block and to `booking-copy.ts`'s
   header comment: *"nothing is charged at booking"*, *"paid on site only"*,
   *"tell the tech on the day"*. The BK-27 ticket and the ROADMAP P8 narrative
   both need a superseded-by marker, or the next reader treats a stale FINAL as
   authoritative — the exact failure BK-27's own header warns about.

5. **`/book/confirmed/` claims a booking that no longer exists at that point.**
   The page title, meta description and `<h1>You're booked</h1>` all render at
   submission. Not a copy nit — it is the same false claim BK-29 spent a whole
   ticket removing from the marketing surfaces, reappearing on the one page
   where the customer is most likely to believe it.

6. **Two timers will race on `pending_review`.** P7's BK-25 auto-declines a
   still-pending booking at `slot − 24h`. The new payment deadline is
   `slot − 4h`. At 24h minimum notice, *every* booking made at the floor is
   auto-declined the instant it is submitted. Either the three slot-relative
   thresholds are re-spaced so they fire in order — escalate to the owner at
   `slot − 12h`, auto-decline at `slot − 6h`, payment deadline at `slot − 4h`
   (which also moves BK-23's proposed 8h escalation) — or the auto-decline is
   re-scoped to "unreviewed for N hours since submission" and stops being
   slot-relative at all. **Needs a decision before BK-25.**

7. **Office ICS at request time fills the calendar with unpaid slots**, and
   there is no CANCEL trigger on the decline or expiry paths to clear them
   (P7 decided declined rows get no CANCEL, correctly, because no invite should
   have existed). §1.4 recommends moving the office invite to confirmation.
   This is a behaviour change from what P7 implies, so it is flagged rather than
   assumed.

8. **The Resend idempotency prefix (§1.5) contradicts the flow at the code
   level** — four customer emails per booking, one idempotency key. Silent in
   dev, silent in production logs. The single most likely way for this flow to
   ship broken.

9. **"Non-refundable" was written for money that moves on site.** Under prepay
   the money moves days earlier, which makes refunds a routine operation rather
   than an edge case and raises the consumer-protection profile of a
   non-refundable prepaid service. Not a legal opinion — just noting that the
   clause's risk changed even though its wording did not, which is why §5 makes
   it a placeholder rather than carrying the old sentence forward.

10. **The Ads conversion still fires at submission** (P7 decision, deliberate).
    Under prepay the gap between "conversion" and "revenue" widens from
    one review step to review + payment. There is now a genuine payment event
    that could carry a second, revenue-accurate conversion. Not urgent, but the
    client's eventual "why do my conversions not match my jobs" question gets
    harder to answer, not easier.

11. **BK-22's Known trap gets worse.** A Blob/env misconfiguration currently
    kills the public booking funnel with no notice and no funnel event. Adding
    a second photo path (BK-34a) and a payment step downstream means more ways
    for a customer to be stranded mid-flow. Still owned by nobody. Worth
    attaching to BK-23's deploy since that release touches the funnel anyway.

12. **ROADMAP says BK-23 owns migration 006.** It now owns 007; BK-31 takes
    006. Mechanical, but the ROADMAP line is load-bearing for the next
    implementer.

---

## 7. Open client questions — not answered here

**Carried from the direction, unanswered by design:**

1. **Refund policy values.** Customer-cancel cutoff (how many hours before the
   slot, and refund in full / in part / not at all after it), and whether a
   no-show forfeits. Blocks the terms copy shipping without placeholders; does
   not block BK-33's mechanism.
2. **Phone / insurance-job prepay exemptions.** Do phone customers pay by link
   like web customers, or on site? Same question for emergency rows created by
   BK-35. This changes whether `payment_method='onsite'` is a routine value or
   an exception.
3. **"Credited against your final invoice" vs. how insurance jobs actually
   settle.** The credit must come off the *customer's* share for the sentence to
   be true and for the copy to stay clear of anything resembling rebating. Needs
   confirmation from someone who has settled one of these.

**New, surfaced by this audit:**

4. **The `N` in "approved_at + N hours"** — proposed 12. Business feel, not
   engineering.
5. **The auto-decline threshold** (§6 item 6) — the P7 timer and the payment
   deadline currently collide.
6. **Publishing the review SLA.** "We usually review requests within an hour" on
   the public form — the client stated it internally; making it a public promise
   is their decision.
7. **GST handling and the GST registration number** — needed for a compliant
   Stripe receipt, and it decides Stripe Tax vs. an explicit tax line item.
8. **The in-service-area FSA list** (§ BK-23c) — shipping with a proposed
   Edmonton-metro default that the client should confirm or correct.
9. **Does the office want the calendar invite for pending requests?** (§6
   item 7.) Recommendation is no; it is their calendar.

---

## 8. External-spec merge and 2026-08-18 client answers

On 2026-08-18 an independently-written spec (`deploy-2-prepay-spec.md`, authored
outside the repo) was dropped in, presenting itself as authoritative for
Deploy 2. It was audited against the codebase before any of it was adopted.

**Outcome: it is an independent document, merged into P9, and P9 wins every
conflict** (user instruction, 2026-08-18). It is not kept in the repo — keeping
a superseded "authoritative" spec beside the real one is precisely the failure
§6 item 4 already records against BK-27's stale FINAL block. What it contributed
and what it got wrong is recorded here instead, which is the whole of its
remaining value.

### 8.1 What it contributed — genuinely new, now in the tickets

| Item | Where it landed |
| --- | --- |
| **Interac e-Transfer as a payment path** — approval email offers it, admin marks it paid, same transition | BK-32, as a second caller of `markPaid()` |
| **The refund baseline** — full refund 24h+ before, none within 24h | BK-33 constants, BK-36 copy; answers open question #4 |

Nothing else in it was new. Its state machine, its Stripe design, its webhook
idempotency layering and its cron expiry were all already specified here in
§3–§4 and in BK-32, in more detail and with the 2026-08-16 client answers it did
not have.

### 8.2 What it got wrong about this codebase

Each verified against the code on 2026-08-18. These are corrections applied to
it, not decisions taken from it.

1. **"Minimum notice is already next-day earliest — verify, don't rebuild."**
   False: `MIN_NOTICE_HOURS = 4`, and same-day web booking works today. Its own
   `slot − 4h` payment deadline is uncomputable under a 4-hour notice rule, so
   the change it listed as *out of scope* is a prerequisite for its own design.
2. **"The client clicks Yes in an email and that creates the calendar event."**
   No such flow exists anywhere. A booking auto-confirms at commit and sends two
   ICS-bearing emails. There is no approval endpoint to repoint; approve/decline
   is built from nothing (BK-23).
3. **"Google Calendar integration — service account or OAuth, a calendar id."**
   None. Calendar events are `.ics` attachments on emails (`booking-ics.ts`).
   Consequences its §4 ordering assumes away: confirmation is **one send**
   carrying a `REQUEST` ics, not "create event, then send email"; cancellation
   needs a `CANCEL` ics under the same UID with a **byte-identical
   `ORGANIZER`**; and decline/expiry must never have sent a `REQUEST` in the
   first place, which is exactly why §1.4 moves both invites to
   payment-confirmed.
4. **"Pricing is `service_type → { amount_cents, label, bookable_online }`."**
   Prices are **assessment tiers**, orthogonal to service, and no customer can
   choose one yet. Its instruction to flag a mould *service* price had no
   target. Superseded anyway by the 2026-08-18 answer below.
5. **"Admin manual booking respects blackout dates."** It bypasses blackouts,
   Fridays, the horizon and the notice rule — deliberately, documented at
   `api/admin/appointments/create.ts:34-38`. **Kept as-is** (user, 2026-08-18):
   documented behaviour beats an outside assumption.

It also did not mention the Resend idempotency prefix (§1.5) at all, which would
have silently eaten four of the five emails its own §6 specifies.

### 8.3 New client answers, 2026-08-18 (WhatsApp)

Full text in `ROADMAP.md` §P9, "Amendments — client answers 2026-08-18". In
brief, and with what each supersedes in the sections above:

- **Minimum notice: next-day earliest**, not the 24 rolling hours §2 of this
  document recommends. §2's *reasoning* stands — the 4-hour floor makes the
  deadline uncomputable — but its **value is superseded**. The two rules differ:
  next-day-earliest allows a Wednesday 11:30 slot booked Tuesday at 15:00, which
  24h notice would refuse. The residual tight window is absorbed by the pay-now
  branch (`PAY_NOW_THRESHOLD_HOURS = 8`), not by a new mechanism.
- **Mould tier prices** — $385 / $645 / $1,185 + GST against the standard
  $399 / $699 / $1,199. **Supersedes BK-31's flat `ASSESSMENT_TIERS` map** in
  §3: the table is keyed `(tier, service)` with a default row per tier and one
  mould override map.
- **After-hours multiplier 1.5x on weekend slots**, shown on the form before the
  customer sends the request. New; nothing above anticipated it. Stat holidays
  deferred out of v1.
- **Travel fee $1.15/km round trip beyond 30 km** — an admin-side *suggestion*
  at review time, never auto-charged, and shipped without a computed distance
  because no distance API exists here and the client said not to block on one.
- **Admin-adjustable amount at approval** — two fields (base, travel), GST and
  total computed, so the approval email can itemize. **This is the one place a
  price may legitimately differ from the table**, and it is authenticated,
  server-side, after the request exists. The public payload still carries a tier
  key and never an amount.
- **All three tiers stay bookable online**; tier 3 must disclose that lab
  results take 3-5 business days.
- **GST registration number: ANSWERED 2026-08-20 — `775654577RT0001`.** Shipped
  by BK-48 as a constant, and it took code: the Stripe Dashboard field governs
  invoices, not Checkout receipts.

### 8.4 What in this document is now stale

- **§2's "raise web minimum notice to 24h"** — right diagnosis, superseded
  value. Read §8.3.
- **§3, BK-31's `ASSESSMENT_TIERS` block** — the flat per-tier map is replaced
  by the `(tier, service)` table with the mould override.
- **§3, BK-32's column table** — `payment_method` is now
  `stripe|interac|onsite|none`, and the itemization columns (`travel_fee_cents`,
  `gst_cents`, `total_amount_cents`, `needs_attention`) were added.
- **§3, BK-33's policy placeholders** — answered; `REFUND_NO_SHOW` was dropped
  rather than answered, because a no-show falls inside the 24-hour rule and a
  separate constant would invent a policy.
- **§5's `[PLACEHOLDER]` refund lines** — filled. The rest of §5's draft copy
  stands, plus the three additions BK-36 now carries: the lab-result turnaround,
  the weekend surcharge, and the sentence that keeps the standard figures honest
  for a mould customer seeing a different number beside the button.
- **§7 item 1 (refund values)** and **§6 item 9's "non-refundable" concern** —
  both closed by the 24-hour answer.
- **§1.5's idempotency fix** is now **BK-43**, its own ticket, shipping before
  BK-31 rather than as BK-23's Task 0.
