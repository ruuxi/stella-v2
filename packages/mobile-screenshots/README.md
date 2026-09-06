# Stella store image studio

Four store slides built around **actual native screenshots**, in this order: **assistant → browser → shopping → computer**. All five device groups use the same sequence; memory is not selected. The studio composes real captures and task outputs with Stella typography, characters and the website aura. It does not redraw or invent app UI. Icon animation tools remain at `/animation`. See [CAPTURE_PLAN.md](CAPTURE_PLAN.md) for capture provenance and current release gates.

## Capture handoff

Capture the current shipping candidate on each device independently. Use real UI actions with a safe test account and natural conversation content. No test markers, personal data, debug overlays, keyboards, stale designs, or unverified claims. Coordinate Simulator ownership with the mobile verification agent.

Place full portrait PNG captures in the ignored local folder:

```
public/captures/iphone/{computer,browser,shopping}.png
public/captures/ipad/{computer,browser,shopping}.png
public/captures/android/{computer,browser,shopping}.png
public/captures/android7/{computer,browser,shopping}.png
public/captures/android10/{computer,browser,shopping}.png
```

- `computer`: real work completed on the paired computer and opened from the phone.
- `browser`: a real browser task with useful results, such as restaurant availability.
- `shopping`: a real item/cart ready for review, without a fabricated purchase.
- `assistant`: reuses that device's `computer.png` through `captureSlug`; no separate raw capture is needed.

Never use model selection or multiple chat history as a Stella product screenshot story. New capture slugs intentionally block reuse of the rejected earlier narrative. That material is preserved only in ignored `out/archive-rejected-story-20260906/`.

The browser, shopping and computer slides also show the real task output at a readable size alongside the native capture. Place those unaltered images at `public/supporting/{computer,browser,shopping}.png`. They must come from the same actual tasks; never draw replacement UI or invent a completed checkout. Export requires every supporting image and records its dimensions and hash separately from the native sources.

Use native iPhone and iPad layouts independently. Android export requires genuine Android captures; iOS screenshots must never stand in for Android. Missing captures show a clearly labeled empty placeholder in the studio and block all exports. Do not export placeholders.

## Local asset setup

Run commands from this package after installing the monorepo dependencies. Native captures, supporting outputs and Chrome Web Store captures are local release inputs, excluded from Git. Restore reviewed originals from the release artifact handoff or capture them again through the real product; do not recreate missing UI. Source metadata is retained in `public/chrome-store/SOURCES.json`.

The iPhone hardware frame is a third-party asset whose recorded terms prohibit standalone redistribution. It must remain local. Fetch it separately using the source and hash documented in [public/devices/SOURCES.md](public/devices/SOURCES.md):

```sh
mkdir -p public/devices
curl --fail --location 'https://www.webmobilefirst.com/img/mockups/mockup-apple-iphone-17-2025-transparent.png' --output public/devices/iphone-17.png
printf '%s\n' '6fd24f0b61434f1bbf07ee3ec7d1e2b965abd518a4be8bd7e997add2ac789f05  public/devices/iphone-17.png' | shasum -a 256 -c -
```

If the hash differs, inspect the changed upstream asset and terms before rendering. Do not commit the downloaded PNG. Do not distribute it separately from a permitted composition.

For the September Chrome Web Store story, the two website captures are the same unaltered sources as the supporting artifacts:

```sh
mkdir -p public/chrome-store
cp public/supporting/browser.png public/chrome-store/browser.png
cp public/supporting/shopping.png public/chrome-store/checkout.png
```

Restore the reviewed `public/chrome-store/connected-popup.png` from the capture handoff, or capture the installed extension's actual Connected popup afresh. The website and popup PNGs remain ignored. Record source hashes and review freshness before exporting; these commands alone do not approve captures.

First-party assets in `public/brand` are committed: the gradient cursor is the exact asset embedded in `packages/stella-browser/extension/lib/agent-cursor.js` (`CURSOR_ASSET`), also used by native desktop automation. The aura panorama and its provenance are generated from the canonical website shader. To regenerate the aura with installed Chrome:

```sh
bun scripts/render-store-aura.ts
```

This freezes the original shader and records its source hash, sampling domain, uniforms and output hash. Rendering environments may differ; visually review a regenerated panorama before replacing an approved one. The blob uses the desktop character rig directly.

## Preview and export

```
bun run dev -- -p 3015
```

Preview `http://localhost:3015`. After adding captures, restart if using a production build. To export:

```
STELLA_SCREENSHOT_URL=http://localhost:3015 \
STELLA_SCREENSHOT_DEVICES=iphone,ipad,android,android7,android10 \
STELLA_SCREENSHOT_SLIDES=assistant,browser,shopping,computer \
bun run export:store
```

If Playwright’s bundled Chromium is unavailable, set `STELLA_SCREENSHOT_BROWSER_CHANNEL=chrome` to use installed Chrome. This is the browser used for the September 2026 export review.

Default devices are iPhone (1242 × 2688) and iPad (2064 × 2752), matching the existing Apple target groups. `STELLA_SCREENSHOT_DEVICES=android,android7,android10` prepares the independent Play phone and tablet groups **only once genuine Android captures for every requested viewport exist**. Verify current store requirements before upload.

Always explicitly select `STELLA_SCREENSHOT_SLIDES=assistant,browser,shopping,computer` for the final sequence; the source catalog still contains historical memory. Each of the five groups exports four images, 20 total. Unknown or duplicate scene names fail; every requested native capture and supporting artifact must exist and decode. Android output sizes are 1080 × 1920 for phone and 7-inch, and 1440 × 2560 for 10-inch. These are composition sizes, not substitutes for independent native captures.

The Play feature graphic also requires the actual Android computer capture:

```
STELLA_SCREENSHOT_URL=http://localhost:3015 STELLA_SCREENSHOT_BROWSER_CHANNEL=chrome bun scripts/export-feature-graphic.ts
```

The Chrome Web Store exporter uses the studio on port 3015: `bun scripts/export-chrome-store.ts`. It requires the three local CWS captures above; `STELLA_CWS_OUTPUT` selects a new output directory. Existing submitted CWS assets are separate from mobile release work.

Exports go into a new timestamped `out/store-*` folder. `STELLA_SCREENSHOT_OUTPUT` may set another new directory; an existing destination is rejected. No previous approved PNGs are deleted or replaced. The manifest records source and output dimensions and SHA-256 hashes. Generated PNGs and native sources are ignored release assets, not committed source.

Review every exported slide at full resolution and thumbnail size: readable text, no clipping, actual device UI, coherent conversation, accurate feature claims, consistent color/spacing. Record app build and capture provenance beside the export manifest. This tool does not upload, submit, sync metadata, or publish store images.

After export, run `python3 scripts/review-exports.py out/store-<timestamp>` (requires Pillow) to verify every PNG's dimensions and full opacity and write one labeled contact sheet per device. These sheets are review artifacts, not store uploads.
