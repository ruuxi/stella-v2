// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { withI18n } from "../../helpers/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn().mockResolvedValue(undefined),
}));

const registry = vi.hoisted(() => {
  let snapshot = {
    phase: "loading",
    apps: [] as Array<{
      slug: string;
      meta: { label: string; createdAt: string };
      status?: string;
    }>,
    error: null as string | null,
    refreshing: false,
  };
  const listeners = new Set<() => void>();
  return {
    get: () => snapshot,
    set: (next: typeof snapshot) => {
      snapshot = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: vi.fn(),
    stop: vi.fn(),
  };
});

vi.mock("@/app/apps/user-apps-registry", () => ({
  getSnapshot: registry.get,
  getServerSnapshot: registry.get,
  subscribe: registry.subscribe,
  refreshUserApps: registry.refresh,
  stopUserApp: registry.stop,
}));

vi.mock("@/app/apps/PersistentUserAppsHost", () => ({
  PersistentUserAppsHost: () => <div data-testid="apps-host" />,
}));

const { AppsSection } = await import("@/shell/sidebar-sections/AppsSection");
const { sidebarSections } = await import(
  "@/features/workspace-display/sidebar-sections"
);
const { displayTabs } = await import("@/features/workspace-display/tab-store");

const ledger = {
  slug: "ledger",
  meta: { label: "Ledger", createdAt: "2026-01-01T00:00:00.000Z" },
  status: "running",
};

describe("AppsSection external-app states", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    registry.refresh.mockClear();
    registry.stop.mockReset();
    registry.stop.mockResolvedValue({ slug: "ledger", status: "stopped" });
    registry.set({
      phase: "loading",
      apps: [],
      error: null,
      refreshing: false,
    });
    sidebarSections.reset();
    displayTabs.setPanelOpen(true);
    sidebarSections.setActiveSection("apps");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    sidebarSections.reset();
  });

  const render = () =>
    act(() => {
      root.render(withI18n(<AppsSection />));
    });

  it("shows loading without flashing the ready-empty CTA", () => {
    render();
    expect(container.textContent).toContain("Loading apps…");
    expect(container.textContent).not.toContain("Nothing here yet");
  });

  it("shows a retryable error when no last-good apps exist", () => {
    registry.set({
      phase: "error",
      apps: [],
      error: "folder unavailable",
      refreshing: false,
    });
    render();
    expect(container.textContent).toContain("Couldn’t load apps");
    expect(container.textContent).toContain("folder unavailable");
    act(() =>
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Try again"))
        ?.click(),
    );
    expect(registry.refresh).toHaveBeenCalledTimes(1);
  });

  it("opens a listed app and clears a removed app only after a ready refresh", () => {
    registry.set({
      phase: "ready",
      apps: [ledger],
      error: null,
      refreshing: false,
    });
    render();
    const card = container.querySelector<HTMLButtonElement>(
      ".apps-section__card-open",
    );
    act(() => card?.click());
    expect(sidebarSections.getSnapshot().locations.apps).toBe("ledger");

    act(() =>
      registry.set({
        phase: "error",
        apps: [ledger],
        error: "temporary",
        refreshing: false,
      }),
    );
    expect(sidebarSections.getSnapshot().locations.apps).toBe("ledger");

    act(() =>
      registry.set({
        phase: "ready",
        apps: [],
        error: null,
        refreshing: false,
      }),
    );
    expect(sidebarSections.getSnapshot().locations.apps).toBeNull();
  });

  it("shows runtime status and shuts down a running app", async () => {
    registry.set({
      phase: "ready",
      apps: [ledger],
      error: null,
      refreshing: false,
    });
    render();

    expect(container.textContent).toContain("On");
    const shutdown = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Shut down Ledger"]',
    );
    await act(async () => shutdown?.click());
    expect(registry.stop).toHaveBeenCalledWith("ledger");
  });

  it("leaves an inactive app card free of runtime chrome", () => {
    registry.set({
      phase: "ready",
      apps: [{ ...ledger, status: "stopped" }],
      error: null,
      refreshing: false,
    });
    render();

    expect(container.textContent).not.toContain("Stopped");
    expect(container.querySelector(".apps-section__card-runtime")).toBeNull();
  });
});
