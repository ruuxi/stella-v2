// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withI18n } from "../../helpers/i18n";

const localRegistry = vi.hoisted(() => {
  const snapshot = {
    phase: "ready",
    apps: [
      {
        slug: "shared",
        meta: { label: "Shared local", createdAt: "2026-01-01T00:00:00Z" },
        status: "stopped",
      },
    ],
    error: null,
    refreshing: false,
  };
  return {
    snapshot,
    subscribe: () => () => undefined,
  };
});

const cloud = vi.hoisted(() => ({
  state: {
    accountScope: "account:one",
    phase: "ready" as const,
    apps: [
      {
        appId: "shared",
        ownerId: "owner-one",
        slug: "shared",
        title: "Shared cloud",
        status: "active",
        activeBuildId: "build-one",
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    error: null,
  },
}));

vi.mock("@/app/apps/user-apps-registry", () => ({
  getSnapshot: () => localRegistry.snapshot,
  getServerSnapshot: () => localRegistry.snapshot,
  subscribe: localRegistry.subscribe,
  refreshUserApps: vi.fn(),
  stopUserApp: vi.fn(),
}));

vi.mock("@/app/apps/PersistentUserAppsHost", () => ({
  PersistentUserAppsHost: () => <div data-testid="local-host" />,
}));

vi.mock("@/features/cloud/use-cloud-apps", () => ({
  useCloudApps: () => cloud.state,
}));

vi.mock("@/features/cloud/CloudAppPanel", () => ({
  CloudAppPanel: ({ slug }: { slug: string }) => (
    <div data-testid={`cloud-frame-${slug}`}>{slug}</div>
  ),
}));

const { AppsSection } = await import("@/shell/sidebar-sections/AppsSection");
const { SidebarTopNav } = await import(
  "@/shell/sidebar-sections/SidebarTopNav"
);
const { sidebarSections } = await import(
  "@/features/workspace-display/sidebar-sections"
);
const { displayTabs } = await import(
  "@/features/workspace-display/tab-store"
);
const { cloudAppTitles } = await import(
  "@/features/cloud/cloud-app-title-store"
);

describe("cloud app discovery in the modern Apps section", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    cloud.state = {
      accountScope: "account:one",
      phase: "ready",
      apps: [
        {
          appId: "shared",
          ownerId: "owner-one",
          slug: "shared",
          title: "Shared cloud",
          status: "active",
          activeBuildId: "build-one",
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      error: null,
    };
    sidebarSections.reset();
    displayTabs.setPanelOpen(true);
    sidebarSections.openLocation("apps", null);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    cloudAppTitles.clear();
    sidebarSections.reset();
  });

  const render = () =>
    act(() => {
      root.render(
        withI18n(
          <>
            <SidebarTopNav />
            <AppsSection />
          </>,
        ),
      );
    });

  it("keeps colliding local and cloud apps distinct and retains the cloud frame", () => {
    render();
    const buttons = Array.from(container.querySelectorAll("button"));
    const localButton = buttons.find((button) =>
      button.textContent?.includes("Shared local"),
    );
    const cloudButton = buttons.find((button) =>
      button.textContent?.includes("Shared cloud"),
    );
    expect(localButton).toBeTruthy();
    expect(cloudButton).toBeTruthy();

    act(() => localButton?.click());
    expect(sidebarSections.getActiveTab()?.location).toBe("shared");

    act(() => sidebarSections.openLocation("apps", null));
    const refreshedCloudButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent?.includes("Shared cloud"));
    act(() => refreshedCloudButton?.click());
    expect(sidebarSections.getActiveTab()?.location).toBe("cloud:shared");
    expect(container.textContent).toContain("Shared cloud");
    expect(container.querySelector('[data-testid="cloud-frame-shared"]')).not.toBeNull();

    act(() => sidebarSections.openLocation("browser", null));
    const retainedFrame = container
      .querySelector('[data-testid="cloud-frame-shared"]')
      ?.closest(".persistent-cloud-app-surface");
    expect(retainedFrame).not.toBeNull();
    expect(retainedFrame?.getAttribute("aria-hidden")).toBe("true");
  });

  it("retires old-account frames and closes authoritatively missing cloud tabs", () => {
    render();
    const cloudButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Shared cloud"),
    );
    act(() => cloudButton?.click());
    expect(sidebarSections.getActiveTab()?.location).toBe("cloud:shared");

    cloud.state = {
      accountScope: "account:two",
      phase: "ready",
      apps: [],
      error: null,
    };
    render();

    expect(container.querySelector('[data-testid="cloud-frame-shared"]')).toBeNull();
    expect(
      sidebarSections
        .getSnapshot()
        .tabs.some((tab) => tab.location === "cloud:shared"),
    ).toBe(false);
  });
});

