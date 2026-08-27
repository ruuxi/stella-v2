import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CREATURE_HIDDEN_PHASES,
  PHASE_ACTS,
  SPLIT_PHASES,
  SPLIT_STEP_ORDER,
} from "@/global/onboarding/onboarding-flow";

const onboardingRoot = path.resolve(
  import.meta.dirname,
  "../../../src/global/onboarding",
);

describe("cloud Memory onboarding flow", () => {
  it("places the authoritative preference between voice and enter", () => {
    const memoryIndex = SPLIT_STEP_ORDER.indexOf("memory");

    expect(SPLIT_STEP_ORDER.slice(memoryIndex - 1, memoryIndex + 2)).toEqual([
      "voice",
      "memory",
      "enter",
    ]);
    expect(SPLIT_PHASES.has("memory")).toBe(true);
    expect(PHASE_ACTS.memory).toBe("flow");
    expect(CREATURE_HIDDEN_PHASES.has("memory")).toBe(false);
  });

  it("wires Memory to cloud authority and removes the revisited-step bypass", () => {
    const stepSource = readFileSync(
      path.join(onboardingRoot, "OnboardingStep1.tsx"),
      "utf8",
    );
    const phaseSource = readFileSync(
      path.join(onboardingRoot, "OnboardingMemoryPhase.tsx"),
      "utf8",
    );

    expect(stepSource).toContain("useCloudMemoryPreference()");
    expect(stepSource).toContain('phase !== "memory"');
    expect(stepSource).toContain(
      'phase === "memory" && memory.status === "saving"',
    );
    expect(phaseSource).toContain("force: preference.revision === 0");
    expect(phaseSource).not.toContain("electronAPI");
    expect(phaseSource).not.toContain("Chronicle");
    expect(phaseSource).not.toContain("localStorage");
  });
});
