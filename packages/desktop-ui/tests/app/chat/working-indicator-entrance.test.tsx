// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InlineWorkingIndicator, type InlineWorkingIndicatorMountProps } from "@/app/chat/InlineWorkingIndicator";
import { INLINE_WORKING_INDICATOR_MIN_VISIBLE_MS } from "@/features/chat/working-indicator-state";

vi.mock("@/app/chat/WorkingIndicator", () => ({
  WorkingIndicator: () => <span data-testid="dots" />,
}));
vi.mock("@/shell/chat-scroll-follow", () => ({
  notifyChatContentGrowth: vi.fn(),
}));

describe("working indicator entrance", () => {
  let container: HTMLDivElement;
  let root: Root;
  const render = (active: boolean, props: Omit<InlineWorkingIndicatorMountProps, "active"> = {}) => {
    act(() => root.render(<InlineWorkingIndicator active={active} exitImmediately {...props} />));
  };
  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
  const indicator = () => container.querySelector('[data-testid="dots"]');
  const shell = () => container.querySelector(".inline-working-indicator");

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it("shows active work on mount without advancing timers and retains the entrance animation", () => {
    render(true);
    expect(indicator()).not.toBeNull();
    expect(shell()?.classList.contains("inline-working-indicator--entering")).toBe(true);
    advance(319);
    expect(shell()?.classList.contains("inline-working-indicator--entering")).toBe(true);
    advance(1);
    expect(shell()?.classList.contains("inline-working-indicator--entering")).toBe(false);
    expect(indicator()).not.toBeNull();
  });

  it("shows newly activated work immediately and leaves idle chats vacant", () => {
    render(false);
    advance(1000);
    expect(indicator()).toBeNull();
    render(true);
    expect(indicator()).not.toBeNull();
    expect(shell()?.classList.contains("inline-working-indicator--vacated")).toBe(false);
  });

  it("cancellation keeps the exit animation and cannot trigger a later entrance", () => {
    render(true);
    advance(10);
    render(false);
    expect(shell()?.classList.contains("inline-working-indicator--leaving")).toBe(true);
    expect(shell()?.classList.contains("inline-working-indicator--entering")).toBe(false);
    advance(239);
    expect(indicator()).not.toBeNull();
    advance(1);
    expect(indicator()).toBeNull();
    advance(1000);
    expect(indicator()).toBeNull();
  });

  it("shows the next run immediately after the previous exit completes", () => {
    render(true);
    render(false);
    advance(240);
    expect(indicator()).toBeNull();
    render(true);
    expect(indicator()).not.toBeNull();
    expect(shell()?.classList.contains("inline-working-indicator--entering")).toBe(true);
    expect(container.querySelectorAll('[data-testid="dots"]')).toHaveLength(1);
  });

  it("reactivation cancels the exit without remounting or duplicating the indicator", () => {
    render(true);
    const original = indicator();
    render(false);
    advance(100);
    render(true);
    expect(indicator()).toBe(original);
    expect(shell()?.classList.contains("inline-working-indicator--leaving")).toBe(false);
    advance(1000);
    expect(indicator()).toBe(original);
    expect(container.querySelectorAll('[data-testid="dots"]')).toHaveLength(1);
  });

  it("retains the same indicator across thinking and tool changes", () => {
    render(true);
    const original = indicator();
    render(true, { runningTool: "web-search", runningToolId: "tool-1" });
    advance(100);
    render(true);
    expect(indicator()).toBe(original);
    expect(shell()?.classList.contains("inline-working-indicator--leaving")).toBe(false);
  });

  it("preserves the ordinary minimum visible interval from immediate activation", () => {
    render(true, { exitImmediately: false });
    advance(100);
    render(false, { exitImmediately: false });
    advance(INLINE_WORKING_INDICATOR_MIN_VISIBLE_MS - 101);
    expect(indicator()).not.toBeNull();
    expect(shell()?.classList.contains("inline-working-indicator--leaving")).toBe(false);
    advance(1);
    expect(shell()?.classList.contains("inline-working-indicator--leaving")).toBe(true);
    advance(239);
    expect(indicator()).not.toBeNull();
    advance(1);
    expect(indicator()).toBeNull();
  });
});
