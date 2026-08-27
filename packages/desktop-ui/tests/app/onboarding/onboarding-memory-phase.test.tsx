// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudMemoryPreferenceView } from "@/features/cloud/use-cloud-memory-preference";
import { OnboardingMemoryPhase } from "@/global/onboarding/OnboardingMemoryPhase";

vi.mock("@/shared/i18n", () => ({
  useT: () => (key: string) =>
    ({
      "common.continue": "Continue",
      "common.loading": "Loading…",
      "common.tryAgain": "Try again",
      "settings.errors.loadMemory": "Failed to load memory setting.",
      "settings.errors.saveMemory": "Failed to update memory setting.",
      "settings.memory.description":
        "Include saved memories and your profile in Stella’s model context.",
    })[key] ?? key,
}));

const preference = (
  revision: number,
  memoryEnabled: boolean,
  ownerGeneration = "generation-1",
) => ({
  ownerGeneration,
  memoryEnabled,
  revision,
  updatedAt: revision,
});

const makeView = (
  overrides: Partial<CloudMemoryPreferenceView> = {},
): CloudMemoryPreferenceView => ({
  status: "synced",
  preference: preference(0, true),
  memoryEnabled: true,
  issue: null,
  issueCode: null,
  disabled: false,
  setMemoryEnabled: vi.fn().mockResolvedValue(true),
  retry: vi.fn().mockResolvedValue(true),
  ...overrides,
});

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const click = async (element: HTMLElement) => {
  await act(async () => element.click());
  await flush();
};

describe("OnboardingMemoryPhase", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onContinue: ReturnType<typeof vi.fn>;
  let onRetryAuthBootstrap: ReturnType<typeof vi.fn>;

  const render = async (
    memory: CloudMemoryPreferenceView,
    authError: string | null = null,
  ) => {
    await act(async () => {
      root.render(
        <OnboardingMemoryPhase
          authError={authError}
          memory={memory}
          splitTransitionActive={false}
          onContinue={onContinue}
          onRetryAuthBootstrap={onRetryAuthBootstrap}
        />,
      );
    });
    await flush();
  };

  const button = (label: string) => {
    const match = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.includes(label),
    );
    expect(match).toBeDefined();
    return match as HTMLButtonElement;
  };

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onContinue = vi.fn();
    onRetryAuthBootstrap = vi.fn();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("requires an explicit revision-zero choice and force-CASes both answers", async () => {
    const setMemoryEnabled = vi.fn().mockResolvedValue(true);
    const memory = makeView({ setMemoryEnabled });
    await render(memory);

    expect(button("Use saved Memory").getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(button("Not now").getAttribute("aria-checked")).toBe("false");
    expect(button("Continue").disabled).toBe(true);

    await click(button("Use saved Memory"));
    await click(button("Continue"));
    expect(setMemoryEnabled).toHaveBeenCalledWith(true, { force: true });
    expect(onContinue).toHaveBeenCalledTimes(1);

    onContinue.mockClear();
    setMemoryEnabled.mockClear();
    await render(makeView({ setMemoryEnabled }));
    await click(button("Not now"));
    await click(button("Continue"));
    expect(setMemoryEnabled).toHaveBeenCalledWith(false, { force: true });
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("hydrates an existing choice and continues without forcing a new head", async () => {
    const setMemoryEnabled = vi.fn().mockResolvedValue(true);
    await render(
      makeView({
        preference: preference(4, false),
        memoryEnabled: false,
        setMemoryEnabled,
      }),
    );

    expect(button("Not now").getAttribute("aria-checked")).toBe("true");
    expect(button("Continue").disabled).toBe(false);
    await click(button("Continue"));

    expect(setMemoryEnabled).toHaveBeenCalledWith(false, { force: false });
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("never advances until the authoritative write resolves true", async () => {
    let resolveWrite: ((value: boolean) => void) | null = null;
    const setMemoryEnabled = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    await render(makeView({ setMemoryEnabled }));
    await click(button("Not now"));
    await click(button("Continue"));

    expect(onContinue).not.toHaveBeenCalled();
    await act(async () => {
      resolveWrite?.(true);
      await Promise.resolve();
    });
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("keeps loading non-authoritative and explains that off preserves documents", async () => {
    const setMemoryEnabled = vi.fn();
    await render(
      makeView({
        status: "loading",
        preference: null,
        memoryEnabled: false,
        disabled: true,
        setMemoryEnabled,
      }),
    );

    expect(container.textContent).toContain("Loading your Memory preference…");
    expect(button("Use saved Memory").disabled).toBe(true);
    expect(button("Not now").disabled).toBe(true);
    expect(button("Continue").disabled).toBe(true);
    expect(container.textContent).toContain(
      "existing cloud and local Memory documents stay available to view, edit, or download",
    );
    expect(setMemoryEnabled).not.toHaveBeenCalled();
  });

  it("uses retry only to recover authority, then force-CASes a replacement revision-zero head", async () => {
    const firstHead = preference(0, true, "generation-1");
    const replacementHead = preference(0, true, "generation-2");
    const setMemoryEnabled = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const retry = vi.fn().mockResolvedValue(true);
    const initial = makeView({
      preference: firstHead,
      setMemoryEnabled,
      retry,
    });
    await render(initial);
    await click(button("Use saved Memory"));
    await click(button("Continue"));
    expect(onContinue).not.toHaveBeenCalled();

    await render({
      ...initial,
      status: "error",
      issue: "save",
      issueCode: "revision_conflict",
    });
    expect(container.textContent).toContain("Failed to update memory setting.");
    await click(button("Try again"));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(onContinue).not.toHaveBeenCalled();

    await render({
      ...initial,
      preference: replacementHead,
      status: "synced",
      issue: null,
      issueCode: null,
    });
    await click(button("Continue"));
    expect(setMemoryEnabled).toHaveBeenLastCalledWith(true, { force: true });
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("surfaces bootstrap failure through its own retry without touching Memory", async () => {
    const retry = vi.fn();
    await render(
      makeView({
        status: "loading",
        preference: null,
        disabled: true,
        retry,
      }),
      "Cloud authentication could not start.",
    );

    expect(container.textContent).toContain(
      "Cloud authentication could not start.",
    );
    await click(button("Try again"));
    expect(onRetryAuthBootstrap).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(onContinue).not.toHaveBeenCalled();
  });
});
