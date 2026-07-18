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
  ThreadTranscriptUpdatedPayload,
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
    },
    {
      id: "child-start-entry",
      timestamp: 1_020,
      kind: "lifecycle",
      lifecycleEvent: {
        _id: "child-thread:1:agent-started",
        timestamp: 1_020,
        type: "agent-started",
        payload: {
          agentId: "child-thread",
          agentType: "general",
          description: "Inspect durable child ownership",
          attemptGeneration: 1,
        },
      },
    },
    {
      id: "child-complete-entry",
      timestamp: 1_030,
      kind: "lifecycle",
      lifecycleEvent: {
        _id: "child-thread:1:agent-completed",
        timestamp: 1_030,
        type: "agent-completed",
        payload: {
          agentId: "child-thread",
          result: "Child consolidated result",
          attemptGeneration: 1,
        },
      },
    },
  ],
};

describe("read-only exact-thread chat surfaces", () => {
  let container: HTMLDivElement;
  let root: Root;
  let activityUpdateListener:
    | ((payload: ThreadActivityUpdatedPayload) => void)
    | undefined;
  let transcriptUpdateListener:
    | ((payload: ThreadTranscriptUpdatedPayload) => void)
    | undefined;
  let currentTranscript = transcript;
  const listThreadTranscript = vi.fn(async () => currentTranscript);
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
    activityUpdateListener = undefined;
    transcriptUpdateListener = undefined;
    currentTranscript = transcript;
    listThreadTranscript.mockReset();
    listThreadTranscript.mockImplementation(async () => currentTranscript);
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
            activityUpdateListener = listener;
            return () => {
              activityUpdateListener = undefined;
            };
          },
          onThreadTranscriptUpdated: (
            listener: (payload: ThreadTranscriptUpdatedPayload) => void,
          ) => {
            transcriptUpdateListener = listener;
            return () => {
              transcriptUpdateListener = undefined;
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

  it("renders authored prose and structured lifecycle cards with no raw tools or send surface", async () => {
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
    expect(container.textContent).toContain("Child consolidated result");
    expect(container.querySelector(".agent-completion-card")).not.toBeNull();
    expect(container.textContent).not.toMatch(
      /\[Tool call\]|\[Tool result\]|exec_command|worktree clean/,
    );
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("[contenteditable='true']")).toBeNull();

    await act(async () => {
      activityUpdateListener?.({
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
      await new Promise((resolve) => window.setTimeout(resolve, 24));
    });
    expect(listThreadTranscript.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it.each(["general", "manager"] as const)(
    "refreshes an open %s tool-only transcript only for its exact thread",
    async (agentType) => {
      currentTranscript = { ...transcript, agentType, entries: [] };
      await act(async () => {
        root.render(<ThreadChatTab threadId={task.id} />);
        await Promise.resolve();
        await Promise.resolve();
      });
      const initialCalls = listThreadTranscript.mock.calls.length;

      await act(async () => {
        transcriptUpdateListener?.({
          threadId: "some-other-thread",
          conversationId: "conv-readonly",
          entryId: "other-entry",
          entryType: "message",
          atMs: 2_000,
        });
        await new Promise((resolve) => window.setTimeout(resolve, 24));
      });
      expect(listThreadTranscript).toHaveBeenCalledTimes(initialCalls);

      currentTranscript = {
        ...currentTranscript,
        entries: [],
      };
      await act(async () => {
        transcriptUpdateListener?.({
          threadId: task.id,
          conversationId: "conv-readonly",
          entryId: "tool-call-entry",
          entryType: "message",
          atMs: 2_001,
        });
        transcriptUpdateListener?.({
          threadId: task.id,
          conversationId: "conv-readonly",
          entryId: "tool-result-entry",
          entryType: "message",
          atMs: 2_002,
        });
        await new Promise((resolve) => window.setTimeout(resolve, 24));
        await Promise.resolve();
      });

      expect(listThreadTranscript).toHaveBeenCalledTimes(initialCalls + 1);
      expect(container.textContent).toContain(
        "No messages in this thread yet.",
      );
      expect(container.textContent).not.toMatch(
        /exec_command|tool-only result landed|\[Tool call\]|\[Tool result\]/,
      );
    },
  );

  it("announces refresh errors while retaining stale transcript content and retry", async () => {
    await act(async () => {
      root.render(<ThreadChatTab threadId={task.id} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain(
      "I checked the durable ancestry before continuing.",
    );

    listThreadTranscript.mockRejectedValueOnce(
      new Error("Transcript refresh failed"),
    );
    await act(async () => {
      transcriptUpdateListener?.({
        threadId: task.id,
        conversationId: "conv-readonly",
        entryId: "failed-refresh-entry",
        entryType: "message",
        atMs: 3_000,
      });
      await new Promise((resolve) => window.setTimeout(resolve, 24));
      await Promise.resolve();
    });

    const alert = container.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.getAttribute("aria-live")).toBe("assertive");
    expect(alert?.textContent).toContain("Transcript refresh failed");
    expect(container.textContent).toContain(
      "I checked the durable ancestry before continuing.",
    );
    const retry = alert?.querySelector<HTMLButtonElement>("button");
    expect(retry?.textContent).toContain("Retry");

    await act(async () => {
      retry?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain(
      "I checked the durable ancestry before continuing.",
    );
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
      activityUpdateListener?.({ conversationId: "conv-readonly" });
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
