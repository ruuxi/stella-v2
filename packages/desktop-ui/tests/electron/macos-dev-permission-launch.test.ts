import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

const readDesktopScript = (relativePath: string) =>
  fs.readFileSync(
    path.join(REPO_ROOT, "packages/desktop/scripts", relativePath),
    "utf8",
  );

describe("macOS development permission identity", () => {
  it("launches Electron as its own TCC-responsible Stella app", () => {
    const launcher = readDesktopScript("launch-electron-dev.mjs");

    expect(launcher).toContain("prepareMacDevPermissionIdentity");
    expect(launcher).toContain("resolveMacDevResponsibilityLauncher");
    expect(launcher).toContain('[electronBinary, ".", "--dev"]');
  });

  it("aligns the bundle executable without restoring the retired lifecycle", () => {
    const identity = readDesktopScript(
      "lib/macos-dev-permission-identity.mjs",
    );
    const responsibilityLauncher = readDesktopScript("disclaim-spawn.c");
    const combined = `${identity}\n${responsibilityLauncher}`;

    expect(identity).toContain('"CFBundleExecutable"');
    expect(identity).toContain("path.basename(electronBinary)");
    expect(identity).toContain('const DEV_BUNDLE_ID = "com.stella.app"');
    expect(responsibilityLauncher).toContain(
      '"responsibility_spawnattrs_setdisclaim"',
    );
    expect(combined).not.toContain("StellaDevRelaunch");
    expect(combined).not.toContain("electron-dev-runner");
    expect(combined).not.toContain("STELLA_LAUNCHER");
  });
});
