import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  connectPreregisteredConnectorOAuth: vi.fn(),
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
  saveConnectorAccessToken: vi.fn(),
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
