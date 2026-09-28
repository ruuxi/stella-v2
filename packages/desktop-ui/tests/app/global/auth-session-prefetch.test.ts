// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/platform/electron/device", () => ({
  configurePiRuntime: vi.fn().mockResolvedValue(undefined),
}));

type AuthSessionModule = typeof import("@/global/auth/services/auth-session");

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
};

describe("auth session prefetch before first render", () => {
  let container: HTMLDivElement;
  let root: Root;
  let getAuthSession: ReturnType<typeof vi.fn>;
  let mod: AuthSessionModule;

  beforeEach(async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetModules();
    getAuthSession = vi.fn().mockResolvedValue({
      status: "authenticated",
      identityIntent: "connected",
      session: { user: { id: "u1" } },
    });
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

  it("reads the session before React mounts and mount does not read again", async () => {
    mod.prefetchAuthSessionBeforeRender();
    await flush();
    // Optimistic cached read plus the authoritative follow-up, no render yet.
    expect(getAuthSession).toHaveBeenCalledTimes(2);
    expect(getAuthSession).toHaveBeenNthCalledWith(1, { allowCached: true });
    expect(mod.getAuthSessionSnapshot().isPending).toBe(false);

    const Probe = () => {
      mod.useDesktopAuthSession();
      return null;
    };
    await act(async () => {
      root.render(createElement(Probe));
    });
    await flush();
    expect(getAuthSession).toHaveBeenCalledTimes(2);
  });

  it("is idempotent", async () => {
    mod.prefetchAuthSessionBeforeRender();
    mod.prefetchAuthSessionBeforeRender();
    await flush();
    expect(getAuthSession).toHaveBeenCalledTimes(2);
  });
});
