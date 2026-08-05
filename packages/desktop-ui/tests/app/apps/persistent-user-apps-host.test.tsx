// @vitest-environment jsdom

import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ledger = vi.hoisted(() => ({
  slug: "ledger",
  meta: { label: "Ledger", createdAt: "2026-01-01T00:00:00.000Z" },
}));

const registrySnapshot = vi.hoisted(() => ({
  phase: "ready",
  apps: [ledger],
  error: null,
  refreshing: false,
}));

vi.mock("@/app/apps/user-apps-registry", () => ({
  getSnapshot: () => registrySnapshot,
  getServerSnapshot: () => registrySnapshot,
  subscribe: () => () => {},
}));

vi.mock("@/features/workspace-display/sidebar-sections", () => ({
  useSidebarSectionLocation: () => "ledger",
  useActiveSidebarSection: () => "apps",
}));

vi.mock("@/features/workspace-display/tab-store", () => ({
  useDisplayPanelOpen: () => true,
}));

const { PersistentUserAppsHost, __resetUserAppLeasesForTests } = await import(
  "@/app/apps/PersistentUserAppsHost"
);

describe("PersistentUserAppsHost", () => {
  let container: HTMLDivElement;
  let root: Root;
  let start: ReturnType<typeof vi.fn>;
  let stop: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    __resetUserAppLeasesForTests();
    start = vi.fn().mockResolvedValue({
      slug: "ledger",
      url: "http://127.0.0.1:43123/",
      status: "running",
    });
    stop = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      userApps: { start, stop },
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    await act(async () => vi.runAllTimersAsync());
    __resetUserAppLeasesForTests();
    container.remove();
    vi.useRealTimers();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it("shares one start lease through StrictMode and stops only on real unmount", async () => {
    await act(async () => {
      root.render(
        <StrictMode>
          <PersistentUserAppsHost />
        </StrictMode>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(start).toHaveBeenCalledTimes(1);
    const frame = container.querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe("http://127.0.0.1:43123/");
    expect(frame?.getAttribute("title")).toBe("Ledger");
    expect(frame?.getAttribute("sandbox")).toContain("allow-scripts");
    expect(stop).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    await act(async () => vi.runAllTimersAsync());
    expect(stop).toHaveBeenCalledTimes(1);

    // The shared afterEach may safely unmount an already-unmounted root.
    root = createRoot(container);
  });
});
