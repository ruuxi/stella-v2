// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activeSection: "home",
  hasConnectedAccount: true,
  location: null as string | null,
  closeSearch: vi.fn(),
  dismissConnectHint: vi.fn(),
  openLocation: vi.fn(),
}));

vi.mock("@/features/workspace-display/display-search-store", () => ({
  displaySearchStore: { close: mocks.closeSearch },
}));

vi.mock("@/features/workspace-display/sidebar-sections", () => ({
  sidebarSections: { openLocation: mocks.openLocation },
  useActiveSidebarSection: () => mocks.activeSection,
  useSidebarSections: () => ({
    locations: { settings: mocks.location },
  }),
}));

vi.mock("@/global/auth/hooks/use-auth-session-state", () => ({
  useAuthSessionState: () => ({
    hasConnectedAccount: mocks.hasConnectedAccount,
  }),
}));

vi.mock("@/global/onboarding/post-onboarding-hints", () => ({
  usePostOnboardingHint: () => ({
    active: true,
    dismiss: mocks.dismissConnectHint,
  }),
}));

import { SettingsMenuButton } from "@/shell/SettingsMenuButton";

describe("settings menu button", () => {
  let container: HTMLDivElement;
  let root: Root;

  const openMenu = async () => {
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Settings"]',
    );
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger?.focus();
      trigger?.dispatchEvent(
        new MouseEvent("pointerdown", {
          bubbles: true,
          button: 0,
          ctrlKey: false,
        }),
      );
    });
  };

  beforeEach(async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.activeSection = "home";
    mocks.hasConnectedAccount = true;
    mocks.location = null;
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <SettingsMenuButton className="shell-topbar-account-settings" />,
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body
      .querySelectorAll('[role="menu"]')
      .forEach((menu) => menu.remove());
  });

  it("opens the destination menu without opening the sidebar", async () => {
    await openMenu();

    expect(mocks.openLocation).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
    expect(
      document.body.querySelectorAll('[role="menuitemradio"]'),
    ).toHaveLength(6);
  });

  it("selects a destination, closes the menu, and opens that sidebar detail", async () => {
    await openMenu();
    const themeItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    ).find((item) => item.textContent?.includes("Theme"));
    expect(themeItem).not.toBeUndefined();

    await act(async () => {
      themeItem?.click();
    });

    expect(mocks.closeSearch).toHaveBeenCalledOnce();
    expect(mocks.openLocation).toHaveBeenCalledWith("settings", "theme");
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
  });

  it("marks the currently open sidebar destination", async () => {
    await act(async () => root.unmount());
    mocks.activeSection = "settings";
    mocks.location = "theme";
    root = createRoot(container);
    await act(async () => {
      root.render(
        <SettingsMenuButton className="shell-topbar-account-settings" />,
      );
    });
    await openMenu();

    const themeItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    ).find((item) => item.textContent?.includes("Theme"));
    expect(themeItem?.getAttribute("aria-checked")).toBe("true");
  });

  it("dismisses with Escape using the shared menu keyboard behavior", async () => {
    await openMenu();
    const menu = document.body.querySelector<HTMLElement>('[role="menu"]');
    expect(menu).not.toBeNull();

    await act(async () => {
      menu?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
      );
    });

    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(
      container
        .querySelector('button[aria-label="Settings"]')
        ?.getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("dismisses on an outside pointer interaction", async () => {
    await openMenu();
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull();

    await act(async () => {
      document.body.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
      );
    });

    expect(document.body.querySelector('[role="menu"]')).toBeNull();
  });
});
