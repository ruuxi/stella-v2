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
  getConvexTokenForSubject,
} from "../../../src/global/auth/services/auth-token";

const jwt = (issuer: string, subject: string) => {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
  return `${encode({ alg: "none" })}.${encode({
    iss: issuer,
    sub: subject,
    exp: Math.floor(Date.now() / 1_000) + 1_800,
  })}.signature`;
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
    await expect(
      getConvexTokenForSubject(`${issuer}|account-b`),
    ).resolves.toBe(accountB);
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
});
