/**
 * Single source of truth for where the published desktop release assets live.
 *
 * The release workflow (`.github/workflows/build-desktop-release.yml`) writes
 * stable aliases under `desktop-v2/stable/`; every user-facing entry point —
 * the `/download/<platform>` redirect route, the download button, and the
 * `curl … | sh` installer script — resolves its URLs from here so a rename of
 * a release alias only has to happen in one place.
 */

export const R2_STABLE_BASE =
  "https://pub-a319aaada8144dc9be5a83625033769c.r2.dev/desktop-v2/stable";

/** Canonical site origin used by the installer script for static assets. */
export const SITE_ORIGIN = "https://stella.sh";

/**
 * Stable release asset aliases keyed by the `/download/<slug>` platform slug.
 *
 * Linux is published for x64 only (the release workflow builds
 * `--linux AppImage pacman --x64`), so there is deliberately no arm64 alias:
 * the installer script fails loudly on other architectures rather than
 * downloading an incompatible binary.
 */
export const RELEASE_ASSETS = {
  windows: `${R2_STABLE_BASE}/Stella.exe`,
  "mac-arm64": `${R2_STABLE_BASE}/Stella-darwin-arm64.dmg`,
  "mac-x64": `${R2_STABLE_BASE}/Stella-darwin-x64.dmg`,
  linux: `${R2_STABLE_BASE}/Stella-linux-x64.AppImage`,
  arch: `${R2_STABLE_BASE}/Stella-arch-x64.pkg.tar.xz`,
} as const satisfies Record<string, string>;

export type ReleaseAssetSlug = keyof typeof RELEASE_ASSETS;

/** The `curl … | sh` one-liner shown to Linux visitors. */
export const INSTALL_COMMAND = `curl -fsSL ${SITE_ORIGIN}/install.sh | sh`;
