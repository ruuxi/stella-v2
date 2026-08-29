import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { getWorkingIndicatorCharacterState } from "@/features/chat/working-indicator-state";
import { getPetCharacterState } from "@/shell/pet/pet-character-state";

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

/**
 * The overlay stands in for both the agent's mood and, when realtime voice is
 * up, the retired voice creature. The priority order is the whole design, so it
 * is pinned rather than left to the reader of a chain of ternaries.
 */
describe("pet character state mapping", () => {
  it("prefers voice activity over the broadcast state", () => {
    expect(getPetCharacterState({ state: "running", voiceMode: "speaking" })).toBe(
      "speaking",
    );
    expect(
      getPetCharacterState({ state: "running", voiceMode: "listening" }),
    ).toBe("listening");
  });

  it("maps broadcast states onto rig states", () => {
    expect(getPetCharacterState({ state: "idle" })).toBe("idle");
    expect(getPetCharacterState({ state: "running" })).toBe("working");
    expect(getPetCharacterState({ state: "waiting" })).toBe("listening");
    expect(getPetCharacterState({ state: "review" })).toBe("happy");
    expect(getPetCharacterState({ state: "failed" })).toBe("confused");
    expect(getPetCharacterState({ state: "waving" })).toBe("happy");
  });

  it("reacts to dragging and hover", () => {
    expect(getPetCharacterState({ state: "failed", dragging: true })).toBe(
      "happy",
    );
    expect(getPetCharacterState({ state: "idle", hover: true })).toBe("happy");
    expect(getPetCharacterState({ state: "running", hover: true })).toBe(
      "working",
    );
  });
});
