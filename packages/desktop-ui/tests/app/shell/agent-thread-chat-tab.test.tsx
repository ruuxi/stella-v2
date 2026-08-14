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

describe("AgentThreadChatTab execution transcript", () => {
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

  const render = async () => {
    await act(async () => {
      root.render(
        withI18n(
          <AgentThreadChatTab
            threadId="agent-1"
            conversationId="conversation-1"
            agentType="general"
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

  it("renders reasoning, paired tool details, and checkpoints as collapsed trace rows", async () => {
    records = [
      {
        entryId: "reasoning-1",
        timestamp: 1,
        role: "reasoning",
        content: "Inspect the current implementation before editing.",
      },
      {
        entryId: "tool-1",
        timestamp: 2,
        role: "tool",
        content: "exec_command completed",
        toolActivity: {
          toolCallId: "call-1",
          toolName: "exec_command",
          status: "completed",
          input: '{\n  "cmd": "rg transcript"\n}',
          output: "packages/desktop/electron/services/agent-thread-history.js",
          completedAt: 3,
        },
      },
      {
        entryId: "checkpoint-1",
        timestamp: 4,
        role: "checkpoint",
        content: "## Goal\nKeep the exact thread observable.",
      },
    ];

    await render();

    expect(container.textContent).not.toContain("No messages in this thread");
    const reasoningGroup = container.querySelector<HTMLDivElement>(
      '.agent-thread-chat__trace-group[data-trace-kind="reasoning"]',
    );
    const toolGroup = container.querySelector<HTMLDivElement>(
      '.agent-thread-chat__trace-group[data-trace-kind="tool"]',
    );
    expect(reasoningGroup?.getAttribute("data-expanded")).toBeNull();
    expect(toolGroup?.getAttribute("data-expanded")).toBeNull();
    expect(reasoningGroup?.textContent).toContain("Reasoning");
    expect(toolGroup?.textContent).toContain("1 tool call");

    await act(async () => {
      reasoningGroup?.querySelector<HTMLButtonElement>("button")?.click();
      toolGroup?.querySelector<HTMLButtonElement>("button")?.click();
      await flush();
    });

    const reasoning = container.querySelector<HTMLDetailsElement>(
      'details[data-trace-kind="reasoning"]',
    );
    const tool = container.querySelector<HTMLDetailsElement>(
      'details[data-trace-kind="tool"]',
    );
    const checkpoint = container.querySelector<HTMLDetailsElement>(
      'details[data-trace-kind="checkpoint"]',
    );
    expect(reasoning?.open).toBe(false);
    expect(tool?.open).toBe(false);
    expect(checkpoint?.open).toBe(false);
    expect(reasoning?.textContent).toContain("Reasoning");
    expect(tool?.textContent).toContain("exec_command");
    expect(tool?.textContent).toContain("Input");
    expect(tool?.textContent).toContain("Output");
    expect(checkpoint?.textContent).toContain("Thread checkpoint");
  });

  it("refreshes an in-flight tool row in place when its persisted result arrives", async () => {
    const running: AgentThreadMessageRecord = {
      entryId: "assistant-1:block:0",
      timestamp: 1,
      role: "tool",
      content: "web running",
      toolActivity: {
        toolCallId: "call-web",
        toolName: "web",
        status: "running",
        input: '{\n  "query": "Stella"\n}',
      },
    };
    records = [running];
    await render();

    const toolGroup = container.querySelector<HTMLDivElement>(
      '.agent-thread-chat__trace-group[data-trace-kind="tool"]',
    );
    expect(toolGroup?.getAttribute("data-expanded")).toBeNull();
    await act(async () => {
      toolGroup?.querySelector<HTMLButtonElement>("button")?.click();
      await flush();
    });

    expect(
      container
        .querySelector('details[data-trace-kind="tool"]')
        ?.getAttribute("data-tool-status"),
    ).toBe("running");
    expect(container.textContent).toContain("Waiting for this tool to finish");

    records = [
      {
        ...running,
        content: "web completed",
        toolActivity: {
          ...running.toolActivity!,
          status: "completed",
          output: "Search complete.",
          completedAt: 2,
        },
      },
    ];
    await act(async () => {
      updateListener?.({
        conversationId: "conversation-1",
        transcriptUpdate: {
          threadId: "agent-1",
          entryId: "tool-result-1",
          atMs: 2,
        },
      });
      await flush();
    });

    expect(listAgentThreadMessages).toHaveBeenCalledTimes(2);
    expect(
      container
        .querySelector('details[data-trace-kind="tool"]')
        ?.getAttribute("data-tool-status"),
    ).toBe("completed");
    expect(container.textContent).toContain("Search complete.");
  });
});
