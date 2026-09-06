Continuing yeg-restoration-v4, booking area.

Read docs/booking/HANDOFF-2026-09-05.md — its LAST section, §11, first, then
work backwards BY FILE POSITION (the numbering below §10 is out of order: 9, 7,
8, 10). Run §0's three checks before trusting any line in it.

Do not read a revision number from ROADMAP.md. Run
`head -20 docs/booking/tickets/BK-53.md` and `head -20 docs/booking/tickets/BK-55.md`.
BK-53 is ~6,700 lines and has ten revisions — do NOT read it from the top. Use
its reading-order table near the top: revision 10 is the spec, and revisions 9,
8 and 7 are each marked "NOT the spec" while still being current for named
sections.

Standing rules, absolute:
- NEVER push bk51-gated to any remote, including as a backup. It is local-only
  and holds BK-51's production code. Use git bundle.
- `git ls-remote --heads origin` must return exactly 3 refs — count them, never
  grep for absence.
- `git push origin main` IS the deploy. Docs pushes are safe; code pushes go
  live. BK-51 + BK-55 + BK-53 are BUILT on bk51-gated and SHIPPED by one push to
  main — never by pushing bk51-gated.
- Six NON-DOCS files differ between main and bk51-gated. `git diff --name-only`
  lists sixteen, because main has advanced; ten are docs.
- The tickets are not usable on bk51-gated — BK-53 is a 212-line draft there and
  BK-55 does not exist. Read them from main.

State: GATE 1 is TWO tickets — BK-53 revision 10 (web) and BK-55 revision 4
(email). Both NOT APPROVED. BK-51 is reviewed and waits on both.

🙋 ONE THING IS BLOCKED ON ME. Do not treat it as decided; do not decide it
yourself. It is NOT decision 24's split, which is answered and shipped.

Last session recommended replacing BK-53's dist/ extractor machinery. The agent
sent to attack that recommendation refuted its load-bearing claim — reverting
R6-3c's ban would go RED on three of the ticket's own approved sentences. The
corrected version is three separate calls and lives in BK-53's R10-8. Its first
draft was wrong by thirteen and is corrected in place.

Do this, in order:

1. Put R10-8's three calls to me — but earn it first. Spawn a fresh agent to
   attack the CORRECTED recommendation, briefed that the target branch is
   bk51-gated, that six NON-DOCS files differ, and that the tickets' bare
   `review.ts:246` means src/pages/api/admin/appointments/review.ts and NOT
   src/lib/booking-review.ts, which has no line 246. The claim to attack hardest
   is R10-8d's replacement: that a threshold-free FILE-LEVEL coupling assertion
   on the built pages — every built file matching a free shape must also contain
   TRAVEL_QUALIFIER — does the job the extractor was built for. Check it is not
   red on arrival against the approved copy, which is how the last proposal died.
   Give me the verdict, then ask.

2. WHILE THAT RUNS — BK-55 is the ready one and its SPEC is not blocked. Take
   revision 4 to plan review: one fresh agent, briefed per its §F, which now
   carries the review.ts correction. It has been validated twice and its repair
   RUN end-to-end twice. Only plan review is owed. Note its §F sequencing
   section IS affected if a new ticket joins the branch — so approve the spec
   and flag §F as pending the decision.

3. THEN, once I have answered:
   - If the gate changes: write BK-53 revision 11 (and open BK-57 if a ticket is
     split out — it is the next free number), then one validation round
     (traceability + adversarial, separate fresh agents, adversary RUNS the
     breaks in a sandbox), then plan review.
   - If not: validation round on revision 10, same two agents, then plan review.
   Either way, R8-8 + R9-8 + R10-7 are ONE red-first table and a scope change is
   a rule rewrite — re-derive every row against the new scope and say which
   verdicts changed.

4. Only then implement, on bk51-gated. BK-55's two commits (the assertion
   counter first), then BK-53's. Gates before implementation review: npm run
   typecheck, npm run build, and the ticket's own verify scripts, with red-first
   evidence scored on (exit code, summary line) — never on a ✗ count. Note that
   THREE scripts crash without a summary line — verify-booking-pricing prints 1
   ✗, verify-booking-email prints 5, verify-booking-ics prints 0 — so a ✗ count
   is not just unreliable, it varies by script. Run `npm run build` before
   re-measuring anything against dist/: the current build is from 2026-09-05 and
   is not committed.

Rules this project paid for and I want honoured:
- A refutation is a measurement. Enumerate the readings before concluding none
  works. Last session a wrong refutation retired a true finding, and a second
  one nearly sent a whole session down the wrong path — caught only because an
  agent was sent to attack the argument itself.
- After writing a disposition that names a section, grep for that section's
  heading. R9-10 was cited nineteen times before it existed.
- An order issued in prose is not performed. Execute a revision's instructions
  to itself in the same commit, and write the strike where the text lives.
- Check the reviewer brief itself before reusing it.

Expect each round to find real defects and about half of them to be in the fix
for the previous round. That has held for six rounds. But rounds 2 and 3 were
the same class at finer granularity, which is what the open question is about —
so if you find yourself writing revision 12, say so plainly rather than writing
it.

Spawn opus and sonnet agents as you see fit. This project's measured failure
mode is under-gating, not over-gating — BK-51 ran eleven adversarial breaks and
all eleven stayed green — so brief adversarial agents to RUN the break, not read
for it.
