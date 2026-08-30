// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasConnectedAccount: true,
  connectHintActive: true,
  dismissConnectHint: vi.fn(),
  preloadSettingsScreen: vi.fn(),
  preloadAuthDialog: vi.fn(),
  preloadBillingScreen: vi.fn(),
  onSignIn: vi.fn(),
}));

vi.mock("@/shell/topbar/nav-surface-preloads", () => ({
  preloadSettingsScreen: mocks.preloadSettingsScreen,
  preloadAuthDialog: mocks.preloadAuthDialog,
  preloadBillingScreen: mocks.preloadBillingScreen,
}));

vi.mock("@/global/onboarding/post-onboarding-hints", () => ({
  usePostOnboardingHint: () => ({
    active: mocks.connectHintActive,
    dismiss: mocks.dismissConnectHint,
  }),
}));

vi.mock("@/global/auth/hooks/use-current-user", () => ({
  useCurrentUser: () => ({
    user: mocks.hasConnectedAccount
      ? { email: "anon@example.com", name: "anon" }
      : null,
    hasConnectedAccount: mocks.hasConnectedAccount,
  }),
}));

vi.mock("@/global/auth/hooks/use-auth-session-state", () => ({
  useAuthSessionState: () => ({ cacheScope: "test", user: null }),
}));

vi.mock("@/global/auth/hooks/use-nickname", () => ({
  useNickname: () => ({ nickname: "anon" }),
}));

vi.mock("@/shared/lib/use-convex-one-shot", () => ({
  usePersistentConvexOneShot: () => ({ plan: "pro", plans: {} }),
}));

vi.mock("@/convex/api", () => ({
  api: { billing: { getSubscriptionStatus: {} } },
}));

vi.mock("@/global/auth/services/auth", () => ({
  secureSignOut: vi.fn(),
}));

vi.mock("@/global/billing/SubscriptionUpgradeDialog", () => ({
  SUBSCRIPTION_UPGRADED_EVENT: "stella:subscription-upgraded",
}));

vi.mock("@/shell/sidebar-sections/feedback-dialog-store", () => ({
  feedbackDialog: { open: vi.fn() },
}));

vi.mock("@/shared/i18n", () => ({
  useT: () => (key: string) => key,
}));

vi.mock("@/global/settings/ThemePicker", () => ({
  ThemePicker: () => null,
}));

import { ShellTopBarAccount } from "@/shell/sidebar/ShellTopBarAccount";
import { SettingsMenuButton } from "@/shell/SettingsMenuButton";

describe("shell top-bar account control", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = async (signedIn: boolean) => {
    mocks.hasConnectedAccount = signedIn;
    await act(async () => {
      // Mirrors ShellTopBarFull: the standalone gear renders only signed out.
      root.render(
        <>
          <ShellTopBarAccount onSignIn={mocks.onSignIn} />
          {!signedIn ? (
            <SettingsMenuButton className="shell-topbar-account-settings" />
          ) : null}
        </>,
      );
    });
  };

  const visibleButtons = () =>
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter(
      (button) => button.getAttribute("aria-hidden") !== "true",
    );

  const trigger = () =>
    container.querySelector<HTMLButtonElement>(".shell-topbar-account-trigger");

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

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.connectHintActive = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body
      .querySelectorAll('[role="menu"]')
      .forEach((menu) => menu.remove());
  });

  it("signed in: one unified button carrying identity plus the settings gear", async () => {
    await render(true);

    const buttons = visibleButtons();
    expect(buttons).toHaveLength(1);
    const [account] = buttons;
    expect(account.classList.contains("shell-topbar-account-trigger")).toBe(
      true,
    );
    expect(account.textContent).toContain("anon");
    // The gear lives inside the single click target, not as a sibling button.
    expect(
      account.querySelector(".shell-topbar-account-settings-icon svg"),
    ).not.toBeNull();
    expect(
      container.querySelector("button.shell-topbar-account-settings"),
    ).toBeNull();
  });

  it("signed in: clicking the unified button opens the settings menu", async () => {
    await render(true);
    expect(document.body.querySelector('[role="menu"]')).toBeNull();

    await openMenu();

    expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
    for (const label of [
      "Settings",
      "Theme",
      "Stella on your phone",
      "Connectors",
      "Send feedback",
    ]) {
      expect(menuItem(label)).not.toBeUndefined();
    }
  });

  it("signed out: separate sign-in button and standalone settings gear", async () => {
    await render(false);

    const buttons = visibleButtons();
    expect(buttons).toHaveLength(2);
    const signIn = container.querySelector<HTMLButtonElement>(
      ".shell-topbar-account-signin",
    );
    const gear = container.querySelector<HTMLButtonElement>(
      "button.shell-topbar-account-settings",
    );
    expect(signIn).not.toBeNull();
    expect(gear).not.toBeNull();
    expect(signIn?.contains(gear)).toBe(false);
    // No gear folded into the sign-in button itself.
    expect(
      signIn?.querySelector(".shell-topbar-account-settings-icon"),
    ).toBeNull();

    await act(async () => {
      signIn?.click();
    });
    expect(mocks.onSignIn).toHaveBeenCalledOnce();
  });

  it("mirrors the connect hint dot on the phone menu item while active", async () => {
    await render(true);

    expect(
      trigger()?.querySelector(".shell-topbar-nav-hint-dot"),
    ).not.toBeNull();

    await openMenu();

    const phoneItem = menuItem("Stella on your phone");
    expect(
      phoneItem?.querySelector(".shell-settings-menu-item-hint-dot"),
    ).not.toBeNull();
    for (const label of ["Settings", "Theme", "Connectors", "Send feedback"]) {
      expect(
        menuItem(label)?.querySelector(".shell-settings-menu-item-hint-dot"),
      ).toBeFalsy();
    }
  });

  it("hides both dots when the hint is inactive", async () => {
    mocks.connectHintActive = false;
    await render(true);

    expect(trigger()?.querySelector(".shell-topbar-nav-hint-dot")).toBeNull();

    await openMenu();

    expect(
      document.body.querySelector(".shell-settings-menu-item-hint-dot"),
    ).toBeNull();
  });

  it("selecting the phone item dismisses the shared hint", async () => {
    await render(true);
    await openMenu();

    await act(async () => {
      menuItem("Stella on your phone")?.click();
    });

    expect(mocks.dismissConnectHint).toHaveBeenCalledOnce();
  });
});
