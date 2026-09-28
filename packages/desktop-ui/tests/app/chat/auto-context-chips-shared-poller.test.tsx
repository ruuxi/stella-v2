// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAutoContextChips } from "@/features/chat/hooks/use-auto-context-chips";

const listRecentApps = vi.fn(async () => ({
  apps: [
    { pid: 11, name: "Cursor", isActive: true, windowTitle: "stella-v2" },
    { pid: 12, name: "Notes", isActive: false },
  ],
}));

const renderCounts = new Map<string, number>();
const laneLabels = new Map<string, string>();

function Surface({ id, active }: { id: string; active: boolean }) {
  const { lanes } = useAutoContextChips(active);
  renderCounts.set(id, (renderCounts.get(id) ?? 0) + 1);
  laneLabels.set(
    id,
    lanes
      .map((lane) =>
        lane.current?.chip.kind === "app" ? lane.current.chip.name : "",
      )
      .join(","),
  );
  return null;
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("auto context chips shared poller", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { platform: "darwin", home: { listRecentApps } },
    });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    listRecentApps.mockClear();
    renderCounts.clear();
    laneLabels.clear();
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (window as { electronAPI?: unknown }).electronAPI;
  });

  it("polls once per interval no matter how many surfaces are active", async () => {
    await act(async () => {
      root.render(
        <>
          <Surface id="main" active />
          <Surface id="panel" active />
          <Surface id="quick" active />
          <Surface id="hidden" active={false} />
        </>,
      );
    });
    await flush();
    // One fetch shared by the three surfaces that activated together.
    expect(listRecentApps).toHaveBeenCalledTimes(1);
    for (const id of ["main", "panel", "quick"]) {
      expect(laneLabels.get(id), id).toBe("Cursor,Notes,");
    }
    expect(laneLabels.get("hidden")).toBe(",,");

    const rendersBefore = new Map(renderCounts);
    for (let tick = 0; tick < 3; tick += 1) {
      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      await flush();
    }
    // Before: one loop per active surface (3 fetches per tick).
    expect(listRecentApps).toHaveBeenCalledTimes(4);
    // Identical snapshots stop re-rendering the surfaces that own the strip
    // (the composer). React may render once more before its eager bailout
    // engages; `useReducer` re-rendered on every tick.
    for (const id of ["main", "panel", "quick"]) {
      expect(renderCounts.get(id)!, id).toBeLessThanOrEqual(
        rendersBefore.get(id)! + 1,
      );
    }
  });

  it("stops polling when the last surface deactivates", async () => {
    await act(async () => {
      root.render(<Surface id="main" active />);
    });
    await flush();
    await act(async () => {
      root.render(<Surface id="main" active={false} />);
    });
    listRecentApps.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(listRecentApps).not.toHaveBeenCalled();
  });
});
