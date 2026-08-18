# Stella Google Search launch pack

Prepared August 5, 2026 and updated August 11, 2026. This is the source of
truth for the current paid-search test. The approved ceiling remains $5,000 per
month, but only $98.68/day is active while the new positioning is validated.

## Positioning

Stella is a personal AI assistant and AI coworker that works across the user's
computer: browser, files, documents, research, voice, and desktop apps. Coding
is a supported use case, not the primary category.

The competitive intent is Claude Cowork. The message should be premium and
capable, with affordability as supporting evidence rather than the identity of
the product:

> Delegate real work to a personal AI that lives on your computer.

The introductory offer is $5 for the first month. Avoid words such as "cheap,"
"budget," or "beginner." Do not imply affiliation with Anthropic or use the
Claude trademark in visible ad copy. Competitor names may be used as search
keywords where Google Ads policy permits.

OpenCode is no longer a strategic competitor. Coding-agent demand should not
receive a dedicated budget unless later search-term evidence supports it.

## Active structure

Search only. Search Partners and Display expansion remain off so search terms
and spend are interpretable.

### Campaign 1: `US | Search | Competitor | Claude Cowork`

- Goal: reach people actively evaluating Claude Cowork or searching for an AI
  coworker for personal and knowledge work.
- Landing page: `https://stella.sh/go?utm_source=google&utm_medium=cpc&utm_campaign=search_claude_cowork&utm_content={creative}`
- Keywords: exact Claude Cowork terms plus tightly scoped phrase-match AI
  coworker terms; see `keywords.csv`.
- Visible copy: sell Stella as a personal AI coworker without using Claude in
  ad text.
- Budget: $41.12/day.

### Campaign 2: `US | Search | Personal Work`

- Goal: reach broader non-developer demand for an AI assistant that can act on
  a computer rather than only answer questions.
- Landing page: `https://stella.sh/go?utm_source=google&utm_medium=cpc&utm_campaign=search_work&utm_content={creative}`
- Keep tightly related personal-work intents in one ad group during the pilot.
  Split only after search-term and conversion volume justify separate copy.
- Budget: $57.56/day.

### Paused historical campaigns

- `US | Search | Coding Agent` — paused; coding is no longer the lead category.
- `US | Search | Competitor | OpenCode` — paused; preserve for history only.

## Controls

- Location: United States, presence only.
- Language: English.
- Devices: desktop only; mobile and tablet bid adjustments are `-100%`.
- Networks: Google Search on; Search Partners and Display off.
- Match types: exact and phrase; broad match off.
- Bidding: Maximize Clicks with a $2.50 maximum CPC.
- Active budget: $98.68/day, approximately $3,000 per Google Ads' 30.4-day
  budgeting month.
- AI Max, final URL expansion, text customization, and automatically created
  assets are off.
- Schedule: all day initially; review by hour after enough conversion data.

## Conversion plan

Google Ads conversion action `Download Stella` is configured as the
account-default Outbound click goal. It is a primary action, counts one
conversion per ad interaction, uses a 30-day click-through window, and does not
use enhanced conversions.

The website implementation uses Google tag `AW-18375048850` and conversion
destination `AW-18375048850/CrdSCMj5-d8cEJL987lE`. The tag loads only for a
Google Ads referral (`gclid`, `gbraid`, or `wbraid`) or during its retained
30-day attribution window. A download button click sends the conversion event
before redirecting to the installer, with a timeout fallback so tracking can
never block the download.

The conversion action will remain misconfigured/inactive in Google Ads until
the website change is deployed and an attributed download is observed. Do not
switch bidding to Maximize Conversions before the tag is verified and enough
conversion volume exists.

Future product events:

1. `first_successful_task` — the installed app completes a first useful task.
2. `start_paid_plan` — a completed paid subscription with transaction value.

Once cross-device product attribution exists, optimize toward activated users
or paid plans rather than raw downloads.

## Responsive search ads

Use the assets in `responsive-search-ads.csv`. The Claude Cowork campaign has
two unbranded-to-competitor responsive ads, while Personal Work retains its
current ads and adds one unpinned variant for combination learning. Every
headline is at most 30 characters and every description is at most 90.

The offer should be expressed as `$5 first month`; avoid cheap-product framing.

Recommended account-level sitelinks:

| Sitelink | URL | Description 1 | Description 2 |
| --- | --- | --- | --- |
| Pricing | `/pricing` | Start free with Stella | Go is $5 the first month |
| How Stella Works | `/learn-more` | See what Stella can do | Browser, files, apps and more |
| AI Agents | `/agents` | Delegate complete tasks | Keep background work moving |
| Voice | `/voice` | Talk and dictate naturally | On-device dictation on Mac |
| Data and Privacy | `/storage` | See what is stored locally | Understand cloud processing |

Callouts:

- Start Free
- $5 First Month
- Local Desktop Database
- Bring Your Own Models
- Mac and Windows
- Browser and Computer Use
- Docs and Spreadsheets

Structured snippet, `Features`:

- Computer Use
- Research
- Documents
- Browser Automation
- Voice
- Coding

## Negative-keyword discipline

Apply `negative-keywords.csv` at the account or campaign level. The Personal
Work campaign also excludes old coding-competitor demand and coworking-office
intent. Check the Search terms report daily during the first week and add
irrelevant terms immediately. Do not negate high-intent comparison terms such
as `alternative`, `vs`, or `pricing`.

## Decision rules

- Pause a keyword after 20 clicks with no download unless its search terms are
  unusually high intent and the landing page is the more likely problem.
- Pause informational, employment, education, pirated, physical-office, and
  unrelated search terms immediately.
- Do not judge an RSA asset from a handful of impressions.
- Keep Maximize Clicks until download measurement is live and statistically
  useful; then test conversion bidding deliberately.
- Once paid-plan attribution works, set target CAC from gross margin and
  retention, not from the introductory payment.
- Expand to Canada, the United Kingdom, and Australia only after the US test
  produces a stable cost per activated user.

## Google Ads account status

- Stella account: `439-929-3264` under `lolruuxi@gmail.com`.
- Billing: United States, Phoenix time zone, USD; advertiser verification is
  complete under FromYou, LLC.
- `US | Search | Personal Work` is active at $57.56/day.
- `US | Search | Competitor | Claude Cowork` is active at $41.12/day and is in
  learning.
- Coding Agent and OpenCode are paused.
- The transition upload applied 72 of 72 spreadsheet rows successfully.
- The new campaign uses Google Search only, United States presence-only,
  desktop-only traffic, exact/phrase match, and Maximize Clicks.
- The five current account sitelinks cover Pricing, How Stella Works, AI Agents,
  Voice, and Data and Privacy. The older Coding and Agents asset
  is paused.
- Image and logo assets have not been uploaded. Generated concepts require
  approval before account changes.
- Download conversion tracking exists in Google Ads and is staged locally on
  the website, but is not deployed.

Run `bun run build-google-ads-import` to regenerate the Google Ads Editor file,
the full web bulk-upload file, and the narrow Claude Cowork transition file.
Account-level assets are managed in the Google Ads UI.

## Sources reviewed

- Claude pricing: https://claude.com/pricing
- Claude Cowork computer use: https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork
- Google trademark policy: https://support.google.com/adspolicy/answer/6118
- Google responsive search ads: https://support.google.com/google-ads/answer/7684791
- Google keyword matching: https://support.google.com/google-ads/answer/14996023
- Google negative keywords: https://support.google.com/google-ads/answer/2453972
- Google tag conversion tracking: https://support.google.com/google-ads/answer/7548399
- Google Maximize Clicks: https://support.google.com/google-ads/answer/6268626
