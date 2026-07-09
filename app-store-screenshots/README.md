# Stella Marketing Asset Studio

This is a small Next.js export tool for Stella marketing assets. It lives at repo root (`app-store-screenshots/`) and is **not** part of the Expo app: it does not import any modules from `mobile/`. Icon files under `public/` are copied in manually when you want them to match `mobile/assets/`.

## What it does

- Renders live Stella animation icon concepts on HTML for static PNG export
- Renders six App Store slides as marketing ads, not literal UI docs
- Uses Stella's real mobile icon assets and repo-derived product copy
- Supports `Carbon`, `Midnight`, and `Editorial` visual themes
- Supports both `iPhone` and `iPad` layouts
- Exports PNGs at Apple's portrait screenshot sizes

## Assumptions

- No raw mobile screenshot set was present, so the tool generates polished mock UI based on the real mobile flows in `mobile/app/(main)` and `mobile/app/(auth)`.
- The narrative arc is:
  1. desktop control on your phone
  2. everyday chat
  3. real computer tasks
  4. quick pairing
  5. flexible input
  6. personalization and polish

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

1. Pick a theme.
2. Pick `iPhone` or `iPad`.
3. Pick the target export size.
4. Use `Export current` or `Export all`.

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
