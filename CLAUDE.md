# yeg-restoration-v4

Astro 7 + Tailwind 4 + Svelte islands on Vercel · Neon Postgres · Resend.

## How work runs

Work is phases → tickets, one ticket per commit. Each work area gets
`docs/<area>/` with a `ROADMAP.md` and `tickets/` — booking is the current one.
Read the area's `ROADMAP.md` before starting anything.

- **Lifecycle** — draft → plan-reviewed → approved → implemented → reviewed →
  committed. Rewrite the ticket's `Status:` line at *every* transition, as it
  happens. Assume the session dies mid-flight.
- **Tiers** — *Reviewed*: plan review + implementation review; mandatory for
  anything touching public write paths, PII/insurance, concurrency, or the
  irreversible. *Light* (copy, styling, config): gates only. The ticket names
  its risk areas; reviewers weight attention by them. (P2 retro, 2026-08-09:
  collapsed from Heavy/Standard — prompt weight had no catches to its name.)
  Reviewers are always fresh agents, never forks, and receive only the ticket
  file, the diff, and gate output — never the implementer's conversation or
  reasoning.
- **Conflict** — findings are blocker / should-fix / nit. Blockers get fixed;
  refusing one in writing is allowed. Only a *disputed blocker* goes to a third
  fresh agent as tiebreaker. No standing third review.
- **Questions** — our code → read it. External behaviour → docs/source, never
  recall. Judgment call → fresh agent. Business logic, policy, cost, or anything
  client-facing → ask the user. Everything settled without the user goes in the
  ticket's Assumptions log.
- **Gates** — `npm run typecheck` and `npm run build` pass, plus the ticket's own
  verification, *before* implementation review. Reviewers see the output.
- **Red first** — a new or changed verify assertion counts toward a gate only
  after it has been seen red: break the production target (never the test),
  watch it fail, restore, then log "red-observed: <what was broken>" in the
  ticket's gate table — one entry per failure mode, not per assert line.
- **Out-of-scope defects** — found mid-ticket but not this ticket's job: record
  in ROADMAP's Known traps with severity and owning ticket, never fix inline.

## Known traps in the process itself

- **A copy inventory built from "where does the constant render" misses every
  sentence that describes the same mechanism in its own words.** BK-36 carried
  a four-file surface table and still shipped to review with the pre-prepay
  claim live on three surfaces no constant touches: `/llms.txt` said *"confirmed
  instantly"* AND *"paid at the end of the visit"* in one sentence, `/contact/`'s
  hero said *"you're confirmed on the spot"*, and the booking island's own
  fallback card said *"You're booked"* under a checkmark for a `pending_review`
  row. A fourth hid inside a constant *name* — `EMAILED_LINE` ("a copy of this
  confirmation") where `RECEIVED_EMAILED_LINE` ("a copy of this request") was
  the reviewed constant for that state. BK-29 paid for this once already, in
  `dist/` rather than in source. **Therefore:** when a mechanism changes, grep
  the *claim* across `src/` — its adjectival and predicative grammars both — not
  the constants that state it, and pin the claim shape rather than the constant
  name. `verify-cutover.ts`'s `BOOKED_CLAIM_SHAPES` over five surfaces is the
  pattern to copy.

- **`astro dev` does not exercise the Vercel route table, so a smoke test
  against it proves nothing about URL resolution.** The dev server routes by
  Astro's own matcher; the deployed site routes by the generated
  `.vercel/output/config.json`, which contains rules the dev server has no
  equivalent for — including, under `trailingSlash: 'always'`, a
  **pre-filesystem** 308 that strips the trailing slash from any path whose last
  segment contains a dot. BK-34a shipped to implementation review with every
  upload link 404ing in production for that exact reason, with typecheck, build,
  its own token suite and a live `curl` against `astro dev` all green.
  **Therefore:** any feature whose URLs carry a token, a signature, a filename,
  a version string, or any other unusual segment shape needs a
  **preview-deploy check as a gate** — a real `vercel deploy` and a `curl` of a
  real URL — or an assertion that simulates the generated route table
  (`scripts/verify-appointment-upload.ts` does the latter and is the pattern to
  copy). A green dev-server smoke test does not satisfy this gate and must not
  be logged as though it did.

- **A fix that turns EXISTING assertions red is a question about the
  assertions, not about the fix.** BK-44's transition guard reddened
  `verify-booking-admin-db.ts` in 35 places and not one was a regression: seven
  arms reached `confirmed` by POSTing it to the status dropdown, because that
  was the only way to get a row there when they were written, and one defended
  the step in a comment as *"not scaffolding; it is the new rule made visible"*.
  It was the defect. **A defect old enough gets encoded in the fixtures, so a
  green suite is not evidence the defect is absent — the fixtures may require
  it.** **Therefore:** when a fix reddens existing arms, establish whether each
  arm was relying on the old behaviour before touching the rule. Make the
  FIXTURE honest — BK-44 added a `markFixturePaid` helper and changed no
  assertion — and never loosen the rule until the suite goes quiet. A fixture
  helper moves the minimum the thing under test actually reads: that one's first
  version also stamped `payment_status` and broke two unrelated arms.

- **A configuration change is not evidence of its own effect.** BK-48. The GST
  registration number was entered in the Stripe dashboard on 2026-08-20 and the
  compliance item was marked CLOSED the same morning — **by an entry whose own
  text said the only proof was a real receipt, written while no receipt
  existed.** Nine hours later the first real charge produced a receipt with no
  registration number on it: the dashboard field governs *invoices*, a Checkout
  Session issues a *receipt*, and the two are different artifacts. The fix was
  code, in a line item name. The same day, the ROADMAP's own recorded
  health-check probe reported a live webhook as broken, because the documented
  `curl` omitted the content type the real caller sends. **Therefore:** an item
  whose effect lands on an artifact nobody has looked at is not closed — it is
  *pending an artifact*. Close it when the artifact arrives, and write the probe
  so it produces the artifact rather than something adjacent to it.

- **A negative assertion is shaped for the claim it was written against, and
  covers no other claim of the same class.** BK-48 hit this twice in one
  ticket. The `$0` confirmation was guarded by *"renders no computed amount"* —
  `!/\$[\d,]+\.\d{2}/` — which a GST registration number walks straight
  through, carrying no dollar sign and no decimals. The ticket documented that
  hole in its own plan review, and then shipped relying on `!/\$\d/` one file
  over to keep the same number off the cancellation email. Implementation review
  found the second instance three hours after the first was written down.
  **Therefore:** when adding a claim to a surface that has negative pins, ask
  what those pins actually match rather than what they are named — and add the
  new claim to the banned list rather than assuming an existing guard is about
  the category. Sibling of the copy-inventory trap above: that one is about
  finding every place a claim is *made*, this one about every place it is
  *forbidden*.

- **A rule rewrite invalidates every case enumerated under the old rule,
  including the cases in the same document.** BK-44's plan tabulated
  `approved_awaiting_payment -> confirmed` as forbidden, with its reasons. Plan
  review replaced the rule's PREDICATE — "may not write `confirmed`" became "may
  not cross into the invite-holding set unpaid" — and the revision silently
  dropped that row, because the new predicate happened to permit it.
  Implementation review found it as a live hole: `paid_at` is never cleared, so
  a re-approved booking could be confirmed on the previous cycle's money.
  **Therefore:** after any rule rewrite, re-derive every enumerated case against
  the NEW rule and state which verdicts changed and why. A row that disappears
  between two versions of a plan is a decision nobody made.
