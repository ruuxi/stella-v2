// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  preloadSettingsScreen: vi.fn(),
  signOut: vi.fn(),
  dismissConnectHint: vi.fn(),
  openFeedback: vi.fn(),
}));

vi.mock("@/shell/topbar/nav-surface-preloads", () => ({
  preloadSettingsScreen: mocks.preloadSettingsScreen,
}));

vi.mock("@/global/auth/services/auth", () => ({
  secureSignOut: mocks.signOut,
}));

vi.mock("@/global/onboarding/post-onboarding-hints", () => ({
  usePostOnboardingHint: () => ({
    active: true,
    dismiss: mocks.dismissConnectHint,
  }),
}));

vi.mock("@/shell/sidebar-sections/feedback-dialog-store", () => ({
  feedbackDialog: { open: mocks.openFeedback },
}));

vi.mock("@/global/settings/SettingsView", () => ({
  SettingsScreen: ({ onSignOut }: { onSignOut?: () => void }) => (
    <div data-testid="settings-screen">
      <button type="button" onClick={onSignOut}>
        Sign out
      </button>
    </div>
  ),
}));

vi.mock("@/global/settings/ThemePicker", () => ({
  ThemePicker: ({ open }: { open?: boolean }) =>
    open ? <div data-testid="theme-picker" /> : null,
}));

import { SettingsMenuButton } from "@/shell/SettingsMenuButton";
import { SettingsDialogHost } from "@/shell/SettingsDialogHost";
import { settingsDialog } from "@/shell/settings-dialog-store";

describe("settings gear menu", () => {
  let container: HTMLDivElement;
  let root: Root;

  const trigger = () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Settings"]');

  const openMenu = async () => {
    expect(trigger()).not.toBeNull();
    await act(async () => {
      trigger()?.focus();
      trigger()?.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
      );
    });
  };

  const menuItem = (label: string) =>
    Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent?.includes(label));

  beforeEach(async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    settingsDialog.close();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <>
          <SettingsMenuButton className="shell-topbar-account-settings" />
          <SettingsDialogHost />
        </>,
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body
      .querySelectorAll('[role="menu"]')
      .forEach((menu) => menu.remove());
    settingsDialog.close();
  });

  it("fans out into a destination menu instead of opening a surface directly", async () => {
    expect(document.body.querySelector('[role="menu"]')).toBeNull();

    await openMenu();

    expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
    expect(document.body.querySelectorAll('[role="menuitem"]')).toHaveLength(5);
    for (const label of [
      "Settings",
      "Theme",
      "Stella on your phone",
      "Connectors",
      "Send feedback",
    ]) {
      expect(menuItem(label)).not.toBeUndefined();
    }
    expect(
      document.body.querySelector('[data-testid="settings-screen"]'),
    ).toBeNull();
  });

  it("opens the settings dialog from the Settings destination", async () => {
    await openMenu();

    await act(async () => {
      menuItem("Settings")?.click();
    });
    // Wait a tick for the lazy SettingsScreen chunk to resolve.
    await act(async () => Promise.resolve());

    expect(
      document.body.querySelector('[data-testid="settings-screen"]'),
    ).not.toBeNull();
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
  });

  it("opens the feedback dialog from the Send feedback destination", async () => {
    await openMenu();

    await act(async () => {
      menuItem("Send feedback")?.click();
    });

    expect(mocks.openFeedback).toHaveBeenCalledOnce();
  });

  it("keeps the theme picker open after the destination menu closes", async () => {
    await openMenu();

    await act(async () => {
      menuItem("Theme")?.click();
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="theme-picker"]'),
    ).not.toBeNull();
  });

  it("dismisses the connect hint when the phone destination is chosen", async () => {
    await openMenu();

    await act(async () => {
      menuItem("Stella on your phone")?.click();
    });

    expect(mocks.dismissConnectHint).toHaveBeenCalledOnce();
  });

  it("preloads the settings screen on hover", async () => {
    await act(async () => {
      trigger()?.dispatchEvent(
        new MouseEvent("mouseenter", { bubbles: false }),
      );
    });
    // React attaches mouseenter via onMouseEnter — simulate through focus,
    // which uses the same preload path.
    await act(async () => {
      trigger()?.focus();
      trigger()?.dispatchEvent(new FocusEvent("focus", { bubbles: false }));
    });
    expect(mocks.preloadSettingsScreen).toHaveBeenCalled();
  });

  it("closes when the dialog host is dismissed through the store", async () => {
    await act(async () => {
      settingsDialog.open();
    });
    await act(async () => Promise.resolve());
    expect(
      document.body.querySelector('[data-testid="settings-screen"]'),
    ).not.toBeNull();

    await act(async () => {
      settingsDialog.close();
    });
    expect(
      document.body.querySelector('[data-testid="settings-screen"]'),
    ).toBeNull();
  });

  it("signs out through the hosted settings screen", async () => {
    await act(async () => {
      settingsDialog.open();
    });
    await act(async () => Promise.resolve());
    const signOutButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Sign out");
    expect(signOutButton).not.toBeUndefined();

    await act(async () => {
      signOutButton?.click();
    });

    expect(mocks.signOut).toHaveBeenCalledOnce();
    expect(
      document.body.querySelector('[data-testid="settings-screen"]'),
    ).toBeNull();
  });
});
