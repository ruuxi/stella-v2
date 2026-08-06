import { describe, expect, it, vi } from "vitest";
import { StellaBrowserBridgeService } from "@stella/desktop/electron/services/stella-browser-bridge-service.js";

type SendCommand = (
  command: Record<string, unknown>,
) => Promise<{ success?: boolean; error?: string; data?: unknown }>;

const createService = () =>
  new StellaBrowserBridgeService({ stellaAppDir: "/tmp/stella-test" });

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

  it("rejects an empty CDP endpoint before issuing a command", async () => {
    const service = createService();
    const sendCommand = mockSendCommand(service, { success: true });

    await expect(service.connectCdp("  ")).rejects.toThrow(
      "A CDP URL is required.",
    );
    expect(sendCommand).not.toHaveBeenCalled();
  });
});
