import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });

const waitForReady = async (origin, child) => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(
        `Workerd exited before readiness.\n${child.testOutput ?? ""}`,
      );
    }
    try {
      const response = await fetch(origin);
      if (response.status < 500) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Workerd did not become ready.");
};

const stop = async (child) => {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
};

let temp;
let untrusted;
let trusted;
let untrustedOrigin;
let trustedOrigin;

beforeAll(async () => {
  if (!chromePath) {
    throw new Error(
      "Interior shell browser tests require Chromium. Run `bun run test:browser:install` or set STELLA_TEST_CHROME_PATH.",
    );
  }
  temp = await mkdtemp(path.join(tmpdir(), "stella-interior-browser-workerd-"));
  const [untrustedPort, trustedPort, untrustedInspector, trustedInspector] =
    await Promise.all([freePort(), freePort(), freePort(), freePort()]);
  untrustedOrigin = `http://127.0.0.1:${untrustedPort}`;
  trustedOrigin = `http://127.0.0.1:${trustedPort}`;
  const untrustedConfig = path.join(temp, "untrusted.json");
  const trustedConfig = path.join(temp, "trusted.json");
  await writeFile(
    untrustedConfig,
    JSON.stringify({
      name: "interior-browser-untrusted-test",
      main: path.join(
        root,
        "tests/fixtures/interior-browser-untrusted-workerd.ts",
      ),
      compatibility_date: "2026-07-22",
      compatibility_flags: ["nodejs_compat"],
      vars: { PARENT_ORIGIN: untrustedOrigin, GATEWAY_ORIGIN: trustedOrigin },
    }),
  );
  await writeFile(
    trustedConfig,
    JSON.stringify({
      name: "interior-browser-trusted-test",
      main: path.join(
        root,
        "tests/fixtures/interior-browser-trusted-workerd.ts",
      ),
      compatibility_date: "2026-07-22",
      compatibility_flags: ["nodejs_compat"],
      vars: { PARENT_ORIGIN: untrustedOrigin },
    }),
  );
  const start = (config, port, inspectorPort, persistDir) => {
    const spawned = spawn(
      process.execPath,
      [
        "x",
        "wrangler",
        "dev",
        "--config",
        config,
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--inspector-port",
        String(inspectorPort),
        "--persist-to",
        persistDir,
      ],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    spawned.testOutput = "";
    const capture = (chunk) => {
      spawned.testOutput = `${spawned.testOutput}${chunk}`.slice(-12_000);
    };
    spawned.stdout.on("data", capture);
    spawned.stderr.on("data", capture);
    return spawned;
  };
  trusted = start(
    trustedConfig,
    trustedPort,
    trustedInspector,
    path.join(temp, "trusted-state"),
  );
  untrusted = start(
    untrustedConfig,
    untrustedPort,
    untrustedInspector,
    path.join(temp, "untrusted-state"),
  );
  await Promise.all([
    waitForReady(`${trustedOrigin}/missing`, trusted),
    waitForReady(untrustedOrigin, untrusted),
  ]);
}, 60_000);

afterAll(async () => {
  await Promise.all([stop(untrusted), stop(trusted)]);
  if (temp) await rm(temp, { recursive: true, force: true });
});

describe("real two-origin Workerd browser interior", () => {
  test("keeps the account authority outside an opaque generated interior", async () => {
    const browser = await chromium.launch({
      executablePath: chromePath,
      headless: true,
    });
    try {
      const page = await browser.newPage();
      await page.goto(untrustedOrigin);
      await page.evaluate(() => {
        localStorage.setItem(
          "better-auth_session_token",
          "broad-account-bearer",
        );
        localStorage.setItem(
          "stella_auth_cached_session",
          '{"token":"broad-account-bearer"}',
        );
        sessionStorage.setItem("better-auth_cookie", "broad-account-bearer");
      });
      await page.reload();
      const raw = page
        .frames()
        .find((frame) => frame.url() === `${untrustedOrigin}/raw`);
      expect(raw).toBeDefined();
      await raw.waitForFunction(() => document.body.dataset.result, null, {
        timeout: 15_000,
      });
      const result = JSON.parse(
        await raw.locator("body").getAttribute("data-result"),
      );
      expect(result).toEqual({
        bridgePresent: true,
        parentBootstrapReadable: false,
        storageAvailable: false,
        tokenOpaque: true,
        tokenInDom: false,
        sessionUser: "viewer-workerd",
        directAuthReachable: false,
        windowName: "",
      });
      expect(
        await page.evaluate(() => ({
          bearer: localStorage.getItem("better-auth_session_token"),
          cached: localStorage.getItem("stella_auth_cached_session"),
          legacy: sessionStorage.getItem("better-auth_cookie"),
          tokenInOuterDom: document.documentElement.outerHTML.includes(
            "v1.opaque-interior-session-not-a-jwt",
          ),
          sandbox: document
            .getElementById("stella-interior")
            ?.getAttribute("sandbox"),
        })),
      ).toEqual({
        bearer: null,
        cached: null,
        legacy: null,
        tokenInOuterDom: false,
        sandbox: "allow-scripts",
      });
    } finally {
      await browser.close();
    }
  }, 30_000);
});
