Continuing yeg-restoration-v4, booking area.

*(Rewritten 2026-09-10 at session close. **Decisions 33–42 landed, BK-58 shipped
and was verified live, and the 36 reddened gate arms were adjudicated. NOTHING is
blocked on the user.**)*

---

## 0 · RUN THESE FIVE FIRST — **before trusting any line below**

```sh
git log --oneline -1                     # expect 36b90f6 or later
git log --oneline origin/main..main      # expect EMPTY — main is pushed
git log --oneline main..bk51-gated       # expect 10
git ls-remote --heads origin             # MUST list exactly 3
git diff --name-only main..bk51-gated | grep -vc '^docs/'   # expect 17 — see §6
```

⚠️ **COUNT the refs. Do not `| grep bk51`.** *A grep that finds nothing looks
identical to a grep that never ran and reads as "safe, not pushed."*

🛑 **`bk51-gated` EXISTS ON THIS MACHINE AND NOWHERE ELSE.** It carries BK-51's
production code. **NEVER push it anywhere, including as a backup** —
`git bundle create ../bk51-gated.bundle bk51-gated`. *(A verified bundle was made
2026-09-10; it is still on this machine, so copying it OFF the machine is worth
doing.)*

🔴 **`git push origin main` IS THE DEPLOY.**

---

## 1 · 🔴 THE ONE-LINE STATE

**Both gate tickets still FAIL plan review. Nothing is approved, nothing is
implemented.** ✅ **Nothing is blocked on the user.**

⚠️ **EVERY COUNT ON THIS PAGE WAS SCRIPTED FROM ITS OWN LIST.** *Re-derive before
acting — the script is in §2. This project's own rule, and this page has broken it
twice: a wrong blocker total reached four documents, and its strikethrough claim of
"twelve" measured sixteen.*

| | |
| --- | --- |
| **BK-53** | ⛔ **NOT APPROVED.** `§U-4` **15 of 24** open · `§T-7` **7 of 10** open |
| **BK-55** | ⛔ **NOT APPROVED.** `§Q-6` **15 of 16** · `§R-5` **10 of 10** · `§P-6` **10 of 10** |
| | 🔴 **57 items not done.** *(Not 52 — `§S5b`'s adjudication added `U19`–`U23`.)* |
| **BK-57** | ✅ DEPLOYED, verified. Closed |
| **BK-58** | ✅ **DEPLOYED AND VERIFIED LIVE 2026-09-10.** Closed |
| **BK-51** | unchanged — reviewed, `bk51-gated` only, never pushed |

---

## 2 · RE-DERIVE THE COUNTS — do not inherit them

```sh
python3 - <<'PY'
import io,re
def scan(p,a,b,pat):
    s=io.open(p,encoding="utf-8").read(); i=s.index(a); j=s.index(b,i)
    return [(m.group(1), l.split("|")[1]) for l in s[i:j].split("\n")
            if l.startswith("| ") for m in [re.search(pat,l)] if m]
cls=lambda c: "done" if "✅" in c else ("partial" if "⇄" in c else ("esc" if "🔴" in c else "OPEN"))
for n,p,a,b,pt in [("§U-4","docs/booking/tickets/BK-53.md","## §U-4","## §U-5",r"\*\*(U\d+b?)"),
                   ("§T-7","docs/booking/tickets/BK-53.md","## §T-7","\n# ",r"\*\*(T\d+[ab]?)"),
                   ("§Q-6","docs/booking/tickets/BK-55.md","## §Q-6","## §Q-7",r"\*\*(Q\d+)"),
                   ("§R-5","docs/booking/tickets/BK-55.md","## §R-5","## §R-6",r"\*\*(R\d+)"),
                   ("§P-6","docs/booking/tickets/BK-55.md","## §P-6","## §P-7",r"\*\*(O-\d+)")]:
    rs=scan(p,a,b,pt); nd=[x[0] for x in rs if cls(x[1])!="done"]
    print("%-6s %2d rows, %2d open: %s" % (n,len(rs),len(nd)," ".join(nd)))
PY
```

---

## 3 · 🆕 DECISIONS **30–42**, all in `ROADMAP.md` under *Locked — do not relitigate*

**Thirteen, no gaps.** The ones that change the work:

| # | What |
| --- | --- |
| **33** | **`#37` is answered by a GUARD, not a claim about the population. `A-R8-5` is STRUCK.** → `BK-55.md` `§R` |
| **34** | ⇄ **Preview builds stopped.** ☑️ **USER REPORTS DONE — PENDING AN ARTIFACT, not closed. §4** |
| **35 · 38 · 39** | The hours claim, the founding year, the badges → **all shipped as BK-58** |
| **36** | **The pricing flip ships BEFORE W20/W21** |
| **37** | Insurance billing is **BOTH, per job** — insurers do not pay Stripe invoices |
| **40** | 🔴 **The guard's predicate is the ACK TIMESTAMP. A money proxy was recommended, MEASURED, and WITHDRAWN.** Three protections are part of the decision |
| **41** | **No customer follow-up** for the paid-era population — the job was delivered |
| **42** | **BK-58's copy, approved as proposed** |

---

## 4 · ☑️ THE ONE OPEN OPERATIONAL ITEM — **pending an ARTIFACT**

**The user set Vercel → Settings → Build and Deployment → Ignored Build Step →
*"Only build production"* on 2026-09-10.**

🔴 **`CLAUDE.md`/BK-48: a configuration change is not evidence of its own effect.**
⛔ **It is NOT verifiable from here** — `vercel pull` does not return
`ignoreCommand`. *Checked.*

☑️ **THE PROBE, and it carries the risk it tests, so it is a deliberate choice:**
push a **throwaway** branch to `origin`, confirm its deployment reads
**`Canceled`**, delete the branch. **If the setting took, nothing builds. If it did
not, ONE preview deploy runs with production credentials.**
🛑 **NEVER use `bk51-gated`.**

⚠️ **A green probe closes only half.** The variables are still scoped to Preview at
**production values**. The setting suppresses the BUILD; it unscopes nothing.

---

## 5 · DO THIS, IN ORDER

1. 🔴 **`U19` FIRST — rewrite the 36 reddened arms per `§S5b`.** *It changes what
   the implementation looks like, so doing it after writing code means writing some
   of it twice.* **Then `U20`, which is bigger than `U19`.**
2. **Work the rest of `§U-4`, `§T-7`, `§Q-6`, `§R-5`, `§P-6`.**
   🛑 **Land each at its DESTINATION, never as a new revision layer.**
3. ⛔ **`U13` IS NOT DISCHARGEABLE AT PLAN STAGE and must not be ticked.**
4. **Re-review** — fresh agents, never forks.
5. **Only then implement**, on `bk51-gated`. 🔴 **REBASE FIRST — §6.**

---

## 6 · 🛑 `bk51-gated` — **SEVENTEEN, AND THE NUMBER MOVES EVERY TIME `main` SHIPS**

⛔ ~~SIX~~ ⛔ ~~EIGHT~~ 🔴 **17.** ***This figure has been wrong in every brief that
stated it, because divergence is a TWO-ENDED measurement and briefs record it as a
fact about the branch.*** **The branch did not change. `main` shipped BK-57 and
BK-58.**

```sh
MB=$(git merge-base main bk51-gated)
for f in $(git diff --name-only main..bk51-gated | grep -v '^docs/'); do
  git diff --quiet $MB..bk51-gated -- "$f" && echo "BEHIND: $f" || echo "branch:  $f"
done
```

**6 branch work** *(stable)* · **11 merely BEHIND** — including BK-57's and BK-58's
production copy and **`scripts/verify-trust-claims.ts`, which is not on the branch
at all.**

⚠️ **THE OLD WARNING WAS OVERSTATED.** An ordinary `git merge` would **NOT** revert
a shipped fix — git keeps `main`'s side for files the branch never touched. **The
real hazards: a hard reset · a whole-tree cherry-pick · briefing an agent to read
the branch as if it were current.**

✅ **REBASE EARLY, not last** — the rebase is what brings `verify:trust` across.

---

## 7 · 🔴 THE THREE FINDINGS THAT SHAPE THE REMAINING WORK

- 🔴 **THE 36 ARE MOSTLY *LIVE*, AND THE COUNT INVITES THE WRONG ACTION** — `§S5b`.
  **Only FOUR are stale on their merits.** ⚠️ **FIVE go green for the wrong reason,
  not four** *(the fifth reduces to a tautology once a deleted constant's `indexOf`
  returns `-1`)*. 🔴 **AND 36 IS THE WRONG NUMBER FOR THE TICKET: four more arms are
  INVERTED — "never say free" → "say free, WITH the qualifier" — and those four are
  a bigger rewrite than all 36.** ⚠️ **One arm is LOAD-BEARING BEYOND ITS SUBJECT:
  `:616-618` carries the only assertion that the tier control is TWO-WAY bound.**
  🛑 **The BK-44 trap is pre-named: *"the block must end on the credit"* states a
  rule that OUTLIVES its encoding, so the defence *"it is the new rule made
  visible"* will be offered and is half right.**
- 🔴 **`S3`'s MEASURED CONSTANTS DO NOT RE-DERIVE** — `§S3a`. A second instrument
  reproduces **four of six rows EXACTLY** and **neither headline constant**
  (`MAX_UNIT` 273→**222**, 273 appears nowhere; `MIN_UNITS` 63→**189**).
  ***They are properties of the EXTRACTOR, not of the site.***
- 🔴 **THE GUARD'S CHOKE POINT IS `planForAppointment`
  (`src/lib/booking-admin-notify.ts:164`), NOT `resend.ts`** — `§R-3`. **THREE
  production surfaces reach the terms block from an existing row** and the
  ROADMAP's own trap entry names ONE. *Two agents found the second independently.*
  ⚠️ **The harm needs NO new tooling — `editorMaySetStatus` permits
  `declined → confirmed` today.**

---

## 8 · BRIEFING FRESH AGENTS — every line was paid for

- **Target branch is `bk51-gated`. NEVER push. Do not check it out** — read with
  `git show bk51-gated:<path>`. **Read DOCS with `git show main:<path>` AND SAY SO.**
- 🔴 **A bare `review.ts` is `src/pages/api/admin/appointments/review.ts`**, NOT
  `src/lib/booking-review.ts`. **A bare `resend.ts` is
  `src/pages/api/admin/appointments/resend.ts`; there is no `src/lib/resend.ts`.**
- 🔴 **CITE POSITIONS INSIDE TICKETS BY STRING, NEVER BY LINE.** `§R`, `§S2a`,
  `§S2b`, `§S3a`–`§S3c`, `§S5a`, `§S5b` were all inserted above text they cite.
- 🔴 **Score on (exit code, summary line), NEVER a `✗` count.** A crash and a
  failure are BOTH exit 1; **the ABSENCE of a summary line is the crash signal.**
  ⚠️ 🆕 **And assert the BUILD exit code too** — a failed build leaves `dist/` stale
  and the gate then grades the PREVIOUS build. *Measured this session.*
- 🔴 **Assert the break LANDED. Restore from a `cp` FILE BACKUP, never
  `git checkout --`.**
- ⚠️ 🆕 **A red-first row that REFUSES to go red is telling you your inventory is
  wrong.** *That is how a fifth site spelled `Licensed &amp; Insured` was found.*
- **If a claim in the brief is false, that is a finding.** *Briefs here have been
  wrong at least ten times, including three written the same day.*

---

## 9 · RULES THIS PROJECT PAID FOR

- 🔴 **A NEGATIVE CHECK WITH NO POSITIVE TWIN PASSES ON AN EMPTY DOCUMENT.**
  🆕 **Five of `verify-cutover.ts`'s pins convert from load-bearing to vacuous the
  moment BK-53 deletes their subject — silently, inside an edit that reddens 36.**
- 🔴 **READ THE LIST BESIDE THE NUMBER.** 🆕 **Four more this session:** the
  strikethrough claim of "twelve" *(sixteen)* · `§P-1` re-derives "23 cases"
  *(twenty-six)* · `§R-2`'s summary said "twelve of 31" and did not reconcile with
  its own table · BK-58's row said "16 source sites" *(seventeen)*.
  ✅ **The fix that works: SCRIPT the count over the table's own last column.**
- 🔴 🆕 **AN UNFILLED PLACEHOLDER CAN CHANGE ITS FAILURE DIRECTION WHEN ITS CONSUMER
  CHANGES.** `Invalid Date` failed **benign** under a render and fails **OPEN**
  under a guard. ***Same value, opposite consequence.***
- 🔴 🆕 **AUDIT A COLUMN'S DURABILITY BEFORE KEYING A GUARD ON IT.** Re-approval
  wipes `paid_at`, `payment_method`, `paid_amount_cents` and `payment_reference` in
  ONE statement. **Prefer the column that IS the fact over a proxy for it.**
- 🔴 🆕 **A RULE REWRITE CAN LEAVE A ROW'S VERDICT INTACT AND ITS REASON FALSE.**
  **Six of `§R-2`'s 31 rows are that shape. They read *"no"* at a glance and are the
  rows nobody re-checks.**
- 🔴 🆕 **A DISPOSITION CAN BE CLOSED ON AN ANSWER TO A DIFFERENT QUESTION.** `T9`
  was closed on `§T-4`, which measured a different property. **`S6` carried two
  rows that disagreed for days.**
- 🔴 🆕 **A CLAIM HAS MORE THAN ONE GRAMMAR AND ONLY ONE IS PROSE.** *"Since 2008"*
  was on 5 of 17 pages; `foundingDate` on **17 of 17**. ⚠️ **A live `curl` of the
  homepage returned ZERO and was NOT evidence of absence.**
- 🔴 🆕 **NEVER SIZE A CLAIM FROM A TRUNCATED GREP.** `cut -c1-140` hid a real
  consumer at column ~150. ***The verification and the misreading were the same
  command.***
- 🔴 🆕 **ASSERT EVERY ANCHOR BEFORE ANY WRITE.** A script that wrote file 1 then
  asserted file 2's anchor left the two out of step when the assert failed.
- 🔴 **GREP THE DESTINATION AFTER ANY SCRIPTED EDIT.** ✅ Used for every edit this
  session, and it caught two real errors.
- 🔴 **EXTERNAL BEHAVIOUR → DOCS, NEVER RECALL.** 🆕 *"Settings → Git → disable
  Preview Deployments"* was **wrong page AND a toggle that does not exist**, and it
  reached two documents before anyone looked it up.
- **`npm run build` before measuring against `dist/`** — `verify-cutover.ts` run
  alone leaves a sentinel and says so on exit.
- ⚠️ **Strikethrough scan uses `FNR`, not `NR`:**
  `awk '{n=gsub(/~~/,"~~"); if(n%2==1) print FILENAME": "FNR}' docs/booking/tickets/*.md`
  **`BK-53.md` = 18 odd lines / 9 pairs · `BK-55.md` = 2 / 1 pair · `BK-57.md` and
  `BK-58.md` = ZERO.**
