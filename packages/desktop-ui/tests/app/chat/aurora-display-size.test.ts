// @vitest-environment jsdom

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { resolveAuroraSpec } from "@/shell/aurora/aurora-spec";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const makeContainer = () => {
  const container = document.createElement("div");
  container.style.setProperty("--aurora-cell-width", "5px");
  container.style.setProperty("--aurora-cell-height", "7px");
  document.body.appendChild(container);
  return container;
};

describe("working-indicator aurora display sizing", () => {
  it("keeps the supersampled backing buffer while using a native 30px footprint", () => {
    const container = makeContainer();

    try {
      const spec = resolveAuroraSpec(container, {
        width: 10,
        height: 7.15,
        displayWidth: 30,
        displayHeight: 30,
        maxDpr: 1,
      });

      expect(spec.cssWidth).toBe(30);
      expect(spec.cssHeight).toBe(30);
      expect(spec.backingWidth).toBe(125);
      expect(spec.backingHeight).toBe(125);
    } finally {
      container.remove();
    }
  });

  it("keeps the natural canvas footprint when no display size is supplied", () => {
    const container = makeContainer();

    try {
      const spec = resolveAuroraSpec(container, {
        width: 10,
        height: 7.15,
        maxDpr: 1,
      });

      expect(spec.cssWidth).toBe(125);
      expect(spec.cssHeight).toBe(125);
      expect(spec.backingWidth).toBe(125);
      expect(spec.backingHeight).toBe(125);
    } finally {
      container.remove();
    }
  });

  it("keeps the working indicator free of a transformed WebGL wrapper", () => {
    const component = fs.readFileSync(
      path.join(PACKAGE_ROOT, "src/app/chat/WorkingIndicator.tsx"),
      "utf8",
    );
    const css = fs.readFileSync(
      path.join(PACKAGE_ROOT, "src/app/chat/indicators.css"),
      "utf8",
    );
    const wrapperRule = css.match(
      /\.indicator-stella-scale\s*\{([^}]*)\}/,
    )?.[1];

    expect(component).toContain("displayWidth={30}");
    expect(component).toContain("displayHeight={30}");
    expect(wrapperRule).toContain("inset: 0");
    expect(wrapperRule).not.toMatch(/\btransform\s*:/);
    expect(wrapperRule).not.toMatch(/\btranslate\s*:/);
  });
});
