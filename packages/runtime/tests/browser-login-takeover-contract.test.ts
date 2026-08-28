import { describe, expect, it, vi } from "vitest";

import { installBrowserWorkerApi } from "../kernel/browser-use/worker-api.js";

const ORIGIN = "https://www.demoblaze.com";
const LOGIN_URL = `${ORIGIN}/index.html`;

const takeover = () => ({
  allowedOrigins: [ORIGIN],
  displayOrigin: ORIGIN,
  startUrl: LOGIN_URL,
  verification: {
    expectedOrigin: ORIGIN,
    authenticatedSelector: "#nameofuser",
    loggedOutSelector: "#login2",
    resumeUrl: LOGIN_URL,
  },
});

describe("cloud browser login takeover contract", () => {
  it("emits the exact same-origin Demoblaze verification shape", async () => {
    const callBrowser = vi.fn(async () => ({ success: true, data: {} }));
    const browser = installBrowserWorkerApi(callBrowser);

    await browser.requestLoginTakeover(takeover());

    expect(callBrowser).toHaveBeenCalledWith("command", [
      "cloud_login_takeover",
      {
        ...takeover(),
        __stellaBrowserBackend: "in-app",
      },
    ]);
  });

  it("requires every verification field and the narrow selector grammar", async () => {
    const callBrowser = vi.fn(async () => ({ success: true, data: {} }));
    const browser = installBrowserWorkerApi(callBrowser);
    const missingLoggedOut = takeover();
    delete (missingLoggedOut.verification as { loggedOutSelector?: string })
      .loggedOutSelector;

    await expect(
      browser.requestLoginTakeover(missingLoggedOut as never),
    ).rejects.toThrow("loggedOutSelector must be a non-empty string");
    for (const selector of [
      "[data-authenticated]",
      "input",
      "#user input",
      '.user[data-secret="one"]',
      "#user:visible",
    ]) {
      await expect(
        browser.requestLoginTakeover({
          ...takeover(),
          verification: {
            ...takeover().verification,
            authenticatedSelector: selector,
          },
        }),
      ).rejects.toThrow("must be #id, .class, or an exact");
    }
    await expect(
      browser.requestLoginTakeover({
        ...takeover(),
        verification: {
          ...takeover().verification,
          authenticatedSelector: "#login2",
        },
      }),
    ).rejects.toThrow("must differ");
    expect(callBrowser).not.toHaveBeenCalled();
  });

  it("rejects multi-origin, mismatched, and cross-origin takeover URLs", async () => {
    const callBrowser = vi.fn(async () => ({ success: true, data: {} }));
    const browser = installBrowserWorkerApi(callBrowser);

    await expect(
      browser.requestLoginTakeover({
        ...takeover(),
        allowedOrigins: [ORIGIN, "https://example.com"],
      }),
    ).rejects.toThrow("exactly the displayed login origin");
    await expect(
      browser.requestLoginTakeover({
        ...takeover(),
        verification: {
          ...takeover().verification,
          expectedOrigin: "https://example.com",
        },
      }),
    ).rejects.toThrow("expectedOrigin and displayOrigin must be the same");
    await expect(
      browser.requestLoginTakeover({
        ...takeover(),
        startUrl: "https://example.com/login",
      }),
    ).rejects.toThrow("same-origin public HTTPS URL");
    await expect(
      browser.requestLoginTakeover({
        ...takeover(),
        verification: {
          ...takeover().verification,
          resumeUrl: "https://example.com/account",
        },
      }),
    ).rejects.toThrow("same-origin public HTTPS URL");
    expect(callBrowser).not.toHaveBeenCalled();
  });
});
