// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_PROFILE_KEY,
  BROWSER_SELECTION_KEY,
} from "@stella/contracts/discovery";

type BrowserState = {
  connection: "checking" | "disconnected" | "connected";
  profileName?: string;
  tabs: Array<{
    id: string;
    url: string;
    title: string;
    loading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
  }>;
  activeTabId?: string;
  error?: string;
};

const mocks = vi.hoisted(() => ({
  activeSection: "browser",
  panelOpen: true,
  uiState: new Map<string, string>(),
}));

vi.mock("@/features/workspace-display/sidebar-sections", () => ({
  useActiveSidebarSection: () => mocks.activeSection,
}));

vi.mock("@/features/workspace-display/tab-store", () => ({
  useDisplayPanelOpen: () => mocks.panelOpen,
}));

vi.mock("@/platform/ui-state", () => ({
  uiState: {
    getItem: (key: string) => mocks.uiState.get(key) ?? null,
  },
}));

const { BrowserSection } = await import(
  "@/shell/sidebar-sections/BrowserSection"
);

const disconnectedState: BrowserState = {
  connection: "disconnected",
  tabs: [],
};

const connectedState: BrowserState = {
  connection: "connected",
  profileName: "Personal",
  tabs: [],
};

const activeState: BrowserState = {
  connection: "connected",
  profileName: "Personal",
  activeTabId: "tab-1",
  tabs: [
    {
      id: "tab-1",
      url: "https://example.com",
      title: "Example",
      loading: false,
      canGoBack: true,
      canGoForward: false,
    },
  ],
};

describe("BrowserSection", () => {
  let container: HTMLDivElement;
  let root: Root;
  let state: BrowserState;
  let stateListener: ((next: BrowserState) => void) | null;
  let api: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.activeSection = "browser";
    mocks.panelOpen = true;
    mocks.uiState.clear();
    mocks.uiState.set(BROWSER_SELECTION_KEY, "brave");
    mocks.uiState.set(BROWSER_PROFILE_KEY, "profile-1");
    state = disconnectedState;
    stateListener = null;
    api = {
      getState: vi.fn(async () => state),
      connect: vi.fn(async () => state),
      show: vi.fn(async () => state),
      setLayout: vi.fn(async () => state),
      hide: vi.fn(async () => state),
      createTab: vi.fn(async () => state),
      selectTab: vi.fn(async () => state),
      closeTab: vi.fn(async () => state),
      navigate: vi.fn(async () => state),
      goBack: vi.fn(async () => state),
      goForward: vi.fn(async () => state),
      reload: vi.fn(async () => state),
      requestExtensionConnect: vi.fn(async () => state),
      onState: vi.fn((listener: (next: BrowserState) => void) => {
        stateListener = listener;
        return vi.fn();
      }),
    };
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { browserView: api },
    });
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserverStub {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function () {
        const surface = this.classList.contains("browser-section__page");
        const x = surface ? 20 : 10;
        const y = surface ? 76 : 40;
        const width = surface ? 500 : 520;
        const height = surface ? 400 : 446;
        return {
          x,
          y,
          width,
          height,
          top: y,
          left: x,
          right: x + width,
          bottom: y + height,
          toJSON: () => ({}),
        };
      },
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete document.documentElement.dataset.displayPanelTakeover;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const render = async () => {
    await act(async () => {
      root.render(<BrowserSection />);
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it("uses the onboarding browser profile and offers extension connection", async () => {
    await render();

    expect(api.connect).toHaveBeenCalledWith({
      browserType: "brave",
      profileId: "profile-1",
    });
    expect(container.textContent).toContain("Connect your browser");

    const connectButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Connect browser"),
    );
    await act(async () => connectButton?.click());
    expect(api.requestExtensionConnect).toHaveBeenCalledOnce();
    expect(api.connect).toHaveBeenCalledTimes(2);
  });

  it("shows a quiet connected state until a browser tab exists", async () => {
    state = connectedState;
    await render();

    expect(container.textContent).toContain("Browser connected");
    expect(container.textContent).toContain("Personal");
    expect(api.show).not.toHaveBeenCalled();
  });

  it("renders browser chrome and positions the native page surface", async () => {
    state = activeState;
    await render();

    expect(container.textContent).toContain("Example");
    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Address and search"]',
      )?.value,
    ).toBe("https://example.com");
    expect(api.show).toHaveBeenCalledWith({
      pageBounds: { x: 32, y: 76, width: 488, height: 400 },
      surfaceBounds: { x: 10, y: 40, width: 520, height: 446 },
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Reload page"]')
        ?.click();
      container
        .querySelector<HTMLButtonElement>('button[aria-label="New tab"]')
        ?.click();
    });
    expect(api.reload).toHaveBeenCalledWith({ tabId: "tab-1" });
    expect(api.createTab).toHaveBeenCalledWith({});
  });

  it("uses the full page width when the resize handle is hidden", async () => {
    document.documentElement.dataset.displayPanelTakeover = "true";
    state = activeState;
    await render();

    expect(api.show).toHaveBeenCalledWith({
      pageBounds: { x: 20, y: 76, width: 500, height: 400 },
      surfaceBounds: { x: 10, y: 40, width: 520, height: 446 },
    });
  });

  it("reacts to main-process state and hides the native surface when inactive", async () => {
    state = disconnectedState;
    await render();

    await act(async () => stateListener?.(activeState));
    expect(api.show).toHaveBeenCalledOnce();

    mocks.activeSection = "apps";
    await act(async () => root.render(<BrowserSection />));
    expect(api.hide).toHaveBeenCalled();
  });
});
