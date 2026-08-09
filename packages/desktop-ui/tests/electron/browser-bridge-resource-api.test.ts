import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessRuntime } from "@stella/desktop/electron/process-runtime.js";
import { createStellaBrowserBridgeResource } from "@stella/desktop/electron/process-resources/browser-bridge-resource.js";
import { StellaBrowserBridgeService } from "@stella/desktop/electron/services/stella-browser-bridge-service.js";

const createResource = () =>
  createStellaBrowserBridgeResource({
    processRuntime: new ProcessRuntime(),
    stellaAppDir: "/tmp/stella-test",
    onStatus: vi.fn(),
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Stella browser bridge resource API", () => {
  it("reports disconnected and rejects bridge operations before startup", async () => {
    const resource = createResource();

    await expect(resource.getExtensionStatus()).resolves.toBe(false);
    await expect(resource.exportAllCookies()).rejects.toThrow(
      "Browser bridge service is not running.",
    );
    await expect(resource.exportCookiesForUrls([])).rejects.toThrow(
      "Browser bridge service is not running.",
    );
    await expect(resource.connectCdp("ws://localhost:9222")).rejects.toThrow(
      "Browser bridge service is not running.",
    );
    await expect(
      resource.connectAgentCdp(
        {
          ownerId: "owner-1",
          turnId: "turn-1",
          ownerLeaseId: "lease-1",
          ownerLeaseIssuedAt: 1,
        },
        "ws://localhost:9223",
      ),
    ).rejects.toThrow("Browser bridge service is not running.");
  });

  it("delegates browser bootstrap operations to the managed service", async () => {
    vi.spyOn(StellaBrowserBridgeService.prototype, "start").mockResolvedValue();
    const stop = vi
      .spyOn(StellaBrowserBridgeService.prototype, "stop")
      .mockResolvedValue();
    const getExtensionStatus = vi
      .spyOn(StellaBrowserBridgeService.prototype, "getExtensionStatus")
      .mockResolvedValue(true);
    const exportedCookies = [
      {
        name: "session",
        value: "secret",
        domain: ".example.com",
        path: "/",
        secure: true,
        httpOnly: true,
        hostOnly: false,
        session: false,
        storeId: "0",
        sameSite: "lax",
      },
    ];
    const exportAllCookies = vi
      .spyOn(StellaBrowserBridgeService.prototype, "exportAllCookies")
      .mockResolvedValue(exportedCookies);
    const exportCookiesForUrls = vi
      .spyOn(StellaBrowserBridgeService.prototype, "exportCookiesForUrls")
      .mockResolvedValue(exportedCookies);
    const connectCdp = vi
      .spyOn(StellaBrowserBridgeService.prototype, "connectCdp")
      .mockResolvedValue();
    const connectAgentCdp = vi
      .spyOn(StellaBrowserBridgeService.prototype, "connectAgentCdp")
      .mockResolvedValue({
        bridgeSessionId: "agent-backend-1",
        capabilityExpiresAt: 10_000,
      });
    const resource = createResource();

    resource.start();

    await expect(resource.getExtensionStatus()).resolves.toBe(true);
    await expect(resource.exportAllCookies()).resolves.toBe(exportedCookies);
    await expect(
      resource.exportCookiesForUrls(["https://example.com"]),
    ).resolves.toBe(exportedCookies);
    await resource.connectCdp("ws://localhost:9222");
    await expect(
      resource.connectAgentCdp(
        {
          ownerId: "owner-1",
          turnId: "turn-1",
          ownerLeaseId: "lease-1",
          ownerLeaseIssuedAt: 1,
        },
        "ws://localhost:9223",
      ),
    ).resolves.toEqual({
      bridgeSessionId: "agent-backend-1",
      capabilityExpiresAt: 10_000,
    });

    expect(getExtensionStatus).toHaveBeenCalledOnce();
    expect(exportAllCookies).toHaveBeenCalledOnce();
    expect(exportCookiesForUrls).toHaveBeenCalledWith(["https://example.com"]);
    expect(connectCdp).toHaveBeenCalledWith("ws://localhost:9222");
    expect(connectAgentCdp).toHaveBeenCalledWith(
      {
        ownerId: "owner-1",
        turnId: "turn-1",
        ownerLeaseId: "lease-1",
        ownerLeaseIssuedAt: 1,
      },
      "ws://localhost:9223",
    );

    await resource.stop();
    expect(stop).toHaveBeenCalledOnce();
  });
});
