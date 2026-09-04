import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const read = (relativePath: string) =>
  readFileSync(path.join(repoRoot, relativePath), "utf8");

describe("M4 desktop release contracts", () => {
  it("keeps loopback verification out of the production Electron entry", () => {
    expect(read("packages/desktop/electron/main.ts")).not.toContain(
      "local-update-verification",
    );
    const buildScript = read("packages/desktop/scripts/dev-electron-build.mjs");
    expect(buildScript).toContain("--local-update-verification");
    expect(buildScript).toContain("includeLocalUpdateVerification");
  });

  it("publishes only exact stable semantic versions to the stable feed", () => {
    const workflow = read(".github/workflows/build-desktop-release.yml");
    expect(workflow).toContain("^[0-9]+\\.[0-9]+\\.[0-9]+$");
    expect(workflow).toContain("needs: validate_stable_tag");
  });

  it("keeps the microphone entitlement on the parent only, and JIT on both", () => {
    const rootPackage = JSON.parse(read("package.json")) as {
      build: { mac: { entitlements: string; entitlementsInherit: string } };
    };
    const parent = read(rootPackage.build.mac.entitlements);
    const inherit = read(rootPackage.build.mac.entitlementsInherit);
    // Only the parent prompts for the mic; helpers must never inherit it.
    expect(parent).toContain("com.apple.security.device.audio-input");
    expect(inherit).not.toContain("com.apple.security.device.audio-input");
    // Electron's own renderer needs JIT too, so this pair is shared rather
    // than helper-only.
    expect(parent).toContain("com.apple.security.cs.allow-jit");
    expect(inherit).toContain("com.apple.security.cs.allow-jit");
    expect(inherit).toContain(
      "com.apple.security.cs.disable-library-validation",
    );
  });

  it("keeps retired source-update residue deleted", () => {
    const retiredGenerator = [
      "packages/desktop/scripts",
      ["generate", "desktop", "source", "pack.mjs"].join("-"),
    ];
    expect(
      existsSync(path.join(repoRoot, ...retiredGenerator)),
    ).toBe(false);
  });

  it("stages the download silently and offers a one-click install", () => {
    const pill = read(
      "packages/desktop-ui/src/shell/ShellTopBarUpdatePill.tsx",
    );
    // A finished download announces nothing: the payload is fetched in the
    // background and the only thing the user ever sees is an Update button
    // that installs on the first click.
    expect(pill).not.toContain("downloadedTitle");
    expect(pill).toContain('t("shell.updatePill.update")');

    const updater = read(
      "packages/desktop/electron/updates/desktop-updater.ts",
    );
    expect(updater).toContain(
      "this.autoDownload = options.autoDownload ?? true",
    );
  });

  it("allows macOS update restarts to close auxiliary windows", () => {
    const lifecycle = read(
      "packages/desktop/electron/bootstrap/lifecycle.js",
    );
    expect(lifecycle).toContain(
      'autoUpdater.on("before-quit-for-update"',
    );
    expect(lifecycle).toContain("context.state.isQuitting = true");

    const appShell = read(
      "packages/desktop/electron/bootstrap/app-shell.js",
    );
    expect(appShell.match(/isQuitting: \(\) => state\.isQuitting/g)).toHaveLength(
      2,
    );

    expect(
      read("packages/desktop/electron/windows/overlay-window.js"),
    ).toContain("if (this.options.isQuitting?.())");
  });
});
