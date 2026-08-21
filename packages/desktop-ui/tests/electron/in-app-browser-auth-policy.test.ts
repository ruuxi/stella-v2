import { describe, expect, it } from "vitest";
import { buildInAppBrowserUserAgent } from "@stella/desktop/electron/services/in-app-browser-auth-policy.js";

describe("buildInAppBrowserUserAgent", () => {
  it("removes Stella and Electron tokens while keeping the runtime Chromium major", () => {
    expect(
      buildInAppBrowserUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) Stella/0.1.65 " +
          "Chrome/150.0.7871.224 Electron/43.4.1 Safari/537.36",
      ),
    ).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/150.0.0.0 Safari/537.36",
    );
  });

  it("builds a reduced fallback UA from the embedded Chromium version", () => {
    expect(buildInAppBrowserUserAgent(undefined, "151.0.7922.0", "win32")).toBe(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/151.0.0.0 Safari/537.36",
    );
  });
});
