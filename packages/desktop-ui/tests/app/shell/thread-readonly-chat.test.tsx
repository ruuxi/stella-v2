// @vitest-environment jsdom

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ThreadActivityUpdatedPayload,
  ThreadTranscript,
} from "@stella/contracts/local-chat";
import { displayTabs } from "@/features/workspace-display/tab-store";
import type { TaskItem } from "@/features/chat/lib/event-transforms";
import {
  ActivityTaskRow,
  openActivityTaskChat,
} from "@/shell/LeftSidebarSections";
import { ThreadChatTab } from "@/shell/display/ThreadChatTab";
import { BackgroundWorkCard } from "@/app/chat/BackgroundWorkCard";
import { __privateThreadActivityStore } from "@/features/chat/services/thread-activity-store";

const ACTIVITY_CSS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/app/chat/chat-workspace-strip.css",
);

const task: TaskItem = {
  id: "manager-thread-exact",
  description: "Coordinate a long nested verification title that must truncate",
  agentType: "manager",
  status: "running",
  startedAtMs: 1_000,
  lastUpdatedAtMs: 1_100,
};

const transcript: ThreadTranscript = {
  threadId: task.id,
  conversationId: "conv-readonly",
  agentType: "manager",
  description: task.description,
  status: "running",
  truncated: false,
  entries: [
    {
      id: "input-1",
      timestamp: 1_000,
      kind: "user",
      text: "Inspect the nested result.",
    },
    {
      id: "assistant-1",
      timestamp: 1_010,
      kind: "assistant",
      text: "I checked the durable ancestry before continuing.",
      tools: [
        {
          toolCallId: "tool-1",
          name: "exec_command",
          argumentsPreview: '{"cmd":"git status --short"}',
        },
      ],
    },
    {
      id: "tool-result-1",
      timestamp: 1_020,
      kind: "tool-result",
      toolCallId: "tool-1",
      toolName: "exec_command",
      text: "worktree clean",
      isError: false,
    },
  ],
};

describe("read-only exact-thread chat surfaces", () => {
  let container: HTMLDivElement;
  let root: Root;
  let updateListener:
    | ((payload: ThreadActivityUpdatedPayload) => void)
    | undefined;
  const listThreadTranscript = vi.fn(async () => transcript);
  let activityAttemptGeneration = 2;
  let activityAssistantMessages = ["Latest authored Manager update"];
  const listThreadActivity = vi.fn(async () => [
    {
      threadId: task.id,
      conversationId: "conv-readonly",
      agentType: "manager",
      description: task.description,
      status: "running" as const,
      attemptGeneration: activityAttemptGeneration,
      startedAt: 1_000,
      updatedAt: 1_100,
      assistantMessages: activityAssistantMessages,
      assistantMessagesUpdatedAt: 1_090,
      assistantMessagesEntrySequence: 9,
    },
  ]);

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    updateListener = undefined;
    listThreadTranscript.mockClear();
    listThreadActivity.mockClear();
    activityAttemptGeneration = 2;
    activityAssistantMessages = ["Latest authored Manager update"];
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        localChat: {
          listThreadTranscript,
          listThreadActivity,
          onThreadActivityUpdated: (
            listener: (payload: ThreadActivityUpdatedPayload) => void,
          ) => {
            updateListener = listener;
            return () => {
              updateListener = undefined;
            };
          },
        },
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    __privateThreadActivityStore.resetForTests();
    container.remove();
  });

  it("opens Activity on the exact thread without a composer-context path", async () => {
    const onNavigate = vi.fn();
    openActivityTaskChat(task, onNavigate);
    const snapshot = displayTabs.getSnapshot();
    const active = snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId);
    expect(active).toMatchObject({
      id: `thread-chat:${task.id}`,
      kind: "chat",
      metadata: {
        kind: "agent-thread",
        threadId: task.id,
        readOnly: true,
      },
    });
    expect(snapshot.panelOpen).toBe(true);
    expect(onNavigate).toHaveBeenCalledOnce();

    const onSelect = vi.fn();
    await act(async () => {
      root.render(
        <ul>
          <ActivityTaskRow
            task={task}
            expanded={false}
            onToggle={vi.fn()}
            onSelect={onSelect}
            files={[]}
            onOpenFile={vi.fn()}
            orderIndex={0}
          />
        </ul>,
      );
    });
    const action = container.querySelector<HTMLButtonElement>(
      '.chat-workspace-strip__task-chat[aria-label^="Open read-only chat"]',
    );
    expect(action).not.toBeNull();
    action!.click();
    expect(onSelect).toHaveBeenCalledWith(task);
    const css = fs.readFileSync(ACTIVITY_CSS_PATH, "utf8");
    const actionRule = css.slice(
      css.indexOf(".chat-workspace-strip__task-chat {"),
      css.indexOf("}", css.indexOf(".chat-workspace-strip__task-chat {")),
    );
    expect(actionRule).toContain("position: absolute");
    expect(actionRule).not.toContain("flex: 0 0 auto");
  });

  it("renders transcript messages and tool cards with no send surface", async () => {
    await act(async () => {
      root.render(<ThreadChatTab threadId={task.id} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(listThreadTranscript).toHaveBeenCalledWith({
      threadId: task.id,
      limit: 300,
    });
    expect(container.textContent).toContain("Read only");
    expect(container.textContent).toContain(
      "I checked the durable ancestry before continuing.",
    );
    expect(container.textContent).toContain("exec_command");
    expect(container.textContent).toContain("worktree clean");
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("[contenteditable='true']")).toBeNull();

    await act(async () => {
      updateListener?.({
        conversationId: "conv-readonly",
        assistantUpdate: {
          threadId: task.id,
          assistantMessages: ["new"],
          reasoningSummaries: ["new"],
          latestMessage: "new",
          atMs: 1_100,
          entrySequence: 10,
          attemptGeneration: 2,
        },
      });
      await Promise.resolve();
    });
    expect(listThreadTranscript.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("uses the latest authored update as live card text and keeps chat as a separate trailing action", async () => {
    await act(async () => {
      root.render(
        <BackgroundWorkCard
          threadIds={[task.id]}
          completedThreadIds={[]}
          pausedThreadIds={[]}
          failedThreadIds={[]}
          supersededThreadIds={[]}
          spawnedAtMs={{ [task.id]: Date.now() }}
          descriptions={{ [task.id]: task.description }}
          statusTexts={{}}
          progressTexts={{ [task.id]: "finished send_input" }}
          toolActivities={{}}
          followUpThreadIds={[]}
          cardId="card-readonly"
          startEventIdsByThread={{ [task.id]: "start-1" }}
          attemptGenerationsByThread={{ [task.id]: 2 }}
          conversationId="conv-readonly"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      container.querySelector(".background-work-card__title")?.textContent,
    ).toContain("Latest authored Manager update");
    expect(
      container.querySelector(".background-work-card__subtitle")?.textContent,
    ).toContain(task.description);
    expect(container.textContent).not.toContain("finished send_input");
    const chat = container.querySelector<HTMLButtonElement>(
      ".background-work-card__chat",
    );
    expect(chat?.getAttribute("aria-label")).toContain("Open read-only chat");
    chat!.click();
    expect(displayTabs.getSnapshot().activeTabId).toBe(
      `thread-chat:${task.id}`,
    );
  });

  it("keeps a resumed thread's authored text on its owning attempt card", async () => {
    activityAttemptGeneration = 1;
    activityAssistantMessages = ["Attempt one authored update"];
    const card = (args: {
      key: string;
      startEventId: string;
      attemptGeneration: number;
      superseded: boolean;
      completed?: boolean;
      description: string;
    }) => (
      <BackgroundWorkCard
        key={args.key}
        threadIds={[task.id]}
        completedThreadIds={args.completed ? [task.id] : []}
        pausedThreadIds={[]}
        failedThreadIds={[]}
        supersededThreadIds={args.superseded ? [task.id] : []}
        spawnedAtMs={{ [task.id]: Date.now() }}
        descriptions={{ [task.id]: args.description }}
        statusTexts={{}}
        progressTexts={{}}
        toolActivities={{}}
        followUpThreadIds={args.attemptGeneration > 1 ? [task.id] : []}
        cardId={`card-${args.startEventId}`}
        startEventIdsByThread={{ [task.id]: args.startEventId }}
        attemptGenerationsByThread={{
          [task.id]: args.attemptGeneration,
        }}
        conversationId="conv-readonly"
      />
    );

    await act(async () => {
      root.render(
        <div>
          {card({
            key: "attempt-1",
            startEventId: "start-attempt-1",
            attemptGeneration: 1,
            superseded: false,
            description: "Attempt one task",
          })}
        </div>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      container.querySelector(".background-work-card__title")?.textContent,
    ).toContain("Attempt one authored update");

    activityAttemptGeneration = 2;
    activityAssistantMessages = ["Attempt two authored update"];
    await act(async () => {
      updateListener?.({ conversationId: "conv-readonly" });
      await new Promise((resolve) => window.setTimeout(resolve, 160));
    });

    await act(async () => {
      root.render(
        <div>
          {card({
            key: "attempt-1",
            startEventId: "start-attempt-1",
            attemptGeneration: 1,
            superseded: true,
            description: "Attempt one task",
          })}
          {card({
            key: "attempt-2",
            startEventId: "start-attempt-2",
            attemptGeneration: 2,
            superseded: false,
            completed: true,
            description: "Attempt two follow-up",
          })}
        </div>,
      );
      await Promise.resolve();
    });

    const oldCard = container.querySelector<HTMLElement>(
      '[data-start-event-ids="start-attempt-1"]',
    );
    const currentCard = container.querySelector<HTMLElement>(
      '[data-start-event-ids="start-attempt-2"]',
    );
    expect(
      oldCard?.querySelector(".background-work-card__title")?.textContent,
    ).toContain("Attempt one authored update");
    expect(oldCard?.textContent).not.toContain("Attempt two authored update");
    expect(oldCard?.getAttribute("data-working")).toBeNull();
    expect(
      currentCard?.querySelector(".background-work-card__title")?.textContent,
    ).toContain("Attempt two authored update");
    expect(currentCard?.getAttribute("data-working")).toBeNull();
  });
});
