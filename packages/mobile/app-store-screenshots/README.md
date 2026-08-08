# Stella Marketing Asset Studio

This is a small Next.js export tool for Stella marketing assets. It lives at repo root (`app-store-screenshots/`) and is **not** part of the Expo app: it does not import any modules from `mobile/`. Icon files under `public/` are copied in manually when you want them to match `mobile/assets/`.

## What it does

- Renders live Stella animation icon concepts on HTML for static PNG export
- Renders six App Store slides with deterministic, production-faithful mobile fixtures
- Uses Stella's current mobile navigation, icon assets, terminology, and product copy
- Supports `Carbon`, `Midnight`, and `Editorial` visual themes
- Supports both `iPhone` and `iPad` layouts
- Exports PNGs at Apple's 6.5-inch iPhone and 13-inch iPad portrait sizes

## Assumptions

- Paired-computer states depend on a live Stella desktop bridge, so the studio uses deterministic safe fixtures modeled on the current production components in `mobile/app/(main)` and `mobile/src/components`.
- The fixtures show the production narrow top bar and wide sidebar patterns, including the current `Chat`, `Computer`, and `Settings` labels. They do not claim to show live account or backend state.
- The narrative arc is:
  1. personal AI chat
  2. text and voice input
  3. paired-computer tasks and activity
  4. QR or manual-code pairing
  5. local-first storage with clear AI-processing language
  6. appearance, notifications, paired computers, and legal settings

## Run it

```bash
cd app-store-screenshots
bun dev
```

Then open `http://localhost:3000`.

## Export workflow

### Icon concepts

1. Open the `Stella Asset Studio` section.
2. Pick a surface, background, and animation state.
3. Freeze a frame if you want a specific static moment.
4. Export a single PNG or the `256 / 512 / 1024` set.

### App Store slides

For a reviewable production export, run:

```bash
cd app-store-screenshots
bunx playwright install chromium # first run only
NODE_ENV=production bun run build
NODE_ENV=production bun run start -- -p 3000
```

In a second terminal:

```bash
cd app-store-screenshots
bun run export:store
```

The export script clears old PNGs from the two target device folders and writes the six approved filenames directly to the ignored local path:

```text
mobile/store/apple/screenshot/en-US/APP_IPHONE_65/
mobile/store/apple/screenshot/en-US/APP_IPAD_PRO_3GEN_129/
```

Set `STELLA_SCREENSHOT_URL` to use a server on another port. Set `STELLA_SCREENSHOT_OUTPUT` to write somewhere other than the default ignored store path.

The interactive studio still supports theme, device, and size selection for previews and one-off exports.

Exports are named with a numeric prefix so they sort correctly in Finder and App Store Connect upload folders.

## Release asset policy

Screenshot PNGs are release assets, not source files. Generated exports under this tool's `out/` folder and staged copies under `mobile/store/apple/screenshot/` stay local and are ignored by git. The committed `mobile/store.config.json` deliberately omits screenshot paths, so a fresh checkout never points EAS Metadata at files that are not in the repository.

The committed config also omits `apple.version`. EAS Metadata otherwise targets the latest available App Store version. When a specific release version has been chosen and exists in App Store Connect, add `apple.version` to the local release config before syncing versioned metadata; do not guess the next version in source control.

For a listing update:

1. Export a fresh iPhone and iPad set and compare every mock screen and claim with the shipping app.
2. Remove personal data, internal notes, and stale UI before approval.
3. Archive the approved originals in versioned release-asset storage with a checksum manifest.
4. Upload them directly in App Store Connect, or copy them into the ignored `mobile/store/apple/screenshot/` folder and add the screenshot map only to a local, uncommitted metadata config before running `eas metadata:push`.

Do not add generated screenshot binaries or committed paths to missing screenshots unless the repository adopts an intentional Git LFS or release-assets convention.

## Key files

- `src/app/page.tsx`: all slide definitions, mock screens, toolbar controls, and export logic
- `src/components/StellaIconStudio.tsx`: live Stella animation icon preview and PNG export controls
- `src/components/stella-animation/*`: WebGL renderer adapted for the asset studio
- `src/app/layout.tsx`: Stella-aligned font setup
- `public/app-icon.png`: copied from `mobile/assets/icon.png`
- `public/splash-icon.png`: copied from `mobile/assets/splash-icon.png`
- `public/mockup.png`: iPhone frame asset used for export
