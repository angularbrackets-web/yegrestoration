# Session state — saved 2026-08-12 (reviewer session, Fable)

## Who this file is for

The next **reviewer session** in the two-session workflow. Normally Fable;
**until Friday 2026-08-14 22:00 the user is at their Fable weekly limit, so
the reviewer session runs on Opus** — same procedure, same standards, this
file is the handoff. An Opus **implementer** session does ticket work; the
reviewer session drafts tickets, runs plan reviews, verifies the
implementer's summary against the repo, runs the implementation review via a
fresh agent, fixes small review findings itself, and commits. The user
ferries paste-ready messages between the two sessions. Never take the
implementer's summary's word for anything checkable.

## Latest (2026-08-12, later in the day — Opus reviewer session)

- **BK-21 committed + pushed** (`90c65a9`) = deployed. The go-over of the
  draft found a **third** hole it had recorded as safe (the contact form's
  email has always been optional), and the two old assertions checked only
  for a bare `—` — a substring the new copy keeps — so they would have
  stayed green against a half-done change. Gates all re-run here; dev branch
  clean; one red re-observed first-hand on the half the implementer had not
  broken.
- **BK-22 drafted + plan-reviewed** (`cba98f3`). 4 blockers / 7 should-fixes
  / 8 nits, all folded in, none refused; every blocker re-confirmed against
  source here before folding. **Blocked only on the user's
  `DRAFT_RATE_LIMIT_PER_HOUR` answer**, then it is approved and ready to hand
  to the implementer. Handoff message is written in the session transcript.
- **Three out-of-scope defects recorded in ROADMAP Known traps** (internal
  email's photo count can't distinguish uploaded from pending — owner BK-23;
  upload-token has no rate limit of its own; verify-booking-commit's
  "Database failure" arm passes via an unhandled path).
- Unchanged: BK-23 and BK-24 plan reviews are still **held for Fable after
  Fri 22:00**.

## Where things stand (2026-08-12, all committed and pushed to main)

- **BK-16** (customer calendar lifecycle) — implemented by Opus, reviewed
  here (fresh agent: approve-with-should-fixes, 0 blockers, 2 should-fixes +
  2 nits, all folded in and red-observed), committed `1162b9d`, pushed =
  deployed. Full review record in the ticket file.
- **BK-21** (internal Reply-To fallback) — drafted (`af106d3`), **next up**.
  Light tier: gates only, no plan/implementation review. Lands BEFORE P7
  because it touches the same email files P7 reworks.
- **P7 planned and committed** (`e33435d`) — review-before-confirm, the
  client's 2026-08-12 change request. Read the P7 section of
  `docs/booking/ROADMAP.md` in full before drafting any of BK-22–26; every
  client decision and planning assumption is recorded there. Sequenced:
  BK-21 → BK-22 (mandatory email + ≥1 photo/video) → BK-23 (pending
  lifecycle core + migration) → BK-24 (signed one-click email actions) →
  BK-25 (reminder + auto-decline cron) → BK-26 (customer checklist).
  BK-17/18/19 deferred behind P7 with amendments noted in their rows.
- **Model-aware sequencing until the Fable reset (Fri 22:00):** BK-21 and
  BK-22 are fully Opus-runnable (draft, plan-review, implement, review).
  **Hold BK-23 and BK-24 plan reviews for Fable after the reset** — the
  migration/index change and the signed unauthenticated endpoint are the two
  highest-risk designs in the phase and where plan-review depth pays most.
  Drafting them earlier is fine; plan review gates implementation.
- **Pending client answer (via user):** the auto-decline rule — reminder at
  +24h unactioned, auto-decline at slot−24h with the "we're at capacity"
  email — is recorded in P7 as *proposed, client's to overturn*. BK-25 is
  last in sequence, so no work blocks on it.

## The reviewer pass, when the implementer reports back (as run for BK-09/10/14/16)

1. Verify tree vs claims: `git status --porcelain`, `git diff --stat`
   (file counts, +/- lines), nothing committed, untracked files explained.
2. Re-run EVERY gate yourself: typecheck, build, the ticket's verify
   scripts, regressions verify:contact + verify:booking:smoke +
   verify:cutover (which chains its own build).
3. Dev-branch cleanliness after any db script: appointments/files/blackouts
   = 0. (`leads` has ~30 historical production rows from the branch fork —
   normal, not leakage; check no fixture-shaped rows.)
4. Secret scan the diff (fake fixtures like vercel_blob_rw_FAKESTORE are
   fine).
5. Launch a FRESH implementation-review agent (general-purpose): ONLY
   /CLAUDE.md, ROADMAP, the ticket, the diff, and your independently re-run
   gate output. Withhold the implementer's "things to push on" notes;
   cross-check afterward whether the reviewer found them independently.
   Findings: blocker / should-fix / nit.
6. Should-fixes: fix in this session if small (BK-10/BK-16 precedent).
   Red-observe every NEW/CHANGED assert: break the PRODUCTION target, watch
   red, RESTORE THE BREAK WITH AN EDIT — **never `git checkout` on an
   uncommitted tree; it discards the implementer's work too** (this bit the
   BK-16 pass; recovery was only possible because the full diff had been
   saved to a scratch file first — always save `git diff > scratch/x.patch`
   before the red pass). Append red rows + an "Implementation review"
   section to the ticket, set Status: committed.
7. Update the ROADMAP row → ✅ committed; one ticket per commit
   ("BK-NN: <summary>" + Co-Authored-By: Claude Fable 5
   <noreply@anthropic.com>); push (push = production deploy via Vercel).
8. Update memory `booking-feature-plan.md` + MEMORY.md index line; give the
   user their post-deploy checklist.

## Open user actions (growing checklist, remind gently)

- **BK-16 post-deploy** (newest): production booking with a real inbox →
  confirmation carries the invite → add it → cancel in admin →
  cancellation email + calendar clears → un-cancel → restore email + event
  returns → delete the test row.
- **BK-21 mail-side half**: create `noreply@yegrestoration.ca` as an alias
  /routing rule to info@ in Google Workspace — the only fix that covers ICS
  RSVP replies; no code can redirect those.
- **Ferry to client**: the P7 auto-decline rule (above).
- Production test row **#22** (cancelled) — delete on the user's word.
- Older owed: BK-08/BK-09/BK-10/BK-14 post-deploy exercises; Google Ads
  account checklist (form action Secondary, "Assessment booked" Primary).
- **BK-06** — blocked on Twilio number verification ((780) 720-8856).
- **BK-11** — launch checks; note booking_availability_error/empty GA4
  events count ATTEMPTS not visitors.

## Facts that save re-derivation

- Implementer/reviewer can NOT log into production admin (ADMIN_PASSWORD
  pulls as "" — vercel env pull trap). Authenticated production checks are
  the user's.
- BOOKING_NOTIFY_DISABLED=1 is the positive mail mute; it silences injected
  seams too, so success/failure arms verify LIB-level with injected senders.
- Dev DB: DATABASE_URL_DEV in .env (values are quoted — strip quotes if
  reading by shell); `DATABASE_URL="$DATABASE_URL_DEV" npm run migrate --
  --status` for the dev ledger; bare command = production.
- Resend resolves {data,error}, never throws; only booking-notify.ts may
  call the SDK (verify-cutover sweeps for it, comment-stripping).
- P7 design pins nobody should re-derive: calendar RSVP cannot approve
  (iTIP REPLY goes to noreply@, send-only stack); one-click email actions
  must not mutate on GET (scanner prefetch) — signed page + POST;
  `pending` holds the slot, `declined` frees it (index becomes
  `NOT IN ('cancelled','declined')`); admin entries skip review
  (`source='admin'` starts `booked`); Ads conversion stays at submission.
- Process: /CLAUDE.md. One ticket per commit. Reviewers are always fresh
  agents with ticket + diff + gate output only.
