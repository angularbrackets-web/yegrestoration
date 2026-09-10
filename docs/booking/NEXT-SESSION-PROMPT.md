Continuing yeg-restoration-v4, booking area.

*(Rewritten 2026-09-09 at the close of the SECOND session that day, replacing the
version written earlier the same day. **The user answered every question that was
blocked on them. Nine decisions landed — 33 through 41.**)*

---

## 0 · RUN THESE FOUR FIRST

```sh
git log --oneline -1                    # expect 035150f or later
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

🔴 **`git push origin main` IS the deploy. `main` IS AHEAD OF `origin/main` BY
SIX DOCS-ONLY COMMITS AND HAS NOT BEEN PUSHED.** The fourth check should print
NOTHING; anything non-docs it lists is an UNPUSHED PRODUCTION CHANGE.

---

## 1 · 🔴 THE ONE-LINE STATE

**Both gate tickets still FAIL plan review. Nothing is approved, nothing is
implemented.** ✅ **But NOTHING IS BLOCKED ON THE USER ANY MORE** — every open
question was put to them and answered on 2026-09-09.

⚠️ **Every count below is SCRIPTED from its own list, not asserted.** Re-derive
before acting: `awk`/`grep` the section, do not trust this number.
*(The previous version of this page carried a wrong total that reached four
documents, and its own strikethrough claim — "BK-53.md's twelve hits" — was also
wrong: there are **sixteen**, in eight pairs, and that was true before anyone
touched the file this session.)*

| | |
| --- | --- |
| **BK-53** | ⛔ **NOT APPROVED.** `§U-4` is **19 rows: 9 done · 3 partial · 2 escalated · 5 open** *(open: `U1b` `U3` `U6` `U7` `U18`)* |
| **BK-55** | ⛔ **NOT APPROVED.** `§Q-6` is **16 rows: 1 done · 15 open**, PLUS **`§R-5`'s ten NEW items (`R1`–`R10`)** created by decision 33 |
| **BK-57** | ✅ DEPLOYED AND VERIFIED (`699b099`). Closed |
| **BK-51** | unchanged — reviewed, `bk51-gated` only, never pushed |
| 🆕 **BK-58** | ⛔ **NOT WRITTEN.** Four live trust claims, at least two FALSE in production — ROADMAP Known traps |

---

## 2 · 🆕 THE NINE DECISIONS — all 2026-09-09, all in `ROADMAP.md`

| # | What |
| --- | --- |
| **33** | **`#37` is answered by a GUARD, not a claim about the population. `A-R8-5` is STRUCK.** → `BK-55.md` `§R` |
| **34** | 🔴 **PREVIEW DEPLOYS ARE TO BE TURNED OFF.** Preview is **NOT isolated** — 25 vars shared with Production at **identical values**, incl. `DATABASE_URL` and `RESEND_API_KEY`. ☐ **USER-OWNED, NOT YET DONE** |
| **35** | 24-hour **phone**, business-hours **booking** → BK-58 |
| **36** | **The pricing flip ships BEFORE W20/W21** |
| **37** | Insurance billing is **BOTH, per job** — insurers do not pay Stripe invoices |
| **38** | 🔴 ***"Since 2008" IS FALSE.*** The FIRM was founded **2026** → BK-58 |
| **39** | IICRC ✅ · Licensed & Insured ✅ · 🔴 **BBB Accredited NOT substantiated, and LIVE** → BK-58 |
| **40** | **The guard's predicate is the ACK TIMESTAMP. A money proxy was recommended, measured, and WITHDRAWN.** Three protections are part of the decision |
| **41** | **No customer follow-up** for the paid-era population |

---

## 3 · 🙋 BLOCKED ON THE USER — **ONE, and it is operational**

| # | Item |
| --- | --- |
| **1** | ☐ **Turn Preview Deployments OFF** — Vercel → `yegrestoration` → Settings → Git. **Decision 34. Until it is done, any pushed branch gets a deploy that reads and writes the REAL database and can email REAL customers.** ⚠️ *Turning previews off does not unscope the variables* |

✅ **ROADMAP human-blocked items 5, 7, 9a and 9b are all ANSWERED.** Only item 1
*(`#36`'s `charge.refunded` resend, deprioritised by the user)* is still parked.

---

## 4 · DO THIS, IN ORDER

1. **Work `§U-4`'s five open rows and `§Q-6`'s fifteen**, plus **`§R-5`'s ten**.
   🛑 **Land each at its DESTINATION, never as a new revision layer.**
2. ⚠️ **`U13` IS NOT DISCHARGEABLE AT PLAN STAGE and must not be ticked.** It
   needs the SHIPPED extractor. *See `S3a`.*
3. **Re-review** — fresh agents, never forks.
4. **Only then implement**, on `bk51-gated`: BK-55's two commits, then BK-53's,
   then **one adversarial pass at the TIP over the union**, then gates, then
   implementation review, then **one push**. 🔴 **REBASE FIRST — see §6.**

---

## 5 · 🔴 THE THREE FINDINGS THAT CHANGE THE WORK

- 🔴 **BK-53 TURNS `verify-cutover.ts` RED IN 36 PLACES, AND FOUR MORE GO
  VACUOUSLY GREEN.** It deletes seven constants that script asserts the presence
  and ORDER of. **The four that go green are `never in the message-form arm`
  negatives — they pass once the constant is gone.** Blast radius is **FOUR
  scripts**. `CLAUDE.md`/BK-44 governs: **rewrite the arms, never loosen the
  rule.** *(`S5a`. And `U11` found a 37th in `verify-cutover.ts:594-598` that
  `S5a` does not count.)*
- 🔴 **`S3`'s MEASURED CONSTANTS DO NOT RE-DERIVE.** A second instrument
  reproduces **four of six rows EXACTLY** (`metaDesc`, `ogDesc`, `title`,
  `llms.txt`) and **neither headline constant**: `MAX_UNIT` **273 → 222** *(273
  appears nowhere)*, `MIN_UNITS` **63 → 189**. ***They are properties of the
  EXTRACTOR, not of the site.*** *(`S3a`.)*
- 🔴 **THE GUARD'S CHOKE POINT IS `planForAppointment`
  (`booking-admin-notify.ts:164`), NOT `resend.ts`.** **THREE production surfaces
  reach the terms block from an existing row** and the ROADMAP's own Known-trap
  entry names ONE. *Two independent agents found the second surface separately.*
  ⚠️ **And the harm needs NO new tooling — `editorMaySetStatus` permits
  `declined → confirmed` today.** *(`§R-3`.)*

---

## 6 · 🛑 `bk51-gated` IS STALE RELATIVE TO PRODUCTION — **SEVENTEEN, AND THE NUMBER MOVES EVERY TIME `main` SHIPS**

🔴 **RE-MEASURED 2026-09-10: SEVENTEEN non-docs files differ.**
⛔ ~~SIX~~ ⛔ ~~EIGHT~~ — ***this figure has now been wrong in every brief that
stated it, including one written the same morning it changed.***

**Re-derive it, never inherit it:**

```sh
git diff --name-only main..bk51-gated | grep -vc '^docs/'          # 17 today
MB=$(git merge-base main bk51-gated)
for f in $(git diff --name-only main..bk51-gated | grep -v '^docs/'); do
  git diff --quiet $MB..bk51-gated -- "$f" && echo "BEHIND: $f" || echo "branch:  $f"
done
```

| | Count | What |
| --- | --- | --- |
| **branch work** | **6** — *stable* | `verify-booking-admin-db.ts` · `verify-booking-review.ts` · `booking-payment.ts` · `booking-review.ts` · `admin/appointments/[id].astro` · `api/admin/appointments/review.ts` |
| 🔴 **merely BEHIND** | **11** — ⛔ ~~2~~ | BK-57's + **BK-58's** production copy, plus `package.json` and **`scripts/verify-trust-claims.ts`, which does not exist on the branch at all** |

⚠️ **WHY IT JUMPED: `main` SHIPPED BK-58 ON 2026-09-10.** *The branch did not
change. Divergence is a two-ended measurement and only one end is under this
ticket's control.*

🔴 **THE OLD WARNING WAS OVERSTATED AND IS CORRECTED HERE.** It read
*"merging without rebasing would REVERT a shipped customer-facing fix."*
⛔ **An ordinary `git merge bk51-gated` would NOT** — git keeps `main`'s side for
the eleven files the branch never touched. **The real hazards are narrower and
worth naming exactly:** a **hard reset** of `main` to the branch · a
**cherry-pick of a whole tree** · or **reading the branch as if it were current**
when briefing an agent or measuring copy.

✅ **AND THERE IS NOW A GATE WHERE THERE WAS NONE.** `npm run verify:trust` pins
BK-58's removals over `dist/`. **It does not exist on `bk51-gated`** — so it
cannot protect the branch until the rebase brings it, **and after the rebase it
protects both halves.** *That is a reason to rebase EARLY rather than at the end.*

---

## 7 · BRIEFING FRESH AGENTS — every line was paid for

- **Target branch is `bk51-gated`. NEVER push. Do not check it out** — read with
  `git show bk51-gated:<path>`. **Read DOCS with `git show main:<path>` AND SAY
  SO** — two worktree agents were 32 and 34 commits stale while source was
  byte-identical.
- 🔴 **A bare `review.ts` is `src/pages/api/admin/appointments/review.ts`**, NOT
  `src/lib/booking-review.ts`. **A bare `resend.ts` is
  `src/pages/api/admin/appointments/resend.ts`; there is no `src/lib/resend.ts`.**
- 🔴 **CITE POSITIONS INSIDE TICKETS BY STRING, NEVER BY LINE.** `§R`, `§S2a`,
  `§S2b`, `§S3a`–`§S3c` and `§S5a` were all inserted above text they cite.
- 🔴 **Score on (exit code, summary line), NEVER a `✗` count.** A crash and a
  failure are BOTH exit 1; **the ABSENCE of a summary line is the crash signal.**
- 🔴 **Assert the break LANDED. Restore from a `cp` FILE BACKUP, never
  `git checkout --`.**
- **If a claim in the brief is false, that is a finding.** *Briefs here have been
  wrong at least eight times, including two written the same day.*

---

## 8 · RULES THIS PROJECT PAID FOR

- 🔴 **A NEGATIVE CHECK WITH NO POSITIVE TWIN PASSES ON AN EMPTY DOCUMENT.**
  🆕 **Measured again this session: four of `verify-cutover.ts`'s pins convert
  from load-bearing to vacuous the moment BK-53 deletes their subject — silently,
  inside an edit that reddens 36 others.**
- 🔴 **READ THE LIST BESIDE THE NUMBER.** 🆕 **Three more this session: the
  strikethrough claim of "twelve" (it is sixteen); `HANDOFF`'s "`§P-1` re-derives
  ALL 23 cases" (it is twenty-six); and `§R-2`'s own summary line, which said
  "twelve of 31" and did not reconcile with the table beneath it.** *The fix that
  works is to SCRIPT the count over the table's own last column.*
- 🔴 🆕 **AN UNFILLED PLACEHOLDER CAN CHANGE ITS FAILURE DIRECTION WHEN ITS
  CONSUMER CHANGES.** `new Date('2026-__-__T00:00:00Z')` is `Invalid Date`, every
  `<` against it is `false`. Under the RENDER use that was the intended arm —
  which is why it sat unfilled and nobody noticed. Under the GUARD use the
  identical value makes the refusal **never fire, silently, exit 0.**
  ***The same value that failed BENIGN now fails OPEN.***
- 🔴 🆕 **A DURABLE COLUMN AND A PROXY FOR IT ARE NOT INTERCHANGEABLE.** A money
  predicate looked strictly better than a timestamp one — until a column audit
  showed **re-approval wipes `paid_at`, `payment_method`, `paid_amount_cents` and
  `payment_reference` in one statement**, on exactly the path that produces the
  harm. **`terms_acked_at` is written once and cleared nowhere.** *Audit
  durability before choosing a discriminator.*
- 🔴 🆕 **A RULE REWRITE CAN LEAVE A ROW'S VERDICT INTACT AND ITS REASON FALSE.**
  Six of `§R-2`'s 31 rows are that shape. **They read *"no"* at a glance and are
  the rows nobody re-checks.** *Specimen: `A13`, still moot, for a reason that is
  now false.*
- 🔴 🆕 **A DISPOSITION CAN BE CLOSED ON AN ANSWER TO A DIFFERENT QUESTION.**
  `T9` was closed on `§T-4`, which measured extraction and bans; the owed thing
  was a LANDMARK row. **`S6` carried two rows that disagreed for days.**
- 🔴 **GREP THE DESTINATION AFTER ANY SCRIPTED EDIT.** ✅ Assert-then-write-once
  works and was used for every edit this session.
- **`npm run build` before measuring against `dist/`** — `verify-cutover.ts` run
  alone leaves a sentinel and says so on exit.
- ⚠️ **Strikethrough scan uses `FNR`, not `NR`:**
  `awk '{n=gsub(/~~/,"~~"); if(n%2==1) print FILENAME": "FNR}' docs/booking/tickets/*.md`.
  **`BK-53.md` = 18 odd lines, NINE pairs, all legitimate. `BK-55.md` = TWO, ONE
  pair, legitimate — it is no longer zero. `BK-57.md` must be ZERO.**
