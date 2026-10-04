/**
 * Single source of truth for where the published desktop launchers live.
 *
 * Stella desktop ships as a native launcher per OS
 * (`.github/workflows/build-launchers.yml` publishes them under
 * `launcher/stable/` with a `SHA256SUMS` file); the launcher installs and runs
 * the app itself. Every user-facing entry point — the `/download/<platform>`
 * redirect route, the download button, and the `install.sh` / `install.ps1`
 * scripts — resolves its URLs from here so a rename only happens in one place.
 */

export const LAUNCHER_STABLE_BASE =
  "https://pub-a319aaada8144dc9be5a83625033769c.r2.dev/launcher/stable";

/** `sha256sum` output covering every launcher asset. */
export const LAUNCHER_CHECKSUMS_URL = `${LAUNCHER_STABLE_BASE}/SHA256SUMS`;

/** Canonical site origin used by the installer scripts. */
export const SITE_ORIGIN = "https://stella.sh";

/**
 * Launcher assets keyed by the `/download/<slug>` platform slug. The macOS
 * launcher is one universal app in a disk image, so both Mac slugs share it.
 * The Linux launchers are raw executables; `arch` stays a working slug and
 * gets the x64 launcher, which installs the same way on Arch/Omarchy.
 */
export const RELEASE_ASSETS = {
  windows: `${LAUNCHER_STABLE_BASE}/Stella.exe`,
  "mac-arm64": `${LAUNCHER_STABLE_BASE}/Stella-macos.dmg`,
  "mac-x64": `${LAUNCHER_STABLE_BASE}/Stella-macos.dmg`,
  linux: `${LAUNCHER_STABLE_BASE}/stella-launcher-linux-x64`,
  "linux-arm64": `${LAUNCHER_STABLE_BASE}/stella-launcher-linux-arm64`,
  arch: `${LAUNCHER_STABLE_BASE}/stella-launcher-linux-x64`,
} as const satisfies Record<string, string>;

/** The same Mac app zipped, for `install.sh`, which unpacks it without mounting. */
export const MAC_APP_ZIP = `${LAUNCHER_STABLE_BASE}/Stella-macos.zip`;

export type ReleaseAssetSlug = keyof typeof RELEASE_ASSETS;

/** The `curl … | sh` one-liner shown to Linux visitors. */
export const INSTALL_COMMAND = `curl -fsSL ${SITE_ORIGIN}/install.sh | sh`;
