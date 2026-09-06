# The prompt for the next session

*Written 2026-09-06 at session close. Copy the block below verbatim.*

---

```
Continuing yeg-restoration-v4, booking area.

Read docs/booking/HANDOFF-2026-09-05.md — its LAST numbered section first,
then work backwards. Run its §0 checks before trusting any line in it.
Do not read a revision number from ROADMAP.md; run
`head -20 docs/booking/tickets/BK-53.md` for the real one.

Standing rule, absolute: NEVER push bk51-gated to any remote, including as a
backup. It is local-only and holds BK-51's production code. Use git bundle.
`git ls-remote --heads origin` must return exactly 3 refs — count them, never
grep for absence.

State: BK-51 is reviewed and gated on GATE 1 only (GATE 2 was discharged
2026-09-03). GATE 1 is now two tickets — BK-53 revision 7 (web) and BK-55
revision 3 (email). Both are NOT APPROVED and revision 7 / revision 3 are
NOT YET VALIDATED. All three ship in ONE push on bk51-gated, BK-55's commits
first.

Do this, in order:

1. Fold in the validation findings already recorded at the end of BK-53 R7
   and BK-55 §H, if any remain open. Then run a traceability audit and an
   adversarial pre-read of revision 7 / revision 3 as SEPARATE FRESH AGENTS.
   Brief both that the target branch is bk51-gated, that its approval path
   differs from main, and that only six files differ between the branches.
   The adversarial agent should RUN the break in a sandbox, not reason about
   it — the last three passes each found a real defect that way and the two
   before them did not.

2. When both come back clean, take BK-53 and BK-55 to plan review — one fresh
   agent each, same briefing.

3. Only then implement, on bk51-gated. BK-55's two commits (the assertion
   counter first, then the rest), then BK-53's. Gates before implementation
   review: npm run typecheck, npm run build, and the ticket's own verify
   scripts, with red-first evidence scored on (exit code, summary line) —
   never on a ✗ count.

Expect each round to find real defects, and expect about half of them to be in
the fix for the previous round. That has been true for four rounds and the
findings are narrowing, not repeating.

Spawn opus and sonnet agents as you see fit.
```

---

## Why the prompt is shaped this way

- **"LAST numbered section first"** — the handoff grows a section per session, and
  a pointer naming a number went stale the same day it was written.
- **"do not read a revision number from ROADMAP"** — it has been two revisions
  behind twice. The tickets are reliable; the index files are not.
- **"count them, never grep for absence"** — CLAUDE.md's BK-33 trap. A grep that
  finds nothing looks identical to a grep that never ran.
- **"RUN the break in a sandbox"** — the two passes that executed breaks found
  defects four review rounds had missed. The two that reasoned found less.
- **"expect half the findings to be in the previous fix"** — sets the right
  expectation so a clean-looking round is treated as suspicious rather than final.
