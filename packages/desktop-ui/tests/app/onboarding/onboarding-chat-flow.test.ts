import { beforeEach, describe, expect, it } from "vitest";
import { uiState } from "@/platform/ui-state";
import {
  clearOnboardingChatProgress,
  nextOnboardingChatStep,
  ONBOARDING_CHAT_STEPS,
  readOnboardingChatProgress,
  writeOnboardingChatProgress,
} from "@/global/onboarding/chat/onboarding-chat-flow";
import {
  clearPendingHandoff,
  peekPendingComposerDraft,
  setPendingComposerDraft,
  setPendingDiscoveryWelcome,
  takePendingComposerDraft,
  takePendingDiscoveryWelcome,
} from "@/global/onboarding/chat/pending-handoff";

describe("chat onboarding flow", () => {
  beforeEach(() => {
    uiState.clear();
  });

  it("runs discovery first so synthesis overlaps the remaining steps", () => {
    expect(ONBOARDING_CHAT_STEPS[0]).toBe("discovery");
    expect(ONBOARDING_CHAT_STEPS[ONBOARDING_CHAT_STEPS.length - 1]).toBe("ready");
    expect(ONBOARDING_CHAT_STEPS).toContain("theme");
    expect(nextOnboardingChatStep("discovery")).toBe("capabilities");
    expect(nextOnboardingChatStep("ready")).toBeNull();
  });

  it("persists resume progress and drops malformed entries", () => {
    expect(readOnboardingChatProgress()).toBeNull();
    writeOnboardingChatProgress({
      step: "theme",
      answers: { discovery: "accepted", capabilities: "done" },
    });
    expect(readOnboardingChatProgress()).toEqual({
      step: "theme",
      answers: { discovery: "accepted", capabilities: "done" },
    });

    uiState.setItem(
      "stella-onboarding-chat-progress",
      JSON.stringify({ step: "theme", answers: { discovery: "maybe", bogus: "done" } }),
    );
    expect(readOnboardingChatProgress()).toEqual({ step: "theme", answers: {} });

    uiState.setItem("stella-onboarding-chat-progress", "{not json");
    expect(readOnboardingChatProgress()).toBeNull();

    writeOnboardingChatProgress({ step: "ready", answers: {} });
    clearOnboardingChatProgress();
    expect(readOnboardingChatProgress()).toBeNull();
  });
});

describe("onboarding hand-off", () => {
  beforeEach(() => {
    uiState.clear();
  });

  it("parks the discovery greeting for exactly one consumer", () => {
    setPendingDiscoveryWelcome("  Hey, welcome back to the cockpit.  ");
    expect(takePendingDiscoveryWelcome()).toBe("Hey, welcome back to the cockpit.");
    expect(takePendingDiscoveryWelcome()).toBeNull();
  });

  it("ignores an empty greeting", () => {
    setPendingDiscoveryWelcome("   ");
    expect(takePendingDiscoveryWelcome()).toBeNull();
  });

  it("keeps a composer draft until the chat surface takes it", () => {
    setPendingComposerDraft({ text: "Plan my week", send: true });
    expect(peekPendingComposerDraft()).toEqual({ text: "Plan my week", send: true });
    expect(takePendingComposerDraft()).toEqual({ text: "Plan my week", send: true });
    expect(takePendingComposerDraft()).toBeNull();
  });

  it("clears everything on replay", () => {
    setPendingDiscoveryWelcome("hello");
    setPendingComposerDraft({ text: "draft", send: false });
    clearPendingHandoff();
    expect(takePendingDiscoveryWelcome()).toBeNull();
    expect(takePendingComposerDraft()).toBeNull();
  });
});
