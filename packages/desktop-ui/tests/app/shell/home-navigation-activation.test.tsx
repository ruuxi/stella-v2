// @vitest-environment jsdom

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useRouterState,
} from "@tanstack/react-router";
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uiState } from "@/platform/ui-state";
import { LeftSidebar } from "@/shell/LeftSidebar";
import { ShellTopBarPrimaryNav } from "@/shell/sidebar/ShellTopBarNav";
import { useChatHomeSurface } from "@/shell/use-chat-home-surface";

vi.mock("@/platform/electron/platform", () => ({
  getPlatform: () => "darwin",
}));
vi.mock("@/shell/LeftSidebarSections", () => ({
  LeftSidebarSections: () => null,
}));
vi.mock("@/shell/sidebar/ShellTopBarAccount", () => ({
  ShellTopBarAccount: () => null,
}));
vi.mock("@/shell/ShellTopBarUpdatePill", () => ({
  ShellTopBarUpdatePill: () => null,
}));

const CHAT_HOME_SURFACE_STORAGE_KEY = "stella.chatHomeSurface";

function HomeActivationHarness({ Nav }: { Nav: ComponentType }) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const { showHomeContent } = useChatHomeSurface({
    isOnChatRoute: pathname === "/chat",
    hasMessages: true,
    isStreaming: false,
    activeConversationId: "nonempty-conversation",
  });

  return (
    <main>
      <output data-testid="route">{pathname}</output>
      <output data-testid="surface">{showHomeContent ? "home" : "chat"}</output>
      <Nav />
    </main>
  );
}

const navImplementations = [
  { name: "top-bar navigation", Nav: ShellTopBarPrimaryNav },
  { name: "left-sidebar navigation", Nav: LeftSidebar },
];

describe.each(navImplementations)(
  "Home activation through $name",
  ({ Nav }) => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
      sessionStorage.clear();
      uiState.setItem(CHAT_HOME_SURFACE_STORAGE_KEY, "chat");
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
        window.setTimeout(() => callback(performance.now()), 0),
      );
      vi.stubGlobal("cancelAnimationFrame", (id: number) =>
        window.clearTimeout(id),
      );
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
    });

    afterEach(async () => {
      await act(async () => root.unmount());
      container.remove();
      sessionStorage.clear();
      uiState.removeItem(CHAT_HOME_SURFACE_STORAGE_KEY);
      vi.unstubAllGlobals();
    });

    it("shows Home after nonempty Chat -> Settings -> click Home", async () => {
      const rootRoute = createRootRoute({
        component: () => <HomeActivationHarness Nav={Nav} />,
      });
      const chatRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: "/chat",
      });
      const settingsRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: "/settings",
      });
      const history = createMemoryHistory({ initialEntries: ["/chat"] });
      const testRouter = createRouter({
        routeTree: rootRoute.addChildren([chatRoute, settingsRoute]),
        history,
      });

      await testRouter.load();
      await act(async () => {
        root.render(<RouterProvider router={testRouter} />);
        await Promise.resolve();
      });
      expect(
        container.querySelector('[data-testid="surface"]')?.textContent,
      ).toBe("chat");

      await act(async () => {
        await testRouter.navigate({ to: "/settings" });
      });
      expect(
        container.querySelector('[data-testid="route"]')?.textContent,
      ).toBe("/settings");

      const homeLink = container.querySelector<HTMLAnchorElement>(
        'a[aria-label="Home"], a.left-sidebar__nav-row',
      );
      expect(homeLink).not.toBeNull();
      await act(async () => {
        homeLink?.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(
        container.querySelector('[data-testid="route"]')?.textContent,
      ).toBe("/chat");
      expect(
        container.querySelector('[data-testid="surface"]')?.textContent,
      ).toBe("home");
      expect(uiState.getItem(CHAT_HOME_SURFACE_STORAGE_KEY)).toBe("home");
    });
  },
);
