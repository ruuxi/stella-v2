import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isCloudBrowserLiveViewNavigationAllowed,
  parseCloudBrowserLiveViewUrl,
} from "@/features/cloud/cloud-browser-live-view";

const takeoverSource = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../src/shell/sidebar-sections/CloudBrowserTakeoverSection.tsx",
  ),
  "utf8",
);

const interventionSource = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../src/features/cloud/CloudBrowserInterventionCard.tsx",
  ),
  "utf8",
);

describe("cloud browser Live View URL boundary", () => {
  test("accepts only HTTPS URLs on the exact Cloudflare Live View origin", () => {
    expect(
      parseCloudBrowserLiveViewUrl(
        "https://live.browser.run/session/opaque?capability=opaque",
      )?.hostname,
    ).toBe("live.browser.run");
    expect(isCloudBrowserLiveViewNavigationAllowed("about:blank")).toBe(true);

    for (const value of [
      "http://live.browser.run/session/opaque",
      "https://live.browser.run.evil.example/session/opaque",
      "https://evil.example/?next=https://live.browser.run",
      "https://user:password@live.browser.run/session/opaque",
      "https://live.browser.run:444/session/opaque",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(parseCloudBrowserLiveViewUrl(value)).toBeNull();
      expect(isCloudBrowserLiveViewNavigationAllowed(value)).toBe(false);
    }
  });

  test("keeps the capability in an ephemeral, no-referrer frame", () => {
    expect(takeoverSource).toContain('referrerPolicy="no-referrer"');
    expect(takeoverSource).toContain(
      'sandbox="allow-forms allow-same-origin allow-scripts"',
    );
    expect(takeoverSource).toContain("active && panelOpen");
    expect(takeoverSource).toContain("panelOpen && !busyDecision");
    expect(takeoverSource).not.toContain("clipboard-read");
    expect(takeoverSource).not.toContain("localStorage");
    expect(takeoverSource).not.toContain("sessionStorage");
  });

  test("always shows the gateway-verified origin instead of a supplied title", () => {
    expect(takeoverSource).toContain("{detail.displayOrigin}");
    expect(takeoverSource).not.toContain(
      "detail.displayTitle?.trim() || detail.displayOrigin",
    );
    expect(interventionSource).toContain("interaction.displayOrigin;");
    expect(interventionSource).not.toContain(
      "interaction.displayTitle?.trim() || interaction.displayOrigin",
    );
  });
});
