// @vitest-environment jsdom
/**
 * Rendered-output contract for a relayed task completion.
 *
 * The reply that relays a task's result quotes the task the iMessage way:
 * one muted bubble above the reply with the status glyph, the task title,
 * a More action, and the task's produced files as pills INSIDE the bubble.
 * There is no separate completion row under the reply, no card chrome, no
 * result excerpt in the stream. These tests pin that shape:
 *   - the bubble carries glyph, title, More, and the pills;
 *   - pills cap at PILL_CAP with a "+N more" overflow and open the file;
 *   - a bare citation of the same thread is not drawn twice;
 *   - the excerpt never renders;
 *   - replay diagnostics identity stays on the bubble.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { withI18n } from "../../helpers/i18n";

const openDisplayPayloadTab = vi.fn();
const openConversationFocus = vi.fn();
vi.mock("@/features/workspace-display/open-payload", () => ({
  openDisplayPayloadTab: (...args: unknown[]) => openDisplayPayloadTab(...args),
}));
vi.mock("@/features/chat/services/conversation-focus-store", () => ({
  openConversationFocus: (...args: unknown[]) => openConversationFocus(...args),
}));
vi.mock("@/features/chat/hooks/use-thread-activity-records", () => ({
  useThreadActivityRecords: () => new Map(),
}));
vi.mock("@/features/cloud/use-cloud-agent-report", () => ({
  useCloudAgentReport: () => null,
}));
vi.mock("@/app/chat/TaskReportButton", () => ({
  TaskReportButton: () => (
    <button type="button" className="reply-preview__report-toggle">More</button>
  ),
}));

import { ReplyPreview } from "@/app/chat/ReplyPreview";
import type { AgentCompletionSection } from "@/features/chat/lib/agent-completion";
import type { ConversationFileEntry } from "@/features/workspace-display/derive-conversation-files";

const file = (path: string): ConversationFileEntry => ({
  path,
  timestamp: 1,
  payload: {
    kind: "markdown",
    filePath: path,
    title: path.split("/").pop()!,
    createdAt: 1,
  },
});

const section = (
  files: ConversationFileEntry[],
  overrides: Partial<AgentCompletionSection> = {},
): AgentCompletionSection => ({
  agentId: "a1",
  title: "write evening memo",
  completedAtMs: 42,
  completionEventId: "evt-c1",
  files,
  summary: "Created it. This excerpt must never render in the stream.",
  ...overrides,
});

describe("relayed completion preview", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    openDisplayPayloadTab.mockReset();
    openConversationFocus.mockReset();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (
    completions: AgentCompletionSection[],
    refs: Parameters<typeof ReplyPreview>[0]["refs"] = [],
  ) =>
    act(() => {
      root.render(
        withI18n(
          <ReplyPreview refs={refs} completions={completions} conversationId="c1" />,
        ),
      );
    });

  it("quotes the task above the reply with its files inside the bubble", async () => {
    await render([section([file("/Users/me/evening-memo.md")])]);
    const bubble = container.querySelector(".reply-preview__bubble--agent")!;
    expect(bubble).not.toBeNull();
    expect(bubble.querySelector(".reply-preview__agent-title")?.textContent).toBe(
      "write evening memo",
    );
    expect(bubble.querySelector(".reply-preview__agent-icon")).not.toBeNull();
    expect(bubble.querySelector(".reply-preview__report-toggle")?.textContent).toBe("More");
    const pills = bubble.querySelectorAll(".agent-activity-files__pill");
    expect(pills).toHaveLength(1);
    expect(pills[0]?.textContent).toContain("evening-memo.md");
    expect(bubble.querySelector(".agent-activity-files--inline")).not.toBeNull();
    // No completion row, no excerpt, anywhere in the output.
    expect(container.querySelector(".agent-activity-row")).toBeNull();
    expect(container.textContent).not.toContain("This excerpt must never render");
    expect(container.querySelector(".reply-preview__connector")).not.toBeNull();
  });

  it("caps the pills and folds the rest behind '+N more'", async () => {
    await render([
      section(Array.from({ length: 7 }, (_, i) => file(`/out/file-${i}.md`))),
    ]);
    const visible = container.querySelectorAll(
      ".agent-activity-files__pills:not(.agent-activity-files__pills--overflow) .agent-activity-files__pill",
    );
    expect(visible).toHaveLength(5);
    const more = container.querySelector<HTMLButtonElement>(".agent-activity-files__more")!;
    expect(more.textContent).toContain("2");
    await act(async () => {
      more.click();
    });
    expect(
      container.querySelector(".agent-activity-files__overflow")?.getAttribute("data-expanded"),
    ).toBe("true");
  });

  it("opens the file from its pill", async () => {
    await render([section([file("/Users/me/evening-memo.md")])]);
    const open = container.querySelector<HTMLButtonElement>(
      ".agent-activity-files__pill-open",
    )!;
    await act(async () => {
      open.click();
    });
    expect(openDisplayPayloadTab).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "markdown", filePath: "/Users/me/evening-memo.md" }),
    );
  });

  it("quotes a completed task once when the reply also cites it", async () => {
    await render(
      [section([file("/out/a.md")])],
      [
        { kind: "agent", threadId: "a1", title: "write evening memo" },
        { kind: "message", id: "m1", role: "user", preview: "please do it" },
      ],
    );
    const bubbles = container.querySelectorAll(".reply-preview__bubble");
    expect(bubbles).toHaveLength(2);
    expect(container.querySelectorAll(".reply-preview__bubble--agent")).toHaveLength(1);
    expect(container.querySelector(".reply-preview__bubble--user")?.textContent).toContain(
      "please do it",
    );
  });

  it("keeps replay diagnostics identity on the bubble", async () => {
    await render([section([file("/out/a.md"), file("/out/b.md")])]);
    const bubble = container.querySelector(".reply-preview__bubble--agent")!;
    expect(bubble.getAttribute("data-reply-ref-thread-id")).toBe("a1");
    expect(bubble.getAttribute("data-completion-event-id")).toBe("evt-c1");
    expect(bubble.getAttribute("data-artifact-ids")).toBe("/out/a.md,/out/b.md");
  });
});
