// @vitest-environment jsdom
/**
 * Rendered-output contract for the settled agent activity row.
 *
 * The completion presentation is a minimal, chrome-less row: the task
 * description alone, a leading glyph (Stella star or the provider's icon),
 * an UNCOLORED grey checkmark, and a trailing chevron. These tests pin
 * that shape:
 *   - description only — the truncated completion excerpt and the file
 *     pills must NOT render in the chat stream anymore;
 *   - the done tell is the muted check, not a colored badge;
 *   - Stella-native agents get the star glyph, external engines get the
 *     provider brand icon in the same slot;
 *   - replay diagnostics identity data attributes stay intact.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { withI18n } from "../../helpers/i18n";
import { AgentCompletionCard } from "@/app/chat/AgentCompletionCard";
import type { AgentCompletionSection } from "@/features/chat/lib/agent-completion";

const filelessSection = (summary: string): AgentCompletionSection => ({
  agentId: "a1",
  title: "Restore composer activity pill",
  completedAtMs: 42,
  files: [],
  summary,
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
      row!.querySelector(".agent-activity-row__status .stella-icon-check"),
    ).not.toBeNull();
    expect(
      row!.querySelector(".agent-activity-row__chevron"),
    ).not.toBeNull();
  });

  it("shows the description ONLY — no completion excerpt, no file pills, no card chrome", async () => {
    await renderCard({
      sections: [
        {
          ...filelessSection(SUMMARY),
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
    expect(container.textContent).not.toContain("Outcome: done.");
    expect(container.textContent).not.toContain("report.md");
    expect(container.querySelector(".agent-completion-card")).toBeNull();
    expect(container.querySelector(".markdown")).toBeNull();
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

  it("shows the star glyph (no brand icon) for Stella-native models", async () => {
    await renderCard({
      sections: [filelessSection("Done.")],
      modelConfigByThread: {
        a1: {
          engine: "default",
          routeModel: "stella/standard",
        },
      },
    });

    expect(container.querySelector(".agent-activity-star")).not.toBeNull();
    expect(container.querySelector("[data-brand]")).toBeNull();
  });

  it("shows the provider icon as the leading glyph for an external engine", async () => {
    await renderCard({
      sections: [filelessSection("Done.")],
      modelConfigByThread: {
        a1: {
          engine: "default",
          routeModel: "stella/openai/gpt-5.6",
        },
      },
    });

    expect(
      container.querySelector(
        '.agent-activity-row__glyph [data-brand="openai"]',
      ),
    ).not.toBeNull();
    expect(container.querySelector(".agent-activity-star")).toBeNull();
  });
});
