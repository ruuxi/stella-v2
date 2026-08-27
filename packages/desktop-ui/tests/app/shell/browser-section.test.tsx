import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_PROFILE_KEY,
  BROWSER_SELECTION_KEY,
} from "@stella/contracts/discovery";
import { withI18n } from "../../helpers/i18n";

type BrowserState = {
  connection: "checking" | "disconnected" | "connected";
  profileName?: string;
  visibleOwnerId: string;
  owners: Array<{
    id: string;
    kind: "manual" | "agent";
    tabCount: number;
    activeTabId?: string;
    latest: boolean;
  }>;
  tabs: Array<{
    id: string;
    ownerId: string;
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
  assistantWorkingMode: "orchestrated" as "direct" | "orchestrated",
  tasks: [] as Array<{ id: string; description: string; agentType: string }>,
}));

vi.mock("@/context/use-chat-runtime", () => ({
  useChatRuntime: () => ({
    conversation: { conversationId: "conversation-1", tasks: mocks.tasks },
  }),
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

const { BrowserSection } =
  await import("@/shell/sidebar-sections/BrowserSection");

const disconnectedState: BrowserState = {
  connection: "disconnected",
  visibleOwnerId: "stella:manual",
  owners: [
    {
      id: "stella:manual",
      kind: "manual",
      tabCount: 0,
      latest: false,
    },
  ],
  tabs: [],
};

const connectedState: BrowserState = {
  connection: "connected",
  profileName: "Personal",
  visibleOwnerId: "stella:manual",
  owners: [
    {
      id: "stella:manual",
      kind: "manual",
      tabCount: 0,
      latest: false,
    },
  ],
  tabs: [],
};

const activeState: BrowserState = {
  connection: "connected",
  profileName: "Personal",
  visibleOwnerId: "stella:manual",
  owners: [
    {
      id: "stella:manual",
      kind: "manual",
      tabCount: 1,
      activeTabId: "tab-1",
      latest: false,
    },
  ],
  activeTabId: "tab-1",
  tabs: [
    {
      id: "tab-1",
      ownerId: "stella:manual",
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
    mocks.assistantWorkingMode = "orchestrated";
    mocks.uiState.clear();
    mocks.tasks = [];
    mocks.uiState.set(BROWSER_SELECTION_KEY, "brave");
    mocks.uiState.set(BROWSER_PROFILE_KEY, "profile-1");
    state = disconnectedState;
    stateListener = null;
    api = {
      getState: vi.fn(async () => state),
      connect: vi.fn(async () => state),
      show: vi.fn(async () => state),
      setVisibleOwner: vi.fn(async () => state),
      setOwnerScope: vi.fn(async () => state),
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
      value: {
        browserView: api,
        system: {
          getLocalModelPreferences: vi.fn(async () => ({
            assistantWorkingMode: mocks.assistantWorkingMode,
          })),
        },
      },
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
      root.render(withI18n(<BrowserSection />));
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
    expect(api.setOwnerScope).toHaveBeenCalledWith({});
    expect(container.textContent).toContain("Stella for Chrome");

    const connectButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Get extension"),
    );
    await act(async () => connectButton?.click());
    expect(api.requestExtensionConnect).toHaveBeenCalledOnce();
    expect(api.connect).toHaveBeenCalledTimes(2);
  });

  it("offers a conversation-owned tab when the connected browser is empty", async () => {
    state = connectedState;
    await render();

    expect(container.textContent).toContain("Browser connected");
    expect(container.textContent).toContain("Personal");
    const newTab = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Open a new tab"),
    );
    await act(async () => newTab?.click());
    expect(api.createTab).toHaveBeenCalledWith({
      ownerId: "orchestrator-conversation-conversation-1",
      activate: true,
    });
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
    expect(api.reload).toHaveBeenCalledWith({
      tabId: "tab-1",
      ownerId: "stella:manual",
    });
    expect(api.createTab).toHaveBeenCalledWith({
      ownerId: "orchestrator-conversation-conversation-1",
      activate: true,
    });
  });

  it("shows every owner tab in orchestrator mode without a session header", async () => {
    const rootOwnerId = "orchestrator-conversation-conversation-1";
    const agentOwnerId = "general-task-agent-1";
    const agentState: BrowserState = {
      connection: "connected",
      profileName: "Personal",
      visibleOwnerId: agentOwnerId,
      owners: [
        {
          id: rootOwnerId,
          kind: "agent",
          tabCount: 1,
          activeTabId: "root-tab",
          latest: false,
        },
        {
          id: agentOwnerId,
          kind: "agent",
          tabCount: 1,
          activeTabId: "agent-tab",
          latest: true,
        },
      ],
      activeTabId: "agent-tab",
      tabs: [
        {
          id: "root-tab",
          ownerId: rootOwnerId,
          url: "https://example.com",
          title: "Root research",
          loading: false,
          canGoBack: false,
          canGoForward: false,
        },
        {
          id: "agent-tab",
          ownerId: agentOwnerId,
          url: "https://appstoreconnect.apple.com",
          title: "App Store Connect",
          loading: false,
          canGoBack: false,
          canGoForward: false,
        },
      ],
    };
    state = agentState;

    await render();

    expect(api.setOwnerScope).toHaveBeenCalledWith({});
    expect(container.textContent).not.toContain("Viewing");
    expect(container.querySelector('[aria-label="Browser session"]')).toBeNull();
    expect(container.textContent).toContain("Root research");
    expect(container.textContent).toContain("App Store Connect");

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Reload page"]')
        ?.click();
    });
    expect(api.reload).toHaveBeenCalledWith({
      tabId: "agent-tab",
      ownerId: agentOwnerId,
    });
  });

  it("automatically scopes direct mode to the active conversation", async () => {
    mocks.assistantWorkingMode = "direct";
    const currentOwnerId = "orchestrator-conversation-conversation-1";
    const currentState: BrowserState = {
      ...activeState,
      visibleOwnerId: currentOwnerId,
      owners: [
        ...activeState.owners,
        {
          id: currentOwnerId,
          kind: "agent",
          tabCount: 1,
          activeTabId: "current-tab",
          latest: true,
        },
      ],
      activeTabId: "current-tab",
      tabs: [
        {
          id: "current-tab",
          ownerId: currentOwnerId,
          url: "https://current.example",
          title: "Current chat tab",
          loading: false,
          canGoBack: false,
          canGoForward: false,
        },
      ],
    };
    api.setOwnerScope.mockImplementation(async (scope) => {
      if (scope.ownerId === currentOwnerId) state = currentState;
      return state;
    });

    await render();
    await vi.waitFor(() =>
      expect(api.setOwnerScope).toHaveBeenCalledWith({
        ownerId: currentOwnerId,
      }),
    );

    expect(container.textContent).toContain("Current chat tab");
    expect(container.textContent).not.toContain("Viewing");
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
    await act(async () => root.render(withI18n(<BrowserSection />)));
    expect(api.hide).toHaveBeenCalled();
  });
});
