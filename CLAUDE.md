# yeg-restoration-v4

Astro 7 + Tailwind 4 + Svelte islands on Vercel · Neon Postgres · Resend.

## How work runs

Work is phases → tickets, one ticket per commit. Roadmap and tickets live in
`docs/booking/` — read `ROADMAP.md` before starting anything.

- **Lifecycle** — draft → plan-reviewed → approved → implemented → reviewed →
  committed. Rewrite the ticket's `Status:` line at *every* transition, as it
  happens. Assume the session dies mid-flight.
- **Tiers** — *Heavy* (public endpoints that write or expose data, insurance/PII,
  concurrency, anything irreversible): plan review + implementation review.
  *Standard*: same two reviews, lighter prompts. *Light* (copy, styling, config):
  gates only. Reviewers are always fresh agents, never forks.
- **Conflict** — findings are blocker / should-fix / nit. Blockers get fixed;
  refusing one in writing is allowed. Only a *disputed blocker* goes to a third
  fresh agent as tiebreaker. No standing third review.
- **Questions** — our code → read it. External behaviour → docs/source, never
  recall. Judgment call → fresh agent. Business logic, policy, cost, or anything
  client-facing → ask the user. Everything settled without the user goes in the
  ticket's Assumptions log.
- **Gates** — `npm run typecheck` and `npm run build` pass, plus the ticket's own
  verification, *before* implementation review. Reviewers see the output.
