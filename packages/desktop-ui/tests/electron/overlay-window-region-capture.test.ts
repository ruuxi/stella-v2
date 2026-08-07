import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  ipcMain: {
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  screen: {
    getAllDisplays: vi.fn(() => []),
    getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock("@stella/desktop/electron/window-capture.js", () => ({
  STELLA_CAPTURE_EXCLUDED_TITLE_PREFIXES: ["Stella Overlay"],
  getWindowInfoAtPoint: vi.fn(),
}));

const { OverlayWindowController } = await import(
  "@stella/desktop/electron/windows/overlay-window.js"
);

describe("OverlayWindowController region capture teardown", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("clears a late hover ring and restores click-through when capture ends", () => {
    vi.useFakeTimers();
    const controller = new OverlayWindowController({
      electronDir: "/tmp",
      getDevServerUrl: () => null,
      isDev: false,
      preloadPath: "/tmp/preload.js",
      sessionPartition: "persist:test",
    });
    const overlayWindow = controller.overlayWindow;
    const send = vi.spyOn(overlayWindow, "send");
    const setIgnoreMouseEvents = vi.spyOn(
      overlayWindow,
      "setIgnoreMouseEvents",
    );
    const fadeOut = vi.spyOn(overlayWindow, "fadeOut");

    controller.activeRegionCapture = true;
    controller.activeWindowHighlight = true;
    const requestId = controller.windowHighlightRequestId;

    controller.endRegionCapture();

    expect(controller.activeRegionCapture).toBe(false);
    expect(controller.activeWindowHighlight).toBe(false);
    expect(controller.windowHighlightRequestId).toBe(requestId + 1);
    expect(send).toHaveBeenCalledWith("overlay:windowHighlight", null);
    expect(send).toHaveBeenCalledWith("overlay:endRegionCapture", undefined);
    expect(setIgnoreMouseEvents).toHaveBeenCalledWith(true);
    expect(fadeOut).toHaveBeenCalledOnce();

    controller.destroy();
  });

  it("ignores point-preview events outside an active capture session", () => {
    const controller = new OverlayWindowController({
      electronDir: "/tmp",
      getDevServerUrl: () => null,
      isDev: false,
      preloadPath: "/tmp/preload.js",
      sessionPartition: "persist:test",
    });
    const setWindowHighlight = vi.spyOn(controller, "setWindowHighlight");

    controller.previewWindowHighlightAtScreenPoint({ x: 100, y: 200 });

    expect(setWindowHighlight).not.toHaveBeenCalled();
    controller.destroy();
  });
});
