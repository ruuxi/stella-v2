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
} from "../../../src/global/auth/services/auth-token";

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
});
