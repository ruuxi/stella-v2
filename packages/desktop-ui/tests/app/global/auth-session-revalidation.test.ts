// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The auth-session store calls `configurePiRuntime` before every network read;
// stub it so the test never touches the real Electron bridge.
vi.mock("@/platform/electron/device", () => ({
  configurePiRuntime: vi.fn().mockResolvedValue(undefined),
}));

type AuthSessionModule = typeof import("@/global/auth/services/auth-session");

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("desktop auth session revalidation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let getAuthSession: ReturnType<typeof vi.fn>;
  let mod: AuthSessionModule;
  let nowMs: number;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    vi.resetModules();
    nowMs = 10_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    getAuthSession = vi.fn().mockResolvedValue({ user: { id: "u1" } });
    (window as unknown as { electronAPI?: unknown }).electronAPI = {
      system: { getAuthSession },
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mod = await import("@/global/auth/services/auth-session");
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  const mountHook = async () => {
    const Probe = () => {
      mod.useDesktopAuthSession();
      return null;
    };
    await act(async () => {
      root.render(createElement(Probe));
    });
    await flush();
  };

  it("revalidates on window focus without flashing the session back to loading", async () => {
    await mountHook();
    // Cold-start mount already issued at least one authoritative read.
    expect(getAuthSession).toHaveBeenCalled();
    expect(mod.getAuthSessionSnapshot().isPending).toBe(false);
    getAuthSession.mockClear();

    nowMs += 120_000;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    // Background revalidation is silent: the signed-in gating stays put.
    expect(mod.getAuthSessionSnapshot().isPending).toBe(false);

    await flush();
    expect(getAuthSession).toHaveBeenCalled();
  });

  it("throttles bursty focus/reconnect events but revalidates again once the window elapses", async () => {
    await mountHook();
    getAuthSession.mockClear();

    nowMs += 120_000;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    const afterFirst = getAuthSession.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    // Second focus inside the throttle window: no additional network reads.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(getAuthSession.mock.calls.length).toBe(afterFirst);

    // Network reconnect after the throttle window elapses: revalidates again.
    nowMs += 120_000;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await flush();
    expect(getAuthSession.mock.calls.length).toBeGreaterThan(afterFirst);
  });
});
