import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {},
  BrowserWindow: {},
  ipcMain: {},
  screen: {},
}));

const { applyOnboardingWindowPresentation } = await import(
  "../../../desktop/electron/ipc/ui-handlers.js"
);

const display = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 24, width: 1920, height: 1056 },
};

const createWindow = () => ({
  getBounds: vi.fn(() => ({ x: 80, y: 90, width: 900, height: 700 })),
  setBounds: vi.fn(),
  setWindowButtonVisibility: vi.fn(),
});

describe("onboarding window presentation", () => {
  it.each([true, false])(
    "preserves Linux window bounds when active is %s",
    (active) => {
      const win = createWindow();
      const getDisplayMatching = vi.fn(() => display);

      applyOnboardingWindowPresentation({
        win,
        active,
        platform: "linux",
        getDisplayMatching,
      });

      expect(win.getBounds).not.toHaveBeenCalled();
      expect(getDisplayMatching).not.toHaveBeenCalled();
      expect(win.setBounds).not.toHaveBeenCalled();
      expect(win.setWindowButtonVisibility).not.toHaveBeenCalled();
    },
  );

  it("keeps Windows onboarding expansion and restore behavior", () => {
    const win = createWindow();
    const getDisplayMatching = vi.fn(() => display);

    applyOnboardingWindowPresentation({
      win,
      active: true,
      platform: "win32",
      getDisplayMatching,
    });
    expect(win.setBounds).toHaveBeenLastCalledWith(display.workArea, false);

    applyOnboardingWindowPresentation({
      win,
      active: false,
      platform: "win32",
      getDisplayMatching,
    });
    expect(win.setBounds).toHaveBeenLastCalledWith(
      { x: 260, y: 82, width: 1400, height: 940 },
      false,
    );
  });

  it("keeps macOS onboarding expansion, controls, and animated restore", () => {
    const win = createWindow();
    const getDisplayMatching = vi.fn(() => display);

    applyOnboardingWindowPresentation({
      win,
      active: true,
      platform: "darwin",
      getDisplayMatching,
    });
    expect(win.setBounds).toHaveBeenLastCalledWith(display.workArea, false);
    expect(win.setWindowButtonVisibility).toHaveBeenLastCalledWith(false);

    applyOnboardingWindowPresentation({
      win,
      active: false,
      platform: "darwin",
      getDisplayMatching,
    });
    expect(win.setWindowButtonVisibility).toHaveBeenLastCalledWith(true);
    expect(win.setBounds).toHaveBeenLastCalledWith(
      { x: 260, y: 82, width: 1400, height: 940 },
      true,
    );
  });
});
