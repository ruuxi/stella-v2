import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bridge: vi.fn(),
  client: vi.fn(),
}));

vi.mock("@/platform/interior/interior-bridge", () => ({
  getStellaInteriorBridge: mocks.bridge,
}));
vi.mock("convex/react", () => ({
  ConvexReactClient: mocks.client,
}));

describe("interior Convex gateway", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
  });

  it("uses the trusted gateway and waits for scoped auth when bridge-injected", async () => {
    mocks.bridge.mockReturnValue({
      protocol: 1,
      gatewayOrigin: "https://apps-auth.example.test",
    });
    await import("@/platform/convex/convex-client");
    expect(mocks.client).toHaveBeenCalledWith(
      "https://apps-auth.example.test",
      { skipConvexDeploymentUrlCheck: true, expectAuth: true },
    );
  });

  it("preserves normal Convex construction when no bridge is present", async () => {
    mocks.bridge.mockReturnValue(null);
    vi.stubEnv("VITE_CONVEX_URL", "https://convex.example.test");
    await import("@/platform/convex/convex-client");
    expect(mocks.client).toHaveBeenCalledWith(
      "https://convex.example.test",
      undefined,
    );
    vi.unstubAllEnvs();
  });
});
