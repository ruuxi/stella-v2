// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useOptimisticStop } from "@/features/chat/hooks/use-optimistic-stop";

function StopProbe({
  isStreaming,
  onStop,
}: {
  isStreaming: boolean;
  onStop: () => void;
}) {
  const { showStop, requestStop } = useOptimisticStop(isStreaming, onStop);

  return showStop ? (
    <button onClick={requestStop}>Stop</button>
  ) : (
    <span>Send</span>
  );
}

describe("optimistic composer stop", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const renderProbe = async (isStreaming: boolean, onStop = vi.fn()) => {
    await act(async () => {
      root.render(<StopProbe isStreaming={isStreaming} onStop={onStop} />);
    });
    return onStop;
  };

  it("switches to send immediately when stop is pressed", async () => {
    const onStop = await renderProbe(true);

    await act(async () => container.querySelector("button")?.click());

    expect(onStop).toHaveBeenCalledOnce();
    expect(container.textContent).toBe("Send");
  });

  it("restores stop after five seconds when the run remains active", async () => {
    await renderProbe(true);
    await act(async () => container.querySelector("button")?.click());

    await act(async () => vi.advanceTimersByTimeAsync(4_999));
    expect(container.textContent).toBe("Send");

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(container.textContent).toBe("Stop");
  });

  it("clears the optimistic request when the run actually stops", async () => {
    const onStop = await renderProbe(true);
    await act(async () => container.querySelector("button")?.click());

    await renderProbe(false, onStop);
    await renderProbe(true, onStop);

    expect(container.textContent).toBe("Stop");
  });
});
