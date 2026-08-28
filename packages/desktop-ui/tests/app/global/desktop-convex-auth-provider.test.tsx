// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SessionSnapshot = {
  data: { user: { id: string; isAnonymous: boolean } } | null;
  isPending: boolean;
  error: Error | null;
  identityRevision: number;
};

const mocks = vi.hoisted(() => ({
  session: {
    data: null,
    isPending: true,
    error: null,
    identityRevision: 0,
  } as SessionSnapshot,
  getTokenForIdentity: vi.fn(),
  clearCachedToken: vi.fn(),
}));

vi.mock("convex/react", () => ({
  ConvexProviderWithAuth: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/global/auth/useMagicLinkAuth", () => ({
  MagicLinkAuthProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/global/auth/services/auth-token", () => ({
  clearCachedToken: mocks.clearCachedToken,
  getConvexTokenForIdentity: mocks.getTokenForIdentity,
}));
vi.mock("@/global/auth/services/auth-session", () => ({
  getAuthSessionSnapshot: () => mocks.session,
  signInAnonymous: vi.fn(),
  useDesktopAuthSession: () => mocks.session,
  waitForBrowserAuthHandoff: vi.fn(),
}));
vi.mock("@/platform/convex/convex-client", () => ({
  convexClient: {},
}));
vi.mock("@/shared/lib/convex-urls", () => ({
  readConfiguredConvexSiteUrl: () => "https://cloud.example.test",
}));
vi.mock("@/global/auth/browser-auth-handoff", () => ({
  decideAutomaticAnonymousBootstrap: vi.fn(),
}));

import { useDesktopConvexAuth } from "@/global/auth/DesktopConvexAuthProvider";

type ConvexAuthValue = ReturnType<typeof useDesktopConvexAuth>;

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe("desktop Convex auth identity transitions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestAuth: ConvexAuthValue | null;

  const Probe = () => {
    latestAuth = useDesktopConvexAuth();
    return null;
  };

  const renderSession = async (session: SessionSnapshot) => {
    mocks.session = session;
    await act(async () => root.render(<Probe />));
    expect(latestAuth).not.toBeNull();
    return latestAuth!;
  };

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    mocks.getTokenForIdentity.mockReset();
    mocks.clearCachedToken.mockReset();
    latestAuth = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("rejects an old callback when the same subject becomes connected", async () => {
    const oldRequest = deferred<string | null>();
    const connectedToken = "connected-token";
    mocks.getTokenForIdentity
      .mockImplementationOnce(() => oldRequest.promise)
      .mockResolvedValueOnce(connectedToken);

    const anonymousAuth = await renderSession({
      data: { user: { id: "same-owner", isAnonymous: true } },
      isPending: false,
      error: null,
      identityRevision: 1,
    });
    const oldToken = anonymousAuth.fetchAccessToken();
    const connectedAuth = await renderSession({
      data: { user: { id: "same-owner", isAnonymous: false } },
      isPending: false,
      error: null,
      identityRevision: 2,
    });

    await expect(connectedAuth.fetchAccessToken()).resolves.toBe(
      connectedToken,
    );
    oldRequest.resolve("anonymous-token");
    await expect(oldToken).resolves.toBeNull();
    expect(mocks.getTokenForIdentity).toHaveBeenNthCalledWith(
      1,
      "https://cloud.example.test|same-owner",
      true,
      { forceRefresh: false, identityRevision: 1 },
    );
    expect(mocks.getTokenForIdentity).toHaveBeenNthCalledWith(
      2,
      "https://cloud.example.test|same-owner",
      false,
      { forceRefresh: false, identityRevision: 2 },
    );
    expect(mocks.clearCachedToken).not.toHaveBeenCalled();
  });

  it("keeps an unchanged identity callback stable and honors Convex force refresh", async () => {
    mocks.getTokenForIdentity.mockResolvedValue("connected-token");
    const session = {
      data: { user: { id: "account-a", isAnonymous: false } },
      isPending: false,
      error: null,
      identityRevision: 4,
    } satisfies SessionSnapshot;
    const first = await renderSession(session);
    const firstFetch = first.fetchAccessToken;
    const second = await renderSession({ ...session });

    expect(second.fetchAccessToken).toBe(firstFetch);
    await expect(
      second.fetchAccessToken({ forceRefreshToken: true }),
    ).resolves.toBe("connected-token");
    expect(mocks.getTokenForIdentity).toHaveBeenCalledWith(
      "https://cloud.example.test|account-a",
      false,
      { forceRefresh: true, identityRevision: 4 },
    );
    expect(mocks.clearCachedToken).not.toHaveBeenCalled();
  });
});
