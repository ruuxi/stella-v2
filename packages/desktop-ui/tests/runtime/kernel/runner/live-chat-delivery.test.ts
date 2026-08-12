import { describe, expect, it } from "vitest";
import {
  prunePendingFollowUpReplies,
  recordPendingFollowUpReplyEntry,
  resolveLiveChatMessageDelivery,
} from "@stella/runtime/kernel/runner/shared";
import { matchesSteerableOrchestratorSession } from "@stella/runtime/kernel/runner/orchestrator";
import type {
  ActiveOrchestratorSession,
  PendingFollowUpReply,
} from "@stella/runtime/kernel/runner/types";

describe("resolveLiveChatMessageDelivery", () => {
  it("steers user messages on the native engine", () => {
    expect(
      resolveLiveChatMessageDelivery({ role: "user", engine: "native" }),
    ).toBe("steer");
  });

  it("steers user messages on external engines", () => {
    expect(
      resolveLiveChatMessageDelivery({ role: "user", engine: "external" }),
    ).toBe("steer");
  });

  it("always steers runtime-internal injections", () => {
    expect(
      resolveLiveChatMessageDelivery({
        role: "runtimeInternal",
        engine: "native",
      }),
    ).toBe("steer");
    expect(
      resolveLiveChatMessageDelivery({
        role: "runtimeInternal",
        engine: "external",
      }),
    ).toBe("steer");
  });
});

describe("matchesSteerableOrchestratorSession", () => {
  it("keeps a hidden lifecycle turn eligible for an in-order user steer", () => {
    const session = {
      conversationId: "conv-1",
      agentType: "orchestrator",
      uiVisibility: "hidden",
      agent: { state: { isStreaming: true } },
    } as ActiveOrchestratorSession;

    expect(
      matchesSteerableOrchestratorSession({
        session,
        conversationId: "conv-1",
        agentType: "orchestrator",
      }),
    ).toBe(true);
  });

  it("rejects completed or unrelated sessions", () => {
    const session = {
      conversationId: "conv-1",
      agentType: "orchestrator",
      uiVisibility: "visible",
      agent: { state: { isStreaming: false } },
    } as ActiveOrchestratorSession;

    expect(
      matchesSteerableOrchestratorSession({
        session,
        conversationId: "conv-1",
      }),
    ).toBe(false);
    session.agent.state.isStreaming = true;
    expect(
      matchesSteerableOrchestratorSession({
        session,
        conversationId: "conv-2",
      }),
    ).toBe(false);
  });
});

describe("pendingFollowUpReplies mirror", () => {
  it("records trimmed entries and skips empty text", () => {
    const replies = new Map<string, PendingFollowUpReply[]>();
    recordPendingFollowUpReplyEntry(replies, "conv-1", {
      text: "  hello  ",
      userMessageId: "m1",
    });
    recordPendingFollowUpReplyEntry(replies, "conv-1", { text: "   " });
    expect(replies.get("conv-1")).toEqual([
      { text: "hello", userMessageId: "m1" },
    ]);
  });

  it("prunes only the delivered message's entries", () => {
    const replies = new Map<string, PendingFollowUpReply[]>();
    recordPendingFollowUpReplyEntry(replies, "conv-1", {
      text: "first",
      userMessageId: "m1",
    });
    recordPendingFollowUpReplyEntry(replies, "conv-1", {
      text: "second",
      userMessageId: "m2",
    });
    prunePendingFollowUpReplies(replies, "conv-1", "m1");
    expect(replies.get("conv-1")).toEqual([
      { text: "second", userMessageId: "m2" },
    ]);
  });

  it("drops the conversation key when the last entry is pruned", () => {
    const replies = new Map<string, PendingFollowUpReply[]>();
    recordPendingFollowUpReplyEntry(replies, "conv-1", {
      text: "only",
      userMessageId: "m1",
    });
    prunePendingFollowUpReplies(replies, "conv-1", "m1");
    expect(replies.has("conv-1")).toBe(false);
  });

  it("keeps unkeyed legacy entries when pruning", () => {
    const replies = new Map<string, PendingFollowUpReply[]>();
    recordPendingFollowUpReplyEntry(replies, "conv-1", { text: "unkeyed" });
    prunePendingFollowUpReplies(replies, "conv-1", "m1");
    expect(replies.get("conv-1")).toEqual([{ text: "unkeyed" }]);
  });

  it("is a no-op for unknown conversations", () => {
    const replies = new Map<string, PendingFollowUpReply[]>();
    expect(() =>
      prunePendingFollowUpReplies(replies, "conv-missing", "m1"),
    ).not.toThrow();
  });
});
