Continuing yeg-restoration-v4, booking area.

*(Rewritten 2026-09-10 at session close, then CORRECTED the same hour after a
cold-read audit judged the first version unusable: **"I could not start from it
alone."** What it was missing is now §1 and §6.)*

---

## 0 · WHAT THIS WORK IS — **read this before anything else**

**The client stopped charging for assessments.** Two tickets carry the change and
NEITHER IS IMPLEMENTED:

| | |
| --- | --- |
| **BK-53** | **THE WEB HALF.** Take every price off every web surface, delete the refund promise, drop the weekend surcharge — **and add a build-time gate so a price or a bare *"free"* claim cannot creep back.** The visit is free **but a travel fee may apply**, so every *"free"* claim must carry that qualifier where the customer reads it, and **`$150` must never appear on any web surface** (decision 25, absolute). |
| **BK-55** | **THE EMAIL HALF.** The same removals in the customer emails, **plus a guard** (decision 33) so the office cannot send today's free terms to a customer who agreed to the PAID terms. |

🔴 **WHICH DOCUMENT IS AUTHORITATIVE, because both tickets are thousands of lines
of superseded revision layers:**

- **`BK-53.md` → `## THE SPEC` (`S1`–`S8`)**, as amended by `§S2a`, `§S2b`,
  `§S3a`–`§S3c`, `§S5a`, `§S5b`. ⚠️ **`THE SPEC` is ALSO what the plan review says
  is BROKEN — read `§U` FIRST or you will implement the defects.**
- **`BK-55.md` → `§P`**, as amended by **`§R`** (decisions 33/40/41).
  **Where `§P` and `§R` disagree, `§R` wins.**
- **The COPY chain:** `R6-2` is the BASE, then `R7-3b` → `R8-3c` → `§V`
  (decision 32, terminal). ⛔ **Do NOT reconstruct *"revision 3 §1 + §5a"* — it
  does not exist and the nearest thing to it is FALSE.** *(`§S2b`.)*

---

## 1 · RUN THESE FIVE FIRST — before trusting any line below

```sh
git log --oneline -1                     # expect e8e2492 or later
git log --oneline origin/main..main      # see the rule below
git log --oneline main..bk51-gated       # expect 10
git ls-remote --heads origin             # MUST list exactly 3
git diff --name-only main..bk51-gated | grep -vc '^docs/'   # expect 17 — §7
```

⚠️ **COUNT the refs. Do not `| grep bk51`.** *A grep that finds nothing looks
identical to a grep that never ran and reads as "safe, not pushed."*

🔴 **CHECK 2 IS NOT "MUST BE EMPTY".** **Anything NON-DOCS it lists is an
UNPUSHED PRODUCTION CHANGE — know what it is before you push.** *Docs-only
commits are safe to push and `git push origin main` IS THE DEPLOY.*

🛑 **`bk51-gated` EXISTS ON THIS MACHINE AND NOWHERE ELSE.** It carries BK-51's
production code. **NEVER push it anywhere, including as a backup** —
`git bundle create ../bk51-gated.bundle bk51-gated`. *(A bundle was created and
`git bundle verify`-ed on **2026-09-09**; it is still on this machine, so copying
it OFF the machine is worth doing.)*

---

## 2 · 🔴 THE ONE-LINE STATE

**Both gate tickets still FAIL plan review. Nothing is approved, nothing is
implemented.** ✅ **Nothing is blocked on the user.**

⚠️ **EVERY COUNT HERE WAS SCRIPTED FROM ITS OWN LIST — re-derive with §3.**
*This page has stated a wrong number twice: a blocker total that reached four
files, and a strikethrough claim of "twelve" that measured sixteen.*

| Ticket | Owed lists — **all figures are OPEN / TOTAL** |
| --- | --- |
| **BK-53** | ⛔ **NOT APPROVED.** `§U-4` **15 open of 24** · `§T-7` **7 open of 10** |
| **BK-55** | ⛔ **NOT APPROVED.** `§Q-6` **15 open of 16** · `§R-5` **10 open of 10** · `§P-6` **10 open of 10** |
| | 🔴 **57 OPEN.** *(Not 52 — `§S5b`'s adjudication added `U19`–`U23`.)* |
| **BK-57 · BK-58** | ✅ Deployed and verified. Closed |
| **BK-51** | reviewed, `bk51-gated` only, never pushed |

---

## 3 · RE-DERIVE THE COUNTS — do not inherit them

```sh
python3 - <<'PY'
import io,re
def scan(p,a,b,pat):
    s=io.open(p,encoding="utf-8").read(); i=s.index(a); j=s.index(b,i)
    return [(m.group(1), l.split("|")[1]) for l in s[i:j].split("\n")
            if l.startswith("| ") for m in [re.search(pat,l)] if m]
cls=lambda c: "done" if "\u2705" in c else "OPEN"
for n,p,a,b,pt in [("U-4","docs/booking/tickets/BK-53.md","## \u00a7U-4","## \u00a7U-5",r"\*\*(U\d+b?)"),
                   ("T-7","docs/booking/tickets/BK-53.md","## \u00a7T-7","\n# ",r"\*\*(T\d+[ab]?)"),
                   ("Q-6","docs/booking/tickets/BK-55.md","## \u00a7Q-6","## \u00a7Q-7",r"\*\*(Q\d+)"),
                   ("R-5","docs/booking/tickets/BK-55.md","## \u00a7R-5","## \u00a7R-6",r"\*\*(R\d+)"),
                   ("P-6","docs/booking/tickets/BK-55.md","## \u00a7P-6","## \u00a7P-7",r"\*\*(O-\d+)")]:
    rs=scan(p,a,b,pt); nd=[x[0] for x in rs if cls(x[1])!="done"]
    print("%-4s %2d rows, %2d OPEN: %s" % (n,len(rs),len(nd)," ".join(nd)))
PY
```

---

## 4 · 🆕 DECISIONS **30–42** — `ROADMAP.md`, under *Locked — do not relitigate*

**Thirteen, no gaps, verified.** ⚠️ **All thirteen matter; these are the ones you
will trip over:**

| # | What |
| --- | --- |
| **30** | 🔴 **THE PAID-ERA BRANCH COLLAPSES** — a row that acknowledged terms renders the CURRENT terms block, whenever it acknowledged them. ***This is the rule `§P-1` was derived under and `§R-2` re-derives against.*** |
| **32** | **Two APPROVED sentences were FALSE and are replaced** — the travel-fee trigger and the payment-link claim. **Terminal for the copy.** ☐ **Its control is still owed — `U1b`** |
| **33** | **`#37` is answered by a GUARD, not a claim about the population. `A-R8-5` is STRUCK** → `BK-55.md` `§R` |
| **34** | ⇄ **Preview builds stopped.** ☐ **USER REPORTS DONE — PENDING AN ARTIFACT, §5** |
| **35 · 38 · 39** | hours · founding year · badges → **shipped as BK-58** |
| **36** | **The pricing flip ships BEFORE W20/W21** |
| **37** | Insurance billing is **BOTH, per job** |
| **40** | 🔴 **The guard's predicate is the ACK TIMESTAMP. A money proxy was recommended, MEASURED, and WITHDRAWN.** Three protections are part of the decision |
| **41** | **No customer follow-up** for the paid-era population |
| **42** | **BK-58's copy, approved as proposed** |

---

## 5 · ☐ THE ONE OPEN OPERATIONAL ITEM — **pending an ARTIFACT**

**The user set Vercel → Settings → Build and Deployment → Ignored Build Step →
*"Only build production"*, 2026-09-10.**

🔴 **`CLAUDE.md`/BK-48: a configuration change is not evidence of its own
effect.** ⛔ **NOT verifiable from here** — `vercel pull` returns nine settings and
`ignoreCommand` is not among them. *Checked.*

☐ **THE PROBE — an ACTION YOU MUST TAKE, and it carries the very risk it tests:**
push a **throwaway** branch to `origin`, confirm its deployment reads
**`Canceled`**, delete the branch. **If the setting took, nothing builds. If it
did not, ONE preview deploy runs with production credentials.**
🛑 **NEVER use `bk51-gated`.**
⚠️ **While the probe branch exists, §1's *"exactly 3 refs"* is temporarily false
BY DESIGN.** *Delete the branch and re-check.*

⚠️ **A green probe closes only HALF.** The variables are still scoped to Preview
at **production values**; the setting suppresses the BUILD and unscopes nothing.

---

## 6 · 🔴 THE SEQUENCE — **restored 2026-09-10; a rewrite had dropped it**

⚠️ ***This project's own "revisions drop rows" trap, occurring in the handoff.***

1. 🔴 **`U19` FIRST — rewrite the 36 reddened arms per `§S5b`.** *It changes what
   the implementation looks like; doing it after writing code means writing some
   of it twice.* **Then `U20`, which is bigger than `U19`.**
2. **Work the rest of `§U-4`, `§T-7`, `§Q-6`, `§R-5`, `§P-6`.**
   🛑 **Land each at its DESTINATION, never as a new revision layer.**
3. **Re-review** — fresh agents, never forks, briefed per §9.
4. **Then implement, on `bk51-gated`, IN THIS ORDER:**
   **(a)** rebase — §7 · **(b)** BK-55's **two** commits, the assertion counter
   FIRST (additive), then everything else · **(c)** BK-53's own counter fix, then
   the copy, then the pins · **(d)** 🔴 **ONE adversarial pass AT THE BRANCH TIP,
   OVER THE UNION** — `CLAUDE.md` triggers it on anything touching a status
   transition, and BK-55's guard is exactly that · **(e)** gates ·
   **(f)** implementation review · **(g)** **ONE `git push origin main`.**

⛔ **PROHIBITIONS, not steps:** **`U13` is NOT dischargeable at plan stage and
must not be ticked** — it needs the SHIPPED extractor.

🔴 **AND THE WINDOW IS GOVERNED.** `ROADMAP.md`: ***"Ship no more than ONE
funnel-affecting change per week… not negotiable"*** — August's collapse is
permanently unattributable because four changes landed in five days.
**BK-58 shipped 2026-09-10 and is funnel-affecting.** ***Count the week from
there before pushing the flip.***
⏰ **UNRELATED BUT TIME-BOXED:** `#36`'s `charge.refunded` CLI resend window
closes **~2026-09-19** — after that it is a hand repair forever. *User
deprioritised it; it is still a deadline.*

---

## 7 · 🛑 `bk51-gated` — **SEVENTEEN, AND THE NUMBER MOVES EVERY TIME `main` SHIPS**

⛔ ~~SIX~~ ⛔ ~~EIGHT~~ 🔴 **17.** ***Wrong in every brief that stated it, because
divergence is a TWO-ENDED measurement and briefs record it as a fact about the
branch.*** **The branch did not change. `main` shipped BK-57 and BK-58.**

```sh
MB=$(git merge-base main bk51-gated)
for f in $(git diff --name-only main..bk51-gated | grep -v '^docs/'); do
  git diff --quiet $MB..bk51-gated -- "$f" && echo "BEHIND: $f" || echo "branch:  $f"
done
```

**6 branch work** *(stable)* · **11 merely BEHIND** — including BK-57's and
BK-58's production copy and **`scripts/verify-trust-claims.ts`, absent from the
branch entirely.**

⚠️ **THE OLD WARNING WAS OVERSTATED.** An ordinary `git merge` would **NOT**
revert a shipped fix — git keeps `main`'s side for files the branch never
touched. **The real hazards: a hard reset · a whole-tree cherry-pick · briefing
an agent to read the branch as if it were current.**
✅ **REBASE EARLY** — the rebase is what brings `verify:trust` across.

---

## 8 · 🔴 THE THREE FINDINGS THAT SHAPE THE WORK

- 🔴 **THE 36 ARE MOSTLY *LIVE*, AND THE COUNT INVITES THE WRONG ACTION** —
  `§S5b`. **Only FOUR are stale on their merits.** ⚠️ **FIVE go green for the
  wrong reason** *(inside the 36; `§S5b` D names a SIXTH which is OUTSIDE the 36 —
  different population, and both numbers are right)*. 🔴 **AND 36 IS THE WRONG
  NUMBER FOR THE TICKET:** five further arms redden or vacuate, of which **TWO
  are INVERTED** — `:470-476` and `:1055-1068`, *"never say free"* → *"say free,
  WITH the qualifier"* — **and those two are a bigger rewrite than all 36.**
  ⚠️ **One arm is LOAD-BEARING BEYOND ITS SUBJECT:** `:616-618` carries the only
  assertion that the tier control is TWO-WAY bound.
  🛑 **The BK-44 trap is pre-named:** *"the block must end on the credit"* states
  a rule that OUTLIVES its encoding, so *"it is the new rule made visible"* will
  be offered and is **half right, which is what makes it dangerous.**
- 🔴 **`S3`'s MEASURED CONSTANTS DO NOT RE-DERIVE** — `§S3a`. A second instrument
  reproduces **four of six rows EXACTLY** and **neither headline constant**
  (`MAX_UNIT` 273→**222**, and 273 appears nowhere; `MIN_UNITS` 63→**189**).
  ***They are properties of the EXTRACTOR, not of the site.***
- 🔴 **THE GUARD'S CHOKE POINT IS `planForAppointment`
  (`src/lib/booking-admin-notify.ts:164`), NOT `resend.ts`** — `§R-3`. **THREE
  production surfaces reach the terms block from an existing row** and the
  ROADMAP's own trap entry names ONE. *Two agents found the second independently.*
  ⚠️ **The harm needs NO new tooling: `editorMaySetStatus` permits
  `declined → confirmed` for a row whose `paid_at` is non-NULL and whose
  `payment_status` is not refunded — `#37` qualifies.** *(That chain is in
  `BK-55.md` `§Q-1`, not in `§R-3`.)*

---

## 9 · UNOWNED, AND A READER WILL MEET THEM IN THE TICKETS

| Item | State |
| --- | --- |
| **`verify-booking-ics.ts` — 60 affected assertions** | 🔴 **UNOWNED.** Decision 24's split table names it NOWHERE. Subject says BK-55. Carried only by `U21` — **confirm in review, do not let it default** |
| **`O-5` — the production `SELECT`** | 🔴 **UNOWNED, no ROADMAP entry.** Self-declared, confirmed |
| **`Direct Insurance Billing` — 18 sites** | ⚠️ **A LIVE OVERCLAIM.** Owner **BK-59, NOT YET WRITTEN**. *`BK-58` closed rows 1–3 of that trap, not row 4* |
| ☑️ **The IICRC registration number and the licence number** | **USER-OWNED — `🙋` index item 12.** Both badges stand on the user's word; **nothing in the repo evidences either** |

---

## 10 · BRIEFING FRESH AGENTS — every line was paid for

- **Target branch is `bk51-gated`. NEVER push. Do not check it out** — read with
  `git show bk51-gated:<path>`. **Read DOCS with `git show main:<path>` AND SAY SO.**
- 🔴 **A bare `review.ts` is `src/pages/api/admin/appointments/review.ts`**, NOT
  `src/lib/booking-review.ts`. **A bare `resend.ts` is
  `src/pages/api/admin/appointments/resend.ts`; there is no `src/lib/resend.ts`.**
- 🔴 **CITE POSITIONS INSIDE TICKETS BY STRING, NEVER BY LINE.** *The `§S*`
  headings were renamed on 2026-09-10 so that `grep '§S5b'` actually finds the
  section — before that every citation was ungreppable.*
- 🔴 **Score on (exit code, summary line), NEVER a `✗` count.** A crash and a
  failure are BOTH exit 1; **the ABSENCE of a summary line is the crash signal.**
  ⚠️ 🆕 **Assert the BUILD exit code too** — a failed build leaves `dist/` stale and
  the gate then grades the PREVIOUS build. *Measured this session.*
- 🔴 **Assert the break LANDED. Restore from a `cp` FILE BACKUP, never
  `git checkout --`.**
- ⚠️ 🆕 **A red-first row that REFUSES to go red is telling you your inventory is
  wrong.**
- ⚙️ **OPERATIONAL:** `verify-booking-admin-db.ts` **needs a live database** and
  **exits 3 on `--reset` by design**; after any interrupted run **clear the probe
  rows** or the next result is meaningless (BK-33). **`npm run build` before
  measuring against `dist/`** — `verify-cutover.ts` run alone leaves a sentinel.
- **If a claim in the brief is false, that is a finding.** *Briefs here have been
  wrong at least ten times, including three written the same day — this page
  among them.*

---

## 11 · RULES THIS PROJECT PAID FOR

- 🔴 **A NEGATIVE CHECK WITH NO POSITIVE TWIN PASSES ON AN EMPTY DOCUMENT.**
- 🔴 **READ THE LIST BESIDE THE NUMBER.** 🆕 *Five more this session, including
  this page's own "twelve" (sixteen) and a summary line that did not reconcile
  with the table beneath it.* ✅ **The fix that works: SCRIPT the count over the
  table's own last column.**
- 🔴 🆕 **AN UNFILLED PLACEHOLDER CAN CHANGE ITS FAILURE DIRECTION WHEN ITS
  CONSUMER CHANGES.** `Invalid Date` failed **benign** under a render and fails
  **OPEN** under a guard.
- 🔴 🆕 **AUDIT A COLUMN'S DURABILITY BEFORE KEYING A GUARD ON IT.** Re-approval
  wipes `paid_at`, `payment_method`, `paid_amount_cents` and `payment_reference`
  in ONE statement.
- 🔴 🆕 **A RULE REWRITE CAN LEAVE A ROW'S VERDICT INTACT AND ITS REASON FALSE.**
  **Six of `§R-2`'s 31 rows are that shape.**
- 🔴 🆕 **A DISPOSITION CAN BE CLOSED ON AN ANSWER TO A DIFFERENT QUESTION.**
- 🔴 🆕 **A CLAIM HAS MORE THAN ONE GRAMMAR AND ONLY ONE IS PROSE.** ⚠️ **A live
  `curl` of the homepage returned ZERO and was NOT evidence of absence.**
- 🔴 🆕 **NEVER SIZE A CLAIM FROM A TRUNCATED GREP.** ***The verification and the
  misreading were the same command.***
- 🔴 🆕 **ASSERT EVERY ANCHOR BEFORE ANY WRITE.**
- 🔴 **GREP THE DESTINATION AFTER ANY SCRIPTED EDIT.**
- 🔴 **EXTERNAL BEHAVIOUR → DOCS, NEVER RECALL.**
- ⚠️ **Strikethrough scan uses `FNR`, not `NR`:**
  `awk '{n=gsub(/~~/,"~~"); if(n%2==1) print FILENAME": "FNR}' docs/booking/tickets/*.md`
  **BK-53 = 18 / 9 pairs · BK-55 = 4 / 2 pairs · BK-57 and BK-58 = ZERO.**
