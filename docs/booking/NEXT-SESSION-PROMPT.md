Continuing yeg-restoration-v4, booking area.

*(Rewritten 2026-09-09 at session close. The previous prompt is replaced: its
validation round is DONE, and two of its three blocked-on-user items are
ANSWERED.)*

---

## 0 · RUN THESE FOUR BEFORE TRUSTING ANY LINE BELOW

```sh
git log --oneline -1                    # expect b0ef1f2 or later
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

⚠️ **`git push origin main` IS the deploy.** 🔴 **THE FOURTH CHECK CHANGED
MEANING THIS SESSION.** It is no longer *"must be empty."* **BK-57 was deployed
on 2026-09-09, so `main` and `origin/main` are now IN SYNC and the check is
empty because everything is pushed, not because nothing is stageable.**
**→ Re-read it as: anything non-docs it lists is an UNPUSHED PRODUCTION CHANGE.
Know what it is before you push.**

---

## 1 · READ, IN THIS ORDER

1. **`docs/booking/HANDOFF-2026-09-05.md`, its LAST section** — find it with
   `grep -n '^# 13 ·' docs/booking/HANDOFF-2026-09-05.md`.
2. **`head -20`** of **`BK-53.md`** and **`BK-55.md`**. 🔴 **Never read a
   revision number from `ROADMAP.md`.**
3. ⭐ **`BK-53.md`'s `## THE SPEC` (S1–S8)** — **to implement, read ONLY that.**
   ⚠️ **`S2` was CORRECTED on 2026-09-09 and is materially different.**
4. **`BK-53.md`'s `§T`** — `grep -n '^# 🟦 §T' docs/booking/tickets/BK-53.md`.
   The validation round. **It changed the gate's DESIGN.**
5. **`BK-55.md`'s `§P`** (revision 8, the spec) — `grep -n '^## §P-0'` — **and
   `§N`** (the validation round), `grep -n '^# 🟦 §N'`.

⚠️ **BK-53 and BK-55 do NOT exist in usable form on `bk51-gated`.** Read from
`main`. 🔴 **AND A WORKTREE IS NOT `main`** — see §5.

---

## 2 · WHAT IS DECIDED — do not re-open

| | |
| --- | --- |
| **The coupling unit** | 🔴 **KEEP THE SENTENCE UNIT.** Answered TWICE. *Two proposals have failed; a third needs new EVIDENCE, not new argument* |
| 🆕 **Decision 30** | ✅ **THE PAID-ERA BRANCH COLLAPSES.** User, 2026-09-09: *"we dont have to worry about existing bookings made on current terms which we are about to change."* Three readings were offered; they chose **collapse**. → `BK-55.md` `§P` |
| 🆕 **BK-55 needs NO client sign-off** | ⇄ `TERMS_PRIOR_LINE` is **deleted**. **This ticket now adds no customer-facing copy at all** |
| **BK-53's shape** | ✅ `THE SPEC` at the top; **delete nothing, strike instead** |
| **The split** | ✅ BK-53 = web, BK-55 = email. 🆕 **BK-57 is OPENED AND DEPLOYED, and it is NOT a gate ticket** — decision 24 is unchanged. **Next free is BK-58** |

---

## 3 · DO THIS, IN ORDER

**1 · PLAN REVIEW on each ticket — fresh agents.** The validation round is done;
plan review is the only gate left before implementation.

🔴 **Brief every agent with all of this:**
- **Target branch is `bk51-gated`, not `main`.** **NEVER push. Do not check out
  the branch** — read it with `git show bk51-gated:<path>`.
- 🔴 **EIGHT non-docs files differ** between `main` and `bk51-gated` — ⚠️ **it
  was SIX until 2026-09-09, and every earlier brief says six. RE-COUNT, do not
  inherit.** `git diff --name-only` now lists **nineteen**; eleven are docs.
  **The eight split into two kinds, and the difference matters:**
  - **SIX are BK-51's own work:** `scripts/verify-booking-admin-db.ts`,
    `scripts/verify-booking-review.ts`, `src/lib/booking-payment.ts`,
    `src/lib/booking-review.ts`, `src/pages/admin/appointments/[id].astro`,
    `src/pages/api/admin/appointments/review.ts`.
  - 🔴 **TWO are BK-57's, and the branch is simply BEHIND on them:**
    `src/data/services.ts`, `src/pages/insurance-claims.astro`. **`bk51-gated`
    has NEVER touched either file** — verify with
    `git diff --quiet $(git merge-base main bk51-gated)..bk51-gated -- <file>`.

🛑 🆕 **THEREFORE: `bk51-gated` IS NOW STALE RELATIVE TO PRODUCTION.** It predates
BK-57's deploy, so **it still carries the three sentences BK-57 removed from the
live site.** ⚠️ **Merging or cherry-picking this branch without rebasing would
REVERT a shipped customer-facing fix**, and no gate in this repo would notice —
`verify-cutover.ts` passed with those sentences live for weeks. **Rebase
`bk51-gated` onto `main`, or confirm the two files come from `main`, BEFORE the
final push.**
- 🔴 **A bare `review.ts:246` means `src/pages/api/admin/appointments/review.ts`**
  (905 lines on the branch), **NOT `src/lib/booking-review.ts`** (171 on `main`,
  209 on the branch, **no line 246**). *Four briefings got this wrong.*
- 🔴 **A bare `resend.ts` means `src/pages/api/admin/appointments/resend.ts`.
  There is no `src/lib/resend.ts`.**
- **`booking-email.ts`, `resend.ts`, `verify-booking-email.ts` are NOT
  divergent.** **`booking-payment.ts` IS** — `:1597` on the branch is `:1567` on
  `main`.
- 🔴 **GIVE THEM THE FILE VIA `git show main:<path>`, and say so.** A worktree
  agent's docs were **32 and 34 commits stale** on 2026-09-09 — one read a BK-53
  with no `THE SPEC` at all, the other a 135-line BK-55 revision-1 stub. **Source
  was byte-identical, which is what makes it invisible.**
- 🔴 **Score on (exit code, summary line), NEVER a `✗` count.** ⚠️ 🆕 **AND
  MEASURED 2026-09-09: at this commit a CRASH AND A FAILURE ARE BOTH `EXIT 1` in
  `verify-booking-email.ts`.** So the rule means **the ABSENCE of a summary line
  is the crash signal** — not "exit 2". **`G0` is a prerequisite for red-first
  row 12 meaning anything.**
- 🔴 **Assert the break LANDED. Restore from a FILE BACKUP (`cp`), never
  `git checkout --`.**
- **If a claim in the brief is false, that is a finding.**

**2 · Then implement, on `bk51-gated`:** BK-55's two commits (counter first),
then BK-53's, then **one adversarial pass at the TIP over the union**, then
gates, then implementation review, then **one push**.

---

## 4 · WHAT THE VALIDATION ROUND FOUND — this is the work

**BK-53 — `§T`. The gate's DESIGN changed; `S2` already carries all three.**
- 🔴 **The corpus needs a `.js` arm.** A hydration-rendered price is in no HTML
  file. `verify-cutover.ts:1029-1030` is already `.html || .js`. **THREE
  independent instances found on 2026-09-09, none planted** — including
  **every FAQ answer on the site**, via `services.*.js`. **An HTML-only corpus
  misses the largest body of prose the site has.**
- 🔴 **The corpus needs a CLOSURE.** `export const prerender = false;` removes a
  page in one line; the gate's output goes **byte-identical to baseline**,
  `verify-cutover` exits `0`, and a `$150` ships live. **Per-file assertions
  structurally cannot see a missing file.**
- 🔴 **The corpus needs a SCOPE LIST**, or the gate is **red on arrival on the
  client's blog and `insurance-claims`** (six findings).
- **The bans miss four classes** the thirteen spellings do not contain:
  fullwidth Unicode, JSON-LD `Offer.price`, `value=` on a submit button, CSS
  `content:`. **And the free shapes miss "free inspection/estimate/quote".**
- **The adjacency relief is satisfiable by a LIE** (*"There is never a travel
  fee."*) **and by INVISIBLE text** (an `sr-only` span).
- ✅ **`S3` and `S4` are CONFIRMED** — reproduced exactly by a second
  independent implementation.
- **`§T-7` is the owed list. `T1` is done; `T1b`–`T9` are not.**

**BK-55 — `§N` + `§P`.**
- 🔴 **NINETEEN of thirty breaks GREEN; fifteen put a real price, a false promise
  or a false status in a customer's inbox.** `§N-3` is the list, each with the
  assertion owed **and its positive twin.** **This is the ticket's real work.**
- 🔴 **`§L-4` is UNDERSTATED:** the canonical `$` shape ships green on the request
  email because **no money regex ever runs against a request body.** Widening
  shapes without instantiating pins fixes none of it.
- 🔴 **`397 / 417` are RETIRED, not re-measured — they cannot exist.** The script
  prints no number. Baseline is `EXIT=0`, `✓ booking notification checks passed`.
- **`§P-6` is the owed list.**

---

## 5 · RULES THIS PROJECT PAID FOR

- 🔴 **A CONSTANT WITH NO RED-FIRST ROW IS UNTESTED, NOT WORTHLESS.** ⚠️ 🆕
  **But that rule is about deleting for an EMPTY CATCH RECORD.** Deleting because
  **the thing it asserts about no longer exists** is legitimate and different —
  `BK-55.md` `§P-2` states the distinction, and makes it checkable.
- 🔴 **GREP THE DESTINATION AFTER ANY SCRIPTED EDIT.** ✅ **A batch that raises
  wrote NOTHING on 2026-09-09 and the greps proved it** — assert before writing,
  write once at the end.
- 🔴 **A DISPOSITION TABLE IS A PROMISSORY NOTE.** `A11-14` was ✅ ACCEPTED while
  in no file; it is in ROADMAP Known traps now.
- 🔴 **A NEGATIVE CHECK WITH NO POSITIVE TWIN PASSES ON AN EMPTY DOCUMENT.**
  ⚠️ **THREE instances in one session**: `G4b` (vacuous, measured), BK-57's `V4`
  (satisfiable by deleting every claim on the site), and BK-57's **live probe**,
  which read *"old claim gone"* off a **301 redirect stub** because `curl` had no
  `-L`. **Always pair the negative with a positive.**
- 🔴 **READ THE LIST BESIDE THE NUMBER.** BK-57's `V4` returned five and not one
  was its own.
- 🔴 **AFTER A RULE REWRITE, RE-DERIVE EVERY ENUMERATED CASE.** Decision 30 did
  this in `§P-1`; two rows would otherwise have vanished silently.
- **`npm run build` before measuring against `dist/`** — the sentinel is real and
  is now in ROADMAP Known traps.

---

## 6 · 🙋 BLOCKED ON THE USER

1. ✅ **CLOSED 2026-09-09 by DECISION 31 — nothing owed here.** ~~Decision 30 has a consequence they should see — `BK-55.md` `§P-4`.~~
   A customer who accepted the **paid** terms is shown the **free** terms block
   on a resend, and **their refund entitlement is stated only in that block.**
   **It is not a new defect class — it ENLARGES `§H-4`'s population** from
   post-flip hand-charged rows to those plus every paid-era row. ⚠️ **The size of
   that population has never been measured** — §G's *"NOT KNOWN"* item 2 has
   wanted a production `SELECT` since revision 4. **Decision 30 removes this
   ticket's NEED for it; it does not answer it.**
   ⇄ ✅ **THE USER ANSWERED IT INSTEAD:** *"ignore refund entitlement question as
   no such bookings exist."* **The paid-era population is EMPTY, so decision 30
   enlarges §H-4 by ZERO.** ⚠️ **ASSERTED BY THE OWNER, NOT MEASURED —
   `A-R8-5`.** ⚠️ **§H-4's ORIGINAL population (post-flip hand-charged rows) is
   UNTOUCHED and still open.**
2. `ROADMAP` human-blocked index items **5** (Vercel Preview isolation), **7**
   (W20/W21 ordering), **9a/9b** (client questions) — unchanged.

✅ **RESOLVED THIS SESSION:** `TERMS_PRIOR_LINE`'s sign-off *(moot — decision 30
deletes it)*, the three decision-20 pages *(BK-57, deployed and verified)*, and
the refund-entitlement question *(decision 31 — the population is empty)*.

🛑 **NOTHING IS PENDING A PUSH.** `main` and `origin/main` are in sync and the
tree is clean. **The next push is the BIG one** — BK-51 + BK-53 + BK-55 together,
and it cannot happen until BK-53 and BK-55 are **implemented and
implementation-reviewed**, which they are not. **Plan review has not run.**

---

⚠️ **Expect plan review to find real defects. That has held for eight rounds.**
**If you find yourself writing revision 13 of BK-53, say so plainly rather than
writing it** — and consider whether the finding belongs in `THE SPEC` or in `§T`.
