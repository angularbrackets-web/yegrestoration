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
