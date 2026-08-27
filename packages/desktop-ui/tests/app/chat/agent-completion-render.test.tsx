import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { withI18n } from "../../helpers/i18n";

const openDisplayPayloadTab = vi.fn();
const openAgentThreadTab = vi.fn();
vi.mock("@/features/workspace-display/open-payload", () => ({
  openDisplayPayloadTab: (...args: unknown[]) => openDisplayPayloadTab(...args),
  openAgentThreadTab: (...args: unknown[]) => openAgentThreadTab(...args),
}));

import { AgentCompletionCard } from "@/app/chat/AgentCompletionCard";
import type { AgentCompletionSection } from "@/features/chat/lib/agent-completion";

const filelessSection = (summary: string): AgentCompletionSection => ({
  agentId: "a1",
  title: "Restore composer activity pill",
  completedAtMs: 42,
  files: [],
  summary,
});

const fileEntry = (path: string) => ({
  path,
  timestamp: 42,
  payload: {
    kind: "markdown" as const,
    filePath: path,
    title: path.split("/").pop()!,
    createdAt: 42,
  },
});

const SUMMARY =
  "**Outcome: done.** Committed `desktop-v0.0.387` — see [notes](https://example.com).";

describe("AgentCompletionCard minimal row rendering", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const renderCard = async (
    props: Partial<Parameters<typeof AgentCompletionCard>[0]> = {},
  ) => {
    await act(async () => {
      root.render(
        withI18n(
          <AgentCompletionCard
            conversationId="conversation-1"
            sections={[filelessSection(SUMMARY)]}
            {...props}
          />,
        ),
      );
    });
  };

  it("renders the description as a clickable row with a grey check and chevron", async () => {
    await renderCard();
    const row = container.querySelector('.agent-activity-row[role="button"]');
    expect(row).not.toBeNull();
    expect(row!.getAttribute("tabindex")).toBe("0");
    expect(
      row!.querySelector(".agent-activity-row__title")!.textContent,
    ).toBe("Restore composer activity pill");
    expect(
      row!.querySelector(".agent-activity-row__glyph .stella-icon-check"),
    ).not.toBeNull();
    expect(
      row!.querySelector(".agent-activity-row__chevron"),
    ).not.toBeNull();
  });

  it("never shows the completion excerpt or card chrome — files render as pills instead", async () => {
    await renderCard({
      sections: [
        { ...filelessSection(SUMMARY), files: [fileEntry("/tmp/report.md")] },
      ],
    });
    expect(container.textContent).not.toContain("Outcome: done.");
    expect(container.querySelector(".agent-completion-card")).toBeNull();
    expect(container.querySelector(".markdown")).toBeNull();

    const pills = container.querySelector(
      ".agent-activity-group__item .agent-activity-row + .agent-activity-files",
    );
    expect(pills).not.toBeNull();
    expect(
      pills!.querySelector(".agent-activity-files__pill-name")!.textContent,
    ).toBe("report.md");
  });

  it("caps the pill strip and offers '+N more' overflow like the old card", async () => {
    const files = Array.from({ length: 7 }, (_, index) =>
      fileEntry(`/tmp/file-${index + 1}.md`),
    );
    await renderCard({ sections: [{ ...filelessSection("Done."), files }] });

    const visiblePills = container.querySelectorAll(
      ".agent-activity-files__pills:not(.agent-activity-files__pills--overflow) .agent-activity-files__pill",
    );
    expect(visiblePills).toHaveLength(5);
    const overflow = container.querySelector(".agent-activity-files__overflow");
    expect(overflow).not.toBeNull();
    expect(overflow!.hasAttribute("inert")).toBe(true);
    expect(
      overflow!.querySelectorAll(".agent-activity-files__pill"),
    ).toHaveLength(2);
    const more = container.querySelector(
      ".agent-activity-files__more",
    ) as HTMLButtonElement;
    expect(more.textContent).toContain("+2 more");
    await act(async () => {
      more.click();
    });
    expect(
      container
        .querySelector(".agent-activity-files__overflow")!
        .getAttribute("data-expanded"),
    ).toBe("true");
    expect(more.textContent).toContain("Show less");
  });

  it("opens the file payload when a pill is clicked (row click-through untouched)", async () => {
    await renderCard({
      sections: [
        { ...filelessSection("Done."), files: [fileEntry("/tmp/report.md")] },
      ],
    });
    openDisplayPayloadTab.mockClear();
    const open = container.querySelector(
      ".agent-activity-files__pill-open",
    ) as HTMLButtonElement;
    await act(async () => {
      open.click();
    });
    expect(openDisplayPayloadTab).toHaveBeenCalledTimes(1);
    expect(openDisplayPayloadTab).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "markdown", filePath: "/tmp/report.md" }),
    );
    expect(openAgentThreadTab).not.toHaveBeenCalled();
  });

  it("stacks one row per section when several agents complete together", async () => {
    await renderCard({
      sections: [
        filelessSection("Done."),
        { ...filelessSection("Also done."), agentId: "a2", title: "Second" },
      ],
    });
    expect(container.querySelectorAll(".agent-activity-row")).toHaveLength(2);
  });

  it("exposes canonical start/completion/run/artifact identity for replay diagnostics", async () => {
    await renderCard({
      cardId: "agent-activity:start-1",
      sections: [
        {
          agentId: "agent-1",
          title: "Build report",
          startEventId: "start-1",
          completionEventId: "done-1",
          rootRunId: "run-1",
          completedAtMs: 42,
          files: [
            {
              path: "/tmp/report.md",
              timestamp: 42,
              payload: {
                kind: "markdown",
                filePath: "/tmp/report.md",
                title: "report.md",
                createdAt: 42,
              },
            },
          ],
        },
      ],
    });
    const card = container.querySelector("[data-activity-card-id]");
    expect(card).not.toBeNull();
    expect((card as HTMLElement).dataset).toMatchObject({
      activityCardId: "agent-activity:start-1",
      agentIds: "agent-1",
      startEventIds: "start-1",
      rootRunIds: "run-1",
      terminalEventIds: "done-1",
      artifactIds: "/tmp/report.md",
    });
  });

  it("never shows provider icons — the check owns the leading slot", async () => {
    await renderCard({
      sections: [filelessSection("Done.")],
      modelConfigByThread: {
        a1: {
          engine: "default",
          routeModel: "stella/openai/gpt-5.6",
        },
      },
    });

    expect(container.querySelector("[data-brand]")).toBeNull();
    expect(container.querySelector(".agent-model-icon")).toBeNull();
    expect(container.querySelector(".agent-activity-star")).toBeNull();
    expect(
      container.querySelector(".agent-activity-row__glyph .stella-icon-check"),
    ).not.toBeNull();
  });
});
