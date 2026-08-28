import { describe, expect, test } from "bun:test";
import {
  isCloudBrowserLiveViewNavigationAllowed,
  parseCloudBrowserLiveViewUrl,
} from "../cloud-browser-live-view";

describe("mobile cloud browser Live View URL boundary", () => {
  test("allows the exact HTTPS Live View origin and rejects lookalikes", () => {
    expect(
      parseCloudBrowserLiveViewUrl(
        "https://live.browser.run/session/opaque?capability=opaque",
      )?.origin,
    ).toBe("https://live.browser.run");
    expect(isCloudBrowserLiveViewNavigationAllowed("about:blank")).toBe(true);

    for (const value of [
      "http://live.browser.run/session/opaque",
      "https://live.browser.run.evil.example/session/opaque",
      "https://user:password@live.browser.run/session/opaque",
      "https://live.browser.run:444/session/opaque",
      "data:text/html,unsafe",
    ]) {
      expect(parseCloudBrowserLiveViewUrl(value)).toBeNull();
      expect(isCloudBrowserLiveViewNavigationAllowed(value)).toBe(false);
    }
  });
});
