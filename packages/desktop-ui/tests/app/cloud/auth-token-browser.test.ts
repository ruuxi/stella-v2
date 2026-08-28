import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  browserToken: vi.fn(),
  configurePiRuntime: vi.fn(),
  hostToken: vi.fn(),
}));

vi.mock("@/global/auth/lib/auth-client", () => ({
  authClient: { convex: { token: mocks.browserToken } },
}));

vi.mock("@/platform/electron/device", () => ({
  configurePiRuntime: mocks.configurePiRuntime,
}));

import {
  clearCachedToken,
  getConvexToken,
  getConvexTokenForIdentity,
  getConvexTokenForSubject,
} from "../../../src/global/auth/services/auth-token";

const jwt = (
  issuer: string,
  subject: string,
  isAnonymous?: boolean,
  nonce?: string,
) => {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
  return `${encode({ alg: "none" })}.${encode({
    iss: issuer,
    sub: subject,
    ...(typeof isAnonymous === "boolean" ? { isAnonymous } : {}),
    ...(nonce ? { nonce } : {}),
    exp: Math.floor(Date.now() / 1_000) + 1_800,
  })}.signature`;
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

beforeEach(() => {
  clearCachedToken();
  mocks.browserToken.mockReset();
  mocks.configurePiRuntime.mockReset();
  mocks.hostToken.mockReset();
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

describe("Convex token ownership by renderer kind", () => {
  test("mints a browser token through Better Auth without Electron", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {},
    });
    mocks.browserToken.mockResolvedValue({
      data: { token: "browser-owner-token" },
    });

    await expect(getConvexToken({ forceRefresh: true })).resolves.toBe(
      "browser-owner-token",
    );
    expect(mocks.browserToken).toHaveBeenCalledTimes(1);
    expect(mocks.configurePiRuntime).not.toHaveBeenCalled();
  });

  test("keeps desktop token minting in the Electron host", async () => {
    mocks.hostToken.mockResolvedValue("desktop-owner-token");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {
        electronAPI: {
          system: { getConvexAuthToken: mocks.hostToken },
        },
      },
    });

    await expect(getConvexToken({ forceRefresh: true })).resolves.toBe(
      "desktop-owner-token",
    );
    expect(mocks.configurePiRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.hostToken).toHaveBeenCalledTimes(1);
    expect(mocks.browserToken).not.toHaveBeenCalled();
  });

  test("force-refreshes a cached token and returns only the exact owner subject", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {},
    });
    const issuer = "https://cloud.example.test";
    const accountA = jwt(issuer, "account-a");
    const accountB = jwt(issuer, "account-b");
    mocks.browserToken
      .mockResolvedValueOnce({ data: { token: accountA } })
      .mockResolvedValueOnce({ data: { token: accountB } });

    await expect(getConvexToken({ forceRefresh: true })).resolves.toBe(
      accountA,
    );
    await expect(getConvexTokenForSubject(`${issuer}|account-b`)).resolves.toBe(
      accountB,
    );
    expect(mocks.browserToken).toHaveBeenCalledTimes(2);
  });

  test("fails closed when the refreshed token still belongs to another owner", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {},
    });
    const issuer = "https://cloud.example.test";
    mocks.browserToken.mockResolvedValue({
      data: { token: jwt(issuer, "account-a") },
    });

    await expect(
      getConvexTokenForSubject(`${issuer}|account-b`),
    ).resolves.toBeNull();
  });

  test("requires issuer, subject, and anonymous state to match", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {},
    });
    const issuer = "https://cloud.example.test";
    const anonymous = jwt(issuer, "same-owner", true);
    const connected = jwt(issuer, "same-owner", false);
    mocks.browserToken
      .mockResolvedValueOnce({ data: { token: anonymous } })
      .mockResolvedValueOnce({ data: { token: connected } });

    await expect(
      getConvexTokenForIdentity(`${issuer}|same-owner`, true, {
        identityRevision: 1,
      }),
    ).resolves.toBe(anonymous);
    await expect(
      getConvexTokenForIdentity(`${issuer}|same-owner`, false, {
        identityRevision: 2,
      }),
    ).resolves.toBe(connected);
    expect(mocks.browserToken).toHaveBeenCalledTimes(2);
  });

  test("fails closed when the anonymous claim is missing", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {},
    });
    const issuer = "https://cloud.example.test";
    mocks.browserToken.mockResolvedValue({
      data: { token: jwt(issuer, "account-a") },
    });

    await expect(
      getConvexTokenForIdentity(`${issuer}|account-a`, false, {
        forceRefresh: true,
        identityRevision: 1,
      }),
    ).resolves.toBeNull();
  });

  test("fences an old in-flight identity after an anonymous-to-account transition", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {},
    });
    const issuer = "https://cloud.example.test";
    const anonymous = jwt(issuer, "same-owner", true);
    const connected = jwt(issuer, "same-owner", false);
    const oldRequest = deferred<{ data: { token: string } }>();
    const newRequest = deferred<{ data: { token: string } }>();
    mocks.browserToken
      .mockImplementationOnce(() => oldRequest.promise)
      .mockImplementationOnce(() => newRequest.promise);

    const oldIdentityToken = getConvexTokenForIdentity(
      `${issuer}|same-owner`,
      true,
      { identityRevision: 1 },
    );
    await vi.waitFor(() => expect(mocks.browserToken).toHaveBeenCalledTimes(1));
    const newIdentityToken = getConvexTokenForIdentity(
      `${issuer}|same-owner`,
      false,
      { identityRevision: 2 },
    );
    await vi.waitFor(() => expect(mocks.browserToken).toHaveBeenCalledTimes(2));

    newRequest.resolve({ data: { token: connected } });
    await expect(newIdentityToken).resolves.toBe(connected);
    oldRequest.resolve({ data: { token: anonymous } });
    await expect(oldIdentityToken).resolves.toBeNull();
    await expect(
      getConvexTokenForIdentity(`${issuer}|same-owner`, false, {
        identityRevision: 2,
      }),
    ).resolves.toBe(connected);
    expect(mocks.browserToken).toHaveBeenCalledTimes(2);
  });

  test("coalesces a strict same-identity recovery refresh", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {},
    });
    const issuer = "https://cloud.example.test";
    const connected = jwt(issuer, "account-a", false, "connected");
    const wrongCachedToken = jwt(issuer, "account-a", true, "anonymous");
    const refreshed = jwt(issuer, "account-a", false, "refreshed");
    const refreshRequest = deferred<{ data: { token: string } }>();
    mocks.browserToken
      .mockResolvedValueOnce({ data: { token: connected } })
      .mockResolvedValueOnce({ data: { token: wrongCachedToken } })
      .mockImplementationOnce(() => refreshRequest.promise);

    await expect(
      getConvexTokenForIdentity(`${issuer}|account-a`, false, {
        identityRevision: 1,
      }),
    ).resolves.toBe(connected);
    await expect(getConvexToken({ forceRefresh: true })).resolves.toBe(
      wrongCachedToken,
    );

    const first = getConvexTokenForIdentity(`${issuer}|account-a`, false, {
      identityRevision: 1,
    });
    const second = getConvexTokenForIdentity(`${issuer}|account-a`, false, {
      identityRevision: 1,
    });
    await vi.waitFor(() => expect(mocks.browserToken).toHaveBeenCalledTimes(3));
    refreshRequest.resolve({ data: { token: refreshed } });

    await expect(first).resolves.toBe(refreshed);
    await expect(second).resolves.toBe(refreshed);
    expect(mocks.browserToken).toHaveBeenCalledTimes(3);
  });

  test("honors an explicit same-identity force refresh", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: {},
    });
    const issuer = "https://cloud.example.test";
    const first = jwt(issuer, "account-a", false, "first");
    const second = jwt(issuer, "account-a", false, "second");
    mocks.browserToken
      .mockResolvedValueOnce({ data: { token: first } })
      .mockResolvedValueOnce({ data: { token: second } });

    await expect(
      getConvexTokenForIdentity(`${issuer}|account-a`, false, {
        identityRevision: 1,
      }),
    ).resolves.toBe(first);
    await expect(
      getConvexTokenForIdentity(`${issuer}|account-a`, false, {
        forceRefresh: true,
        identityRevision: 1,
      }),
    ).resolves.toBe(second);
    expect(mocks.browserToken).toHaveBeenCalledTimes(2);
  });
});
