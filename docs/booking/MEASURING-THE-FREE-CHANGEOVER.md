# Is the free assessment working? — a one-page answer

**Written 2026-09-02, before the changeover ships.** Deliberately short. If this
grows past one page, it has stopped being useful.

## The one sentence that decides everything else

> **At this size you can see a doubling. You cannot see a 30% change.**
> Build the measurement to catch a doubling, spend nothing chasing anything
> smaller — and count **jobs**, not form submissions.

## Why "count the bookings" is the wrong instrument

**The booking system records about 1 in 20 of this company's real
transactions.** Twenty Interac payments Jul–Aug, thirteen in August, from ~11
payers — against **one** Interac payment in `appointments`, which was a developer
test. `#37` is recorded `declined`; the job was done and paid twice.

So the row count measures **the form's health**, not the business's. Keep looking
at it — it is free — but never conclude from it.

## What is and is not detectable

Measured: Aug 10–16 → **9** web bookings in 7 days. Aug 17–31 → **1** in 15 days.
Traffic was ~15–20 ad clicks/day throughout.

Fortnight to fortnight you need roughly a **3× change AND at least ~6 in the
bigger period** before it is more than a coin flip. From today's rate of about
one a fortnight:

- 1 → 3 is **noise.** 1 → 4 is arguable. 1 → 8 is real and needs no statistics.
- Over a month it either lands at **8–17 bookings** (obvious to anyone) or at
  **1–5** (where "better", "unchanged" and "worse" are permanently
  indistinguishable). **There is no middle band this business can resolve.**

Two things make it worse and neither is fixable: **season** (the rain regime
broke ~Jul 28, so Sep vs Aug is not like-for-like), and **four changes shipping
together** — free assessment, all prices off, photos optional, no weekend
surcharge. That is the same collinearity that made August's cause unrecoverable.
It is the right commercial call, but it means the honest unit is **"the September
package"**, never "free booking".

## The three measurements worth having

**1 · A one-line-per-job ledger — office, ~30 seconds per job.**
Date · name · how they reached us · did we do the assessment · did they go ahead ·
roughly what it billed. **This is the only instrument that survives the
20-payments-1-row problem**, because it counts jobs.

*Add five seconds:* on each call ask **"what made you get in touch?"** and write
the answer down. At 10–20 conversations a month that is the only causal evidence
available about the free offer, and it costs nothing.

**2 · Cost per connected call — owner, ~2 min/week.**
August: CA$1,716.95 ÷ 45 call conversions ≈ **$38 per conversation.** Already
measured, deploy-independent, and the one number that judges a month of ad money.
⚠️ `Website call` is our own tag on our own pages — a deploy can break it
silently. Treat a drop as *"check the tag"* before *"demand fell"*.

**3 · The phone carrier's call detail record — owner, ~15 min, once.**
Free, never requested. The **only** thing that separates *"demand fell"* from
*"we were on a job site and the phone rang out"*. Ads counts *connected* calls, and
August was the busiest field month. **Get it before the flip**, so there is a
baseline answer rate.

## The Friday ten minutes

1. Jobs done this week, and how many became agreed work *(from the ledger)*
2. How many of those said "the website"
3. Web booking rows in the last 7 days *(admin panel)*
4. Ads: spend ÷ calls = cost per conversation. **Write it down.**
5. Ask the office: did anyone mention price, or the free assessment, unprompted?

**Good news:** 4+ web rows a week for two weeks running, *and* those assessments
actually happening, *and* most turning into agreed work.
**Bad news:** 0–1 rows a week for three straight weeks on unchanged ad spend.
**The alarm specific to free:** assessments done goes **up** and jobs agreed does
**not** — that is free working as a lead magnet and failing as a business. The
owner accepted "a couple of bad free bookings"; line 1 is the only way to know
whether it is a couple or a pattern.

**Write the number every week even when it is boring, and do not judge before six
weeks.**

## The trap, and it has already happened here once

**The first good week will read as proof. It isn't.** At a base rate near one a
fortnight, three in a week is entirely ordinary — and will not feel ordinary.
This project has a documented record of it: **six conclusions asserted and
withdrawn in a single day**, by someone being careful, with more data than this.

Three shapes it will take:

1. **Crediting "free" when four things changed at once** — plus a season change.
   *Date-fit is never evidence*, and here the date is known in advance, which
   makes it more tempting, not less.
2. **Counting the software and calling it the company.** See the 1-in-20 above.
3. **The half-recommendation.** The evidence said a *free* diagnostic books
   **worse** than one priced $1–$49.99, and recommended a free triage lane **plus
   a paid report**. The client took the free half. If free produces volume, the
   version that carried the evidence never gets tested — and "free worked" gets
   recorded as though the alternative had been tried.

**Three moves that cost nothing and must happen BEFORE the flip:**
write today's numbers down on one page; pick the two numbers that would mean
success and the two that would mean failure; **pick the date you will look —
six to eight weeks out — and do not look before it**, except the boring weekly
tally.

**Never say "free did it." Say "the September package."** If someone later asks
which of the four it was, the honest answer is that it is not recoverable — the
same answer August got.

## Today's numbers, for the "before" column

| | |
| --- | --- |
| Web bookings | ~1 per fortnight (was 9 in the week of Aug 10–16) |
| Ad spend | CA$1,716.95 in August · ~19 clicks/day |
| Call conversions | 45 in August ≈ **$38 per conversation** |
| GBP calls | 53 in six months · Jul peak ~23 · Aug ~16 *(monthly data — do not read weekly)* |
| Interac payments | 20 across Jul–Aug, 13 in August, ~11 distinct payers |
| Recorded in `appointments` | **1** — a developer test |
