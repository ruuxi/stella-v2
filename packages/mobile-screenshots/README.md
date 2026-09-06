# Stella store image studio

Four restrained store slides built around **actual native screenshots**: computer work, browser errands, shopping review, and memory in one ongoing conversation. The studio adds typography, background color, and a simple border around each capture. It does not redraw, restyle, crop, or invent the app UI. Icon animation tools remain at `/animation`.

## Capture handoff

Capture the current shipping candidate on each device independently. Use real UI actions with a safe test account and natural conversation content. No test markers, personal data, debug overlays, keyboards, stale designs, or unverified claims. Coordinate Simulator ownership with the mobile verification agent.

Place full portrait PNG captures in the ignored local folder:

```
public/captures/iphone/{computer,browser,shopping,memory}.png
public/captures/ipad/{computer,browser,shopping,memory}.png
public/captures/android/{computer,browser,shopping,memory}.png
public/captures/android7/{computer,browser,shopping,memory}.png
public/captures/android10/{computer,browser,shopping,memory}.png
```

- `computer`: real work completed on the paired computer and opened from the phone.
- `browser`: a real browser task with useful results, such as restaurant availability.
- `shopping`: a real item/cart ready for review, without a fabricated purchase.
- `memory`: the same ongoing conversation recalling an earlier preference or item.

Never use model selection or multiple chat history as a Stella product screenshot story. New capture slugs intentionally block reuse of the rejected earlier narrative. That material is preserved only in ignored `out/archive-rejected-story-20260906/`.

The first three slides also show the real task output at a readable size alongside the native capture. Place those unaltered images at `public/supporting/{computer,browser,shopping}.png`. They must come from the same actual tasks; never draw replacement UI or invent a completed checkout. Export requires every supporting image and records its dimensions and hash separately from the native sources.

Use the actual iPad layout for iPad. Android export is prepared, but requires genuine Android captures; iOS screenshots must never stand in for Android. Missing captures show a clearly labeled empty placeholder in the studio and block all exports. Do not export placeholders.

## Preview and export

```
bun run dev -- -p 3015
```

Preview `http://localhost:3015`. After adding captures, restart if using a production build. To export:

```
STELLA_SCREENSHOT_URL=http://localhost:3015 bun run export:store
```

If Playwright’s bundled Chromium is unavailable, set `STELLA_SCREENSHOT_BROWSER_CHANNEL=chrome` to use installed Chrome. This is the browser used for the September 2026 export review.

Default devices are iPhone (1242 × 2688) and iPad (2064 × 2752), matching the existing Apple target groups. `STELLA_SCREENSHOT_DEVICES=android,android7,android10` prepares the independent Play phone and tablet groups **only once genuine Android captures for every requested viewport exist**. Verify current store requirements before upload.

The Play feature graphic also requires the actual Android computer capture:

```
STELLA_SCREENSHOT_URL=http://localhost:3016 STELLA_SCREENSHOT_BROWSER_CHANNEL=chrome bun scripts/export-feature-graphic.ts
```

Exports go into a new timestamped `out/store-*` folder. `STELLA_SCREENSHOT_OUTPUT` may set another new directory; an existing destination is rejected. No previous approved PNGs are deleted or replaced. The manifest records source and output dimensions and SHA-256 hashes. Generated PNGs and native sources are ignored release assets, not committed source.

Review every exported slide at full resolution and thumbnail size: readable text, no clipping, actual device UI, coherent conversation, accurate feature claims, consistent color/spacing. Record app build and capture provenance beside the export manifest. This tool does not upload, submit, sync metadata, or publish store images.

After export, run `python3 scripts/review-exports.py out/store-<timestamp>` (requires Pillow) to verify every PNG's dimensions and full opacity and write one labeled contact sheet per device. These sheets are review artifacts, not store uploads.
