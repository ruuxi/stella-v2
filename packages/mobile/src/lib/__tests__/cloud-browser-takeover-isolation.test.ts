import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../components/CloudBrowserTakeoverModal.tsx",
  ),
  "utf8",
);

describe("mobile cloud browser takeover isolation", () => {
  test("keeps the Live View in a fresh, non-shared WebView", () => {
    expect(source).toContain("incognito");
    expect(source).toContain("cacheEnabled={false}");
    expect(source).toContain("sharedCookiesEnabled={false}");
    expect(source).toContain("thirdPartyCookiesEnabled={false}");
    expect(source).toContain('originWhitelist={["https://live.browser.run"]}');
    expect(source).toContain("isCloudBrowserLiveViewNavigationAllowed");
  });

  test("provides no WebView credential bridge or caller-supplied headers", () => {
    expect(source).not.toContain("injectedJavaScript");
    expect(source).not.toMatch(/\bonMessage\s*=/);
    expect(source).not.toMatch(/\bheaders\s*:/);
  });

  test("captures locally without giving the page a credential bridge", () => {
    expect(source).toContain("captureAndEncryptCloudBrowserSession");
    expect(source).toContain("mintSessionTransfer");
    expect(source).toContain("importSessionTransfer");
    expect(source).toContain("localNavigationAllowed");
    expect(source).toContain("source={{ uri: detail.loginUrl }}");
    expect(source).not.toContain("document.cookie");
  });

  test("keeps Done, Cancel, and the remote fallback user-controlled", () => {
    expect(source).toContain('onDecision("cancel")');
    expect(source).toContain('onDecision("done")');
    expect(source).toContain('setMode("remote")');
    expect(source).toContain("cloudBrowser.actions.useCloudBrowser");
    expect(source).not.toContain("onNavigationStateChange");
  });

  test("shows the gateway-verified origin even when a deceptive title exists", () => {
    expect(source).toContain("const title = detail.displayOrigin");
    expect(source).not.toContain(
      "detail.displayTitle?.trim() || detail.displayOrigin",
    );
  });
});
