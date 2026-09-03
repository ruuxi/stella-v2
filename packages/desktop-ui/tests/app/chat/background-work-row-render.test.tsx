// @vitest-environment jsdom
/**
 * Rendered-output contract for the live (spawn-anchored) agent activity row.
 *
 * Status is conveyed by motion, not badges or color:
 *   - running → the description shimmers (TextShimmer) beside a tiny
 *     spinner;
 *   - follow-up (`send_input`) → an arrow status glyph once settled;
 *   - completed (without completion payload) → the quiet grey check;
 *   - failed → no invented treatment, just the settled row.
 * The leading glyph is Stella's star, or the provider's icon when the
 * thread runs on an external engine.
 */
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

vi.mock("@/features/chat/services/conversation-focus-store", () => ({
  openConversationFocus: vi.fn(),
}));
vi.mock("@/features/chat/services/reply-counts-store", () => ({
  useReplyCounts: () => ({ messages: {}, agents: {} }),
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
    // The shimmer alone carries progress; the leading slot holds the star.
    expect(row!.querySelector(".stella-loader-circle")).toBeNull();
    expect(
      row!.querySelector(".agent-activity-row__glyph .agent-activity-star"),
    ).not.toBeNull();
    expect(row!.querySelector(".agent-activity-row__chevron")).not.toBeNull();
    // No subtitle / completion prose — the description is the whole row
    // (the shimmer's aria-hidden sweep layer repeats the same string).
    expect(row!.querySelector(".text-shimmer__base")!.textContent).toBe(
      "Summarize the quarterly report",
    );
    expect(row!.querySelector(".agent-activity-row__subtitle")).toBeNull();
  });

  it("shimmer polarity: dim resting base, bright sweeping highlight (CSS contract)", async () => {
    // jsdom doesn't apply stylesheets, so pin the scoped variable override
    // in the shipped CSS: the row remaps TextShimmer's base ink to the
    // muted color and the sweep band to the strong color — light sweeping
    // across dim text, never the reverse.
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
    // Description size: one step above the row base (14px `--font-size-md`),
    // matched by mobile — keep the two in sync if this changes.
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
