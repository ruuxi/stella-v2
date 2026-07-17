import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const PHASE_KEY = "stella-onboarding-phase";
const ONBOARDING_ROOT = path.resolve(
  import.meta.dirname,
  "../../../src/global/onboarding",
);
const LOCALES_ROOT = path.resolve(
  import.meta.dirname,
  "../../../src/shared/i18n/locales",
);

type FakeWindow = {
  __stellaUiState?: Record<string, string>;
  addEventListener: () => void;
  removeEventListener: () => void;
  dispatchEvent: () => boolean;
  location: { href: string };
};

const installWindow = (phase?: string) => {
  (globalThis as unknown as { window?: FakeWindow }).window = {
    __stellaUiState: phase ? { [PHASE_KEY]: phase } : {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    location: { href: "https://stella.test/" },
  };
};

const importFreshState = async () => {
  vi.resetModules();
  const { uiState } = await import("../../../src/platform/ui-state");
  const onboardingState = await import(
    "../../../src/global/onboarding/use-onboarding-state"
  );
  return { uiState, ...onboardingState };
};

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
  vi.resetModules();
});

describe("retired onboarding phase", () => {
  it("advances persisted shapeshift state to the next supported phase", async () => {
    installWindow("shapeshift");
    const { readOnboardingPhase, uiState } = await importFreshState();

    expect(readOnboardingPhase()).toBe("theme");
    expect(uiState.getItem(PHASE_KEY)).toBe("theme");
  });

  it("still clears unknown persisted phases instead of restarting there", async () => {
    installWindow("not-a-real-phase");
    const { readOnboardingPhase, uiState } = await importFreshState();

    expect(readOnboardingPhase()).toBeNull();
    expect(uiState.getItem(PHASE_KEY)).toBeNull();
  });

  it("walks directly from capabilities to theme", async () => {
    const { CREATURE_HIDDEN_PHASES, SPLIT_STEP_ORDER } = await import(
      "../../../src/global/onboarding/onboarding-flow"
    );

    expect(SPLIT_STEP_ORDER.slice(0, 2)).toEqual(["capabilities", "theme"]);
    expect(SPLIT_STEP_ORDER).not.toContain("shapeshift");
    expect(CREATURE_HIDDEN_PHASES).not.toContain("shapeshift");
  });

  it("ships no reachable self-rewrite component or localized claim", async () => {
    const onboardingFiles = await readdir(ONBOARDING_ROOT, {
      withFileTypes: true,
    });
    const componentNames = onboardingFiles.map((entry) => entry.name);
    expect(componentNames).not.toContain("OnboardingShapeshiftPhase.tsx");
    expect(componentNames).not.toContain("OnboardingShapeshiftPhase.css");

    const stepSource = await readFile(
      path.join(ONBOARDING_ROOT, "OnboardingStep1.tsx"),
      "utf-8",
    );
    expect(stepSource).not.toContain("OnboardingShapeshiftPhase");

    const localeFiles = (await readdir(LOCALES_ROOT)).filter((name) =>
      name.endsWith(".json"),
    );
    const localePayload = (
      await Promise.all(
        localeFiles.map((name) =>
          readFile(path.join(LOCALES_ROOT, name), "utf-8"),
        ),
      )
    ).join("\n");
    expect(localePayload).not.toMatch(/"shapeshift"\s*:/u);
    expect(localePayload).not.toMatch(/rewrite itself/iu);
  });
});
