import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { withI18n } from "../../helpers/i18n";

const threadActivityState: { records: unknown[] } = { records: [] };

vi.mock("@/features/chat/hooks/use-thread-activity", () => ({
  useThreadActivity: () => ({
    records: threadActivityState.records,
    hasLoaded: true,
    error: null,
  }),
}));

vi.mock("@/features/workspace-display/open-payload", () => ({
  openAgentThreadTab: vi.fn(),
}));

import { BackgroundWorkCard } from "@/app/chat/BackgroundWorkCard";

const baseProps = {
  threadIds: ["thread-1"],
  descriptions: { "thread-1": "Summarize the quarterly report" },
  cardId: "agent-activity:start-1",
  startEventIdsByThread: { "thread-1": "start-1" },
  conversationId: "conversation-1",
};

describe("BackgroundWorkCard minimal row states", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    threadActivityState.records = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const render = async (
    props: Partial<Parameters<typeof BackgroundWorkCard>[0]> = {},
  ) => {
    await act(async () => {
      root.render(withI18n(<BackgroundWorkCard {...baseProps} {...props} />));
    });
  };

  it("running: shimmers the description beside a static star — no spinner, no badges", async () => {
    await render();
    const row = container.querySelector('.agent-activity-row[role="button"]');
    expect(row).not.toBeNull();
    expect(row!.getAttribute("data-working")).toBe("true");
    expect(row!.querySelector(".text-shimmer")).not.toBeNull();
    expect(row!.textContent).toContain("Summarize the quarterly report");

    expect(row!.querySelector(".stella-loader-circle")).toBeNull();
    expect(
      row!.querySelector(".agent-activity-row__glyph .agent-activity-star"),
    ).not.toBeNull();
    expect(row!.querySelector(".agent-activity-row__chevron")).not.toBeNull();

    expect(row!.querySelector(".text-shimmer__base")!.textContent).toBe(
      "Summarize the quarterly report",
    );
    expect(row!.querySelector(".agent-activity-row__subtitle")).toBeNull();
  });

  it("shimmer polarity: dim resting base, bright sweeping highlight (CSS contract)", async () => {

    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const css = fs.readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../src/app/chat/agent-activity-row.css",
      ),
      "utf8",
    );
    const scope = css.slice(
      css.indexOf(".agent-activity-row__title .text-shimmer {"),
      css.indexOf("}", css.indexOf(".agent-activity-row__title .text-shimmer {")),
    );
    expect(scope).toContain("--text-shimmer-from: var(--text-base)");
    expect(scope).toContain("--text-shimmer-via: var(--text-strong)");

    const titleScope = css.slice(
      css.indexOf(".agent-activity-row__title {"),
      css.indexOf("}", css.indexOf(".agent-activity-row__title {")),
    );
    expect(titleScope).toContain("font-size: var(--font-size-md)");
  });

  it("completed: settles into a calm row with an uncolored check in the leading slot", async () => {
    await render({ completedThreadIds: ["thread-1"] });
    const row = container.querySelector(".agent-activity-row")!;
    expect(row.getAttribute("data-working")).toBeNull();
    expect(row.querySelector(".text-shimmer")).toBeNull();
    expect(
      row.querySelector(".agent-activity-row__glyph .stella-icon-check"),
    ).not.toBeNull();
    expect(row.querySelector(".agent-activity-star")).toBeNull();
  });

  it("follow-up: shows the arrow in the leading slot once settled", async () => {
    await render({
      completedThreadIds: ["thread-1"],
      followUpThreadIds: ["thread-1"],
      statusTexts: { "thread-1": "Also cover the appendix" },
    });
    const row = container.querySelector(".agent-activity-row")!;
    expect(row.getAttribute("data-state")).toBe("follow-up");
    expect(row.textContent).toContain("Also cover the appendix");
    expect(
      row.querySelector(".agent-activity-row__glyph .stella-icon-arrow-right"),
    ).not.toBeNull();
    expect(
      row.querySelector(".agent-activity-row__glyph .stella-icon-check"),
    ).toBeNull();
  });

  it("failed: settles with the plain star, no status glyph", async () => {
    await render({ failedThreadIds: ["thread-1"] });
    const row = container.querySelector(".agent-activity-row")!;
    expect(row.getAttribute("data-state")).toBe("failed");
    expect(row.querySelector(".text-shimmer")).toBeNull();
    expect(
      row.querySelector(".agent-activity-row__glyph .agent-activity-star"),
    ).not.toBeNull();
    expect(row.querySelector(".stella-icon-check")).toBeNull();
    expect(row.querySelector(".stella-icon-arrow-right")).toBeNull();
  });

  it("never shows provider icons, even when the thread runs on an external engine", async () => {
    threadActivityState.records = [
      {
        threadId: "thread-1",
        agentType: "Agent",
        status: "running",
        startedAt: 1,
        updatedAt: 1,
        modelConfigSnapshot: {
          engine: "claude_code_local",
          routeModel: "claude-code/opus",
        },
      },
    ];
    await render();
    expect(container.querySelector("[data-brand]")).toBeNull();
    expect(container.querySelector(".agent-model-icon")).toBeNull();
    expect(container.querySelector(".agent-activity-star")).not.toBeNull();
  });
});
