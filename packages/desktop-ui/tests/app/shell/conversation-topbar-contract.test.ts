// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  isConversationTabTitleOverflowing,
  isConfirmedConversationCreateRejection,
  measureConversationTabOverflow,
  mergeCloudConversationHistory,
  resolveHistoryDeleteActivation,
  resolveConversationTabShortcut,
  shouldMarkConversationUnread,
} from "@/shell/topbar/ConversationTopBar";
import { ConvexError } from "convex/values";

describe("conversation top-bar contracts", () => {
  const tabs = [
    { conversationId: "first" },
    { conversationId: "second" },
    { conversationId: "third" },
  ];

  const shortcut = (
    key: string,
    modifiers: Partial<
      Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">
    > = {},
    target: EventTarget | null = document.body,
  ) =>
    resolveConversationTabShortcut(
      {
        key,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        target,
        ...modifiers,
      },
      tabs,
      "second",
    );

  it("distinguishes durable create rejection from an ambiguous transport failure", () => {
    expect(
      isConfirmedConversationCreateRejection(
        new ConvexError("Conversation could not be created"),
      ),
    ).toBe(true);
    expect(
      isConfirmedConversationCreateRejection(new Error("Network disconnected")),
    ).toBe(false);
  });

  it("maps the OpenCode tab shortcuts and wraps cycling", () => {
    expect(shortcut("t", { metaKey: true })).toEqual({ type: "new" });
    expect(shortcut("w", { ctrlKey: true })).toEqual({
      type: "close",
      conversationId: "second",
    });
    expect(shortcut("Tab", { ctrlKey: true })).toEqual({
      type: "select",
      conversationId: "third",
    });
    expect(shortcut("Tab", { ctrlKey: true, shiftKey: true })).toEqual({
      type: "select",
      conversationId: "first",
    });
    expect(shortcut("1", { metaKey: true })).toEqual({
      type: "select",
      conversationId: "first",
    });
    expect(shortcut("9", { metaKey: true })).toBeNull();
  });

  it("leaves editable targets and unhandled modified keys alone", () => {
    const input = document.createElement("input");
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    expect(shortcut("w", { metaKey: true }, input)).toBeNull();
    expect(shortcut("Tab", { ctrlKey: true }, editor)).toBeNull();
    expect(shortcut("t", { metaKey: true, shiftKey: true })).toBeNull();
    expect(shortcut("w", { metaKey: true, altKey: true })).toBeNull();
  });

  it("measures both overflow edges from the scroll viewport", () => {
    expect(
      measureConversationTabOverflow({
        scrollLeft: 0,
        scrollWidth: 600,
        clientWidth: 300,
      }),
    ).toEqual({ left: false, right: true });
    expect(
      measureConversationTabOverflow({
        scrollLeft: 150,
        scrollWidth: 600,
        clientWidth: 300,
      }),
    ).toEqual({ left: true, right: true });
    expect(
      measureConversationTabOverflow({
        scrollLeft: 300,
        scrollWidth: 600,
        clientWidth: 300,
      }),
    ).toEqual({ left: true, right: false });
  });

  it("fades titles only after their rendered text actually overflows", () => {
    expect(
      isConversationTabTitleOverflowing({ scrollWidth: 120, clientWidth: 120 }),
    ).toBe(false);
    expect(
      isConversationTabTitleOverflowing({ scrollWidth: 121, clientWidth: 120 }),
    ).toBe(false);
    expect(
      isConversationTabTitleOverflowing({ scrollWidth: 140, clientWidth: 120 }),
    ).toBe(true);
  });

  it("flags only background conversations with a persisted assistant reply", () => {
    const update = (type: string, conversationId: string) => ({
      conversationId,
      event: { _id: "e1", timestamp: 1, type },
    });

    expect(
      shouldMarkConversationUnread(
        update("assistant_message", "first"),
        "first",
        "second",
      ),
    ).toBe(true);
    expect(
      shouldMarkConversationUnread(
        update("assistant_message", "second"),
        "second",
        "second",
      ),
    ).toBe(false);
    expect(
      shouldMarkConversationUnread(
        update("user_message", "first"),
        "first",
        "second",
      ),
    ).toBe(false);
    expect(shouldMarkConversationUnread(null, "first", "second")).toBe(false);
  });

  it("keeps a row that crosses the frozen history bound visible through the recent slice", () => {
    const frozen = [
      {
        conversationId: "older",
        ownerId: "owner",
        title: "Older title",
        createdAt: 1,
        updatedAt: 10,
      },
      {
        conversationId: "stable",
        ownerId: "owner",
        title: "Stable",
        createdAt: 2,
        updatedAt: 20,
      },
    ];
    const recent = [
      {
        ...frozen[0]!,
        title: "Updated title",
        updatedAt: 100,
      },
      {
        conversationId: "new",
        ownerId: "owner",
        title: "New",
        createdAt: 3,
        updatedAt: 100,
      },
    ];

    expect(mergeCloudConversationHistory(frozen, recent)).toEqual([
      recent[0],
      recent[1],
      frozen[1],
    ]);
  });

  it("requires two activations on the same history row to delete", () => {
    expect(resolveHistoryDeleteActivation(null, "first")).toBe("arm");
    expect(resolveHistoryDeleteActivation("first", "second")).toBe("arm");
    expect(resolveHistoryDeleteActivation("first", "first")).toBe("delete");
  });
});
