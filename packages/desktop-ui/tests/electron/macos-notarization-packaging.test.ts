import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");

const read = (relativePath: string) =>
  readFileSync(path.join(repoRoot, relativePath), "utf8");

describe("macOS notarization packaging contracts", () => {
  it("defines an afterPack hook that removes unused prebuild archives", () => {
    const pkg = JSON.parse(read("package.json")) as {
      build: { afterPack?: string };
    };
    expect(pkg.build.afterPack).toBe(
      "packages/desktop/scripts/after-pack.mjs",
    );

    const afterPack = read(pkg.build.afterPack as string);
    expect(afterPack).toContain("mac-screen-capture-permissions");
    expect(afterPack).toContain("prebuilds");
    // Ensure the hook keeps the legitimate signed binary at build/Release (it does via explicit protection in code comments)
    // but the string for the binary path appears only inside comments explaining preservation.
    // So we just assert it logs for CI visibility.
    expect(afterPack).toContain("[afterPack]");
  });

  it("does not reintroduce the offending tar.gz payload via build.files or extraResources", () => {
    const pkg = JSON.parse(read("package.json")) as {
      build: { files: unknown[]; extraResources: unknown[] };
    };
    const serialized = JSON.stringify(pkg.build);
    // The forbidden pattern is a tar.gz under mac-screen-capture-permissions/prebuilds.
    // If we ever explicitly include that path again, fail fast before we waste Apple notarization time.
    expect(serialized).not.toContain(
      "mac-screen-capture-permissions/prebuilds",
    );
    expect(serialized).not.toContain(
      "mac-screen-capture-permissions-v2",
    );
  });

  it("preserves the existing notarization hook and signing contracts", () => {
    const pkg = JSON.parse(read("package.json")) as {
      build: { afterSign: string; mac: { entitlements: string; entitlementsInherit: string } };
    };
    expect(pkg.build.afterSign).toBe("packages/desktop/scripts/notarize.mjs");
    // Sanity: notarize script still references required env vars.
    const notarize = read(pkg.build.afterSign);
    expect(notarize).toContain("APPLE_ID");
    expect(notarize).toContain("APPLE_PASSWORD");
    expect(notarize).toContain("notarize");
  });
});
