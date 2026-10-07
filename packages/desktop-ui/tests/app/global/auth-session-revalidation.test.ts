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

const authenticated = (session: unknown) => ({
  status: "authenticated" as const,
  identityIntent:
    (session as { user?: { isAnonymous?: boolean } }).user?.isAnonymous === true
      ? ("anonymous" as const)
      : ("connected" as const),
  session,
});

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
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetModules();
    nowMs = 10_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    getAuthSession = vi
      .fn()
      .mockResolvedValue(authenticated({ user: { id: "u1" } }));
    (window as unknown as { electronAPI?: unknown }).electronAPI = {
      system: {
        getAuthSession,
        signOutAuth: vi.fn().mockResolvedValue({ ok: true }),
      },
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

  it("rotates the identity revision only when the immutable owner changes", async () => {
    await mountHook();
    const firstRevision = mod.getAuthSessionSnapshot().identityRevision;
    expect(firstRevision).toBeGreaterThan(0);

    getAuthSession.mockResolvedValue(
      authenticated({
        user: { id: "u1" },
        session: { id: "rotated-session" },
      }),
    );
    nowMs += 120_000;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(mod.getAuthSessionSnapshot().identityRevision).toBe(firstRevision);

    getAuthSession.mockResolvedValue(authenticated({ user: { id: "u2" } }));
    nowMs += 120_000;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await flush();
    expect(mod.getAuthSessionSnapshot().identityRevision).toBe(
      firstRevision + 1,
    );
  });

  it("keeps the connected identity visible when Electron IPC cannot return a verdict", async () => {
    await mountHook();
    const before = mod.getAuthSessionSnapshot();
    getAuthSession.mockRejectedValue(new Error("IPC unavailable"));

    await mod.refreshAuthSession({ silent: true });

    expect(mod.getAuthSessionSnapshot()).toMatchObject({
      status: "unknown",
      data: { user: { id: "u1" } },
      isPending: false,
      identityRevision: before.identityRevision,
    });
  });

  it("keeps the cached display identity while requiring reauthentication", async () => {
    await mountHook();
    getAuthSession.mockResolvedValue({
      status: "reauth_required",
      identityIntent: "connected",
      staleSession: { user: { id: "u1" } },
      reason: "session_rejected",
    });

    await mod.refreshAuthSession({ silent: true });

    expect(mod.getAuthSessionSnapshot()).toMatchObject({
      status: "reauth_required",
      data: { user: { id: "u1" } },
      isPending: false,
    });
  });

  it("does not let a late refresh resurrect an identity after sign-out", async () => {
    await mountHook();
    let release!: (value: ReturnType<typeof authenticated>) => void;
    const late = new Promise<ReturnType<typeof authenticated>>((resolve) => {
      release = resolve;
    });
    getAuthSession.mockReturnValue(late);

    const refresh = mod.refreshAuthSession({ silent: true });
    await Promise.resolve();
    await mod.signOutAuthSession();
    release(authenticated({ user: { id: "late-user" } }));
    await refresh;

    expect(mod.getAuthSessionSnapshot()).toMatchObject({
      status: "anonymous_required",
      data: null,
    });
  });
});
