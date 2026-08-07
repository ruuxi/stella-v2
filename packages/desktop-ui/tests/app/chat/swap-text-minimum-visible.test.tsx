// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SwapText } from "@/app/chat/SwapText";
import {
  buildInlineWorkingIndicatorProps,
  getWorkingIndicatorDisplayStatus,
} from "@/features/chat/working-indicator-state";

describe("SwapText minimum visible duration", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.setSystemTime(0);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const renderText = async (text: string, minimumVisibleMs = 2_000) => {
    await act(async () => {
      root.render(
        <SwapText
          text={text}
          active={false}
          minimumVisibleMs={minimumVisibleMs}
        />,
      );
    });
  };

  it("holds a phrase for two seconds and then shows the latest update", async () => {
    await renderText("Thinking");
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await renderText("Reading");
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await renderText("Making changes");

    expect(container.textContent).toBe("Thinking");

    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(container.textContent).toBe("Thinking");

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(container.textContent).toContain("Making changes");
    expect(container.textContent).not.toContain("Reading");
  });

  it("shows a tool result immediately when the receipt disables the hold", async () => {
    await renderText("Running command");
    await act(async () => vi.advanceTimersByTimeAsync(100));

    await renderText("Ran command", 0);

    expect(
      container.querySelector(".swap-text__layer--in")?.textContent,
    ).toBe("Ran command");
  });

  it("keeps only the latest friendly tool result until the turn ends", () => {
    const completed = buildInlineWorkingIndicatorProps({
      isStreaming: true,
      isStreamingResponseText: true,
      isToolActive: false,
      hasToolActivity: true,
      latestCompletedTool: {
        toolCallId: "call-1",
        toolName: "exec_command",
      },
    });
    expect(completed).toMatchObject({
      active: true,
      status: "Ran command",
      minimumVisibleMs: 0,
    });
    expect(completed.runningTool).toBeUndefined();

    const ended = buildInlineWorkingIndicatorProps({
      isStreaming: false,
      isStreamingResponseText: false,
      isToolActive: false,
      hasToolActivity: true,
    });
    expect(ended).toMatchObject({ active: false, exitImmediately: true });
  });

  it("uses friendly tool copy instead of live runtime status text", () => {
    const props = buildInlineWorkingIndicatorProps({
      isStreaming: true,
      isStreamingResponseText: false,
      isToolActive: true,
      hasToolActivity: true,
      activeToolName: "exec_command",
      activeToolCallId: "call-1",
      runtimeStatusText: "Running exec_command with internal details",
    });

    expect(props.status).toBeNull();
    expect(
      getWorkingIndicatorDisplayStatus({
        status: props.status ?? undefined,
        toolName: props.runningTool,
        toolCallId: props.runningToolId,
      }),
    ).not.toContain("exec_command");
  });
});
