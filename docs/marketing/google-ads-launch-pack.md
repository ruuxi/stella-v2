# Stella Google Search launch pack

Prepared August 5, 2026 and updated August 6, 2026. This is the source of truth
for the first paid-search test. The approved ceiling is $5,000 per month.

## Positioning

OpenCode's current copy is deliberately narrow and concrete:

- "The open source AI coding agent."
- "Low cost coding models for everyone."
- "$5 first month, then $10/month."
- "Use with any agent."

The pattern is strong: category, price, audience, then proof. Stella should keep
that clarity without pretending its recurring managed plan is cheaper. Stella's
advantage is a wider job boundary:

> One agent for more than code.

Stella is the personal assistant, knowledge-work agent, and coding agent in one
local-first desktop app. It can work across code, research, documents, browser,
files, and desktop apps. The offer is:

- Start free with supported bring-your-own-model options.
- Stella managed AI is $5 for the first month, then $10/month.
- Open source, local first, Mac and Windows.

Do not claim that Stella is cheaper than OpenCode. Do not imply affiliation with
OpenCode, Cursor, Claude, or any other competitor.

## Launch structure

Start with Search only. Disable Display expansion and Search Partners for the
first test so search terms remain interpretable.

### Campaign 1: `US | Search | Competitor | OpenCode`

- Goal: capture people already evaluating OpenCode or OpenCode Go.
- Landing page: `https://stella.sh/go?utm_source=google&utm_medium=cpc&utm_campaign=search_opencode&utm_content={creative}`
- Keywords: exact and phrase only; see `keywords.csv`.
- Visible copy: never use the OpenCode name. Sell "more than code."

### Campaign 2: `US | Search | Coding Agent`

- Goal: compete for category demand without depending on competitor volume.
- Landing page: `https://stella.sh/go?utm_source=google&utm_medium=cpc&utm_campaign=search_coding&utm_content={creative}`
- Keywords: exact and phrase only at launch.

### Campaign 3: `US | Search | Personal Work`

- Goal: reach the larger non-developer market Stella can serve.
- Landing page: `https://stella.sh/go?utm_source=google&utm_medium=cpc&utm_campaign=search_work&utm_content={creative}`
- Keep these intents in one Personal Work ad group for the low-budget pilot.
  Split them only after search-term volume justifies separate copy and budgets.

## Initial controls

- Location: United States, presence only (people in the location), English.
- Devices: desktop first. Exclude or sharply reduce mobile until cross-device
  install attribution exists.
- Ages: 18+ for the first test.
- Networks: Google Search on; Search Partners and Display off.
- Match types: exact and phrase. Do not enable broad match on a new account.
- Bidding: Maximize Clicks with a maximum CPC cap until reliable conversions
  exist. Suggested starting cap: $2.50; raise only if impression share is near
  zero on high-intent exact terms.
- Approved portfolio budget: $164.47/day, which is approximately $5,000 per
  Google Ads' 30.4-day budgeting month. Allocate $41.12/day to competitor,
  $65.79/day to coding, and $57.56/day to personal work.
- Schedule: all day initially. Review by hour after enough data exists.

## Conversion plan

The website currently has no Google tag or Google Ads conversion event. Do not
optimize toward "conversions" until these events are implemented and verified:

1. `download_stella` — click on the platform download button. Initial primary.
2. `first_successful_task` — the installed app completes a first useful turn.
   This should become the primary product conversion once attribution can cross
   from web to app.
3. `start_paid_plan` — completed paid subscription, with the real transaction
   value. Primary revenue conversion.

Until product activation attribution exists, judge campaigns on cost per
download, not raw clicks. Preserve `gclid`, `wbraid`, `gbraid`, and UTM values
on the landing site and carry attribution into browser-based sign-in when
possible.

Adding Google advertising tags also requires updating the public privacy notice
and deciding on consent behavior before production deployment. Stella's current
policy says it does not use user data for targeted advertising; do not silently
ship a remarketing setup that contradicts that promise.

## Responsive search ads

Use the assets in `responsive-search-ads.csv`. Every headline is at most 30
characters and every description is at most 90 characters. Keep assets unpinned
at launch unless Google produces incoherent combinations.

Recommended sitelinks:

| Sitelink | URL | Description 1 | Description 2 |
| --- | --- | --- | --- |
| Pricing | `/pricing` | Start free with Stella | Go is $5 the first month |
| How Stella Works | `/learn-more` | See what Stella can do | Browser, files, apps and more |
| Coding and Agents | `/go#work` | Build, debug and research | Keep background work moving |
| Open Source | `https://github.com/ruuxi/stella-v2` | Read Stella's source | Local-first desktop assistant |

Callouts:

- Start Free
- $5 First Month
- Open Source
- Local First
- Bring Your Own Models
- Mac and Windows
- Browser and Computer Use
- Docs and Spreadsheets

Structured snippet, `Features`:

- Coding
- Computer Use
- Research
- Documents
- Browser Automation
- Voice

## Negative-keyword discipline

Apply `negative-keywords.csv` at the account or campaign level. Check the Search
terms report every day for the first week. Add irrelevant terms immediately,
but do not negate high-intent comparison terms such as "alternative," "vs," or
"pricing."

## Decision rules

- Pause any keyword after 20 clicks with no download unless its search terms are
  unusually high intent and the landing page is the more likely problem.
- Pause any search term that is informational, employment-related, educational,
  pirated, or unrelated to desktop AI.
- Do not judge a responsive-search-ad asset from a handful of impressions.
- Once paid-plan attribution works, set a target CAC from gross margin and
  retention—not from the $5 intro payment.
- Expand to Canada, the United Kingdom, and Australia as separate campaigns
  only after the US test produces a stable cost per activated user.

## Google Ads account status

- Stella account: `439-929-3264` under `lolruuxi@gmail.com`.
- Billing country: United States; time zone: Phoenix; currency: USD.
- The new-advertiser offer is selected: spend $500 by October 5, 2026 to receive
  $500 in Ads credit, subject to Google's terms.
- Billing is not active. Google rejected the temporary $50 authorization on the
  saved payment methods. The remaining saved Visa requires its ZIP code to be
  updated manually.
- `Joyi 564-160-0625` was deliberately not reused because it contains $1,362.91
  in historical spend and has its own failed payment state.

After billing is corrected, run `bun run build-google-ads-import`, import
`google-ads-editor-import.csv` into account `439-929-3264`, review the proposed
changes, and keep the campaigns paused until the location option is confirmed
as presence-only. The import contains the approved $164.47/day portfolio cap,
Search-only networks, desktop-only device modifiers, keywords, negatives, six
responsive search ads, and account-level assets.

## Sources reviewed

- OpenCode homepage: https://opencode.ai/
- OpenCode Go: https://opencode.ai/go
- Google responsive search ads:
  https://support.google.com/google-ads/answer/7684791
- Google keyword matching:
  https://support.google.com/google-ads/answer/14996023
- Google negative keywords:
  https://support.google.com/google-ads/answer/2453972
- Google tag conversion tracking:
  https://support.google.com/google-ads/answer/7548399
- Google Maximize Clicks:
  https://support.google.com/google-ads/answer/6268626
