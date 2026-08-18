import { describe, expect, it, vi } from "vitest";
import { StellaBrowserBridgeService } from "@stella/desktop/electron/services/stella-browser-bridge-service.js";

type SendCommand = (
  command: Record<string, unknown>,
) => Promise<{ success?: boolean; error?: string; data?: unknown }>;

const createService = () => {
  const service = new StellaBrowserBridgeService({
    stellaAppDir: "/tmp/stella-test",
  });
  vi.spyOn(service, "start").mockResolvedValue();
  return service;
};

const mockSendCommand = (
  service: StellaBrowserBridgeService,
  response: Awaited<ReturnType<SendCommand>>,
) =>
  vi
    .spyOn(service as unknown as { sendCommand: SendCommand }, "sendCommand")
    .mockResolvedValue(response);

describe("StellaBrowserBridgeService browser bootstrap API", () => {
  it("reads extension connection state through a daemon-local command", async () => {
    const service = createService();
    const sendCommand = mockSendCommand(service, {
      success: true,
      data: { connected: true },
    });

    await expect(service.getExtensionStatus()).resolves.toBe(true);
    expect(sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ action: "extension_status" }),
    );
  });

  it("exports the complete cookie payload without reshaping it", async () => {
    const service = createService();
    const cookies = [
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
        expirationDate: 2_000_000_000,
        partitionKey: {
          topLevelSite: "https://example.com",
          hasCrossSiteAncestor: false,
        },
      },
    ];
    const sendCommand = mockSendCommand(service, {
      success: true,
      data: { cookies },
    });

    await expect(service.exportAllCookies()).resolves.toBe(cookies);
    expect(sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cookies_export_all" }),
    );
  });

  it("rejects malformed cookie export responses", async () => {
    const service = createService();
    mockSendCommand(service, { success: true, data: {} });

    await expect(service.exportAllCookies()).rejects.toThrow(
      "Browser extension returned an invalid cookie export.",
    );
  });

  it("requests URL-scoped cookies for older extension compatibility", async () => {
    const service = createService();
    const cookies = [{ name: "legacy", domain: "example.com", path: "/" }];
    const sendCommand = mockSendCommand(service, {
      success: true,
      data: { cookies },
    });

    await expect(
      service.exportCookiesForUrls(["https://example.com/app"]),
    ).resolves.toBe(cookies);
    expect(sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "cookies_export_for_urls",
        urls: ["https://example.com/app"],
      }),
    );
  });

  it("switches the daemon to the supplied in-app CDP endpoint", async () => {
    const service = createService();
    const sendCommand = mockSendCommand(service, {
      success: true,
      data: { launched: true },
    });

    await service.connectCdp("ws://127.0.0.1:9222/devtools/browser/test");

    expect(sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "launch",
        cdpUrl: "ws://127.0.0.1:9222/devtools/browser/test",
      }),
    );
  });

  it("keeps a successful CDP route sticky across browser sessions", async () => {
    const service = createService();
    const sendCommand = mockSendCommand(service, {
      success: true,
      data: { launched: true },
    });
    const cdpUrl = "ws://127.0.0.1:9222/devtools/browser/test";

    await Promise.all([service.connectCdp(cdpUrl), service.connectCdp(cdpUrl)]);
    await service.connectCdp(cdpUrl);

    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it("retries a CDP route after a failed launch", async () => {
    const service = createService();
    const sendCommand = vi
      .spyOn(service as unknown as { sendCommand: SendCommand }, "sendCommand")
      .mockRejectedValueOnce(new Error("launch failed"))
      .mockResolvedValueOnce({ success: true, data: { launched: true } });
    const cdpUrl = "ws://127.0.0.1:9222/devtools/browser/retry";

    await expect(service.connectCdp(cdpUrl)).rejects.toThrow("launch failed");
    await expect(service.connectCdp(cdpUrl)).resolves.toBeUndefined();

    expect(sendCommand).toHaveBeenCalledTimes(2);
  });

  it("invalidates the sticky CDP route when the daemon stops", async () => {
    const service = createService();
    const sendCommand = mockSendCommand(service, {
      success: true,
      data: { launched: true },
    });
    vi.spyOn(
      service as unknown as { killDaemonProcess: () => Promise<void> },
      "killDaemonProcess",
    ).mockResolvedValue();
    vi.spyOn(
      service as unknown as {
        stopOrphanedBundledDaemons: () => Promise<void>;
      },
      "stopOrphanedBundledDaemons",
    ).mockResolvedValue();
    const cdpUrl = "ws://127.0.0.1:9222/devtools/browser/restart";

    await service.connectCdp(cdpUrl);
    await service.stop();
    await service.connectCdp(cdpUrl);

    expect(
      sendCommand.mock.calls.filter(([command]) => command.action === "launch"),
    ).toHaveLength(2);
  });

  it("rejects an empty CDP endpoint before issuing a command", async () => {
    const service = createService();
    const sendCommand = mockSendCommand(service, { success: true });

    await expect(service.connectCdp("  ")).rejects.toThrow(
      "A CDP URL is required.",
    );
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("single-flights an exact agent capability into its own backend session", async () => {
    const service = createService();
    const capability = {
      ownerId: "agent-thread-1",
      turnId: "turn-1",
      ownerLeaseId: "lease-1",
      ownerLeaseIssuedAt: 1_000,
    };
    const process = { exitCode: null, killed: false };
    const spawnAgentBackend = vi
      .spyOn(
        service as unknown as {
          spawnAgentBackend: (
            input: Record<string, unknown>,
          ) => Promise<unknown>;
        },
        "spawnAgentBackend",
      )
      .mockImplementation(async (input) => ({
        ...input,
        bridgeSessionId: "agent-random-session",
        capabilityExpiresAt: Date.now() + 60_000,
        controlToken: "control-token",
        process,
      }));

    const [first, second] = await Promise.all([
      service.connectAgentCdp(capability, "ws://127.0.0.1:9000/owner-cap"),
      service.connectAgentCdp(capability, "ws://127.0.0.1:9000/owner-cap"),
    ]);
    await service.connectAgentCdp(capability, "ws://127.0.0.1:9000/owner-cap");

    expect(first).toEqual(second);
    expect(first.bridgeSessionId).toBe("agent-random-session");
    expect(spawnAgentBackend).toHaveBeenCalledOnce();
    expect(spawnAgentBackend).toHaveBeenCalledWith({
      ...capability,
      cdpUrl: "ws://127.0.0.1:9000/owner-cap",
    });
  });

  it("replaces a wedged backend when the same lease requests recovery", async () => {
    const service = createService();
    const capability = {
      ownerId: "agent-thread-1",
      turnId: "turn-1",
      ownerLeaseId: "lease-1",
      ownerLeaseIssuedAt: 1_000,
    };
    const spawnAgentBackend = vi
      .spyOn(
        service as unknown as {
          spawnAgentBackend: (
            input: Record<string, unknown>,
          ) => Promise<unknown>;
        },
        "spawnAgentBackend",
      )
      .mockImplementationOnce(async (input) => ({
        ...input,
        bridgeSessionId: "agent-wedged-session",
        capabilityExpiresAt: Date.now() + 60_000,
        controlToken: "old-control-token",
        process: { exitCode: null, killed: false },
      }))
      .mockImplementationOnce(async (input) => ({
        ...input,
        bridgeSessionId: "agent-recovered-session",
        capabilityExpiresAt: Date.now() + 60_000,
        controlToken: "new-control-token",
        process: { exitCode: null, killed: false },
      }));
    const stopAgentBackend = vi
      .spyOn(
        service as unknown as {
          stopAgentBackend: (backend: unknown) => Promise<void>;
        },
        "stopAgentBackend",
      )
      .mockResolvedValue();

    await expect(
      service.connectAgentCdp(capability, "ws://127.0.0.1:9000/owner-cap"),
    ).resolves.toMatchObject({ bridgeSessionId: "agent-wedged-session" });
    await expect(
      service.connectAgentCdp(
        { ...capability, recover: true },
        "ws://127.0.0.1:9000/owner-cap",
      ),
    ).resolves.toMatchObject({ bridgeSessionId: "agent-recovered-session" });

    expect(stopAgentBackend).toHaveBeenCalledOnce();
    expect(spawnAgentBackend).toHaveBeenCalledTimes(2);
  });

  it("rejects an older lease from replacing an active agent backend", async () => {
    const service = createService();
    const process = { exitCode: null, killed: false };
    vi.spyOn(
      service as unknown as {
        spawnAgentBackend: (input: Record<string, unknown>) => Promise<unknown>;
      },
      "spawnAgentBackend",
    ).mockImplementation(async (input) => ({
      ...input,
      bridgeSessionId: "agent-random-session",
      capabilityExpiresAt: Date.now() + 60_000,
      controlToken: "control-token",
      process,
    }));
    const current = {
      ownerId: "agent-thread-1",
      turnId: "turn-2",
      ownerLeaseId: "lease-2",
      ownerLeaseIssuedAt: 2_000,
    };
    await service.connectAgentCdp(current, "ws://127.0.0.1:9000/current");

    await expect(
      service.connectAgentCdp(
        {
          ...current,
          turnId: "turn-old",
          ownerLeaseId: "lease-old",
          ownerLeaseIssuedAt: 1_000,
        },
        "ws://127.0.0.1:9000/stale",
      ),
    ).rejects.toThrow("newer browser session already owns");
  });

  it("keeps the owner lease high-water after an agent backend exits", async () => {
    const service = createService();
    const process = { exitCode: null, killed: false };
    vi.spyOn(
      service as unknown as {
        spawnAgentBackend: (input: Record<string, unknown>) => Promise<unknown>;
      },
      "spawnAgentBackend",
    ).mockImplementation(async (input) => ({
      ...input,
      bridgeSessionId: "agent-random-session",
      capabilityExpiresAt: Date.now() + 60_000,
      controlToken: "control-token",
      process,
    }));
    const current = {
      ownerId: "agent-thread-1",
      turnId: "turn-2",
      ownerLeaseId: "lease-2",
      ownerLeaseIssuedAt: 2_000,
    };
    await service.connectAgentCdp(current, "ws://127.0.0.1:9000/current");

    // Agent daemon exit/error handlers remove only the process record. The
    // durable lease high-water must continue fencing stale workers.
    (
      service as unknown as {
        agentBackends: Map<string, unknown>;
      }
    ).agentBackends.clear();

    await expect(
      service.connectAgentCdp(
        {
          ...current,
          turnId: "turn-old",
          ownerLeaseId: "lease-old",
          ownerLeaseIssuedAt: 1_000,
        },
        "ws://127.0.0.1:9000/stale",
      ),
    ).rejects.toThrow("newer browser session already owns");
    await expect(
      service.connectAgentCdp(
        {
          ...current,
          turnId: "turn-same-ms-newer",
          ownerLeaseId: "lease-3",
        },
        "ws://127.0.0.1:9000/same-ms-newer",
      ),
    ).resolves.toMatchObject({ bridgeSessionId: "agent-random-session" });
    await expect(
      service.connectAgentCdp(
        {
          ...current,
          turnId: "turn-same-ms-stale",
          ownerLeaseId: "lease-1",
        },
        "ws://127.0.0.1:9000/same-ms-stale",
      ),
    ).rejects.toThrow("newer browser session already owns");
    await expect(
      service.connectAgentCdp(
        {
          ...current,
          turnId: "turn-conflict",
          ownerLeaseId: "lease-3",
        },
        "ws://127.0.0.1:9000/conflict",
      ),
    ).rejects.toThrow("conflicting browser lease");
  });

  it("does not publish a backend superseded while it was spawning", async () => {
    const service = createService();
    let releaseFirst!: (backend: unknown) => void;
    const spawnAgentBackend = vi
      .spyOn(
        service as unknown as {
          spawnAgentBackend: (
            input: Record<string, unknown>,
          ) => Promise<unknown>;
        },
        "spawnAgentBackend",
      )
      .mockImplementationOnce(
        (input) =>
          new Promise((resolve) => {
            releaseFirst = (backend) => resolve({ ...input, ...backend });
          }),
      )
      .mockImplementationOnce(async (input) => ({
        ...input,
        bridgeSessionId: "agent-new-session",
        capabilityExpiresAt: Date.now() + 60_000,
        controlToken: "new-control-token",
        process: { exitCode: null, killed: false },
      }));
    const stopAgentBackend = vi
      .spyOn(
        service as unknown as {
          stopAgentBackend: (backend: unknown) => Promise<void>;
        },
        "stopAgentBackend",
      )
      .mockResolvedValue();
    const first = service.connectAgentCdp(
      {
        ownerId: "agent-thread-1",
        turnId: "turn-1",
        ownerLeaseId: "lease-1",
        ownerLeaseIssuedAt: 1_000,
      },
      "ws://127.0.0.1:9000/first",
    );
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf("function"));
    const second = service.connectAgentCdp(
      {
        ownerId: "agent-thread-1",
        turnId: "turn-2",
        ownerLeaseId: "lease-2",
        ownerLeaseIssuedAt: 1_000,
      },
      "ws://127.0.0.1:9000/second",
    );
    releaseFirst({
      bridgeSessionId: "agent-old-session",
      capabilityExpiresAt: Date.now() + 60_000,
      controlToken: "old-control-token",
      process: { exitCode: null, killed: false },
    });

    await expect(first).rejects.toThrow("superseded");
    await expect(second).resolves.toMatchObject({
      bridgeSessionId: "agent-new-session",
    });
    expect(spawnAgentBackend).toHaveBeenCalledTimes(2);
    expect(stopAgentBackend).toHaveBeenCalledOnce();
  });

  it("invalidates an in-flight agent backend when the service stops", async () => {
    const service = createService();
    let releaseSpawn!: (backend: unknown) => void;
    vi.spyOn(
      service as unknown as {
        spawnAgentBackend: (input: Record<string, unknown>) => Promise<unknown>;
      },
      "spawnAgentBackend",
    ).mockImplementation(
      (input) =>
        new Promise((resolve) => {
          releaseSpawn = (backend) => resolve({ ...input, ...backend });
        }),
    );
    const stopAgentBackend = vi
      .spyOn(
        service as unknown as {
          stopAgentBackend: (backend: unknown) => Promise<void>;
        },
        "stopAgentBackend",
      )
      .mockResolvedValue();
    mockSendCommand(service, { success: true });
    vi.spyOn(
      service as unknown as { killDaemonProcess: () => Promise<void> },
      "killDaemonProcess",
    ).mockResolvedValue();
    vi.spyOn(
      service as unknown as {
        stopOrphanedBundledDaemons: () => Promise<void>;
      },
      "stopOrphanedBundledDaemons",
    ).mockResolvedValue();

    const connecting = service.connectAgentCdp(
      {
        ownerId: "agent-thread-1",
        turnId: "turn-1",
        ownerLeaseId: "lease-1",
        ownerLeaseIssuedAt: 1_000,
      },
      "ws://127.0.0.1:9000/owner-cap",
    );
    await vi.waitFor(() => expect(releaseSpawn).toBeTypeOf("function"));
    const stopping = service.stop();
    releaseSpawn({
      bridgeSessionId: "agent-stale-session",
      capabilityExpiresAt: Date.now() + 60_000,
      controlToken: "control-token",
      process: { exitCode: null, killed: false },
    });

    await expect(connecting).rejects.toThrow(
      "restarted during agent initialization",
    );
    await expect(stopping).resolves.toBeUndefined();
    expect(stopAgentBackend).toHaveBeenCalledOnce();
  });
});
