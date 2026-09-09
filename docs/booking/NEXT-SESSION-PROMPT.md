Continuing yeg-restoration-v4, booking area.

*(Rewritten 2026-09-09 at session close, replacing the version written the same
morning. **Plan review has now RUN on both tickets and both FAILED it.**)*

---

## 0 · RUN THESE FOUR FIRST

```sh
git log --oneline -1                    # expect the session-close commit or later
git log --oneline main..bk51-gated      # expect 10
git ls-remote --heads origin            # MUST list exactly 3: main,
                                        # booking/p1-foundation, deploy-2-prepay
git diff --name-only origin/main..main | grep -v '^docs/'   # see below
```

⚠️ **COUNT the refs. Do not `| grep bk51`.** A grep that finds nothing looks
identical to a grep that never ran and reads as *"safe, not pushed."*

🛑 **`bk51-gated` exists on this machine and nowhere else.** It carries BK-51's
production code. **NEVER push it anywhere, including as a backup** — use
`git bundle create ../bk51-gated.bundle bk51-gated`.

⚠️ **`git push origin main` IS the deploy.** 🔴 **The fourth check is NOT
"must be empty" any more.** BK-57 was deployed on 2026-09-09, so `main` and
`origin/main` are in sync. **Read it as: anything non-docs it lists is an
UNPUSHED PRODUCTION CHANGE. Know what it is before you push.**

---

## 1 · 🔴 THE ONE-LINE STATE

**Both gate tickets FAILED plan review on 2026-09-09. Nothing is approved.
Nothing is implemented. There are TWENTY-THREE blockers, and THREE of them are
blocked on the user** *(plus four carried-forward `ROADMAP` items that are a
different thing — §3)*. *The next job is to work the blockers, not to build.*

⚠️ **Every count on this page was RE-DERIVED from its enumeration on 2026-09-09,
after a cold read caught a wrong one.** ⛔ ~~twenty-five~~ ~~fourteen~~ — *the
error was written from a number rather than a list and reached four documents.*
🔴 **Re-count anything you are about to act on. This project's own rule, and it
was broken by the document that states it.**

| | |
| --- | --- |
| **BK-53** | ⛔ **NOT APPROVED.** **11** blockers — `GB1`–`GB6` *(gate)* + `CB1`–`CB5` *(copy)*. Owed list: **`§U-4`** |
| **BK-55** | ⛔ **NOT APPROVED.** **12** blockers — `QB1`–`QB5` *(rule-rewrite)* + `QG1`–`QG7` *(gate)*. Owed list: **`§Q-6`** |
| **BK-57** | ✅ **DEPLOYED AND VERIFIED 2026-09-09** (`699b099`). Closed |
| **BK-51** | unchanged — reviewed, `bk51-gated` only, never pushed |

---

## 2 · READ, IN THIS ORDER

1. **`HANDOFF-2026-09-05.md`'s LAST section** —
   `grep -n '^# 14 ·' docs/booking/HANDOFF-2026-09-05.md`.
2. **`head -25`** of **`BK-53.md`** and **`BK-55.md`**. 🔴 **Never read a revision
   number from `ROADMAP.md`.**
3. 🔴 **`BK-53.md`'s `§U`** — `grep -n '^## §U-0' docs/booking/tickets/BK-53.md`.
   **The plan review. `§U-4` is the owed list.**
4. 🔴 **`BK-55.md`'s `§Q`** — `grep -n '^## §Q-0' docs/booking/tickets/BK-55.md`.
   **`§Q-6` is the owed list.**
5. **Only then** `BK-53.md`'s `## THE SPEC` (S1–S8) and `BK-55.md`'s `§P`.
   ⚠️ **`THE SPEC` is what the review says is BROKEN. Read `§U` first or you will
   implement the defects.**

⚠️ **BK-53 and BK-55 do NOT exist in usable form on `bk51-gated`.** Read from
`main`. 🔴 **AND A WORKTREE IS NOT `main`** — see §6.

---

## 3 · 🙋 BLOCKED ON THE USER — **THREE fresh, plus a carried-forward bundle**

⚠️ **Rows 1–3 are this round's blockers and gate real work. Row 4 is four
pre-existing `ROADMAP` items and is a DIFFERENT class** — counting them together
is what produced the wrong total above.

| # | Item | Where |
| --- | --- | --- |
| **1** | 🔴 **`A-R8-5` IS FALSE.** The user said *"no such bookings exist"*; **`#37` is a named, real, paying customer in that population** — booked through the web 2026-08-23, a week after terms reached production. **`O-1` is RE-OPENED.** *Three ways out are written in `§Q-1`: run the `SELECT`, name `#37` as an exception with a Resend guard, or leave it recorded as asserted with a named counterexample* | `BK-55.md` `§Q-1` |
| **2** | 🔴 **The travel-fee trigger is FALSE copy.** It says *"outside our service area"*; the fee bills **beyond 30 km** and the site advertises Leduc, Fort Saskatchewan and *"anywhere in Alberta"*. **Proposed:** *"If you're beyond about 30 km from us, a travel fee may apply."* ⛔ **NOT APPLIED** | `BK-53.md` `§U-2` `CB1` |
| **3** | 🔴 **The payment-link claim is FALSE copy**, in the box a customer must TICK. Interac and on-site are schema-level methods with **twenty Interac payments on record**. **Proposed:** *"We never take money without telling you the amount first, and we always tell you how to pay it."* ⛔ **NOT APPLIED** | `BK-53.md` `§U-2` `CB2` |
| **4** | `ROADMAP` human-blocked items **5**, **7**, **9a/9b** — unchanged | `ROADMAP.md` |

---

## 4 · DO THIS, IN ORDER

1. **Get answers to §3's items 1–3.** They change copy and scope.
2. **Work `§U-4` and `§Q-6`**, landing each at its destination. 🛑 **NOT as a new
   revision layer** — that is how this ticket lost rows seven times. **If you find
   yourself writing revision 13 of BK-53, say so plainly rather than writing it.**
3. **Re-review** — the blockers are substantial enough that a fresh pass is owed,
   not a self-check.
4. **Only then implement**, on `bk51-gated`: BK-55's two commits (counter first),
   then BK-53's, then **one adversarial pass at the TIP over the union**, then
   gates, then implementation review, then **one push**.

🔴 **Before that final push, REBASE.** See §5.

---

## 5 · 🛑 `bk51-gated` IS NOW STALE RELATIVE TO PRODUCTION

**The non-docs divergence between `main` and `bk51-gated` went from SIX to EIGHT
on 2026-09-09, and every brief in this repo older than that says six. RE-COUNT.**

- **SIX are BK-51's own work:** `scripts/verify-booking-admin-db.ts`,
  `scripts/verify-booking-review.ts`, `src/lib/booking-payment.ts`,
  `src/lib/booking-review.ts`, `src/pages/admin/appointments/[id].astro`,
  `src/pages/api/admin/appointments/review.ts`.
- 🔴 **TWO are files the branch is merely BEHIND on:** `src/data/services.ts`,
  `src/pages/insurance-claims.astro`. **The branch has NEVER touched either** —
  check with
  `git diff --quiet $(git merge-base main bk51-gated)..bk51-gated -- <file>`.

⚠️ **So `bk51-gated` still carries the three sentences BK-57 REMOVED from the live
site. Merging or cherry-picking it without rebasing would REVERT a shipped
customer-facing fix, and NO GATE WOULD NOTICE** — `verify-cutover.ts` passed with
those sentences live for weeks.

---

## 6 · BRIEFING FRESH AGENTS — every line here was paid for

- **Target branch is `bk51-gated`, not `main`. NEVER push. Do not check it out** —
  read it with `git show bk51-gated:<path>`.
- **EIGHT non-docs files differ; nineteen total, eleven docs.** *(§5.)*
- 🔴 **A bare `review.ts:NNN` means `src/pages/api/admin/appointments/review.ts`**
  (905 lines on the branch, 829 on `main`), **NOT `src/lib/booking-review.ts`**
  (171 on `main`, 209 on the branch, **no line 246**). *Four briefings got this
  wrong.*
- 🔴 **A bare `resend.ts` means `src/pages/api/admin/appointments/resend.ts`.
  There is no `src/lib/resend.ts`.**
- **`booking-email.ts`, `booking-copy.ts`, `resend.ts` and
  `verify-booking-email.ts` are NOT divergent.** **`booking-payment.ts` IS** —
  `:1597` on the branch is `:1567` on `main`.
- 🔴 **GIVE AGENTS THE FILE VIA `git show main:<path>`, AND SAY SO.** Two worktree
  agents on 2026-09-09 were **32 and 34 commits stale** — one read a BK-53 with no
  `THE SPEC` at all, the other a 135-line BK-55 revision-1 stub. **Source was
  byte-identical, which is what makes it invisible.**
- 🔴 **Score on (exit code, summary line), NEVER a `✗` count.** ⚠️ **Measured:
  in `verify-booking-email.ts` a CRASH and an ordinary FAILURE are BOTH exit 1**,
  so **the ABSENCE of a summary line is the crash signal.** `G0` is a
  prerequisite for red-first row 12 meaning anything.
- 🔴 **Assert the break LANDED. Restore from a `cp` FILE BACKUP, never
  `git checkout --`.**
- **If a claim in the brief is false, that is a finding.** *Briefs here have been
  wrong at least seven times, including one written the same day.*

---

## 7 · RULES THIS PROJECT PAID FOR

- 🔴 **A NEGATIVE CHECK WITH NO POSITIVE TWIN PASSES ON AN EMPTY DOCUMENT.**
  **Four instances in one day**: a pin measured vacuous; a check satisfiable by
  deleting every instance of the claim; a live probe that read *"claim removed"*
  off a **301 redirect stub**; and four owed shape families given a
  *body-non-empty* twin that proves the fixture rendered and not that the shapes
  still match anything.
- 🔴 **READ THE LIST BESIDE THE NUMBER.** On 2026-09-09 alone: a wrong exclusion
  count propagated into a fix, a review's own tally did not reconcile with its own
  table, and a check returned five hits of which none belonged to the ticket.
- 🔴 **AFTER A RULE REWRITE, RE-DERIVE EVERY ENUMERATED CASE.** BK-55 did this and
  still dropped **thirteen** — including four an earlier round had dropped once
  and written itself a note about.
- 🔴 **GREP THE DESTINATION AFTER ANY SCRIPTED EDIT.** ✅ Assert-then-write-once
  works: two batches raised on a bad anchor and **wrote nothing**, and the
  destination greps proved it.
- 🔴 **A DISPOSITION TABLE IS A PROMISSORY NOTE.** A trap marked ✅ ACCEPTED was in
  no file for weeks.
- **`npm run build` before measuring against `dist/`** — `verify-cutover.ts` run
  alone leaves a sentinel and says so on exit.
- 🔴 **HALF OF EACH ROUND'S FINDINGS ARE IN THE PREVIOUS ROUND'S FIX.** Three of
  BK-53's six gate blockers are defects in corrections landed the same morning.
  **Expect this. It is not a reason to stop reviewing.**
- 🔴 🆕 **A SECTION THAT QUOTES LINE NUMBERS BECOMES SELF-FALSIFYING THE MOMENT
  IT IS INSERTED ABOVE THEM.** Writing `§U` and `§Q` pushed everything they cite
  down by **~400 lines**, so **every intra-ticket line number in both is stale by
  construction** — true when measured, false as shipped. **Both carry a banner
  saying so. GREP THE QUOTED STRING; never go to the line.** *(`src/` and
  `scripts/` citations are unaffected and were verified exact.)* **When you cite
  a position inside a document you are also editing, cite a STRING.**
- ⚠️ 🆕 **The strikethrough scan must use `FNR`, not `NR`.** Across multiple
  files `NR` is cumulative and reports line numbers that do not exist:
  `awk '{n=gsub(/~~/,"~~"); if(n%2==1) print FILENAME": "FNR}' docs/booking/tickets/*.md`.
  **`BK-53.md`'s twelve hits are all legitimate multi-line blocks** — verified
  pair by pair. **`BK-55.md` and `BK-57.md` must be ZERO.**
