// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  preloadSettingsScreen: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/shell/topbar/nav-surface-preloads", () => ({
  preloadSettingsScreen: mocks.preloadSettingsScreen,
}));

vi.mock("@/global/auth/services/auth", () => ({
  secureSignOut: mocks.signOut,
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

import { SettingsMenuButton } from "@/shell/SettingsMenuButton";
import { SettingsDialogHost } from "@/shell/SettingsDialogHost";
import { settingsDialog } from "@/shell/settings-dialog-store";

describe("settings gear button", () => {
  let container: HTMLDivElement;
  let root: Root;

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
    settingsDialog.close();
  });

  const trigger = () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Settings"]');

  it("opens the settings dialog directly, with no destination menu", async () => {
    expect(document.body.querySelector('[role="menu"]')).toBeNull();

    await act(async () => {
      trigger()?.click();
    });

    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    // Wait a tick for the lazy SettingsScreen chunk to resolve.
    await act(async () => Promise.resolve());
    expect(
      document.body.querySelector('[data-testid="settings-screen"]'),
    ).not.toBeNull();
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
      trigger()?.click();
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
      trigger()?.click();
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
