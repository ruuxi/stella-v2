import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { appWrapperScript } from "../src/index.ts";

const chromePath =
  [
    process.env.STELLA_TEST_CHROME_PATH,
    chromium.executablePath(),
    process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : null,
    process.platform === "darwin"
      ? "/Applications/Chromium.app/Contents/MacOS/Chromium"
      : null,
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
      : null,
    process.platform === "linux" ? "/usr/bin/google-chrome" : null,
    process.platform === "linux" ? "/usr/bin/chromium" : null,
    process.platform === "linux" ? "/usr/bin/chromium-browser" : null,
  ].find((candidate) => candidate && existsSync(candidate)) ?? null;

let server;
let origin = "";
let refreshCalls = 0;
const observedRequests = [];

const rawDocument = `<!doctype html><meta charset="utf-8"><body><script>
let bridgeAuthority = null;
let bridgeInitialized = false;
addEventListener("message", (event) => {
  const message = event.data || {};
  if (message.source === "stella-host-init") {
    if (bridgeInitialized || event.source !== parent || event.origin === "null" ||
        message.protocol !== 2 || message.parentOrigin !== event.origin ||
        typeof message.nonce !== "string" || !/^[0-9a-f-]{36}$/i.test(message.nonce)) return;
    bridgeInitialized = true;
    bridgeAuthority = { nonce: message.nonce, parentOrigin: event.origin };
    parent.postMessage({
      source: "stella-app", protocol: 2, nonce: message.nonce,
      id: "session-refresh-proof", method: "session",
    }, event.origin);
    return;
  }
  if (bridgeAuthority && event.source === parent &&
      event.origin === bridgeAuthority.parentOrigin &&
      message.source === "stella-host" && message.protocol === 2 &&
      message.nonce === bridgeAuthority.nonce &&
      message.id === "session-refresh-proof") {
    document.body.dataset.session = message.result?.token === "scoped-app-session" ? "ok" : JSON.stringify(message);
  }
});
(async () => {
  const result = { parentBootstrapReadable: false, storageReadable: false, wrapperFetchReadable: false };
  try { result.parentBootstrapReadable = typeof parent.document.documentElement.dataset.bootstrap === "string"; } catch {}
  try { localStorage.setItem("generated", "yes"); result.storageReadable = localStorage.getItem("wrapper-session") === "account-secret"; } catch {}
  try { const response = await fetch("/wrapper"); result.wrapperFetchReadable = (await response.text()).includes("wrapper-secret"); } catch {}
  document.body.dataset.result = JSON.stringify(result);
  parent.postMessage({ type: "raw-boundary-result", result }, "*");
})();
</script>`;

beforeAll(async () => {
  if (!chromePath) {
    throw new Error(
      "Apps Host browser boundary tests require Chromium. Run `bun run test:browser:install` or set STELLA_TEST_CHROME_PATH.",
    );
  }
  server = createServer((request, response) => {
    observedRequests.push(`${request.method} ${request.url}`);
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>seed</title>");
      return;
    }
    if (request.url === "/wrapper") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy":
          "default-src 'none'; script-src 'self'; frame-src 'self'; connect-src 'self'",
      });
      response.end(`<!doctype html><html data-bootstrap="expired-wrapper-bootstrap" data-bootstrap-expires-at="${Date.now() - 1}" data-bootstrap-refresh-url="/apps/test/_bootstrap" data-convex-site-url="${origin}" data-trusted-auth-origin="${origin}"><body>
        <iframe id="stella-generated-app" data-raw-src="/raw" sandbox="allow-scripts"></iframe>
        <script src="/_stella/app-wrapper.js"></script>
      </body></html>`);
      return;
    }
    if (request.url === "/desktop") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy":
          "default-src 'none'; script-src 'self'; frame-src 'self'",
      });
      response.end(
        `<!doctype html><body><iframe id="app" data-src="/wrapper"></iframe><script src="/desktop.js"></script>`,
      );
      return;
    }
    if (request.url === "/desktop.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(`(() => {
        const frame = document.querySelector("#app");
        const nonce = "123e4567-e89b-42d3-a456-426614174000";
        addEventListener("message", (event) => {
          const message = event.data || {};
          if (event.source !== frame.contentWindow || event.origin !== location.origin || message.protocol !== 2) return;
          if (message.source === "stella-wrapper-ready") {
            frame.contentWindow.postMessage({ source: "stella-host-init", protocol: 2, nonce, parentOrigin: location.origin }, location.origin);
            document.body.dataset.initialized = "yes";
            return;
          }
          if (message.source === "stella-app" && message.nonce === nonce && message.id && message.method === "session") {
            frame.contentWindow.postMessage({ source: "stella-host", protocol: 2, nonce, id: message.id, result: { token: "scoped-app-session", expiresAt: Date.now() + 60000, user: { userId: "viewer", username: "Viewer", anonymous: false } } }, location.origin);
          }
        });
        frame.src = frame.dataset.src;
      })();`);
      return;
    }
    if (request.url === "/apps/test/_bootstrap" && request.method === "POST") {
      refreshCalls += 1;
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(
        JSON.stringify({
          bootstrap: "refreshed-wrapper-bootstrap",
          expiresAt: Date.now() + 120_000,
        }),
      );
      return;
    }
    if (request.url === "/api/apps/connected-session") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"error":"Sign in required."}');
      return;
    }
    if (request.url === "/api/apps/session") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          token: "scoped-app-session",
          expiresAt: Date.now() + 60_000,
          user: { userId: null, username: "Guest", anonymous: true },
        }),
      );
      return;
    }
    if (request.url === "/_stella/app-wrapper.js") {
      response.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(appWrapperScript());
      return;
    }
    if (request.url === "/raw") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy":
          "default-src 'self'; script-src 'unsafe-inline'; connect-src 'self'; sandbox allow-scripts",
      });
      response.end(rawDocument);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe("real browser generated-app boundary", () => {
  test("keeps nested and directly navigated generated documents opaque", async () => {
    const browser = await chromium.launch({
      executablePath: chromePath,
      headless: true,
    });
    try {
      const page = await browser.newPage();
      await page.goto(origin);
      await page.evaluate(() => {
        localStorage.setItem(
          "better-auth_session_token",
          "reusable-account-bearer",
        );
        localStorage.setItem(
          "stella_auth_cached_session",
          '{"token":"reusable-account-bearer"}',
        );
        sessionStorage.setItem("better-auth_cookie", "reusable-account-bearer");
      });
      await page.goto(`${origin}/wrapper`);
      const rawFrame = page
        .frames()
        .find((frame) => frame.url() === `${origin}/raw`);
      expect(rawFrame).toBeDefined();
      await rawFrame.waitForFunction(() => document.body.dataset.result);
      expect(
        JSON.parse(await rawFrame.locator("body").getAttribute("data-result")),
      ).toEqual({
        parentBootstrapReadable: false,
        storageReadable: false,
        wrapperFetchReadable: false,
      });
      try {
        await rawFrame.waitForFunction(
          () => document.body.dataset.session === "ok",
          undefined,
          { timeout: 5_000 },
        );
      } catch {
        throw new Error(
          JSON.stringify({
            requests: observedRequests,
            session: await rawFrame
              .locator("body")
              .getAttribute("data-session"),
          }),
        );
      }
      expect(refreshCalls).toBe(1);
      expect(
        await page.evaluate(() => ({
          bearer: localStorage.getItem("better-auth_session_token"),
          cache: localStorage.getItem("stella_auth_cached_session"),
          legacy: sessionStorage.getItem("better-auth_cookie"),
        })),
      ).toEqual({ bearer: null, cache: null, legacy: null });

      await page.goto(`${origin}/raw`);
      await page.waitForFunction(() => document.body.dataset.result);
      expect(
        JSON.parse(await page.locator("body").getAttribute("data-result")),
      ).toEqual({
        parentBootstrapReadable: false,
        storageReadable: false,
        wrapperFetchReadable: false,
      });
      expect(
        await page.evaluate(() => {
          try {
            localStorage.setItem("direct", "yes");
            return true;
          } catch {
            return false;
          }
        }),
      ).toBe(false);
    } finally {
      await browser.close();
    }
  }, 30_000);

  test("establishes the desktop-to-wrapper-to-opaque-child bridge without window.name", async () => {
    const browser = await chromium.launch({
      executablePath: chromePath,
      headless: true,
    });
    try {
      const page = await browser.newPage();
      await page.goto(`${origin}/desktop`);
      await page.waitForFunction(
        () => document.body.dataset.initialized === "yes",
      );
      const rawFrame = page
        .frames()
        .find((frame) => frame.url() === `${origin}/raw`);
      expect(rawFrame).toBeDefined();
      await rawFrame.waitForFunction(
        () => document.body.dataset.session === "ok",
      );
      expect(await rawFrame.locator("body").getAttribute("data-session")).toBe(
        "ok",
      );
    } finally {
      await browser.close();
    }
  }, 30_000);
});
