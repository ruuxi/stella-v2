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

  it("no longer mounts the aurora inside the chat working indicator", () => {
    const component = fs.readFileSync(
      path.join(PACKAGE_ROOT, "src/app/chat/WorkingIndicator.tsx"),
      "utf8",
    );

    expect(component).not.toContain("StellaAnimation");
    expect(component).toContain("StellaCharacter");
    expect(component).toContain("INDICATOR_MARK_SIZE_PX = 30");
  });
});
