# Store capture story — September 2026

Status: real capability work and native artifact verification are complete; final device captures and export review remain in progress. The revised phone memory scene and supporting-artifact composition have been reviewed, but no complete revised set is approved for upload. The old exports and native captures are preserved only in ignored `out/archive-rejected-story-20260906/`; they are not current candidates.

Stella is one long-running conversation with memory. Product screenshots must show useful computer work, browser work, shopping and continuity. Never use model selection or a list of separate chats as a marketing story.

## Proposed four scenes

| Slide    | Short headline                  | Source example                                                                                                | Actual capture requirement                                                                                                                                                                                                                                                               |
| -------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| computer | Your computer. From your phone. | Desktop onboarding: “Update the Q3 sheet and build the board deck”                                            | Request a bounded task against synthetic local documents. Capture the actual mobile result after work completes on the paired computer.                                                                                                                                                  |
| browser  | Leave the browsing to Stella.   | Desktop onboarding: “Book sushi for two on Friday at 8”                                                       | Find actual restaurant options/availability and show the useful result. Do not make a real reservation merely for the screenshot.                                                                                                                                                        |
| shopping | Let Stella handle checkout.     | Desktop onboarding: “Order the trail runners I looked at yesterday, size 10”, followed by a confirmation card | Show an actual checkout workflow paused for purchase approval, paired with the subtitle “You approve the purchase.” Recommendations alone do not establish this claim. Do not invent an order, receipt, shipping estimate or payment completion. No purchase is authorized by this task. |
| memory   | It remembers what matters.      | Desktop onboarding MemoryCard: one conversation that remembers earlier context                                | Continue the same conversation and recall a preference/item genuinely supplied earlier. Do not manufacture memory or recreate the app UI.                                                                                                                                                |

Source references: `packages/desktop-ui/src/global/onboarding/chat/cards/CapabilitiesCard.tsx` defines the concrete errands, shopping and work prompts. `packages/desktop-ui/src/global/onboarding/demo/DemoScenes.tsx` renders their illustrative onboarding scenes. `packages/desktop-ui/src/global/onboarding/chat/cards/MemoryCard.tsx` establishes the single-conversation memory story. These examples guide the narrative; their hard-coded completion messages are not proof of a real transaction and must not be presented as such.

All four actual scenes use one ongoing conversation on the isolated dev Pro account. The computer created a September sales workbook and three-slide deck from synthetic source files. The browser visited Hana Japanese Eatery's real website. Shopping reached Merrell checkout for one black size-10 pair at $110, leaving shipping and payment blank. Memory saved the color preference and recalled the earlier size and budget. No reservation or purchase was made.

Native image and PowerPoint previews passed after controlled computer restarts, without manual session refresh. Evidence is in `.agents/skills/verify-stella/artifacts/store-capabilities-browser/`. The generated deck's obsolete template date was subsequently removed as an explicitly approved document edit; do not attribute that cleanup to Stella. Its original backup and exact ZIP-part comparison are recorded in `deck-footer-cleanup/provenance.json`. The corrected document was reopened in the native app successfully.

Coordinate Simulator ownership with the native release agent. Do not expose diagnostic tokens, IDs, development overlays, private files, account details or credentials.

## Capture and export gates

Actual native screenshots go in `public/captures/{iphone,ipad,android,android7,android10}/{computer,browser,shopping,memory}.png`. New slugs intentionally prevent the rejected old captures from exporting under the revised copy. Missing sources block export.

The first three scenes also require `public/supporting/{computer,browser,shopping}.png`, rendered or captured from those same actual task outputs. The exporter waits for these images to decode and records their dimensions and hashes separately. Missing supporting images block export before any output is created.

Capture actual iPhone and iPad viewports independently; do not stretch phone pixels into a tablet. Android phone, 7-inch tablet and 10-inch tablet groups must use their own actual native viewport captures; never stretch one group into another. Native status-bar overrides may show 9:41/full battery, as authorized by root. Preserve native pixels; no UI mockups, retouching or fabricated results.

The composition/export pipeline remains validated: production build and TypeScript passed, missing captures block export, and the prior pipeline audit confirmed exact dimensions/full opacity. Those checks validate the tooling, not the revised story or its future captures.

When final captures exist, export into a fresh folder and run `scripts/review-exports.py`. Review all images at full resolution and in contact sheets; record source/build/device provenance and source/output SHA-256 hashes. Store upload/submission remains root-owned and must use only a subsequently approved revised set.
