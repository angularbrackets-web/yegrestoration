# Session state — saved 2026-08-16 (Opus session: BK-27 + BK-29 shipped to production)

## Read this first

**BK-27 and BK-29 are DEPLOYED (2026-08-16).** Migration 005 was applied to
production first, then 7 commits were pushed (`ec2d31d..1de17d0`) — which also
carried BK-22, live code that had never deployed. Verified against the live
site. Nothing is pending release.

Everything durable is in the repo. This file is orientation, not the source of
truth: `/CLAUDE.md` (process), `docs/booking/ROADMAP.md` (phases, Known traps,
P8), `docs/booking/tickets/BK-27.md` and `BK-29.md`.

## Exact tree state

- **Working tree clean, nothing unpushed.** `origin/main` == `main` == `1de17d0`.
- Migration 005 is applied to **both** dev and production (`migrate --status`
  bare = prod shows all five `✓`).
- Live verification done: 12 pages + `llms.txt` return 0 "free assessment"
  claims; `/book/` serves all three tiers, the terms box, the credit line and
  the non-refundable line; `verify:booking:smoke` confirms both stamp columns
  write without a type error.

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

**The recurring error, five times across P8: writing a disclosure check as a
keyword search.** (The fifth was BK-29's own dist gate, which matched `free`
adjacent to `assessment` and missed "free on-site assessment".) A keyword red proves a weaker property than the assertion
claims. What works is naming the accepted phrasings of the correct claim and
explicitly refusing its negation. Written up in BK-27.md under "Re-review".

## Next actions, in order

Nothing is blocked and nothing is pending release.

1. **BK-31** — assessment tier selection at booking. The form has no picker, so
   the copy currently says "Tell the tech on the day which of these you want."
   BK-31 owns rewriting that line once a picker exists, and owns recording WHICH
   tier was chosen (the re-review's S2 accepted that `terms_acked_at` proves a
   box was ticked, not what it said).
2. **BK-28** (homepage availability preview) and **BK-23** (review lifecycle),
   both queued behind P8. BK-23 must move the fee-terms echo into the
   application-received email when it splits the confirmation — handoff is in
   BK-27's Sequencing section.
3. Post-deploy exercises still owed from earlier tickets: BK-08 / BK-09 / BK-10
   / BK-14 / BK-16.

## Post-deploy watch items (2026-08-16)

- **First real booking through the new form.** The path is verified end-to-end
  on the dev branch, and production's schema is confirmed, but no production
  booking has run through it yet. Worth eyeballing the first one: the row should
  carry a non-null `terms_acked_at`, and the customer's confirmation email
  should contain the "Assessment terms" section in both HTML and text.
- **Google Ads copy and indexed snippets.** Ads may still say "free
  assessment" — the account is the user's, not reachable from here. Search
  results will lag the deploy by weeks; that is expected, not a fault.

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
- **`verify:booking:smoke` IS safe to run locally — an earlier note here said
  the opposite and was wrong.** It starts a local server on port 4333 against
  the Neon DEV branch, refuses outright if `DATABASE_URL_DEV` resolves to the
  production host, and deletes the appointment, files and blackout it creates.
  It never touches production. Run it after any change to the commit path.
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
