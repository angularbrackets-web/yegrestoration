# Session state — saved 2026-08-15 (Opus session: BK-27 copy revision, re-review, BK-29 draft)

## Read this first

**BK-27 is committed and reviewed. It is NOT pushed, and pushing is the deploy.**
Nothing in this session reached production.

Everything durable is in the repo. This file is orientation, not the source of
truth: `/CLAUDE.md` (process), `docs/booking/ROADMAP.md` (phases, Known traps,
P8), `docs/booking/tickets/BK-27.md` and `BK-29.md`.

## Exact tree state

- **Working tree clean.** Both commits landed this session:
  - `c20ade0` BK-29 draft
  - `a1eedc9` BK-27 implementation
- **5 unpushed commits on `main`**: the two above plus `95e0773`, `2adc752`
  (BK-22 — live code that has never deployed) and `0daa89d`.
- Migration 005 is **applied to dev**, **still pending on production**.

## What BK-27 shipped

Assessment fee terms on the public booking form: a terms box, a required
acknowledgment checkbox on step 3, `terms_acked_at TIMESTAMPTZ` via migration
005, public-only enforcement riding BK-22's `entry: 'public' | 'admin'`
discriminator (admin exempt, `parseAdminEntry` unchanged), the terms echoed in
the confirmation email's HTML *and* text, and the stamp shown in admin.

**The pricing model, in one paragraph.** Every customer pays at the end of the
visit; if they go ahead with the work the fee is credited in full against the
final invoice. Three tiers — **$399 + GST** (assessment only), **$699 + GST**
(+ cause-of-loss report and estimate), **$1,199 + GST** (+ insurance sketch,
*includes* the report). Non-refundable if they don't proceed. No time limit on
the credit. Paid on site only. Nothing charged at booking. The tier is **not
binding** and there is **no tier picker yet** — that is BK-31, and the copy is
worded to be true without one.

The five copy constants live in `src/lib/booking-copy.ts` and nowhere else.
**No surface outside the booking pages states a price** — that is a design rule,
not an accident, and BK-29 depends on it.

## Reviews — both rounds done, nothing refused

- **Mechanism, 2026-08-14** (fresh session): 2 blockers / 4 should-fixes / 3
  nits. All folded in, one should-fix accepted-and-documented (S2).
- **Copy revision, 2026-08-15** (fresh subagent): 0 blockers / 4 should-fixes /
  3 nits. All folded in.

Three of the second round's four should-fixes were **gates passing green while
the violation shipped**, each proved by planting rather than argument:

- `stripForUse` deleted everything after `https://` on a line, so the
  "free assessment" pin passed while the phrase rendered into `dist/`.
- The island's terms box — the only surface with the checkbox — had no pin.
- `/refund/i` matched "It is **fully** refundable", the client's exact negation.

**The recurring error, now four times in this ticket: writing a disclosure check
as a keyword search.** A keyword red proves a weaker property than the assertion
claims. What works is naming the accepted phrasings of the correct claim and
explicitly refusing its negation. Written up in BK-27.md under "Re-review".

## Next actions, in order

1. **Implement BK-29** (`docs/booking/tickets/BK-29.md`, drafted, plan review not
   run). 51 claims / 22 files. **Its gate must read `dist/`, not source.** Expect
   the new pin to be red until the sweep finishes — that is the intended
   sequence, written into the ticket.
2. **Apply migration 005 to production BEFORE the push.** New code names the
   column, so new-code-on-old-schema 500s every booking, and production holds 5
   real appointment rows.
3. **Push BK-27 + BK-29 together.** Neither deploys alone.
4. **BK-31** (tier selection at booking) after that. It owns rewriting the
   outro's "Tell the tech on the day…" once a picker exists.
5. BK-28 (homepage availability preview) and BK-23 remain queued behind P8.

## Open with the client

1. **Sign-off on BK-29's replacement wording** — ~51 customer-facing claims.
2. **Wasted-trip charge?** Recommendation given: publish the expectation, charge
   nothing at launch, revisit when card-on-site is live.
3. **Insurance route** — confirm the credit applies to the customer's own share,
   and mind the framing (never "we help with your deductible").
4. Whether the ack should record **which tier** was chosen (recommended, BK-31).
5. **Google Ads copy** likely still says "free assessment", and indexed
   titles/descriptions will for weeks after deploy. The account is the user's.

## Older open user actions (unchanged, remind gently)

- `noreply@yegrestoration.ca` alias in Google Workspace — the only fix for ICS
  RSVP replies; no code can redirect those.
- Post-deploy exercises still owed: BK-08 / BK-09 / BK-10 / BK-14 / BK-16.
- Production test row **#22** (cancelled) — delete on the user's word.
- Google Ads account checklist (form action → Secondary, "Assessment booked"
  → Primary).
- **BK-06** blocked on Twilio number verification ((780) 720-8856).
- **BK-11** launch checks — `booking_availability_error/empty` GA4 events count
  ATTEMPTS, not visitors.
- `workflow-options.md` (build vs Jobber vs OSS) still awaiting client
  direction. Payment recording folds into that decision.

## Facts that save re-derivation

- Run `verify:booking:commit` with **no `DATABASE_URL` override** — it reads
  `DATABASE_URL_DEV` itself and refuses if that host equals `DATABASE_URL`'s.
- **Never run `verify:booking:smoke` locally** — it POSTs to the deployed site.
  Its fixture carries `termsAck: true`; it belongs to the post-deploy pass.
- The implementer/reviewer **cannot log into production admin** —
  `ADMIN_PASSWORD` pulls as `""` (the `vercel env pull` trap). `DATABASE_URL`
  **is** real, so `npm run migrate -- --status` (bare = prod) works.
- Dev DB: `DATABASE_URL_DEV` in `.env`, values quoted — strip quotes in shell.
- `BOOKING_NOTIFY_DISABLED=1` is the positive mail mute; it silences injected
  seams too, so success/failure arms verify at LIB level with injected senders.
- Resend resolves `{data,error}`, never throws; only `booking-notify.ts` may call
  the SDK (`verify-cutover` sweeps for it, comment-stripping).
- Red pass rule: restore breaks **by edit**, never `git checkout` on an
  uncommitted tree. Save `git diff > scratch.patch` first, diff against it after.
- **Do not drive file edits through `perl -0777 -i -pe` with shell-quoted
  strings** — `&`, `/` and em-dashes mangled a line this session. Use the Edit
  tool for break/restore.
