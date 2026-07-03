# Google Ads + GA4 Tracking Setup Runbook

The site ships with tracking code that is **dormant until env vars are set**. No
scripts load and nothing changes on the page until you complete the steps below
and redeploy. Total time: ~30 minutes.

What you get once it's live:

- **Call conversions** — Google swaps the phone number shown on the site for
  visitors who clicked an ad, so calls are attributed to the exact campaign,
  ad group, and keyword.
- **Form conversions** — every quote-form submission is reported to Google Ads.
- **GA4 analytics** — page views plus a `click_to_call` event for every tap on
  a phone link, and a `generate_lead` event (tagged with the service requested)
  for every form submission.

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
2. You'll create two conversion actions (steps 4 and 5). Both share one
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

## Step 5 — Create the form conversion action

1. Conversions → **+ New conversion action** → **Website**.
2. Enter `https://yegrestoration.ca`, then create the action manually:
   - Category: **Submit lead form**.
   - Conversion name: `Quote form submit`.
   - Count: **One**.
3. Again choose "install yourself" and note the conversion **label** →
   `PUBLIC_AW_FORM_LABEL` (the `AW-` ID is the same one from Step 4).

## Step 6 — Set the env vars

Four variables, same names everywhere:

| Variable | Example value | From |
|---|---|---|
| `PUBLIC_GA4_ID` | `G-XXXXXXXXXX` | Step 1 |
| `PUBLIC_AW_ID` | `AW-XXXXXXXXXX` | Step 3/4 |
| `PUBLIC_AW_CALL_LABEL` | `AbC-D_efGhIjKlMnOp` | Step 4 |
| `PUBLIC_AW_FORM_LABEL` | `QrS-T_uvWxYzAbCdEf` | Step 5 |

**Vercel (production):**

```sh
vercel env add PUBLIC_GA4_ID production
vercel env add PUBLIC_AW_ID production
vercel env add PUBLIC_AW_CALL_LABEL production
vercel env add PUBLIC_AW_FORM_LABEL production
```

(or Dashboard → Project → Settings → Environment Variables). Add to
**Production only** — leaving preview/dev unset keeps test traffic out of your
conversion data.

**Local testing (optional):** add the same four lines to `.env.local`
(see `.env.example`), run `npm run dev`, and check that the gtag script loads.

## Step 7 — Redeploy

Env vars are baked in at build time (static site), so trigger a new deploy:

```sh
vercel --prod
```

or push any commit to `main`.

## Step 8 — Verify

1. **Tag present**: open yegrestoration.ca → view source → search for
   `googletagmanager.com/gtag/js`. Should appear exactly once.
2. **Tag Assistant**: install the [Tag Assistant Companion](https://tagassistant.google.com)
   extension, connect to the site — you should see the GA4 tag and the
   Google Ads tag fire on page load.
3. **Form event**: submit a test lead → in browser devtools console run
   `dataLayer` → the array should contain a `conversion` and a `generate_lead`
   event. In GA4: Reports → Realtime shows `generate_lead`.
4. **Number swap**: click one of your own ads (yes, it costs a click), and
   confirm the phone number displayed on the landing page changes to a Google
   forwarding number. Call it briefly — within ~3 hours the call shows in
   Ads → Conversions.
5. **Ads diagnostics**: Tools → Conversions → each action's status should move
   from "Inactive/Unverified" to **"Recording conversions"** within 24–48 h of
   the first real conversion.

## Troubleshooting

- **No gtag script in page source** → env vars not set for the environment you
  deployed, or deploy predates setting them. Re-check `vercel env ls`, redeploy.
- **Number never swaps** → the swap only happens for visitors arriving via an
  ad click (`gclid` in URL). Test via a real ad click, not by typing the URL.
- **Conversion action stuck "Unverified"** → normal until the first conversion
  is recorded; give it 48 h after a real test conversion.
- **Double-counted page views** → make sure the gtag snippet was never also
  added manually elsewhere (it shouldn't be — `Analytics.astro` is the only source).
