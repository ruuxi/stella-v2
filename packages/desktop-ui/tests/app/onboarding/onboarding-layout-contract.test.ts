import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = path.resolve(import.meta.dirname, "../../../src");

describe("onboarding theme grid layout", () => {
  it("caps the desktop grid at eight orbs and reflows at narrower widths", () => {
    const styles = readFileSync(
      path.join(sourceRoot, "global/onboarding/Onboarding.css"),
      "utf8",
    );
    const gridRule = styles.match(
      /\.onboarding-theme-grid--orbs\s*\{(?<body>[^}]*)\}/,
    )?.groups?.body;

    expect(gridRule).toBeDefined();
    expect(gridRule).toMatch(
      /grid-template-columns:\s*repeat\(auto-fit,\s*38px\)/,
    );
    expect(gridRule).toMatch(/width:\s*100%/);
    expect(gridRule).toMatch(/max-width:\s*388px/);
    expect(gridRule).not.toMatch(/repeat\(8,/);
  });
});
