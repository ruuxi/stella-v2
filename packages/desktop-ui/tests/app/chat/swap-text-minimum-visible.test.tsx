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

  it("holds the current phrase for two seconds, then skips ahead to the latest", async () => {
    await renderText("Thinking");
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    await renderText("Reading");
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await renderText("Read files");
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await renderText("Making changes");
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await renderText("Ran command");

    expect(visibleIn()).toBe("Reading");

    await act(async () => vi.advanceTimersByTimeAsync(499));
    expect(visibleIn()).toBe("Reading");

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(visibleIn()).toBe("Ran command");
  });

  it("does not let an early receipt abort the in-progress tool phrase", async () => {
    await renderText("Thinking");
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    await renderText("Reading");
    await act(async () => vi.advanceTimersByTimeAsync(200));
    await renderText("Read files", 0);

    expect(visibleIn()).toBe("Reading");

    await act(async () => vi.advanceTimersByTimeAsync(1799));
    expect(visibleIn()).toBe("Reading");

    await act(async () => vi.advanceTimersByTimeAsync(1));
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

  it("returns to thinking after a tool and stays up until the run ends", () => {
    const afterTool = buildInlineWorkingIndicatorProps({
      isStreaming: true,
      isToolActive: false,
    });
    expect(afterTool).toMatchObject({
      active: true,
      runningTool: undefined,
      status: null,
    });
    expect(afterTool.exitImmediately).toBeUndefined();
    expect(
      getWorkingIndicatorDisplayStatus({
        status: afterTool.status ?? undefined,
        toolName: afterTool.runningTool,
        isReasoning: !afterTool.runningTool,
        reasoningSeed: "turn-1",
      }),
    ).not.toMatch(/read|command/i);

    const ended = buildInlineWorkingIndicatorProps({
      isStreaming: false,
      isToolActive: false,
    });
    expect(ended).toMatchObject({ active: false, exitImmediately: true });
  });

  it("holds the in-progress tool phrase, then catches up to thinking", async () => {
    const thinking = buildInlineWorkingIndicatorProps({
      isStreaming: true,
      isToolActive: false,
    });
    const during = buildInlineWorkingIndicatorProps({
      isStreaming: true,
      isToolActive: true,
      activeToolName: "read",
      activeToolCallId: "call-1",
    });
    const after = buildInlineWorkingIndicatorProps({
      isStreaming: true,
      isToolActive: false,
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
    const afterText = getWorkingIndicatorDisplayStatus({
      status: after.status ?? undefined,
      toolName: after.runningTool,
      toolCallId: after.runningToolId,
      isReasoning: !after.runningTool,
      reasoningSeed: "turn-1",
    });

    await renderText(thinkingText, thinking.minimumVisibleMs ?? 2_000);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    await renderText(duringText, during.minimumVisibleMs ?? 2_000);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    await renderText(afterText, after.minimumVisibleMs ?? 2_000);

    expect(visibleIn()).toBe(duringText);

    await act(async () => vi.advanceTimersByTimeAsync(1799));
    expect(visibleIn()).toBe(duringText);

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(visibleIn()).toBe(afterText);
  });

  it("uses friendly tool copy instead of live runtime status text", () => {
    const props = buildInlineWorkingIndicatorProps({
      isStreaming: true,
      isToolActive: true,
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
