import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { getWorkingIndicatorCharacterState } from "@/features/chat/working-indicator-state";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const readSource = (relativePath: string) =>
  fs.readFileSync(path.join(PACKAGE_ROOT, relativePath), "utf8");

/**
 * The indicator's mark is the product's face, so these read the source rather
 * than the rendered output: the rig is imperative and canvas-free, and asserting
 * on its DOM would pin implementation detail instead of the contract that the
 * indicator mounts the rig at all, and hides its label while thinking.
 */
describe("chat working indicator character", () => {
  it("mounts the svg character rig instead of the retired aurora", () => {
    const component = readSource("src/app/chat/WorkingIndicator.tsx");

    expect(component).not.toContain("StellaAnimation");
    expect(component).toContain("StellaCharacter");
    expect(component).toContain("INDICATOR_MARK_SIZE_PX = 30");
  });

  it("suppresses the label in thinking mode and keeps it for tools", () => {
    expect(getWorkingIndicatorCharacterState({ isReasoning: true })).toBe(
      "thinking",
    );
    expect(getWorkingIndicatorCharacterState({ toolName: "web_search" })).toBe(
      "searching",
    );

    const component = readSource("src/app/chat/WorkingIndicator.tsx");
    expect(component).toContain('characterState === "thinking"');
    expect(component).toContain("dotsOnly ? null : (");
  });
});
