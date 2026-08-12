# Google Ads + GA4 Tracking Setup Runbook

The site ships with tracking code that is **dormant until env vars are set**. No
scripts load and nothing changes on the page until you complete the steps below
and redeploy. Total time: ~30 minutes.

What you get once it's live:

- **Call conversions** — Google swaps the phone number shown on the site for
  visitors who clicked an ad, so calls are attributed to the exact campaign,
  ad group, and keyword.
- **Booking conversions** — every completed booking on `/book/` is reported to
  Google Ads. Since the 2026-08-11 cutover this is the site's *only* form-side
  conversion: `/book/` is the quote path, and the contact form became a general
  message channel that reports nothing to Ads (see "Cutover note" below).
- **GA4 analytics** — page views plus a `click_to_call` event for every tap on
  a phone link, a `generate_lead` event for every message sent through the
  contact form (tagged with the service, when one was picked), a
  `booking_confirmed` event for every booking, and two funnel-failure events,
  `booking_availability_error` and `booking_availability_empty`.

---

## Step 1 — Create a GA4 property

1. Go to [analytics.google.com](https://analytics.google.com) → **Admin** (gear icon) → **Create** → **Property**.
2. Name: `YEG Restoration`. Timezone: `(GMT-07:00) Edmonton`. Currency: `CAD`.
3. Business details: Construction, small. Objectives: **Generate leads**.
4. Create a **Web** data stream: URL `https://yegrestoration.ca`, name `Website`.
5. Copy the **Measurement ID** — looks like `G-XXXXXXXXXX`. This is `PUBLIC_GA4_ID`.
6. Leave "Enhanced measurement" on (default).

## Step 2 — Link GA4 to Google Ads

1. Still in GA4 Admin → **Product links** → **Google Ads links** → **Link**.
2. Choose your Google Ads account → confirm. Keep "Enable personalized advertising" on.
3. In Google Ads: **Tools & settings → Setup → Linked accounts** — verify the GA4 link shows as active.

## Step 3 — Find your Google Ads conversion ID

1. In Google Ads: **Tools & settings → Measurement → Conversions**.
2. You'll create two conversion actions (steps 4 and 6 — step 5 is retained
   for history only). Both share one
   **conversion ID** that looks like `AW-XXXXXXXXXX` — you'll see it in the tag
   setup screen of either action. This is `PUBLIC_AW_ID`.

## Step 4 — Create the call conversion action

1. Conversions → **+ New conversion action** → **Phone calls** →
   **"Calls to a phone number on your website"**.
2. Settings:
   - Goal: **Contact** / Lead.
   - Conversion name: `Website call`.
   - Value: "Don't use a value" (or set an average lead value if you know it).
   - Count: **One** (one call per click is one lead).
   - **Call length: 30 seconds** — filters out wrong numbers and instant hang-ups.
   - Click-through window: 30 days (default).
3. On the "set up the tag" screen choose **"Use Google tag manager / install yourself"**
   and note two values:
   - The conversion ID `AW-XXXXXXXXXX` → `PUBLIC_AW_ID`
   - The conversion **label** (string after the `/`, e.g. `AbC-D_efGhIjKlMnOp`) → `PUBLIC_AW_CALL_LABEL`
4. The phone number to enter when asked what number appears on the site:
   **(780) 479-3285** — it must match the displayed number exactly.

> The site already renders the snippet for you — you only need the ID + label.
> Do **not** paste Google's code snippet into the site.

## Step 5 — The form conversion action (RETIRED 2026-08-11 — do not create)

**Skip this step on a new setup.** The contact form no longer reports a
conversion: BK-10 made `/book/` the quote path and demoted the form to a
general message channel, so the tag was removed from the site and
`PUBLIC_AW_FORM_LABEL` no longer exists.

On the existing account the `Quote form submit` action is set to **Secondary**
— **not deleted**. Deleting it destroys the historical data and makes
before/after comparison impossible; Secondary keeps the history while taking it
out of Smart Bidding.

## Step 6 — Create the booking conversion action

A booked assessment is a firmer commitment than a contact-form enquiry — the
visitor has given a time, an address, and often photos — so it gets its own
action rather than sharing the form's. Keeping them apart is what lets you bid
differently on the two.

1. Conversions → **+ New conversion action** → **Website**.
2. Enter `https://yegrestoration.ca`, then create the action manually:
   - Category: **Book appointment**.
   - Conversion name: `Assessment booked`.
   - Count: **One**. The site also sends a `transaction_id`, so a refreshed or
     re-opened confirmation page cannot count twice.
3. "Install yourself" again, and note the conversion **label** →
   `PUBLIC_AW_BOOKING_LABEL` (same `AW-` ID as Step 4).

The site fires this on `/book/confirmed/`, alongside a GA4 `booking_confirmed`
event. Until the variable is set, the booking flow reports to GA4 only and sends
Google Ads nothing — no broken or empty conversion is sent in the meantime.

## Step 7 — Set the env vars

Four variables, same names everywhere:

| Variable | Example value | From |
|---|---|---|
| `PUBLIC_GA4_ID` | `G-XXXXXXXXXX` | Step 1 |
| `PUBLIC_AW_ID` | `AW-XXXXXXXXXX` | Step 3/4 |
| `PUBLIC_AW_CALL_LABEL` | `AbC-D_efGhIjKlMnOp` | Step 4 |
| `PUBLIC_AW_BOOKING_LABEL` | `UvW-X_yzAbCdEfGhIj` | Step 6 |

**Vercel (production):**

```sh
vercel env add PUBLIC_GA4_ID production
vercel env add PUBLIC_AW_ID production
vercel env add PUBLIC_AW_CALL_LABEL production
vercel env add PUBLIC_AW_BOOKING_LABEL production
```

(or Dashboard → Project → Settings → Environment Variables). Add to
**Production only** — leaving preview/dev unset keeps test traffic out of your
conversion data.

**Local testing (optional):** add the same four lines to `.env.local`
(see `.env.example`), run `npm run dev`, and check that the gtag script loads.

## Step 8 — Redeploy

Env vars are baked in at build time (static site), so trigger a new deploy:

```sh
vercel --prod
```

or push any commit to `main`.

## Step 9 — Verify

1. **Tag present**: open yegrestoration.ca → view source → search for
   `googletagmanager.com/gtag/js`. Should appear exactly once.
2. **Tag Assistant**: install the [Tag Assistant Companion](https://tagassistant.google.com)
   extension, connect to the site — you should see the GA4 tag and the
   Google Ads tag fire on page load.
3. **Message event**: send a test message from `/contact/` → in browser
   devtools console run `dataLayer` → the array should contain a
   `generate_lead` event and **no** `conversion` event (the form's Ads tag is
   gone; a `conversion` here would mean the cutover was reverted). In GA4:
   Reports → Realtime shows `generate_lead`.
4. **Booking event**: complete a test booking → you land on `/book/confirmed/`
   → run `dataLayer` in the console: it should contain a `conversion` and a
   `booking_confirmed` event. **Reload the page** — neither should appear a
   second time. In GA4: Reports → Realtime shows `booking_confirmed`.
5. **Number swap**: click one of your own ads (yes, it costs a click), and
   confirm the phone number displayed on the landing page changes to a Google
   forwarding number. Call it briefly — within ~3 hours the call shows in
   Ads → Conversions.
6. **Ads diagnostics**: Tools → Conversions → each action's status should move
   from "Inactive/Unverified" to **"Recording conversions"** within 24–48 h of
   the first real conversion.

## Field notes — 2026-07-07 setup session

The Google Ads UI changed from what Steps 4–5 describe. What the flow actually
looks like now, plus gotchas hit during the real setup:

- **New flow**: Goals → Conversions → Summary → **+ Create conversion action**
  opens a 3-step wizard (Get started → Create conversion actions → Summary).
  Conversion actions are grouped under **goal categories** (e.g. "Contact").
- **Call action path**: inside the Contact category → **+ Create conversion** →
  data source **"Calls from website visits"** (not "Calls from ads" — that only
  tracks call-extension numbers in the ad itself; "Calls via uploads" is offline
  import). Then choose event **"Someone calls a number shown on my website
  (Requires a Google Forwarding number)"** — this matches our
  `phone_conversion_number` snippet. The other option ("makes a call by
  clicking a number") is a tel:-click conversion needing a different snippet.
- **Two phone fields**: *Destination number* = raw digits callers reach
  (`7804793285`); *Display number* = **exactly** as rendered on the site:
  `(780) 479-3285` (must match `BUSINESS.phone` in `src/data/services.ts`).
- **Call length defaults to 60s** — lower it to 30s in Edit settings
  (Conversion settings panel). Emergency-restoration leads can be short calls.
- **Value**: "same value each conversion, CAD $1" is fine and slightly better
  than "no value" — gives Smart Bidding a signal to optimize on.
- **"No tag found for this account" warning** on the final Summary screen is
  expected while the site deploy predates the env vars — the site renders the
  Google tag itself (`Analytics.astro`); never install Google's snippet.
- **The label** lives under **"See event snippet"** on the final Summary
  screen — the string after `/` in `send_to: 'AW-XXXXXXXXXX/LABEL'`.
- **"Misconfigured" status** on an existing conversion action just means
  Google has never seen the tag fire; it self-resolves after deploy + first
  test conversion.
- **GA4 property check**: verify timezone/currency (Admin → Property details).
  This property was created with America/Los_Angeles + USD and had to be
  corrected to Edmonton + CAD.

## Cutover note — 2026-08-11 (BK-10)

Booking replaced the contact form as the site's quote path. What changed for
measurement:

- The form's Google Ads `conversion` tag was **removed from the site**;
  `PUBLIC_AW_FORM_LABEL` was deleted from `env.d.ts` and `.env.example`.
- The `Quote form submit` action in Google Ads is **Secondary, not deleted**.
- `Assessment booked` is the **Primary** action and should carry a value
  meaningfully above the call action's $1.
- GA4's `generate_lead` **kept its name** across the reframe. It means "someone
  sent a message" now, not "someone requested a quote". Renaming it would have
  broken every existing report for a purity win; a GA4 property annotation
  dated the change instead.
- Expect a **1–2 week Smart Bidding learning period** after the tag change.

## Troubleshooting

- **No gtag script in page source** → env vars not set for the environment you
  deployed, or deploy predates setting them. Re-check `vercel env ls`, redeploy.
- **Number never swaps** → the swap only happens for visitors arriving via an
  ad click (`gclid` in URL). Test via a real ad click, not by typing the URL.
- **Conversion action stuck "Unverified"** → normal until the first conversion
  is recorded; give it 48 h after a real test conversion.
- **Double-counted page views** → make sure the gtag snippet was never also
  added manually elsewhere (it shouldn't be — `Analytics.astro` is the only source).
