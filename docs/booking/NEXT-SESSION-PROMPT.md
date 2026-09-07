Continuing yeg-restoration-v4, booking area.

*(Written 2026-09-07 at session close. The previous prompt is replaced entirely —
it had gone stale in four ways and told a session to act on a decision that had
since been reversed.)*

---

## 0 · RUN THESE THREE BEFORE TRUSTING ANY LINE BELOW

```sh
git log --oneline -1                    # expect 959110f or later
git log --oneline main..bk51-gated      # expect 10
git ls-remote --heads origin            # MUST list exactly 3: main,
                                        # booking/p1-foundation, deploy-2-prepay
```

⚠️ **COUNT the refs. Do not `| grep bk51`.** A grep that finds nothing looks
identical to a grep that never ran and reads as *"safe, not pushed."* That is
CLAUDE.md's BK-33 trap.

🛑 **`bk51-gated` exists on this machine and nowhere else.** It carries BK-51's
production code. **NEVER push it anywhere, including as a backup** — use
`git bundle create ../bk51-gated.bundle bk51-gated`.
⚠️ **`git push origin main` IS the deploy.** Docs pushes are safe. **Right now
`main` is 29 commits ahead of `origin/main` and all 29 are docs-only** — verify
with `git diff --name-only origin/main..main | grep -v '^docs/'` before believing
that.

---

## 1 · READ, IN THIS ORDER — and nothing else to start

1. **`docs/booking/HANDOFF-2026-09-05.md` §12** — the last section. It carries
   this session's state, the three decisions, the measured constants and the five
   new traps.
2. **`head -30 docs/booking/tickets/BK-53.md`** and
   **`head -30 docs/booking/tickets/BK-55.md`**. 🔴 **Never read a revision number
   from `ROADMAP.md`.**
3. ⭐ **`BK-53.md`'s `## THE SPEC` section (S1–S8).** **To implement, read ONLY
   that.** BK-53 is ~7,550 lines with twelve revisions; the spec is the merged
   current state and **where it and a revision disagree, the spec wins.**
4. **`BK-55.md`'s `§M`** (revision 7) and **`§L-9`**.

⚠️ **BK-53 and BK-55 do NOT exist in usable form on `bk51-gated`** — BK-53 is a
212-line draft there and BK-55 is absent. **Read them from `main`.**

---

## 2 · WHAT IS DECIDED — do not re-open any of these

| | |
| --- | --- |
| **The coupling unit** | 🔴 **KEEP THE SENTENCE UNIT** with the three-tier same-or-next adjacency. **Answered TWICE** — the user chose a BLOCK unit and withdrew it the same day after measurement. `MAX_UNIT`, `MIN_UNITS`, the residue rule and `A-R10-4` are all **restored**. **Both bans kept.** *Two proposals to change the unit have failed; a third needs new EVIDENCE, not new argument* |
| **BK-55's `termsEra` guard** | ✅ **Route (e): the sentence changes so no guard is needed.** `TERMS_PRIOR_LINE`. **No new field, no fifth arm, `termsEra` stays four-valued** |
| **BK-53's shape** | ✅ **`THE SPEC` at the top; delete nothing.** A re-baseline was rejected — rewrites are how this project loses rows |
| **The split** | ✅ Decision 24: BK-53 = web, BK-55 = email. **BK-57 is UNOPENED and stays that way** |

---

## 3 · DO THIS, IN ORDER

**1 · One validation round on EACH ticket — four fresh agents, in parallel.**

Per ticket: a **traceability audit** (*"what is in a review or a prior revision
and absent from the current one with no stated reason?"*) and an **adversarial
pre-read** (*"assuming this ships as written, what still ships GREEN?"*).

🔴 **Brief every agent with all of this:**
- **Target branch is `bk51-gated`, not `main`.** **NEVER push. Do not check out
  the branch** — read it with `git show bk51-gated:<path>`.
- **SIX NON-DOCS files differ** between `main` and `bk51-gated`:
  `scripts/verify-booking-admin-db.ts`, `scripts/verify-booking-review.ts`,
  `src/lib/booking-payment.ts`, `src/lib/booking-review.ts`,
  `src/pages/admin/appointments/[id].astro`,
  `src/pages/api/admin/appointments/review.ts`.
  `git diff --name-only` lists **sixteen**; ten are docs.
- 🔴 **A bare `review.ts:246` means `src/pages/api/admin/appointments/review.ts`**
  (905 lines on the branch), **NOT `src/lib/booking-review.ts`** (171 on `main`,
  209 on the branch, **no line 246**). *Four consecutive briefings got this wrong.*
- 🔴 **A bare `resend.ts` means `src/pages/api/admin/appointments/resend.ts`.
  There is no `src/lib/resend.ts`.** *A briefing invented it.*
- **`booking-email.ts`, `resend.ts` and `verify-booking-email.ts` are NOT
  divergent**, so their line numbers are valid on either branch.
  **`booking-payment.ts` IS** — `:1597` on the branch is `:1567` on `main`.
- **The copy is approved (decision 26)** — challenge on truth and on whether a
  pin matches, never on taste. ⚠️ **EXCEPT `TERMS_PRIOR_LINE`, which is new and
  awaits the client.**
- **Give the adversary a worktree** *(`isolation: "worktree"`)* **and tell it to
  RUN the breaks.** This project's measured failure mode is UNDER-gating: BK-51
  ran eleven breaks and eleven stayed green.
- 🔴 **Score on (exit code, summary line), NEVER a `✗` count.** Three scripts
  crash without a summary line — `verify-booking-pricing` prints 1 `✗`,
  `verify-booking-email` 5, `verify-booking-ics` 0.
- 🔴 **Assert the break LANDED before scoring it. Restore from a FILE BACKUP
  (`cp`), never `git checkout --`** — it reverts to HEAD and eats uncommitted work.
- **If a claim in the brief is false, that is a finding.** Briefs here have been
  wrong at least six times.

**2 · Then plan review on each, also fresh agents.**

**3 · Only then implement, on `bk51-gated`:** BK-55's two commits (the assertion
counter first), then BK-53's, then **one adversarial pass at the TIP over the
union**, then gates, then implementation review, then **one push**.

---

## 4 · KNOWN OPEN ITEMS — expect the round to find these; they are not news

- **BK-53:** `WEB_AMOUNT_BAN` misses **nine of the thirteen** spellings tested —
  *"The travel fee is 150."* ships green. **The shapes must widen.** And
  **`head:title` and `attr` have no red-first row.**
- **BK-53:** **`MAX_UNIT` must be measured over OWNED pages only** — the global
  max (273) is set by a **client-authored blog post**; owned max is **222**.
- **BK-55:** 🔴 **At commit (b) NOTHING pins the request email** — all three money
  regexes are on **confirmed**-arm fixtures. **Six planted defects shipped
  green.** G1's row ordered *"BOTH message types"* and nothing performed it.
- **BK-55:** the `397 / 417` check counts come from **one agent's run**; this
  session reproduced the `✗ 10` and the baseline, **not those.** Re-measure.
- **Client:** `TERMS_PRIOR_LINE` needs sign-off.

---

## 5 · RULES THIS PROJECT PAID FOR — honour them

- 🔴 **A CONSTANT WITH NO RED-FIRST ROW IS UNTESTED, NOT WORTHLESS.** Before
  deleting any assertion for an empty catch record, **write the row that would
  catch its failure and RUN it.** Two constants were deleted on that reasoning
  and each was the only detector of a real failure.
- 🔴 **GREP THE DESTINATION AFTER ANY SCRIPTED EDIT.** A batch that raises later
  **discards earlier edits while their `OK` lines stay on screen.** Happened
  twice last session.
- 🔴 **A DISPOSITION TABLE IS A PROMISSORY NOTE.** *"✅ applied in place"* is the
  same act as *"→ PERFORMED"*. An audit found **6 of 11** and **10 of 14** claimed
  corrections untouched, and three destinations that did not exist.
- 🔴 **SANDBOX THE COMMIT, NOT THE FINDING.** Diff the sandbox against the
  sequencing section's contents and say which items were in it.
- 🔴 **A REFUTATION IS A MEASUREMENT.** Enumerate the readings before concluding
  none works. A wrong refutation retires a TRUE finding.
- 🔴 **READ THE LIST BESIDE THE NUMBER.** *"14 of 19"* and *"53 rows"* were both
  wrong and both propagated.
- **After writing a disposition that names a section, `grep` for its heading.**
- **`npm run build` before measuring anything against `dist/`** — and note
  `verify-cutover.ts` alone leaves a **sentinel build** behind.

---

## 6 · 🙋 BLOCKED ON THE USER

1. **`TERMS_PRIOR_LINE` needs the client's sign-off** — new customer-facing copy,
   not covered by decision 26.
2. **The three decision-20 pages are still unowned** —
   `insurance-claims.astro:70`, `services.ts:389`, `services.ts:291` say the
   assessment produces a written document, which decision 20 makes false.
   **HIGH, customer-facing, wrong today, belongs to no ticket.** *Worth asking
   whether this should jump the queue ahead of GATE 1.*
3. `ROADMAP` human-blocked index items **5** (Vercel Preview isolation), **7**
   (W20/W21 ordering), **9a/9b** (client questions) — unchanged.

---

⚠️ **Expect each round to find real defects, and about half of them to be in the
fix for the previous round. That has held for seven rounds.** The findings do get
narrower. **If you find yourself writing revision 13 of BK-53, say so plainly
rather than writing it** — and consider whether the finding belongs in `THE SPEC`
instead of in a new revision layer.
