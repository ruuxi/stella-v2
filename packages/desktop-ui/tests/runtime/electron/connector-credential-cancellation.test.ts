import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  connectPreregisteredConnectorOAuth: vi.fn(),
  saveConnectorAccessToken: vi.fn(),
}));

const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send: mocks.send },
};

vi.mock("electron", () => ({
  BrowserWindow: {
    getFocusedWindow: () => fakeWindow,
    getAllWindows: () => [fakeWindow],
  },
  shell: { openExternal: vi.fn() },
}));

vi.mock("@stella/runtime/kernel/connectors/oauth", () => ({
  beginConnectorDeviceOAuth: vi.fn(),
  completeConnectorDeviceOAuth: vi.fn(),
  connectConnectorOAuth: vi.fn(),
  connectPreregisteredConnectorOAuth: mocks.connectPreregisteredConnectorOAuth,
  saveConnectorAccessToken: mocks.saveConnectorAccessToken,
}));

const { ConnectorCredentialService } = await import(
  "@stella/desktop/electron/services/connector-credential-service.js"
);

const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition not reached");
};

beforeEach(() => {
  mocks.send.mockReset();
  mocks.connectPreregisteredConnectorOAuth.mockReset();
  mocks.saveConnectorAccessToken.mockReset();
  mocks.connectPreregisteredConnectorOAuth.mockImplementation(
    async (_root, options: { signal: AbortSignal }) =>
      await new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(options.signal.reason),
          { once: true },
        );
      }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ConnectorCredentialService OAuth cancellation", () => {
  it("aborts the active provider flow, settles the request, and notifies the UI", async () => {
    const service = new ConnectorCredentialService({
      getStellaAppDir: () => "/tmp/stella-test",
      windowManagerTarget: { getWindowManager: () => null },
    });
    const authorization = service.requestPreregisteredOAuth({
      tokenKey: "google-workspace",
      displayName: "Google Workspace",
      clientId: "client-id-sentinel",
      authorizationEndpoint: "https://accounts.example.test/oauth",
    });
    await waitFor(() => mocks.send.mock.calls.length > 0);
    const request = mocks.send.mock.calls.find(
      ([channel]) => channel === "connector-credential:request",
    )?.[1] as { requestId: string };
    expect(request.requestId).toBeTruthy();
    expect(JSON.stringify(request)).not.toContain("client-id-sentinel");
    expect(JSON.stringify(request)).not.toContain("accounts.example.test");

    await service.submitCredential({
      requestId: request.requestId,
      value: "open",
    });
    await waitFor(() =>
      mocks.connectPreregisteredConnectorOAuth.mock.calls.length > 0,
    );
    const signal = mocks.connectPreregisteredConnectorOAuth.mock.calls[0]?.[1]
      .signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    expect(service.cancelCredential({ requestId: request.requestId })).toEqual({
      ok: true,
    });
    expect(signal.aborted).toBe(true);
    await expect(authorization).resolves.toEqual({
      ok: false,
      reason: "cancelled",
    });
    expect(mocks.send).toHaveBeenCalledWith(
      "connector-credential:complete",
      {
        requestId: request.requestId,
        ok: false,
        reason: "cancelled",
      },
    );
  });
});

describe("ConnectorCredentialService backend API-key custody", () => {
  it("submits the protected value directly to the authenticated vault and never local storage", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ connected: true, generation: 4 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const service = new ConnectorCredentialService({
      getStellaAppDir: () => "/tmp/stella-test",
      getConvexSiteUrl: () => "https://backend.stella.test/",
      getConvexAuthToken: async () => "session-token-sentinel",
      windowManagerTarget: { getWindowManager: () => null },
    });
    const connected = service.requestBackendApiKey({
      connectorId: "firecrawl",
      displayName: "Firecrawl",
      credentialLabel: "Firecrawl API key",
      expectedGeneration: 3,
    });
    await waitFor(() => mocks.send.mock.calls.length > 0);
    const request = mocks.send.mock.calls.find(
      ([channel]) => channel === "connector-credential:request",
    )?.[1] as { requestId: string };
    expect(JSON.stringify(request)).not.toContain("session-token-sentinel");

    const submitted = await service.submitCredential({
      requestId: request.requestId,
      value: "firecrawl-key-sentinel",
    });

    expect(submitted).toEqual({ ok: true });
    await expect(connected).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://backend.stella.test/api/native-integrations/api-key",
    );
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer session-token-sentinel",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      id: "firecrawl",
      apiKey: "firecrawl-key-sentinel",
      expectedGeneration: 3,
    });
    expect(mocks.saveConnectorAccessToken).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.send.mock.calls)).not.toContain(
      "firecrawl-key-sentinel",
    );
  });

  it("keeps a failed submission pending for an explicit user retry", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "stale-key-sentinel" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ connected: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const service = new ConnectorCredentialService({
      getStellaAppDir: () => "/tmp/stella-test",
      getConvexSiteUrl: () => "https://backend.stella.test",
      getConvexAuthToken: async () => "session-token-sentinel",
      windowManagerTarget: { getWindowManager: () => null },
    });
    const connected = service.requestBackendApiKey({
      connectorId: "firecrawl",
      displayName: "Firecrawl",
      credentialLabel: "Firecrawl API key",
      expectedGeneration: 2,
    });
    await waitFor(() => mocks.send.mock.calls.length > 0);
    const request = mocks.send.mock.calls.find(
      ([channel]) => channel === "connector-credential:request",
    )?.[1] as { requestId: string };

    await expect(
      service.submitCredential({
        requestId: request.requestId,
        value: "stale-key-sentinel",
      }),
    ).resolves.toEqual({
      ok: false,
      error:
        "The stored credential changed. Reopen the connection prompt before retrying.",
    });
    await expect(
      service.submitCredential({
        requestId: request.requestId,
        value: "fresh-key-sentinel",
      }),
    ).resolves.toEqual({ ok: true });
    await expect(connected).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.saveConnectorAccessToken).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.send.mock.calls)).not.toContain(
      "stale-key-sentinel",
    );
  });
});
