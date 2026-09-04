// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InlineWorkingIndicator } from "@/app/chat/InlineWorkingIndicator";

vi.mock("@/app/chat/WorkingIndicator", () => ({
  WorkingIndicator: () => <span data-testid="dots" />,
}));
vi.mock("@/shell/chat-scroll-follow", () => ({
  notifyChatContentGrowth: vi.fn(),
}));

describe("working indicator entrance", () => {
  let container: HTMLDivElement;
  let root: Root;
  const render = (active: boolean) => {
    act(() => root.render(<InlineWorkingIndicator active={active} exitImmediately />));
  };
  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
  const visible = () => container.querySelector('[data-testid="dots"]') !== null;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it("waits 200ms even when mounted during active work", () => {
    render(true);
    expect(visible()).toBe(false);
    advance(199);
    expect(visible()).toBe(false);
    advance(1);
    expect(visible()).toBe(true);
  });

  it("never flashes for work that ends during the delay", () => {
    render(false);
    render(true);
    advance(100);
    render(false);
    advance(1000);
    expect(visible()).toBe(false);
  });

  it("starts a fresh delay for the next run", () => {
    render(true);
    advance(150);
    render(false);
    render(true);
    advance(199);
    expect(visible()).toBe(false);
    advance(1);
    expect(visible()).toBe(true);
  });

  it("resumes visible work immediately during the exit animation", () => {
    render(true);
    advance(200);
    render(false);
    advance(100);
    render(true);
    advance(500);
    expect(visible()).toBe(true);
  });
});
