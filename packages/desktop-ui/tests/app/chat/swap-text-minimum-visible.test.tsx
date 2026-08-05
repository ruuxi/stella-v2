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

  const renderText = async (text: string) => {
    await act(async () => {
      root.render(
        <SwapText text={text} active={false} minimumVisibleMs={2_000} />,
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
