import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  closeConversationFocus,
  focusRootKey,
  getConversationFocus,
  openConversationFocus,
  subscribeToConversationFocus,
} from "@/features/chat/services/conversation-focus-store";

afterEach(() => {
  __testing.reset();
});

describe("conversation focus store", () => {
  it("holds one focus at a time and notifies subscribers", () => {
    const listener = vi.fn();
    subscribeToConversationFocus(listener);
    openConversationFocus({
      conversationId: "c1",
      root: { kind: "agent", threadId: "task-1" },
      title: "Pricing",
    });
    expect(getConversationFocus()).toEqual({
      conversationId: "c1",
      root: { kind: "agent", threadId: "task-1" },
      title: "Pricing",
    });
    openConversationFocus({
      conversationId: "c1",
      root: { kind: "message", id: "m1" },
    });
    expect(getConversationFocus()?.root).toEqual({ kind: "message", id: "m1" });
    closeConversationFocus();
    expect(getConversationFocus()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("ignores a re-open of the identical focus", () => {
    const listener = vi.fn();
    subscribeToConversationFocus(listener);
    const focus = {
      conversationId: "c1",
      root: { kind: "agent" as const, threadId: "task-1" },
      title: "Pricing",
    };
    openConversationFocus(focus);
    openConversationFocus({ ...focus });
    expect(listener).toHaveBeenCalledTimes(1);
    closeConversationFocus();
    closeConversationFocus();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keys roots by kind and identity", () => {
    expect(focusRootKey({ kind: "message", id: "m1" })).toBe("message:m1");
    expect(focusRootKey({ kind: "agent", threadId: "t" })).toBe("agent:t");
  });
});
