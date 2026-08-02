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

  it("separates the parent microphone entitlement from helper exceptions", () => {
    const rootPackage = JSON.parse(read("package.json")) as {
      build: { mac: { entitlements: string; entitlementsInherit: string } };
    };
    const parent = read(rootPackage.build.mac.entitlements);
    const inherit = read(rootPackage.build.mac.entitlementsInherit);
    expect(parent).toContain("com.apple.security.device.audio-input");
    expect(parent).not.toContain("com.apple.security.cs.allow-jit");
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

  it("describes the completed download truthfully", () => {
    const pill = read(
      "packages/desktop-ui/src/shell/ShellTopBarUpdatePill.tsx",
    );
    expect(pill).toContain('title: "Update downloaded"');
    expect(pill).not.toContain('title: "Downloading Stella update"');
  });
});
