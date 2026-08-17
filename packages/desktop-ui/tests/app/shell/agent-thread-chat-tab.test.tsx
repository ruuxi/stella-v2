// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withI18n } from "../../helpers/i18n";
import type { AgentThreadMessageRecord } from "@/features/chat/thread-activity-types";

const mocks = vi.hoisted(() => ({
  threadActivity: [] as unknown[],
}));

vi.mock("@/features/chat/hooks/use-thread-activity", () => ({
  useThreadActivity: () => ({ records: mocks.threadActivity }),
}));

vi.mock("@/app/chat/Markdown", () => ({
  Markdown: ({ text }: { text: string }) => <div>{text}</div>,
}));

vi.mock("@/app/chat/BackgroundWorkCard", () => ({
  BackgroundWorkCard: () => <div>Background work</div>,
}));

vi.mock("@/app/chat/AgentCompletionCard", () => ({
  AgentCompletionCard: () => <div>Agent completion</div>,
}));

const { AgentThreadChatTab } = await import(
  "@/shell/display/AgentThreadChatTab"
);

describe("AgentThreadChatTab read-only transcript", () => {
  let container: HTMLDivElement;
  let root: Root;
  let records: AgentThreadMessageRecord[];
  let updateListener:
    | ((payload: {
        conversationId: string;
        transcriptUpdate?: { threadId: string; entryId: string; atMs: number };
      }) => void)
    | undefined;
  let listAgentThreadMessages: ReturnType<typeof vi.fn>;

  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  const render = async (agentType = "general") => {
    await act(async () => {
      root.render(
        withI18n(
          <AgentThreadChatTab
            threadId="agent-1"
            conversationId="conversation-1"
            agentType={agentType}
          />,
        ),
      );
      await flush();
    });
  };

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.threadActivity = [];
    records = [];
    updateListener = undefined;
    listAgentThreadMessages = vi.fn(async () => records);
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        localChat: {
          listAgentThreadMessages,
          onThreadActivityUpdated: vi.fn(
            (listener: NonNullable<typeof updateListener>) => {
              updateListener = listener;
              return vi.fn();
            },
          ),
        },
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("hides tool + reasoning, keeps user/assistant/checkpoint, and drops the read-only header and assistant role label", async () => {
    records = [
      {
        entryId: "user-1",
        timestamp: 1,
        role: "user",
        content: "Do the thing.",
      },
      {
        entryId: "reasoning-1",
        timestamp: 2,
        role: "reasoning",
        content: "Reasoning that should not appear.",
      },
      {
        entryId: "tool-1",
        timestamp: 3,
        role: "tool",
        content: "exec_command completed",
        toolActivity: {
          toolCallId: "call-1",
          toolName: "exec_command",
          status: "completed",
          input: '{\n  "cmd": "rg transcript"\n}',
          output: "some/output/path",
          completedAt: 4,
        },
      },
      {
        entryId: "assistant-1",
        timestamp: 5,
        role: "assistant",
        content: "Here is the answer.",
      },
      {
        entryId: "checkpoint-1",
        timestamp: 6,
        role: "checkpoint",
        content: "## Goal\nKeep the exact thread observable.",
      },
    ];

    await render();

    // The "Read-only agent thread" eyebrow header is gone.
    expect(
      container.querySelector(".agent-thread-chat__header"),
    ).toBeNull();
    expect(container.textContent).not.toContain("Read-only agent thread");

    // Tools and (non-Codex) reasoning are not rendered.
    expect(
      container.querySelector('[data-trace-kind="tool"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-trace-kind="reasoning"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain(
      "Reasoning that should not appear.",
    );
    expect(container.textContent).not.toContain("exec_command");

    // User, assistant, and checkpoint content survive.
    expect(container.textContent).toContain("Do the thing.");
    expect(container.textContent).toContain("Here is the answer.");
    expect(
      container.querySelector('details[data-trace-kind="checkpoint"]'),
    ).not.toBeNull();

    // Assistant rows drop the "Agent" role label; user rows keep their eyebrow.
    const assistantLi = container.querySelector('li[data-role="assistant"]');
    expect(
      assistantLi?.querySelector(".agent-thread-chat__role"),
    ).toBeNull();
    const userLi = container.querySelector('li[data-role="user"]');
    expect(
      userLi?.querySelector(".agent-thread-chat__role"),
    ).not.toBeNull();
  });

  it("renders Codex reasoning as an assistant message", async () => {
    mocks.threadActivity = [
      {
        threadId: "agent-1",
        source: "stella",
        modelConfigSnapshot: { engine: "codex_cli" },
      },
    ];
    records = [
      {
        entryId: "reasoning-1",
        timestamp: 1,
        role: "reasoning",
        content: "Codex is thinking out loud.",
      },
    ];

    await render("codex");

    const assistantLi = container.querySelector('li[data-role="assistant"]');
    expect(assistantLi).not.toBeNull();
    expect(
      assistantLi?.querySelector(".event-item.assistant"),
    ).not.toBeNull();
    expect(
      assistantLi?.querySelector(".agent-thread-chat__role"),
    ).toBeNull();
    expect(container.textContent).toContain("Codex is thinking out loud.");
  });

  it("refreshes the transcript in place when a transcript update arrives", async () => {
    records = [
      {
        entryId: "assistant-1",
        timestamp: 1,
        role: "assistant",
        content: "First reply.",
      },
    ];
    await render();
    expect(container.textContent).toContain("First reply.");

    records = [
      {
        entryId: "assistant-1",
        timestamp: 1,
        role: "assistant",
        content: "First reply.",
      },
      {
        entryId: "assistant-2",
        timestamp: 2,
        role: "assistant",
        content: "Second reply.",
      },
    ];
    await act(async () => {
      updateListener?.({
        conversationId: "conversation-1",
        transcriptUpdate: {
          threadId: "agent-1",
          entryId: "entry-2",
          atMs: 2,
        },
      });
      await flush();
    });

    expect(listAgentThreadMessages).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Second reply.");
  });
});
