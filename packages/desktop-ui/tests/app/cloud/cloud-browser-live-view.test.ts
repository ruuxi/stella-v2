import { describe, expect, test } from "vitest";
import {
  isCloudBrowserLiveViewNavigationAllowed,
  parseCloudBrowserLiveViewUrl,
} from "@/features/cloud/cloud-browser-live-view";

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
});
