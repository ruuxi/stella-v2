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

const cloudReportState = vi.hoisted(() => ({ report: null as import("@stella/contracts/local-chat").LocalChatAgentReport | null | undefined }));
vi.mock("@/features/cloud/use-cloud-agent-report", () => ({
  useCloudAgentReport: (_conversation: string, _thread: string, enabled: boolean) => enabled ? cloudReportState.report : null,
}));

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

import { ReplyPreview } from "@/app/chat/ReplyPreview";
import { TaskReportButton, __testing } from "@/app/chat/TaskReportButton";
const getAgentReport = vi.fn();
describe("work context navigation", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    activityRecords.clear();
    openConversationFocus.mockReset();
    getAgentReport.mockReset();
    cloudReportState.report = null;
    __testing.clearReportCache();
    Object.defineProperty(window, "electronAPI", { configurable: true, value: { localChat: { getAgentReport } } });
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });
  it("shows one compact task label without status, quotation, or Report", () => {
    act(() => root.render(withI18n(<ReplyPreview conversationId="c1" refs={[{ kind: "agent", threadId: "a1", title: "Research" }]} />)));
    expect(container.textContent).toBe("Research");
    expect(container.querySelectorAll("button")).toHaveLength(1);
    act(() => container.querySelector("button")!.click());
    expect(openConversationFocus).toHaveBeenCalledWith({ conversationId: "c1", root: { kind: "agent", threadId: "a1" }, title: "Research" });
  });
  it("keeps the full cloud report available in the focus action and refreshes it", async () => {
    getAgentReport.mockResolvedValue(null);
    cloudReportState.report = undefined;
    const render = () => root.render(withI18n(<TaskReportButton conversationId="c1" reference={{ kind: "agent", threadId: "a1", title: "Research" }} />));
    act(render);
    await act(async () => { container.querySelector("button")!.click(); });
    expect(container.textContent).not.toContain("no longer available");
    cloudReportState.report = { threadId: "a1", description: "Research", agentType: "general", status: "completed", startedAt: 1, result: "Full cloud report" };
    act(render);
    expect(container.textContent).toContain("Full cloud report");
    cloudReportState.report = { ...cloudReportState.report, result: "Follow-up report" };
    act(render);
    expect(container.textContent).toContain("Follow-up report");
    expect(container.textContent).not.toContain("Full cloud report");
  });
  it("keeps local reports available", async () => {
    getAgentReport.mockResolvedValue({ status: "completed", result: "Local report" });
    act(() => root.render(withI18n(<TaskReportButton conversationId="c1" reference={{ kind: "agent", threadId: "local", title: "Local task" }} />)));
    await act(async () => { container.querySelector("button")!.click(); });
    expect(container.textContent).toContain("Local report");
  });
});
