// @vitest-environment jsdom
/**
 * Rendered-output contract for the iMessage-style reply preview:
 *   - one muted bubble per reference, message previews quote the text;
 *   - an agent preview shows the task title and live status, and its
 *     "Report" button fetches the full report on hover intent and opens it
 *     in a floating panel that its close button dismisses;
 *   - clicking a preview opens focus on that target.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cloneElement,
  createContext,
  useContext,
  type ReactElement,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { withI18n } from "../../helpers/i18n";

const openConversationFocus = vi.fn();
vi.mock("@/features/chat/services/conversation-focus-store", () => ({
  openConversationFocus: (...args: unknown[]) => openConversationFocus(...args),
}));

const activityRecords = new Map<
  string,
  { status: string; description: string }
>();
vi.mock("@/features/chat/hooks/use-thread-activity-records", () => ({
  useThreadActivityRecords: () => activityRecords,
}));

// The report panel is a Radix popover in the app; here a minimal stand-in
// keeps the open/close contract (trigger toggles, content renders only while
// open) without popper positioning in jsdom.
vi.mock("@/ui/popover", () => {
  const Ctx = createContext<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }>({ open: false, onOpenChange: () => {} });
  const Root = ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: ReactNode;
  }) => <Ctx.Provider value={{ open, onOpenChange }}>{children}</Ctx.Provider>;
  const Trigger = ({ children }: { children: ReactElement }) => {
    const ctx = useContext(Ctx);
    return cloneElement(children as ReactElement<Record<string, unknown>>, {
      onClick: () => ctx.onOpenChange(!ctx.open),
      "data-state": ctx.open ? "open" : "closed",
    });
  };
  const Content = ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => {
    const ctx = useContext(Ctx);
    return ctx.open ? <div className={className}>{children}</div> : null;
  };
  return { Popover: Object.assign(Root, { Trigger, Content }) };
});

vi.mock("@/app/chat/Markdown", () => ({
  Markdown: ({ text }: { text: string }) => (
    <div data-testid="markdown">{text}</div>
  ),
}));

import { ReplyPreview, __testing } from "@/app/chat/ReplyPreview";

const getAgentReport = vi.fn();

describe("ReplyPreview rendering", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    openConversationFocus.mockReset();
    getAgentReport.mockReset();
    activityRecords.clear();
    __testing.clearReportCache();
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      localChat: { getAgentReport },
    };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("quotes a cited message and opens focus on click", () => {
    act(() => {
      root.render(
        withI18n(
          <ReplyPreview
            conversationId="c1"
            refs={[
              {
                kind: "message",
                id: "m7",
                sequence: 7,
                role: "user",
                preview: "Compare vendor pricing for me",
              },
            ]}
          />,
        ),
      );
    });
    const bubble = container.querySelector<HTMLButtonElement>(
      '[data-reply-ref-message-id="m7"]',
    );
    expect(bubble).not.toBeNull();
    expect(bubble!.textContent).toContain("Replying to you");
    expect(bubble!.textContent).toContain("Compare vendor pricing for me");
    act(() => bubble!.click());
    expect(openConversationFocus).toHaveBeenCalledWith({
      conversationId: "c1",
      root: { kind: "message", id: "m7" },
      title: "Compare vendor pricing for me",
    });
  });

  it("shows an agent's live title and status, and opens its full report in a panel", async () => {
    activityRecords.set("pricing-research", {
      status: "completed",
      description: "Pricing research (live)",
    });
    getAgentReport.mockResolvedValue({
      threadId: "pricing-research",
      description: "Pricing research",
      agentType: "general",
      status: "completed",
      result: "Three vendors publish rates; two need a call.",
      startedAt: 1,
      completedAt: 2,
    });
    act(() => {
      root.render(
        withI18n(
          <ReplyPreview
            conversationId="c1"
            refs={[
              {
                kind: "agent",
                threadId: "pricing-research",
                title: "Pricing research",
              },
            ]}
          />,
        ),
      );
    });
    const bubble = container.querySelector<HTMLElement>(
      '[data-reply-ref-thread-id="pricing-research"]',
    );
    expect(bubble).not.toBeNull();
    expect(bubble!.textContent).toContain("Pricing research (live)");
    expect(bubble!.textContent).not.toContain("Done");
    expect(
      container.querySelector('[data-testid="reply-preview-report"]'),
    ).toBeNull();

    const toggle = bubble!.querySelector<HTMLButtonElement>(
      ".reply-preview__report-toggle",
    );
    await act(async () => {
      toggle!.click();
      await Promise.resolve();
    });
    expect(getAgentReport).toHaveBeenCalledWith({
      threadId: "pricing-research",
    });
    const report = container.querySelector(
      '[data-testid="reply-preview-report"]',
    );
    expect(report).not.toBeNull();
    expect(report!.textContent).toContain("Pricing research (live)");
    expect(report!.textContent).toContain("Three vendors publish rates");

    const close = report!.querySelector<HTMLButtonElement>(
      ".reply-preview-report__close",
    );
    act(() => close!.click());
    expect(
      container.querySelector('[data-testid="reply-preview-report"]'),
    ).toBeNull();

    const head = bubble!.querySelector<HTMLButtonElement>(
      ".reply-preview__agent-head",
    );
    act(() => head!.click());
    expect(openConversationFocus).toHaveBeenCalledWith({
      conversationId: "c1",
      root: { kind: "agent", threadId: "pricing-research" },
      title: "Pricing research (live)",
    });
  });

  it("stacks up to three previews and collapses the rest behind a count", () => {
    act(() => {
      root.render(
        withI18n(
          <ReplyPreview
            conversationId="c1"
            refs={[1, 2, 3, 4, 5].map((n) => ({
              kind: "message" as const,
              id: `m${n}`,
              sequence: n,
              role: "user" as const,
              preview: `message ${n}`,
            }))}
          />,
        ),
      );
    });
    expect(container.querySelectorAll(".reply-preview__bubble")).toHaveLength(
      3,
    );
    const more = container.querySelector<HTMLButtonElement>(
      ".reply-preview__more",
    );
    expect(more!.textContent).toBe("+2 more");
    act(() => more!.click());
    expect(container.querySelectorAll(".reply-preview__bubble")).toHaveLength(
      5,
    );
  });
});
