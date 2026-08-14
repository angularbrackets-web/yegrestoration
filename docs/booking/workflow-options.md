# Quote/booking → work order → invoice: options report

**Date:** 2026-08-13 · **Status:** for review — no decision made, no tickets
exist. The client gave the core idea only ("link a quote/booking to a work
order, invoice, etc. — better track the different areas of the business");
this report frames the options and makes a recommendation for them to react to.

## What we're solving

Today the business runs on two disconnected halves:

- **The website** (this repo): captures the lead — booking with photos,
  payment route (insurance vs private), pipeline stage
  (assessment/mitigation/restoration), plus the message inbox and admin pages.
  It ends at "appointment happened".
- **Everything after the assessment** — estimates, work orders, scheduling
  crews, invoicing, payments, insurance paperwork — lives wherever it lives
  today (paper, spreadsheets, memory). Nothing links back to the original
  booking.

The ask is the connective tissue: one thread from first contact to paid
invoice, so the client can see where every job stands and where money is.

Three honest ways to get it:

## Option 1 — Integrate a field-service SaaS (recommended: Jobber)

**Shape:** the website stays what it is — the lead-capture and booking front
door — and a purpose-built operations platform takes over from "assessment
booked" onward. A thin bridge pushes each booking (or each *approved* booking,
once P7's review flow lands) into the platform as a client + job request.

**Why Jobber specifically:**

- **Built for exactly this business size and shape.** Canadian company
  (Edmonton-founded, fittingly), aimed at home-service businesses of one to a
  few crews. The product *is* the requested workflow: request → quote → job
  (work order) → invoice → payment, with scheduling, a client portal,
  QuickBooks sync, and card/e-transfer payments.
- **Real, supported API.** A public [GraphQL API](https://developer.getjobber.com/docs/)
  with OAuth and [webhooks](https://developer.getjobber.com/docs/using_jobbers_api/setting_up_webhooks/)
  covering clients, requests, quotes, jobs, and invoices — everything the
  bridge needs, in both directions (we could later show "job status" in our
  admin, or fire our Resend emails off Jobber webhooks).
- **Predictable cost.** [2026 pricing](https://checkthat.ai/brands/jobber/pricing)
  runs roughly **$39/mo (Core, 1 user) → $119 (Connect) → $199 (Grow)**, with
  team plans above that ([overview](https://www.scanmanifold.com/blog-posts/jobber-pricing-2026-what-every-plan-costs));
  Canadian pricing is published in CAD on their site — verify the current CAD
  figures before presenting numbers to the client. Core or Connect is almost
  certainly enough to start.

**Alternates in the same category:**

- [Housecall Pro](https://www.fieldpulse.com/resources/blog/housecall-pro-vs-jobber)
  (~$59/mo up) and [Kickserv](https://www.itqlick.com/kickserv/competitors)
  (~$19/mo up, simplest) — same shape, US-centric, weaker
  API stories. Fine fallbacks if Jobber's demo disappoints.
- **Restoration-specific platforms:** [Encircle](https://www.getencircle.com/pricing/)
  (Canadian, field documentation + Xactimate integration, from ~$270/mo),
  DASH, Albi ([category overview](https://companycam.com/resources/blog/best-restoration-software-apps)).
  These matter if the insurance side dominates: insurers effectively require
  estimates in **Xactimate**, and Encircle/DASH speak that language. They cost
  3–7× Jobber and are documentation/claims tools first, invoicing tools
  second. Reasonable as a *later add-on* for the insurance pipeline rather
  than the first system.

**What we'd build (small):** one integration ticket — on booking approval,
create/upsert the client and a job request in Jobber via the GraphQL API
(server-side, keyed off the same seam BK-23 adds for approval). Attachments
can follow (Jobber supports note attachments) or remain linked back to our
admin. Realistically a single Reviewed ticket plus an env var, not a phase.

**Costs:** subscription (≈ $470–$1,400+/yr depending on plan) + one small
ticket now, near-zero maintenance after. The client also gets the things we'd
never build: mobile crew app, payment collection, QuickBooks sync, receipts.

**Risks:** vendor lock-in (mitigated: our site keeps the customer
relationship and all original booking data); per-user costs grow with
headcount; the client must actually adopt a new tool day-to-day — the biggest
real-world failure mode of this option.

## Option 2 — Build it in-house

**Shape:** extend this codebase: `jobs` table linking to `appointments`, work
orders, invoice records, PDF generation, status dashboard in the admin,
GST handling, payment tracking, maybe Stripe.

**What it's really priced at.** The data model and admin screens are the easy
20% — the repo already has auth, DB, email, and a `pipeline_stage` column
pointing this direction. The other 80% is the part that never ends:

- **Invoicing is a compliance surface**: GST registration numbers, invoice
  numbering rules, credit notes, partial payments, write-offs, year-end
  export for the accountant. Every bug is a money bug.
- **Insurance billing isn't ours to solve**: estimates live in Xactimate
  because insurers require it; an in-house invoice module still leaves the
  insurance half outside the system.
- **No mobile crew experience** unless we build one.
- Every future need (deposits, e-transfer reconciliation, payment reminders)
  becomes a ticket in this repo, under this process, forever.

**When it would make sense:** if the client only wants *tracking* — not
invoicing. A thin "job thread" (link appointment → status → notes → manual
"invoiced/paid" flags) is maybe 2–3 tickets and zero compliance surface. That
is a legitimate budget option, and it's compatible with adopting Jobber later.
Full in-house invoicing is not recommended at this team size.

## Option 3 — Self-hosted open source (the "popular GitHub repos" route)

Odoo (~45k stars), ERPNext (~30k), Invoice Ninja (~9k) and friends are real
products — but stars measure popularity of the *project*, not fit for a
two-person restoration company:

- **You become the vendor.** Hosting, upgrades, backups, security patches for
  the system that holds every invoice. Realistic implementation quotes for
  ERPNext start around
  [$5k+ even for simple setups](https://www.erpresearch.com/pricing/erpnext),
  with [ongoing DevOps burden](https://www.erpresearch.com/en-us/erpnext)
  explicitly on the internal team; Odoo Community
  [self-hosting](https://www.erpresearch.com/en-us/odoo-erp-overview) has the
  same shape. That burden lands on you (the agency) as unpaid IT.
- **Generic ERP shape.** These model warehouses, manufacturing, HR. Bending
  them to assessment → mitigation → restoration is configuration work that
  rivals Option 2's build cost, and the integration ticket (our site → their
  API) still has to be written — against a messier API than Jobber's.
- **Invoice Ninja** is the lightest of the three
  ([self-hosted free, hosted from ~$10/mo](https://canivibecodeit.com/invoice-ninja))
  and worth a mention *only* if the need collapses to "send invoices, nothing
  else" — at which point its hosted tier beats self-hosting anyway.

Not recommended as the system of record. The savings are illusory at this
scale: subscription dollars are exchanged for maintenance hours, at a worse
rate, with more risk.

## Recommendation

**Option 1 with Jobber**, in three steps:

1. **Client does a Jobber trial** (they offer free trials/demos) against a
   week of real jobs — the decision hinge is whether the office will live in
   it, not anything technical.
2. **If adopted:** one integration ticket in this repo — approved booking →
   Jobber client + request via the GraphQL API. Our site remains the system of
   record for how the lead arrived (photos, terms acknowledgment, funnel
   analytics); Jobber becomes the system of record for quotes, work orders,
   invoices, payments.
3. **Revisit the insurance half separately.** If insurance volume grows,
   evaluate Encircle as a documentation/Xactimate layer — it integrates with
   the same ecosystem and doesn't displace Jobber.

**Fallback if the client balks at a subscription:** the thin in-house "job
thread" from Option 2 (tracking only, no invoicing) — cheap, useful, and
doesn't foreclose Jobber later.

## What we need from the client before proceeding

1. What do they use for **accounting/invoicing today** (QuickBooks? Wave?
   paper)? Sync needs drive the platform choice.
2. **Team size** now and in 12 months (drives Jobber plan/per-user cost).
3. **Insurance vs private mix** — mostly-insurance pushes Encircle/DASH up
   the list; mostly-private makes Jobber alone sufficient.
4. Do they already use **Xactimate** (or a bordereau/TPA portal) for
   insurance estimates?
5. Monthly **invoice volume** — single digits favours the thin in-house
   tracker; dozens favours Jobber immediately.
6. Budget tolerance: is ~$39–119 CAD-ish/mo acceptable ongoing spend?

## Sources

- [Jobber Developer Center](https://developer.getjobber.com/docs/) ·
  [API queries & mutations](https://developer.getjobber.com/docs/using_jobbers_api/api_queries_and_mutations/) ·
  [Webhooks](https://developer.getjobber.com/docs/using_jobbers_api/setting_up_webhooks/)
- Jobber pricing 2026: [checkthat.ai](https://checkthat.ai/brands/jobber/pricing) ·
  [scanmanifold.com](https://www.scanmanifold.com/blog-posts/jobber-pricing-2026-what-every-plan-costs) ·
  [Capterra Canada](https://www.capterra.ca/software/127994/jobber)
- Comparisons: [FieldPulse — Housecall Pro vs Jobber](https://www.fieldpulse.com/resources/blog/housecall-pro-vs-jobber) ·
  [ITQlick — Kickserv](https://www.itqlick.com/kickserv/competitors)
- Restoration-specific: [Encircle pricing](https://www.getencircle.com/pricing/) ·
  [Encircle integrations](https://www.getencircle.com/integrations) ·
  [CompanyCam — best restoration software 2026](https://companycam.com/resources/blog/best-restoration-software-apps)
- OSS reality: [ERP Research — ERPNext](https://www.erpresearch.com/en-us/erpnext) ·
  [ERPNext pricing](https://www.erpresearch.com/pricing/erpnext) ·
  [Odoo overview](https://www.erpresearch.com/en-us/odoo-erp-overview) ·
  [Invoice Ninja verdict](https://canivibecodeit.com/invoice-ninja)
