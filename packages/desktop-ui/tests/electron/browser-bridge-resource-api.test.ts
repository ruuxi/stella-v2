import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessRuntime } from "@stella/desktop/electron/process-runtime.js";
import { createStellaBrowserBridgeResource } from "@stella/desktop/electron/process-resources/browser-bridge-resource.js";
import { StellaBrowserBridgeService } from "@stella/desktop/electron/services/stella-browser-bridge-service.js";
import { BROWSER_BRIDGE_MISSING_ERROR } from "@stella/desktop/electron/utils/register-stella-native-messaging-host.js";
import type { StellaBrowserBridgeStatus } from "@stella/contracts/browser-bridge-status";

const createResource = (
  onStatus: (status: StellaBrowserBridgeStatus) => void = vi.fn(),
  processRuntime: Pick<
    ProcessRuntime,
    "isShuttingDown" | "setManagedTimeout"
  > = new ProcessRuntime(),
) =>
  createStellaBrowserBridgeResource({
    processRuntime: processRuntime as ProcessRuntime,
    stellaAppDir: "/tmp/stella-test",
    onStatus,
  });

const flush = async (times = 8) => {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
};

const waitForStatus = async (
  statuses: StellaBrowserBridgeStatus[],
  predicate: (status: StellaBrowserBridgeStatus) => boolean,
) => {
  for (let i = 0; i < 20; i += 1) {
    if (statuses.some(predicate)) {
      return;
    }
    await flush(2);
  }
  throw new Error("Timed out waiting for browser bridge status.");
};

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

  it("retries missing, disconnected, and exhausted bridge states without notifyUser", async () => {
    const start = vi.spyOn(StellaBrowserBridgeService.prototype, "start");
    start
      .mockRejectedValueOnce(new Error(BROWSER_BRIDGE_MISSING_ERROR))
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockRejectedValue(new Error("Native messaging host registration failed"));
    vi.spyOn(StellaBrowserBridgeService.prototype, "stop").mockResolvedValue();

    const statuses: StellaBrowserBridgeStatus[] = [];
    const pendingRetries: Array<() => void> = [];
    const resource = createResource(
      (status) => {
        statuses.push(status);
      },
      {
        isShuttingDown: () => false,
        setManagedTimeout: (callback) => {
          pendingRetries.push(callback);
          return () => undefined;
        },
      },
    );

    resource.start();
    await waitForStatus(
      statuses,
      (status) =>
        status.state === "reconnecting" && status.reason === "bridge_missing",
    );

    expect(statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "connecting",
          attempt: 0,
        }),
        expect.objectContaining({
          state: "host_registration_failed",
          reason: "bridge_missing",
          error: BROWSER_BRIDGE_MISSING_ERROR,
          notifyUser: false,
        }),
        expect.objectContaining({
          state: "reconnecting",
          attempt: 1,
          reason: "bridge_missing",
          error: BROWSER_BRIDGE_MISSING_ERROR,
          notifyUser: false,
        }),
      ]),
    );

    pendingRetries.shift()?.();
    await waitForStatus(
      statuses,
      (status) =>
        status.reason === "transient_failure" ||
        status.reason === "connection_lost",
    );
    pendingRetries.shift()?.();
    await waitForStatus(
      statuses,
      (status) => status.reason === "authorization_failed",
    );
    pendingRetries.shift()?.();
    await waitForStatus(
      statuses,
      (status) =>
        status.state === "host_registration_failed" &&
        status.error?.includes("Native messaging host registration"),
    );
    pendingRetries.shift()?.();
    await flush();

    expect(statuses.filter((status) => status.notifyUser).length).toBe(0);
    expect(
      statuses.some(
        (status) =>
          status.reason === "transient_failure" && status.notifyUser === false,
      ),
    ).toBe(true);
    expect(
      statuses.some(
        (status) =>
          status.reason === "authorization_failed" &&
          status.notifyUser === false,
      ),
    ).toBe(true);
    expect(
      statuses.some(
        (status) =>
          status.state === "host_registration_failed" &&
          status.notifyUser === false,
      ),
    ).toBe(true);
    expect(resource.getStatus().notifyUser).toBe(false);

    await resource.stop();
  });
});
