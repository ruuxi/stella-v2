import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BUNDLED_BIN = "/bundled/asar/dist-electron/bin/cloudflared";

const install = vi.fn(async (to: string) => {
  fs.writeFileSync(to, "#!/bin/sh\n");
  return to;
});

vi.mock("cloudflared", () => ({
  bin: BUNDLED_BIN,
  install: (to: string) => install(to),
}));

const { CloudflareTunnelService } = await import(
  "@stella/desktop/electron/services/mobile-bridge/tunnel-service.js"
);

const createService = (getCloudflaredBinDir?: () => string | null) =>
  new CloudflareTunnelService({
    getAuthToken: async () => "desktop-token",
    getConvexSiteUrl: () => "https://example.convex.site",
    getDeviceId: () => "desktop-device",
    ...(getCloudflaredBinDir ? { getCloudflaredBinDir } : {}),
    onTunnelUrl: vi.fn(),
  }) as any;

describe("CloudflareTunnelService binary resolution", () => {
  let binDir: string;

  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "stella-cloudflared-"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    fs.rmSync(binDir, { recursive: true, force: true });
    install.mockClear();
    vi.restoreAllMocks();
  });

  it("installs into the configured app-data directory rather than the packaged default", async () => {

    const target = path.join(binDir, "nested");
    const service = createService(() => target);

    const resolved = await service.ensureCloudflaredBinary();

    expect(resolved).toBe(
      path.join(
        target,
        process.platform === "win32" ? "cloudflared.exe" : "cloudflared",
      ),
    );
    expect(install).toHaveBeenCalledWith(resolved);
    expect(fs.existsSync(resolved)).toBe(true);
  });

  it("reuses an already-installed binary without downloading again", async () => {
    const service = createService(() => binDir);
    const existing = path.join(
      binDir,
      process.platform === "win32" ? "cloudflared.exe" : "cloudflared",
    );
    fs.writeFileSync(existing, "#!/bin/sh\n");

    const resolved = await service.ensureCloudflaredBinary();

    expect(resolved).toBe(existing);
    expect(install).not.toHaveBeenCalled();
  });

  it("falls back to the package default when no directory is configured", async () => {
    const service = createService();
    vi.spyOn(fs, "existsSync").mockReturnValue(true);

    await expect(service.ensureCloudflaredBinary()).resolves.toBe(BUNDLED_BIN);
    expect(install).not.toHaveBeenCalled();
  });
});
