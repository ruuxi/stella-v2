import { describe, expect, it } from "vitest";

import { ExternalLinkService } from "@stella/desktop/electron/services/external-link-service";


describe("ExternalLinkService renderer trust", () => {
  it("trusts only the renderer's source origin for shell renderer URLs", () => {
    const service = new ExternalLinkService();
    service.trustRendererOrigin("stella-app://desktop");

    expect(service.isAppUrl("stella-app://desktop/index.html")).toBe(true);
    expect(
      service.isTrustedRendererUrl("stella-app://desktop/overlay.html?window=overlay"),
    ).toBe(true);

    expect(service.isTrustedRendererUrl("stella-app://other/index.html")).toBe(false);
    expect(service.isAppUrl("http://localhost:57314/index.html")).toBe(false);
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
});
