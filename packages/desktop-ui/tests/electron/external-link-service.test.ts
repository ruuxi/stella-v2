import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { ExternalLinkService } from "@stella/desktop/electron/services/external-link-service";
import { resolveRendererRoot } from "@stella/desktop/electron/renderer-location";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");

describe("ExternalLinkService renderer trust", () => {
  it("trusts only the configured Stella dev origin for shell renderer URLs", () => {
    const service = new ExternalLinkService();
    service.trustDevServerBaseUrl("http://localhost:57314/");

    expect(service.isAppUrl("http://localhost:57314/index.html")).toBe(true);
    expect(
      service.isTrustedRendererUrl("http://localhost:57314/index.html"),
    ).toBe(true);

    expect(service.isAppUrl("http://localhost:3000")).toBe(false);
    expect(service.isTrustedRendererUrl("http://localhost:3000")).toBe(false);
    expect(service.isAppUrl("http://127.0.0.1:57314/index.html")).toBe(false);
    expect(
      service.isTrustedRendererUrl("http://127.0.0.1:57314/index.html"),
    ).toBe(false);
    expect(service.isAppUrl("file:///tmp/stella.html")).toBe(false);
    expect(service.isTrustedRendererUrl("file:///tmp/stella.html")).toBe(false);
  });

  it("supports the exact internal mobile bridge sender without trusting the whole protocol", () => {
    const service = new ExternalLinkService();

    expect(service.isTrustedRendererUrl("stella-mobile-bridge://mobile")).toBe(
      true,
    );
    expect(
      service.isTrustedRendererUrl("stella-mobile-bridge://localhost"),
    ).toBe(false);
    expect(
      service.isTrustedRendererUrl("stella-mobile-bridge://mobile/extra"),
    ).toBe(false);
  });

  it("allows about:blank navigation without granting privileged renderer trust", () => {
    const service = new ExternalLinkService();

    expect(service.isAppUrl("about:blank")).toBe(true);
    expect(service.isTrustedRendererUrl("about:blank")).toBe(false);
  });

  it("trusts the resolved packaged renderer root without trusting sibling files", () => {
    const tempRoot = mkdtempSync(
      path.join(os.tmpdir(), "stella-renderer-trust-"),
    );
    try {
      const resourcesRoot = path.join(
        tempRoot,
        "Stella.app",
        "Contents",
        "Resources",
      );
      const electronDir = path.join(
        resourcesRoot,
        "app.asar",
        "dist-electron",
        "electron",
      );
      const rendererRoot = path.join(resourcesRoot, "app.asar", "renderer");
      mkdirSync(electronDir, { recursive: true });
      mkdirSync(rendererRoot, { recursive: true });

      const resolvedRoot = resolveRendererRoot(electronDir);
      expect(resolvedRoot).toBe(rendererRoot);

      const service = new ExternalLinkService();
      service.trustFileRendererRoot(resolvedRoot);

      const entryUrl = pathToFileURL(path.join(rendererRoot, "index.html"));
      entryUrl.searchParams.set("window", "full");
      expect(service.isTrustedRendererUrl(entryUrl.toString())).toBe(true);
      expect(
        service.isTrustedRendererUrl(
          pathToFileURL(path.join(rendererRoot, "assets", "app.js")).toString(),
        ),
      ).toBe(true);
      expect(
        service.isTrustedRendererUrl(
          pathToFileURL(
            path.join(resourcesRoot, "dist", "index.html"),
          ).toString(),
        ),
      ).toBe(false);
      expect(
        service.isTrustedRendererUrl(
          pathToFileURL(path.join(resourcesRoot, "outside.html")).toString(),
        ),
      ).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("configures packaged bootstrap trust from the shared renderer resolver", () => {
    const bootstrapServices = readFileSync(
      path.join(
        repoRoot,
        "packages/desktop/electron/bootstrap/bootstrap-services.js",
      ),
      "utf8",
    );
    expect(bootstrapServices).toContain(
      'import { resolveRendererRoot } from "../renderer-location.js";',
    );
    expect(bootstrapServices).toContain(
      "trustFileRendererRoot(resolveRendererRoot(config.electronDir))",
    );
    expect(bootstrapServices).not.toContain(
      'trustFileRendererRoot(path.resolve(config.electronDir, "../../../dist"))',
    );
  });
});
