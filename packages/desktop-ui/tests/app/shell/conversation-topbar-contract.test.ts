// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isConversationTabTitleOverflowing,
  measureConversationTabOverflow,
  resolveHistoryDeleteActivation,
  resolveConversationTabShortcut,
  shouldMarkConversationUnread,
  shouldRenderNewChatLabel,
  shouldRenderConversationHomeLauncher,
} from "@/shell/topbar/ConversationTopBar";
import enCatalog from "../../../src/shared/i18n/locales/en.json";

const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src",
);

/**
 * The New chat label used to be literal JSX text. It is now a `t()` key,
 * so the contract is checked in two halves: the source renders the key in
 * the right slot, and the English catalog still maps that key to the copy
 * this contract is about. Checking only the key would let the copy drift
 * silently; checking only the copy would miss the label being moved to a
 * different control.
 */
const englishFor = (key: string): string => {
  const value = key
    .split(".")
    .reduce<unknown>(
      (node, segment) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[segment]
          : undefined,
      enCatalog,
    );
  expect(typeof value, `${key} missing from en.json`).toBe("string");
  return value as string;
};

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

  it("labels New chat only until multiple tabs are open", () => {
    expect(shouldRenderNewChatLabel(0)).toBe(true);
    expect(shouldRenderNewChatLabel(1)).toBe(true);
    expect(shouldRenderNewChatLabel(2)).toBe(false);
    expect(shouldRenderNewChatLabel(12)).toBe(false);
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

  it("replaces a sole tab with the Home launcher", () => {
    expect(shouldRenderConversationHomeLauncher(1)).toBe(true);
    expect(shouldRenderConversationHomeLauncher(2)).toBe(false);
    expect(
      resolveConversationTabShortcut(
        {
          key: "w",
          altKey: false,
          ctrlKey: false,
          metaKey: true,
          shiftKey: false,
          target: document.body,
        },
        [{ conversationId: "only" }],
        "only",
      ),
    ).toBeNull();
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

  it("renders the unread dot only on inactive tabs", () => {
    const source = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/topbar/ConversationTopBar.tsx"),
      "utf8",
    );
    const css = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/topbar/conversation-topbar.css"),
      "utf8",
    );

    expect(source).toContain("const unread = Boolean(tab.unread) && !active;");
    expect(source).toContain('data-unread={unread ? "true" : undefined}');
    expect(source).toContain("conversationTabs.markUnread");
    expect(source).toContain("conversationTabs.markRead");
    expect(englishFor("shell.topbar.conversation.unread")).toBe(
      "Unread messages",
    );
    expect(css).toMatch(
      /\.conversation-topbar__tab-unread\s*\{[^}]*width:\s*6px;[^}]*height:\s*6px;[^}]*border-radius:\s*50%;[^}]*background:\s*var\(--primary\);/,
    );
    // The dot and the close button share one slot, so hover must swap them.
    expect(css).toMatch(
      /\.conversation-topbar__tab:hover \.conversation-topbar__tab-unread,[\s\S]*?opacity:\s*0;/,
    );
  });

  it("requires two activations on the same history row to delete", () => {
    expect(resolveHistoryDeleteActivation(null, "first")).toBe("arm");
    expect(resolveHistoryDeleteActivation("first", "second")).toBe("arm");
    expect(resolveHistoryDeleteActivation("first", "first")).toBe("delete");
  });

  it("keeps OpenCode tab geometry and overflow work on animation frames", () => {
    const source = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/topbar/ConversationTopBar.tsx"),
      "utf8",
    );
    const css = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/topbar/conversation-topbar.css"),
      "utf8",
    );

    expect(source).toContain("window.requestAnimationFrame");
    expect(source).toContain("new ResizeObserver");
    expect(source).toContain(
      'className="shell-topbar-icon-btn conversation-topbar__home"',
    );
    expect(source).toContain("onClick={dispatchShowHome}");
    expect(source).not.toContain("conversation-topbar__home-label");
    expect(englishFor("shell.topbar.conversation.newChat")).toBe("New chat");
    // Whitespace-tolerant: prettier reflows the span across lines once the
    // literal becomes a t() call.
    expect(source).toMatch(
      /<span className="conversation-topbar__new-label">\s*\{t\("shell\.topbar\.conversation\.newChat"\)\}\s*<\/span>/,
    );
    expect(source).toContain(
      'data-compact={!showNewChatLabel ? "true" : undefined}',
    );
    expect(source).toContain(
      'aria-label={t("shell.topbar.conversation.newChat")}',
    );
    expect(source).toMatch(
      /<House[\s\S]*?size=\{16\}[\s\S]*?strokeWidth=\{1\.85\}/,
    );
    expect(
      source.match(/size=\{16\}[\s\S]*?strokeWidth=\{1\.85\}/g),
    ).toHaveLength(3);
    expect(source).not.toContain(
      'className="conversation-history-popover__header"',
    );
    expect(source).not.toContain(
      'className="conversation-history-popover__new"',
    );
    expect(source).toContain(
      'className="conversation-history-popover__delete"',
    );
    expect(source).toContain("extraData=");
    expect(source).toContain('role="tablist"');
    expect(source).toContain("onMouseDown");
    expect(source).toContain("onAuxClick");
    expect(source).toContain("TAB_DRAG_ACTIVATION_DISTANCE = 4");
    expect(source).toContain('behavior: "auto"');
    expect(css).toMatch(
      /\.conversation-topbar__tab\s*\{[^}]*min-width:\s*28px;[^}]*max-width:\s*224px;[^}]*height:\s*calc\(var\(--shell-topbar-height, 38px\) - 5px\);/,
    );
    expect(css).toMatch(/\.conversation-topbar\s*\{[^}]*gap:\s*4px;/);
    expect(css).toMatch(/\.conversation-topbar__tabs\s*\{[^}]*gap:\s*0;/);
    expect(css).toMatch(
      /\.conversation-topbar__tab-close\s*\{[^}]*top:\s*9px;[^}]*width:\s*20px;[^}]*height:\s*20px;/,
    );
    expect(css).toContain("@container (max-width: 64px)");
    expect(css).toMatch(
      /\.conversation-topbar__tab \+ \.conversation-topbar__tab\s*\{[^}]*margin-left:\s*-1px;/,
    );
    expect(css).toContain("mask-image: linear-gradient(");
    expect(css).toContain('[data-title-overflow="true"]');
    expect(css).toMatch(
      /\.conversation-topbar__tabs\s*\{[^}]*width:\s*max-content;/,
    );
    expect(css).toMatch(
      /\.conversation-topbar__history,[\s\S]*?width:\s*28px;[\s\S]*?height:\s*28px;/,
    );
    expect(css).toMatch(
      /\.conversation-topbar__plus\s*\{[^}]*width:\s*auto;[^}]*min-width:\s*76px;[^}]*height:\s*28px;/,
    );
    expect(css).toMatch(
      /\.conversation-topbar__plus\s*\{[^}]*padding:\s*0 17px 0 10px;/,
    );
    expect(css).toMatch(
      /\.conversation-topbar__plus\[data-compact="true"\]\s*\{[^}]*width:\s*28px;[^}]*min-width:\s*28px;/,
    );
    expect(css).toMatch(
      /\.conversation-topbar__new-label\s*\{[^}]*white-space:\s*nowrap;/,
    );
    expect(css).toMatch(
      /\.conversation-topbar__history,[\s\S]*?\.conversation-topbar__home\s*\{[^}]*color:\s*var\(--text-muted\)/,
    );
    expect(css).toMatch(
      /\.conversation-topbar__plus\s*\{[^}]*color:\s*var\(--text-muted\)/,
    );
    expect(css).toMatch(
      /\.conversation-topbar__viewport::before,[\s\S]*?width:\s*24px;/,
    );
    expect(css).not.toContain("scroll-snap-type");
    expect(css).toMatch(
      /\.conversation-topbar__home\s*\{[^}]*background:\s*transparent/,
    );
    expect(css).toMatch(
      /\.conversation-topbar__home\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px;/,
    );
    expect(css).toMatch(
      /\.conversation-topbar__history:hover,[\s\S]*?\.conversation-topbar__home:hover,[\s\S]*?\.conversation-topbar__plus:hover\s*\{[^}]*background:\s*color-mix\(/,
    );
    expect(css).toMatch(
      /\.conversation-topbar__control-icon\s*\{[^}]*transform:\s*translateY\(1px\)/,
    );
    expect(css).toMatch(
      /\.conversation-history-popover__delete\s*\{[^}]*position:\s*absolute/,
    );
    expect(css).toContain('[data-delete-armed="true"]');
  });

  it("keeps tabs metadata-only and one chat runtime mounted", () => {
    const source = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/topbar/ConversationTopBar.tsx"),
      "utf8",
    );
    const root = fs.readFileSync(
      path.join(SOURCE_ROOT, "routes/__root.tsx"),
      "utf8",
    );
    const store = fs.readFileSync(
      path.join(
        SOURCE_ROOT,
        "features/chat/services/conversation-tabs-store.ts",
      ),
      "utf8",
    );

    expect(source).toContain("const HISTORY_PAGE_SIZE = 50");
    expect(source).toContain("conversationTabs.updateTitle");
    expect(source).not.toContain("ChatMessagesContext");
    expect(source).not.toContain("useConversationMessages");
    expect(source).toContain("<LegendList<ConversationSummary>");
    expect(source).not.toContain("history.map(");
    expect(store).not.toContain("activeConversationId:");
    expect(root.match(/<ChatRuntimeProvider/g)).toHaveLength(1);
    expect(root.match(/<ChatColumn/g)).toHaveLength(1);
  });
  it("keeps the top bar as the only New Chat entry point", () => {
    const topBar = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/topbar/ConversationTopBar.tsx"),
      "utf8",
    );
    const fullChat = fs.readFileSync(
      path.join(SOURCE_ROOT, "shell/use-full-shell-chat.js"),
      "utf8",
    );
    const localChatStore = fs.readFileSync(
      path.join(SOURCE_ROOT, "features/chat/services/local-chat-store.js"),
      "utf8",
    );

    expect(topBar).toContain("await createNewLocalConversationId()");
    expect(fullChat).not.toContain("createNewLocalConversationId");
    expect(fullChat).not.toContain("startNewChat");
    expect(fullChat).not.toContain("onNewChat");
    expect(topBar).not.toContain("createNewDefaultConversationId");
    expect(fullChat).not.toContain("createNewDefaultConversationId");
    expect(localChatStore).toContain(
      "getLocalChatApi().createNewDefaultConversationId()",
    );
  });
});
