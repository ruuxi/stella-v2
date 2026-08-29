// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Markdown } from "@/app/chat/Markdown";
import { sidebarSections } from "@/features/workspace-display/sidebar-sections";
import { displayTabs } from "@/features/workspace-display/tab-store";
import type {
  BrowserViewState,
  ElectronBrowserViewApi,
} from "@/shared/types/electron";
import { withI18n } from "../../helpers/i18n";

const tab = (url: string) => ({
  id: "tab-docs",
  ownerId: "owner-current",
  url,
  title: "Docs",
  loading: false,
  canGoBack: false,
  canGoForward: false,
});

const state = (tabs: BrowserViewState["tabs"]): BrowserViewState => ({
  connection: "connected",
  visibleOwnerId: "owner-current",
  owners: [],
  tabs,
});

describe("chat markdown web links", () => {
  let container: HTMLDivElement;
  let root: Root;
  let browserView: Pick<
    ElectronBrowserViewApi,
    "createTab" | "getState" | "selectTab"
  >;
  const openExternal = vi.fn();

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    sidebarSections.reset();
    displayTabs.reset();
    openExternal.mockReset();
    browserView = {
      getState: vi.fn(),
      createTab: vi.fn(),
      selectTab: vi.fn(),
    };
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        browserView,
        system: { openExternal },
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (window as { electronAPI?: unknown }).electronAPI;
  });

  const render = async (url: string) => {
    await act(async () => {
      root.render(withI18n(<Markdown text={`[Docs](${url})`} />));
    });
    return container.querySelector<HTMLAnchorElement>("a")!;
  };

  const click = async (
    anchor: HTMLAnchorElement,
    modifiers: MouseEventInit = {},
  ) => {
    let allowed = true;
    await act(async () => {
      allowed = anchor.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          button: 0,
          cancelable: true,
          ...modifiers,
        }),
      );
      await Promise.resolve();
    });
    return allowed;
  };

  it("focuses an in-app tab already open at the exact URL", async () => {
    const url = "https://example.com/docs";
    vi.mocked(browserView.getState).mockResolvedValue(state([tab(url)]));
    vi.mocked(browserView.selectTab).mockResolvedValue(state([tab(url)]));
    const anchor = await render(url);

    expect(await click(anchor)).toBe(false);
    await vi.waitFor(() =>
      expect(browserView.selectTab).toHaveBeenCalledWith({
        tabId: "tab-docs",
        ownerId: "owner-current",
        activate: true,
      }),
    );
    expect(browserView.createTab).not.toHaveBeenCalled();
    expect(sidebarSections.getActiveTab()?.kind).toBe("browser");
    expect(displayTabs.getSnapshot().panelOpen).toBe(true);
  });

  it("opens a new in-app tab without replacing existing tabs", async () => {
    const existing = tab("https://example.com/elsewhere");
    vi.mocked(browserView.getState).mockResolvedValue(state([existing]));
    vi.mocked(browserView.createTab).mockResolvedValue(
      state([existing, tab("https://example.com/docs")]),
    );
    const anchor = await render("https://example.com/docs");

    expect(await click(anchor)).toBe(false);
    await vi.waitFor(() =>
      expect(browserView.createTab).toHaveBeenCalledWith({
        url: "https://example.com/docs",
        ownerId: "owner-current",
        activate: true,
      }),
    );
    expect(browserView.selectTab).not.toHaveBeenCalled();
  });

  it("leaves modifier clicks and non-web protocols to native link handling", async () => {
    const web = await render("https://example.com/docs");
    expect(await click(web, { metaKey: true })).toBe(true);

    const email = await render("mailto:hello@example.com");
    expect(await click(email)).toBe(true);
    expect(browserView.getState).not.toHaveBeenCalled();
    expect(browserView.createTab).not.toHaveBeenCalled();
    expect(browserView.selectTab).not.toHaveBeenCalled();
  });
});
