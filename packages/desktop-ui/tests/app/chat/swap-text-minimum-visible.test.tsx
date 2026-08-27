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

  const visibleIn = () =>
    container.querySelector(".swap-text__layer--in")?.textContent;

  it("holds each phrase for two seconds and then plays the next queued one", async () => {
    await renderText("Thinking");
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await renderText("Reading");
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await renderText("Making changes");

    expect(visibleIn()).toBe("Thinking");

    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(visibleIn()).toBe("Thinking");

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(visibleIn()).toBe("Reading");

    await act(async () => vi.advanceTimersByTimeAsync(1999));
    expect(visibleIn()).toBe("Reading");

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(visibleIn()).toBe("Making changes");
  });

  it("does not skip an in-progress orchestrator tool phrase when a receipt arrives early", async () => {
    await renderText("Thinking");
    await act(async () => vi.advanceTimersByTimeAsync(400));
    await renderText("Reading");
    await act(async () => vi.advanceTimersByTimeAsync(200));
    await renderText("Read files", 0);

    expect(visibleIn()).toBe("Thinking");

    await act(async () => vi.advanceTimersByTimeAsync(1400));
    expect(visibleIn()).toBe("Reading");

    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(visibleIn()).toBe("Read files");
  });

  it("keeps the in-progress tool phrase for two seconds before showing the receipt", async () => {
    await renderText("Running command");
    await act(async () => vi.advanceTimersByTimeAsync(100));

    await renderText("Ran command", 0);

    expect(visibleIn()).toBe("Running command");

    await act(async () => vi.advanceTimersByTimeAsync(1899));
    expect(visibleIn()).toBe("Running command");

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(visibleIn()).toBe("Ran command");
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
    });
    expect(completed.minimumVisibleMs).toBeUndefined();
    expect(completed.runningTool).toBeUndefined();

    const ended = buildInlineWorkingIndicatorProps({
      isStreaming: false,
      isStreamingResponseText: false,
      isToolActive: false,
      hasToolActivity: true,
    });
    expect(ended).toMatchObject({ active: false, exitImmediately: true });
  });

  it("plays live orchestrator tool copy before the receipt across indicator snapshots", async () => {
    const thinking = buildInlineWorkingIndicatorProps({
      isStreaming: true,
      isStreamingResponseText: false,
      isToolActive: false,
      hasToolActivity: false,
    });
    const during = buildInlineWorkingIndicatorProps({
      isStreaming: true,
      isStreamingResponseText: false,
      isToolActive: true,
      hasToolActivity: true,
      activeToolName: "read",
      activeToolCallId: "call-1",
    });
    const done = buildInlineWorkingIndicatorProps({
      isStreaming: true,
      isStreamingResponseText: false,
      isToolActive: false,
      hasToolActivity: true,
      latestCompletedTool: {
        toolCallId: "call-1",
        toolName: "read",
      },
    });

    const thinkingText = getWorkingIndicatorDisplayStatus({
      status: thinking.status ?? undefined,
      toolName: thinking.runningTool,
      toolCallId: thinking.runningToolId,
      isReasoning: !thinking.runningTool,
      reasoningSeed: "turn-1",
    });
    const duringText = getWorkingIndicatorDisplayStatus({
      status: during.status ?? undefined,
      toolName: during.runningTool,
      toolCallId: during.runningToolId,
    });
    const doneText = getWorkingIndicatorDisplayStatus({
      status: done.status ?? undefined,
      toolName: done.runningTool,
      toolCallId: done.runningToolId,
    });

    await renderText(thinkingText, thinking.minimumVisibleMs ?? 2_000);
    await act(async () => vi.advanceTimersByTimeAsync(300));
    await renderText(duringText, during.minimumVisibleMs ?? 2_000);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    await renderText(doneText, done.minimumVisibleMs ?? 2_000);

    expect(visibleIn()).toBe(thinkingText);

    await act(async () => vi.advanceTimersByTimeAsync(1700));
    expect(visibleIn()).toBe(duringText);

    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(visibleIn()).toBe(doneText);
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
