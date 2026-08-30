import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bridge: vi.fn(),
  authHeaders: vi.fn(),
  deviceId: vi.fn(),
}));

vi.mock("@/platform/interior/interior-bridge", () => ({
  getStellaInteriorBridge: mocks.bridge,
}));
vi.mock("@/global/auth/services/auth-token", () => ({
  getAuthHeaders: mocks.authHeaders,
}));
vi.mock("@/platform/electron/device", () => ({
  getOrCreateDeviceId: mocks.deviceId,
}));

import { createServiceRequest } from "@/platform/http/service-request";

describe("interior service request routing", () => {
  beforeEach(() => {
    mocks.bridge.mockReset();
    mocks.authHeaders
      .mockReset()
      .mockResolvedValue({ authorization: "Bearer scoped" });
    mocks.deviceId.mockReset().mockResolvedValue(null);
  });

  it("routes an injected interior through the trusted gateway", async () => {
    mocks.bridge.mockReturnValue({
      protocol: 1,
      gatewayOrigin: "https://apps-auth.example.test",
    });
    await expect(createServiceRequest("/api/chat")).resolves.toEqual({
      endpoint: "https://apps-auth.example.test/api/chat",
      headers: { authorization: "Bearer scoped" },
    });
  });

  it("leaves the normal browser and desktop service origin unchanged", async () => {
    mocks.bridge.mockReturnValue(null);
    vi.stubEnv("VITE_CONVEX_SITE_URL", "https://convex-site.example.test");
    await expect(createServiceRequest("/api/chat")).resolves.toEqual({
      endpoint: "https://convex-site.example.test/api/chat",
      headers: { authorization: "Bearer scoped" },
    });
    vi.unstubAllEnvs();
  });
});
