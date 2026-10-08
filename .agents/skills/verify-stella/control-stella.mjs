#!/usr/bin/env node
/**
 * Isolated launch/doctor/drive/cleanup helper for the Stella desktop app.
 * Invocation examples live in ./SKILL.md. Do not drive a session this
 * script did not start.
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  BOOLEAN_FLAGS,
  capabilities,
  commandHelp,
  helpText,
  resolveCommand,
  unexpectedPositionals,
  unknownOptions,
} from "./cli/registry.mjs";

import { DOM_TOOLS_JS, compareObservations } from "./cli/dom.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const skillRoot = path.dirname(scriptPath);
const repoRoot = path.resolve(skillRoot, "../../..");
const POINTER_PATH = path.join(skillRoot, ".run", "current.json");
const DEFAULT_EVIDENCE_DIR = path.join(skillRoot, "artifacts");
const READY_SELECTOR = ".shell-topbar-full";
const SETTLE_IGNORED_SELECTOR = 'svg[aria-hidden="true"]';
const HOST_HEALTH_EXPRESSION = String.raw`
(async () => {
  const getDeviceId = window.electronAPI?.system?.getDeviceId;
  if (typeof getDeviceId !== "function") {
    throw new Error("Electron device identity bridge is unavailable.");
  }
  const deviceId = await getDeviceId();
  if (typeof deviceId !== "string" || deviceId.trim().length === 0) {
    throw new Error("Electron device identity is empty.");
  }
  const healthCheck = window.electronAPI?.agent?.healthCheck;
  if (typeof healthCheck !== "function") {
    throw new Error("Stella runtime health bridge is unavailable.");
  }
  const runtimeHealth = await healthCheck();
  if (!runtimeHealth || typeof runtimeHealth !== "object") {
    throw new Error("Stella runtime host is unavailable.");
  }
  return true;
})()
`;
const LAUNCH_TIMEOUT_MS = 120_000;
const CDP_CONNECT_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 15_000;
const ELECTRON_SYSTEM_ENV_KEYS = [
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "DISPLAY",
  "XDG_RUNTIME_DIR",
  // The harness is a developer instance, so it serves the renderer in
  // development mode. Pass this through to verify the production build the
  // installed product serves (see resolveRendererBuildMode).
  "STELLA_RENDERER_MODE",
];

const usage = helpText();
const PROCESS_STARTED_AT = Date.now();
let activeCommandId = "unknown";
let activeHelpHint = "Run `help` or `capabilities` to inspect the supported command surface.";

const fail = (message, code = 1, details = {}) => {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      command: activeCommandId,
      error: {
        code: details.errorCode ?? "USAGE",
        message,
        recovery: details.recovery ?? (details.errorCode ? null : activeHelpHint),
        retryable: details.retryable ?? false,
        ...(details.candidates ? { candidates: details.candidates, count: details.count } : {}),
      },
    })}\n`,
  );
  process.exit(code);
};

const parseArgs = (argv) => {
  const options = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--") && BOOLEAN_FLAGS.has(arg.slice(2))) {
      options[arg.slice(2)] = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value == null || value.startsWith("--")) {
        fail(`Missing value for --${key}`);
      }
      options[key] = value;
      i += 1;
      continue;
    }
    options._.push(arg);
  }
  return options;
};

const readJson = (filePath) => JSON.parse(readFileSync(filePath, "utf8"));

const writeJson = (filePath, value) => {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  rmSync(`${filePath}.tmp`, { force: true });
};

const allocatePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a TCP port."));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });

const isAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForExit = async (pid, timeoutMs = 5_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isAlive(pid)) return;
    await delay(100);
  }
};

const stopPid = async (pid) => {
  if (!isAlive(pid)) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }
  await waitForExit(pid, 4_000);
  if (!isAlive(pid)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return;
    }
  }
  await waitForExit(pid, 2_000);
};

const currentRun = () => {
  if (!existsSync(POINTER_PATH)) return null;
  try {
    return readJson(POINTER_PATH);
  } catch {
    return null;
  }
};

const SHORT_DARWIN_TMPDIR = "/tmp/sv";

const harnessTempRoot = () => {
  if (process.platform !== "darwin") return os.tmpdir();
  mkdirSync(SHORT_DARWIN_TMPDIR, { recursive: true, mode: 0o700 });
  return SHORT_DARWIN_TMPDIR;
};

const removeTemporaryUserData = (run) => {
  const tempRoot = path.join(
    path.dirname(path.dirname(run.userDataDir ?? "")),
    `stella-verify-${run.runId}`,
  );
  if (![os.tmpdir(), SHORT_DARWIN_TMPDIR].includes(path.dirname(tempRoot))) return;
  if (
    path.resolve(run.userDataDir ?? "") !==
    path.join(tempRoot, "electron-user-data")
  )
    return;
  rmSync(tempRoot, { recursive: true, force: true });
};

const bunBin = () => {
  const fromEnv = process.env.BUN_INSTALL
    ? path.join(process.env.BUN_INSTALL, "bin", "bun")
    : "";
  const candidates = [
    process.env.STELLA_BUN_PATH,
    fromEnv,
    path.join(process.env.HOME ?? "", ".bun", "bin", "bun"),
    "bun",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === "bun" || existsSync(candidate)) return candidate;
  }
  return "bun";
};

const electronBin = () => {
  const require = createRequire(path.join(repoRoot, "package.json"));
  return require("electron");
};

const waitForHttp = async (url, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not tried";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(1_500),
      });
      if (response.ok || response.status === 404) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${url} (${lastError}).`);
};

const linuxSoftwareGl = () =>
  process.platform === "linux" &&
  (process.env.STELLA_VERIFY_SOFTWARE_GL === "1" || !existsSync("/dev/dri"));

const shortSocketTmpdir = (value) => {
  if (process.platform !== "darwin" || (value && value.length <= SHORT_DARWIN_TMPDIR.length + 4)) {
    return value;
  }
  mkdirSync(SHORT_DARWIN_TMPDIR, { recursive: true, mode: 0o700 });
  return SHORT_DARWIN_TMPDIR;
};

const isolatedElectronEnvironment = () => {
  const env = Object.fromEntries(
    ELECTRON_SYSTEM_ENV_KEYS.filter(
      (key) =>
        typeof process.env[key] === "string" && process.env[key].length > 0,
    ).map((key) => [key, process.env[key]]),
  );
  const tmpdir = shortSocketTmpdir(env.TMPDIR);
  if (tmpdir) env.TMPDIR = tmpdir;
  return env;
};

const cdpTargets = async (cdpPort) => {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, {
    signal: AbortSignal.timeout(1_500),
  });
  if (!response.ok) {
    throw new Error(`CDP list failed: HTTP ${response.status}`);
  }
  return response.json();
};

const pickShellTarget = (targets) => {
  const pages = targets.filter((target) => target.type === "page");
  return (
    pages.find((target) => /window=full|index\.html/.test(target.url ?? "")) ??
    pages[0] ??
    null
  );
};

const waitForCdp = async (cdpPort, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no targets";
  while (Date.now() < deadline) {
    try {
      const targets = await cdpTargets(cdpPort);
      const target = pickShellTarget(targets);
      if (target?.webSocketDebuggerUrl) return target;
      lastError = `targets=${targets.length}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(
    `Timed out waiting for Electron CDP on ${cdpPort} (${lastError}).`,
  );
};

const cdpSend = async (ws, id, method, params) => {
  const payload = JSON.stringify({ id, method, params });
  ws.send(payload);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error(`CDP timeout: ${method}`));
    }, COMMAND_TIMEOUT_MS);
    const onMessage = (event) => {
      let parsed;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (parsed.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      if (parsed.error) {
        reject(
          new Error(
            `${method}: ${parsed.error.message ?? JSON.stringify(parsed.error)}`,
          ),
        );
        return;
      }
      resolve(parsed.result ?? {});
    };
    ws.addEventListener("message", onMessage);
  });
};

const withCdp = async (run, fn) => {
  const target = await waitForCdp(run.cdpPort, 10_000);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener(
      "error",
      () => reject(new Error("CDP websocket failed.")),
      {
        once: true,
      },
    );
  });
  try {
    await cdpSend(ws, 1, "Runtime.enable", {});
    await cdpSend(ws, 2, "Page.enable", {});
    return await fn(ws);
  } finally {
    ws.terminate();
  }
};

const runtimeEvaluate = async (ws, expression) => {
  const result = await cdpSend(ws, Date.now() % 1_000_000, "Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const description =
      result.exceptionDetails.exception?.description ??
      result.exceptionDetails.text ??
      "Runtime.evaluate failed";
    const target = description.match(/STELLA_TARGET:([^\n]+)/);
    if (target) {
      const details = JSON.parse(target[1]);
      throw Object.assign(new Error(details.message), details);
    }
    throw new Error(description);
  }
  return result.result?.value;
};

const seedDataDir = (dataDir) => {
  mkdirSync(dataDir, { recursive: true });
  writeJson(path.join(dataDir, "ui-state.json"), {
    "stella-onboarding-complete": "true",
  });
  writeJson(path.join(dataDir, "preferences.json"), {
    onboardingCompleted: true,
  });
};

const ACCOUNT_MODES = ["anonymous", "signed-in", "go", "pro"];
const TEST_ACCOUNT_EMAIL_DOMAIN = "test.stella.local";

const DEV_BACKEND_URL = "https://stella-v2-cloud-builder-dev.fromyou.workers.dev";

/** A value from the gitignored workers/cloud-builder/.dev.vars, if present. */
const readDevVar = (name) => {
  const envPath = path.join(repoRoot, "workers/cloud-builder/.dev.vars");
  if (!existsSync(envPath)) return "";
  const line = readFileSync(envPath, "utf8")
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${name}=`));
  return line
    ? line.slice(name.length + 1).split(" #")[0].trim().replace(/^"(.*)"$/, "$1")
    : "";
};

const resolveAdminApiSecret = () =>
  process.env.STELLA_ADMIN_API_SECRET?.trim() || readDevVar("STELLA_ADMIN_API_SECRET");

/** The backend (cloud-builder) origin: auth, test accounts and the API. */
const resolveSiteUrl = () =>
  (process.env.STELLA_BACKEND_URL?.trim() || DEV_BACKEND_URL).replace(/\/+$/, "");

/**
 * One anonymous session per machine, kept for `--reuse`. A fresh profile
 * has no stored bearer, so without this every launch signs up a new
 * anonymous user on the dev deployment and the per-IP sybil counters fill
 * up within a handful of runs. The file holds a dev anonymous bearer only
 * and is owner-readable.
 */
const ANONYMOUS_SESSION_PATH = path.join(
  skillRoot,
  ".run",
  "anonymous-session.json",
);

const writeSecretJson = (filePath, value) => {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(filePath, 0o600);
};

const authHeaders = (token) => ({
  accept: "application/json",
  "content-type": "application/json",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

const sessionIsAlive = async (siteUrl, token) => {
  try {
    const response = await fetch(`${siteUrl}/api/auth/get-session`, {
      headers: authHeaders(token),
    });
    if (!response.ok) return false;
    const payload = await response.json().catch(() => null);
    return Boolean(payload?.user?.id);
  } catch {
    return false;
  }
};

const mintAnonymousSession = async (siteUrl) => {
  let response;
  try {
    response = await fetch(`${siteUrl}/api/auth/sign-in/anonymous`, {
      method: "POST",
      headers: authHeaders(),
      body: "{}",
    });
  } catch (error) {
    fail(
      `Anonymous sign-in request failed: ${error instanceof Error ? error.message : String(error)}`,
      2,
      { errorCode: "ANONYMOUS_SESSION_REQUEST_FAILED", retryable: true },
    );
  }
  const token = response.headers.get("set-auth-token")?.trim() ?? "";
  const payload = await response.json().catch(() => null);
  if (!response.ok || !token || !payload?.user?.id) {
    fail(
      `Anonymous sign-in returned HTTP ${response.status}: ${payload?.error ?? payload?.message ?? "no session token"}`,
      2,
      {
        errorCode: "ANONYMOUS_SESSION_MINT_FAILED",
        recovery:
          "Check that the backend at STELLA_BACKEND_URL is deployed and allows anonymous sign-in without a Turnstile token (dev leaves TURNSTILE_SECRET_KEY unset).",
      },
    );
  }
  return {
    siteUrl,
    token,
    userId: payload.user.id,
    createdAt: new Date().toISOString(),
  };
};

/**
 * Return the saved anonymous session when it still verifies against this
 * backend; otherwise mint one and save it. `reused` tells the run record
 * which happened.
 */
const ensureReusableAnonymousSession = async () => {
  const siteUrl = resolveSiteUrl();
  if (existsSync(ANONYMOUS_SESSION_PATH)) {
    let saved = null;
    try {
      saved = readJson(ANONYMOUS_SESSION_PATH);
    } catch {
      saved = null;
    }
    if (
      saved?.siteUrl === siteUrl &&
      typeof saved.token === "string" &&
      (await sessionIsAlive(siteUrl, saved.token))
    ) {
      return { session: saved, reused: true };
    }
    process.stderr.write(
      "Saved anonymous session is missing, for another backend, or no longer valid; creating a new one.\n",
    );
  }
  const session = await mintAnonymousSession(siteUrl);
  writeSecretJson(ANONYMOUS_SESSION_PATH, session);
  return { session, reused: false };
};

/**
 * Mint a signed-in (non-anonymous) test account on the dev deployment via
 * the admin API. Returns the bearer token Electron adopts at boot, plus the
 * identifiers recorded in the run pointer. The token is never persisted.
 */
const mintTestAccount = async (runId, mode) => {
  const siteUrl = resolveSiteUrl();
  const secret = resolveAdminApiSecret();
  if (!secret)
    fail("STELLA_ADMIN_API_SECRET is unavailable.", 2, {
      errorCode: "TEST_ACCOUNT_SECRET_MISSING",
      recovery:
        "Export STELLA_ADMIN_API_SECRET, or set it in the gitignored workers/cloud-builder/.dev.vars.",
    });
  // STELLA_VERIFY_ACCOUNT_EMAIL reuses one test account across runs, e.g.
  // two checkouts acting as the same owner's two computers.
  const reuseEmail = process.env.STELLA_VERIFY_ACCOUNT_EMAIL?.trim();
  if (reuseEmail && !reuseEmail.endsWith(`@${TEST_ACCOUNT_EMAIL_DOMAIN}`)) {
    fail(`STELLA_VERIFY_ACCOUNT_EMAIL must end with @${TEST_ACCOUNT_EMAIL_DOMAIN}.`, 2, {
      errorCode: "TEST_ACCOUNT_EMAIL_INVALID", recovery: `Use an address ending in @${TEST_ACCOUNT_EMAIL_DOMAIN}, or unset STELLA_VERIFY_ACCOUNT_EMAIL.`,
    });
  }
  const body = { email: reuseEmail || `agent-${runId}@${TEST_ACCOUNT_EMAIL_DOMAIN}` };
  if (mode === "go" || mode === "pro") {
    body.plan = mode;
    body.usageMode = "unlimited";
  }
  let response;
  try {
    response = await fetch(`${siteUrl}/api/admin/test-accounts/session`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    fail(
      `Test account request failed: ${error instanceof Error ? error.message : String(error)}`,
      2,
      { errorCode: "TEST_ACCOUNT_REQUEST_FAILED", retryable: true },
    );
  }
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  if (!response.ok || !payload?.sessionToken) {
    fail(
      `Test account mint returned HTTP ${response.status}: ${payload?.error ?? text.slice(0, 200)}`,
      2,
      {
        errorCode: "TEST_ACCOUNT_MINT_FAILED",
        recovery:
          response.status === 404
            ? "The deployment has no STELLA_TEST_ACCOUNTS=1; only the dev deployment enables test accounts."
            : "Check STELLA_ADMIN_API_SECRET and that the backend at STELLA_BACKEND_URL is deployed with the test-accounts route.",
      },
    );
  }
  return {
    sessionToken: payload.sessionToken,
    account: {
      mode,
      ownerId: payload.ownerId,
      email: payload.email,
      plan: payload.plan,
    },
  };
};

const spawnLogged = (command, args, options) => {
  mkdirSync(path.dirname(options.logPath), { recursive: true });
  const logFd = openSync(options.logPath, "a");
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  child.on("error", (error) => {
    writeFileSync(options.logPath, `[spawn error] ${error.message}\n`, {
      flag: "a",
    });
  });
  child.unref();
  return child;
};

const requireRun = () => {
  const run = currentRun();
  if (!run)
    fail("No verification instance is recorded.", 2, {
      errorCode: "NO_RUN",
      recovery: "Run `session launch` from the Stella repository, then retry this command.",
      retryable: true,
    });
  return run;
};

const doctorReport = async (run) => {
  const report = {
    ok: false,
    runId: run.runId,
    dataDir: run.dataDir,
    userDataDir: run.userDataDir,
    cdpPort: run.cdpPort,
    electronPidAlive: isAlive(run.electronPid),
    cdp: false,
    shellReady: false,
    hostReady: false,
    title: null,
    href: null,
    errors: [],
  };
  if (!report.electronPidAlive)
    report.errors.push("Electron process is not running.");
  try {
    const target = await waitForCdp(run.cdpPort, 2_000);
    report.cdp = true;
    report.title = target.title ?? null;
    report.href = target.url ?? null;
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
  }
  if (report.cdp) {
    try {
      report.shellReady = Boolean(
        await withCdp(run, (ws) =>
          runtimeEvaluate(
            ws,
            `Boolean(document.querySelector(${JSON.stringify(READY_SELECTOR)}))`,
          ),
        ),
      );
      if (!report.shellReady) {
        report.errors.push(
          `Shell top bar ${READY_SELECTOR} is missing. Onboarding may still be covering the app.`,
        );
      }
    } catch (error) {
      report.errors.push(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  if (report.shellReady) {
    try {
      report.hostReady = Boolean(
        await withCdp(run, (ws) => runtimeEvaluate(ws, HOST_HEALTH_EXPRESSION)),
      );
      if (!report.hostReady) {
        report.errors.push("Electron host health check returned false.");
      }
    } catch (error) {
      report.errors.push(
        `Electron host health check failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  report.ok =
    report.electronPidAlive &&
    report.cdp &&
    report.shellReady &&
    report.hostReady;
  return report;
};

const cmdLaunch = async (options) => {
  const existing = currentRun();
  if (
    existing &&
    isAlive(existing.electronPid)
  ) {
    if (!options.replace) {
      fail(
        `A verification instance is already running (runId ${existing.runId}). Pass --replace to stop it first, or drive that instance.`,
        1,
        { errorCode: "ALREADY_RUNNING", recovery: "Run `cleanup plan`, then `session launch --replace`, or keep driving the recorded run." },
      );
    }
    await cmdStop({ silent: true });
  }

  const accountMode = options.account ?? "anonymous";
  if (!ACCOUNT_MODES.includes(accountMode))
    fail(`Unknown --account ${accountMode}. Use one of ${ACCOUNT_MODES.join(", ")}.`);

  if (options.reuse && accountMode !== "anonymous")
    fail("--reuse applies to anonymous launches only; test accounts are minted per run.");

  const modelGateway = options["model-gateway"] ? new URL(options["model-gateway"]).origin : null;
  const fakeMic = options["fake-mic"] ? path.resolve(options["fake-mic"]) : null;
  if (fakeMic && !existsSync(fakeMic)) fail(`--fake-mic file not found: ${fakeMic}`);
  const browserBridge = options["browser-bridge"] ?? null;
  if (browserBridge && !["shared", "isolated"].includes(browserBridge))
    fail("--browser-bridge must be shared or isolated.");

  const runId = randomUUID().slice(0, 8);
  const runDir = path.join(skillRoot, ".run", runId);
  let minted = null;
  let account = { mode: "anonymous", reused: false };
  if (accountMode !== "anonymous") {
    minted = await mintTestAccount(runId, accountMode);
    account = minted.account;
  } else if (options.reuse) {
    const { session, reused } = await ensureReusableAnonymousSession();
    minted = { sessionToken: session.token };
    account = { mode: "anonymous", reused, userId: session.userId };
  }
  const dataDir = path.join(runDir, "data");
  const userDataDir = path.join(
    harnessTempRoot(),
    `stella-verify-${runId}`,
    "electron-user-data",
  );
  mkdirSync(userDataDir, { recursive: true });
  seedDataDir(dataDir);
  const providerHomes = {
    CLAUDE_CONFIG_DIR: path.join(runDir, "provider-homes", "claude"),
    CODEX_HOME: path.join(runDir, "provider-homes", "codex"),
  };
  for (const dir of Object.values(providerHomes)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const cdpPort = await allocatePort();
  const sharedEnv = {
    ...process.env,
    STELLA_SKIP_BROWSER_HYDRATE: "1",
    STELLA_DATA_DIR: dataDir,
    STELLA_V2_DEV_DATA_DIR: dataDir,
  };

  const run = {
    runId,
    runDir,
    dataDir,
    userDataDir,
    cdpPort,
    electronPid: null,
    startedAt: new Date().toISOString(),
    evidenceDir: DEFAULT_EVIDENCE_DIR,
    account,
    browserBridge: browserBridge ?? "isolated",
    providerHomes,
  };
  writeJson(POINTER_PATH, run);
  writeJson(path.join(runDir, "run.json"), run);

  try {
    process.stderr.write("Starting Electron...\n");
    const softwareGl = linuxSoftwareGl();
    const electronArgs = [];
    if (process.platform === "linux") {
      electronArgs.push("--no-sandbox", "--disable-dev-shm-usage");
      if (softwareGl) {
        electronArgs.push(
          "--disable-gpu",
          "--disable-gpu-sandbox",
          "--in-process-gpu",
          "--enable-unsafe-swiftshader",
          "--ozone-platform=x11",
        );
      }
    }
    if (fakeMic) {
      // Chromium plays the WAV as the only microphone, looping, and grants
      // capture without a prompt. Used to drive dictation end to end.
      electronArgs.push(
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        `--use-file-for-fake-audio-capture=${fakeMic}`,
      );
    }
    electronArgs.push("--remote-allow-origins=*");
    // Main-process inspector for evaluating in main (e.g. hot-update checks).
    if (process.env.STELLA_VERIFY_INSPECT_MAIN) {
      electronArgs.push(`--inspect=127.0.0.1:${process.env.STELLA_VERIFY_INSPECT_MAIN}`);
    }
    electronArgs.push(repoRoot, "--dev");
    const electron = spawnLogged(electronBin(), electronArgs, {
      cwd: repoRoot,
      env: {
        ...isolatedElectronEnvironment(),
        ...(modelGateway ? { STELLA_MODEL_GATEWAY_URL: modelGateway } : {}),
        ...(browserBridge ? { STELLA_BROWSER_BRIDGE: browserBridge } : {}),
        ...providerHomes,
        // The app talks to the backend the harness signs in against.
        ...(process.env.STELLA_BACKEND_URL?.trim()
          ? { VITE_STELLA_BACKEND_URL: resolveSiteUrl() }
          : {}),
        STELLA_SKIP_BROWSER_HYDRATE: "1",
        STELLA_DATA_DIR: dataDir,
        STELLA_V2_DEV_DATA_DIR: dataDir,
        STELLA_DEV_HARNESS: "1",
        STELLA_DEV_HARNESS_STORAGE_KEY: randomBytes(32).toString("base64url"),
        ...(minted
          ? { STELLA_DEV_HARNESS_SESSION_TOKEN: minted.sessionToken }
          : {}),
        STELLA_V2_DEV_USER_DATA_DIR: userDataDir,
        STELLA_RUNTIME_IPC_DIR: path.dirname(userDataDir),
        STELLA_REMOTE_DEBUG_PORT: String(cdpPort),
        NODE_ENV: "development",
        ...(softwareGl
          ? {
              ELECTRON_OZONE_PLATFORM_HINT: "x11",
              LIBGL_ALWAYS_SOFTWARE: "1",
            }
          : {}),
      },
      logPath: path.join(runDir, "electron.log"),
    });
    run.electronPid = electron.pid;
    writeJson(POINTER_PATH, run);
    writeJson(path.join(runDir, "run.json"), run);

    await waitForCdp(cdpPort, CDP_CONNECT_TIMEOUT_MS);
    const deadline = Date.now() + CDP_CONNECT_TIMEOUT_MS;
    let ready = false;
    let lastError = "shell not ready";
    while (Date.now() < deadline) {
      try {
        ready = Boolean(
          await withCdp(run, (ws) =>
            runtimeEvaluate(
              ws,
              `Boolean(document.querySelector(${JSON.stringify(READY_SELECTOR)}))`,
            ),
          ),
        );
        if (ready) break;
        lastError = `selector ${READY_SELECTOR} missing`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await delay(400);
    }
    if (!ready)
      throw new Error(
        `Electron window came up but the shell did not: ${lastError}`,
      );
    // The shell can mount before the detached runtime host finishes starting.
    // Wait for the same health contract used by doctor instead of treating its
    // first null response as a failed launch and killing a healthy startup.
    const hostDeadline = Date.now() + CDP_CONNECT_TIMEOUT_MS;
    let hostReady = false;
    let lastHostError = "runtime host not ready";
    while (Date.now() < hostDeadline) {
      try {
        hostReady = Boolean(
          await withCdp(run, (ws) => runtimeEvaluate(ws, HOST_HEALTH_EXPRESSION)),
        );
        if (hostReady) break;
      } catch (error) {
        lastHostError = error instanceof Error ? error.message : String(error);
      }
      if (!isAlive(run.electronPid)) break;
      await delay(400);
    }
    if (!hostReady) {
      throw new Error(`Electron shell is ready but the runtime host did not become ready: ${lastHostError}`);
    }
  } catch (error) {
    // STELLA_VERIFY_KEEP_ON_FAILURE=1 leaves a failed launch up to inspect.
    if (process.env.STELLA_VERIFY_KEEP_ON_FAILURE !== "1") {
      await stopPid(run.electronPid);
      removeTemporaryUserData(run);
      rmSync(POINTER_PATH, { force: true });
    }
    throw error;
  }

  respond(run, run);
};

const cmdStop = async ({ silent = false, "dry-run": dryRun = false } = {}) => {
  const run = currentRun();
  if (!run) {
    if (!silent) respond({ stopped: false, reason: "No verification instance is recorded." }, null);
    return;
  }
  if (dryRun) {
    respond(
      {
        dryRun: true,
        runId: run.runId,
        wouldStop: {
          electronPid: run.electronPid,
        },
        wouldRemove: [run.userDataDir, POINTER_PATH],
        wouldKeep: [run.dataDir, run.evidenceDir],
      },
      run,
    );
    return;
  }
  await stopPid(run.electronPid);
  removeTemporaryUserData(run);
  rmSync(POINTER_PATH, { force: true });
  if (!silent) {
    respond(
      {
        stopped: true,
        runId: run.runId,
        evidenceDir: run.evidenceDir,
        dataDirKept: run.dataDir,
      },
      run,
    );
  }
};

const cmdDoctor = async () => {
  const run = requireRun();
  const report = await doctorReport(run);
  respond(report, run);
  if (!report.ok) process.exitCode = 2;
};

const cmdInfo = () => {
  const run = requireRun();
  respond(run, run);
};

const FIND_ELEMENT_JS = `(${DOM_TOOLS_JS}).find`;

const evaluateFind = (ws, query) =>
  runtimeEvaluate(ws, `(${FIND_ELEMENT_JS})(${JSON.stringify({ ...query, unique: false })}); true`);

const clickQuery = (run, query) =>
  withCdp(run, async (ws) => {
    const hit = await runtimeEvaluate(
      ws,
      `(() => {
        const el = (${FIND_ELEMENT_JS})(${JSON.stringify(query)});
        el.scrollIntoView({ block: "center", inline: "center" });
        const rect = el.getBoundingClientRect();
        return {
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          tag: el.tagName,
          name: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 80),
        };
      })()`,
    );
    await cdpSend(ws, 30, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: hit.x,
      y: hit.y,
    });
    await cdpSend(ws, 31, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: hit.x,
      y: hit.y,
      button: "left",
      clickCount: 1,
    });
    await cdpSend(ws, 32, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: hit.x,
      y: hit.y,
      button: "left",
      clickCount: 1,
    });
    return hit;
  });

const fillQuery = (run, query, value) =>
  withCdp(run, (ws) =>
    runtimeEvaluate(
      ws,
      `(() => {
        const el = (${FIND_ELEMENT_JS})(${JSON.stringify(query)});
        el.focus();
        const proto = el.tagName === "TEXTAREA"
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
        descriptor.set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { value: el.value, placeholder: el.getAttribute("placeholder") };
      })()`,
    ),
  );

const dispatchKey = (run, spec) =>
  withCdp(run, async (ws) => {
    await cdpSend(ws, 10, "Input.dispatchKeyEvent", {
      type: "keyDown",
      ...spec,
    });
    await cdpSend(ws, 11, "Input.dispatchKeyEvent", {
      type: "keyUp",
      ...spec,
    });
  });

const waitQuery = async (run, query, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not found";
  while (Date.now() < deadline) {
    try {
      await withCdp(run, (ws) => evaluateFind(ws, query));
      return { ok: true, query };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await delay(200);
    }
  }
  throw new Error(`wait timed out: ${lastError}`);
};

const cmdClick = async (options) => {
  const run = requireRun();
  if (!options.name && !options.selector && !options.role)
    fail("click requires --name, --role, or --selector");
  const hit = await clickQuery(run, {
    role: options.role ?? null,
    name: options.name ?? null,
    selector: options.selector ?? null,
    within: options.within ?? null,
  });
  respond(hit, run);
};

const cmdFill = async (options) => {
  const run = requireRun();
  if (options.value == null) fail("fill requires --value");
  if (!options.placeholder && !options.selector && !options.name) {
    fail("fill requires --placeholder, --name, or --selector");
  }
  const value = await fillQuery(
    run,
    {
      placeholder: options.placeholder ?? null,
      name: options.name ?? null,
      selector: options.selector ?? null,
      within: options.within ?? null,
      role: options.role ?? null,
    },
    options.value,
  );
  respond(value, run);
};

const KEY_CODES = {
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  "/": { key: "/", code: "Slash", windowsVirtualKeyCode: 191 },
};

const MODIFIERS = {
  Alt: 1,
  Control: 2,
  Ctrl: 2,
  Meta: 4,
  Command: 4,
  Shift: 8,
};

const parseKeyChord = (value) => {
  if (!value) fail("drive press requires --key <key-or-chord>.");
  const parts = value.split("+").filter(Boolean);
  const keyName = parts.pop();
  let modifiers = 0;
  for (const modifier of parts) {
    if (!(modifier in MODIFIERS)) {
      fail(`Unknown modifier ${modifier}. Use Alt, Control, Ctrl, Meta, Command, or Shift.`);
    }
    modifiers |= MODIFIERS[modifier];
  }
  let spec = KEY_CODES[keyName];
  if (!spec && /^Key[A-Z]$/.test(keyName)) {
    const letter = keyName.slice(3);
    spec = { key: letter.toLowerCase(), code: keyName, windowsVirtualKeyCode: letter.charCodeAt(0) };
  }
  if (!spec && /^Digit[0-9]$/.test(keyName)) {
    const digit = keyName.slice(5);
    spec = { key: digit, code: keyName, windowsVirtualKeyCode: digit.charCodeAt(0) };
  }
  if (!spec && /^[a-zA-Z0-9]$/.test(keyName)) {
    const upper = keyName.toUpperCase();
    spec = {
      key: keyName,
      code: /[A-Z]/.test(upper) ? `Key${upper}` : `Digit${keyName}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
    };
  }
  if (!spec) {
    fail(
      `Unknown key ${keyName}. Use a named key, KeyA-KeyZ, Digit0-Digit9, or a chord such as Meta+KeyN.`,
    );
  }
  return { ...spec, modifiers };
};

const cmdPress = async (options) => {
  const run = requireRun();
  const spec = parseKeyChord(options.key);
  await dispatchKey(run, spec);
  respond({ key: options.key }, run);
};

const cmdWait = async (options) => {
  const run = requireRun();
  const query = {
    selector: options.selector ?? null,
    within: options.within ?? null,
    name: options.name ?? null,
    text: options.text ?? null,
    placeholder: options.placeholder ?? null,
    role: options.role ?? null,
  };
  const result = await waitQuery(run, query, Number(options.timeout) || 10_000);
  respond(result, run);
};

const boundedInteger = (value, fallback, { min, max, label }) => {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    fail(`${label} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
};

const cmdWaitSettle = async (options) => {
  const run = requireRun();
  const quietMs = boundedInteger(options.quiet, 500, {
    min: 100,
    max: 5_000,
    label: "--quiet",
  });
  const timeoutMs = boundedInteger(options.timeout, 10_000, {
    min: quietMs,
    max: 13_000,
    label: "--timeout",
  });
  const ignore = [SETTLE_IGNORED_SELECTOR, options.ignore].filter(Boolean).join(", ");
  const result = await withCdp(run, (ws) =>
    runtimeEvaluate(
      ws,
      `new Promise((resolve, reject) => {
        const startedAt = performance.now();
        const ignore = ${JSON.stringify(ignore)};
        let ignored = 0;
        let quietTimer;
        let timeoutTimer;
        const finish = () => {
          observer.disconnect();
          clearTimeout(timeoutTimer);
          requestAnimationFrame(() => requestAnimationFrame(() => resolve({
            quietMs: ${quietMs},
            elapsedMs: Math.round(performance.now() - startedAt),
            ignoredSelector: ignore,
            ignoredMutations: ignored,
          })));
        };
        const arm = () => {
          clearTimeout(quietTimer);
          quietTimer = setTimeout(finish, ${quietMs});
        };
        const relevant = (mutation) => {
          const node = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
          if (node && node.closest(ignore)) {
            ignored += 1;
            return false;
          }
          return true;
        };
        const observer = new MutationObserver((mutations) => {
          if (mutations.some(relevant)) arm();
        });
        observer.observe(document.documentElement, {
          attributes: true,
          childList: true,
          characterData: true,
          subtree: true,
        });
        timeoutTimer = setTimeout(() => {
          observer.disconnect();
          clearTimeout(quietTimer);
          reject(new Error("UI did not settle within ${timeoutMs}ms."));
        }, ${timeoutMs});
        arm();
      })`,
    ),
  );
  respond({ settled: true, ...result }, run);
};

const emitSuccess = (command, data, run = null, startedAt = Date.now()) => {
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      command,
      data,
      meta: {
        schemaVersion: 1,
        runId: run?.runId ?? null,
        elapsedMs: Date.now() - startedAt,
      },
    })}\n`,
  );
};

const respond = (data, run = currentRun()) =>
  emitSuccess(activeCommandId, data, run, PROCESS_STARTED_AT);

const SHELL_STATE_JS = `(() => {
  const visible = (el) => {
    if (!(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden"
      && !el.closest('[inert], [aria-hidden="true"]')
      && rect.width > 0 && rect.height > 0
      && rect.right > 0 && rect.bottom > 0
      && rect.left < window.innerWidth && rect.top < window.innerHeight;
  };
  const composer = [...document.querySelectorAll("textarea.composer-input")].find(visible) || null;
  const chatSurface = document.querySelector('[data-testid="chat-surface"]');
  const chatColumn = [...document.querySelectorAll("[data-conversation-id]")].find(visible) || null;
  const selectedTabs = [...document.querySelectorAll('[role="tab"][aria-selected="true"]')]
    .filter(visible)
    .map((el) => (el.getAttribute("aria-label") || el.textContent || "").trim())
    .filter(Boolean);
  return {
    title: document.title,
    route: location.pathname,
    search: location.search,
    activeConversationId: chatColumn?.getAttribute("data-conversation-id") || chatSurface?.getAttribute("data-conversation-id") || null,
    homeOpen: Boolean(document.querySelector(".full-body-home-overlay")),
    settingsOpen: Boolean([...document.querySelectorAll('[role="dialog"]')].find((el) => visible(el) && (el.textContent || "").includes("Settings"))),
    panelOpen: document.querySelector(".display-panel-topbar")?.getAttribute("data-display-open") === "true",
    composer: composer ? { visible: true, enabled: !composer.disabled, empty: composer.value.length === 0 } : { visible: false, enabled: false, empty: true },
    selectedTabs,
  };
})()`;

const readShellState = (run) =>
  withCdp(run, (ws) => runtimeEvaluate(ws, SHELL_STATE_JS));

const cmdInspectState = async () => {
  const startedAt = Date.now();
  const run = requireRun();
  emitSuccess("inspect.state", await readShellState(run), run, startedAt);
};

const cmdChatReady = async () => {
  const startedAt = Date.now();
  const run = requireRun();
  const doctor = await doctorReport(run);
  const state = doctor.ok ? await readShellState(run) : null;
  const ready = Boolean(
    doctor.ok &&
      state?.activeConversationId &&
      state.composer.visible &&
      state.composer.enabled,
  );
  emitSuccess("chat.ready", { ready, doctor, state }, run, startedAt);
  if (!ready) process.exitCode = 2;
};

const waitForState = async (run, predicate, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  let state = await readShellState(run);
  while (Date.now() < deadline) {
    if (predicate(state)) return state;
    await delay(200);
    state = await readShellState(run);
  }
  throw new Error("Timed out waiting for Stella's semantic UI state.");
};

const cmdChatSend = async (options, positionals) => {
  const startedAt = Date.now();
  const run = requireRun();
  const text = options.text ?? positionals.join(" ");
  if (!text) fail("chat send requires --text <message> or a positional message.");
  const before = await readShellState(run);
  if (!before.activeConversationId || !before.composer.enabled) {
    fail("The chat composer is not ready.", 2, {
      errorCode: "APP_NOT_READY", recovery: "Inspect the app and run `session doctor`.", retryable: true,
    });
  }
  const timeoutMs = boundedInteger(options.timeout, 10_000, { min: 500, max: 120_000, label: "--timeout" });
  const observe = () => withCdp(run, (ws) => runtimeEvaluate(ws,
    `(${DOM_TOOLS_JS}).chat(${JSON.stringify(text)}, ${JSON.stringify(before.activeConversationId)})`));
  const baseline = await observe();
  if (!baseline.surfaceFound) {
    fail("The active chat surface could not be identified.", 2, {
      errorCode: "APP_NOT_READY", recovery: "Close any open dialog or menu (drive press --key Escape), then run `chat ready`.", retryable: true,
    });
  }
  const within = baseline.composerScope;
  await fillQuery(run, { within, selector: "textarea.composer-input" }, text);
  await dispatchKey(run, KEY_CODES.Enter);
  const deadline = Date.now() + timeoutMs;
  let observed;
  let newMessageIds = [];
  let newNotices = [];
  do {
    observed = await observe();
    newMessageIds = observed.matchingMessageIds.filter((id) => !baseline.mountedMatchingMessageIds.includes(id));
    newNotices = observed.notices.filter((notice) => !baseline.notices.some((prior) => JSON.stringify(prior) === JSON.stringify(notice)));
    if (newMessageIds.length || newNotices.length) break;
    await delay(200);
  } while (Date.now() < deadline);
  const observation = newMessageIds.length ? "new-user-message" : newNotices.length ? "new-notice" : "no-new-evidence";
  emitSuccess("chat.send", {
    conversationId: before.activeConversationId,
    action: "enter-dispatched", observation,
    userMessageVisible: newMessageIds.length > 0,
    newMessageIds, newNotices: newNotices.map((notice) => ({ ...notice, text: redactText(notice.text) })),
    composerCleared: observed.composerCleared,
    surfaceFound: observed.surfaceFound,
    timedOut: observation === "no-new-evidence",
    responseCompletion: "not-assessed",
  }, run, startedAt);
  if (observation === "no-new-evidence") process.exitCode = 2;
};

const cmdChatState = async () => {
  const startedAt = Date.now();
  const run = requireRun();
  emitSuccess("chat.state", await readShellState(run), run, startedAt);
};

const openLauncherDestination = async (run, name) => {
  if (!(await readShellState(run)).panelOpen) {
    await clickQuery(run, { role: "button", name: "Open panel" });
    await waitForState(run, (state) => state.panelOpen);
  }
  await clickQuery(run, { role: "button", name: "New tab" });
  await waitQuery(run, { role: "button", name });
  await clickQuery(run, { role: "button", name });
  return waitForState(run, (state) => state.selectedTabs.includes(name));
};

const cmdNavHome = async () => {
  const startedAt = Date.now();
  const run = requireRun();
  const before = await readShellState(run);
  if (!before.homeOpen) {
    fail("Home is not showing. It appears on its own for an empty conversation, on the first view after launch until the user interacts, and after an hour idle; there is no Home launcher or New chat control.", 2, {
      errorCode: "APP_NOT_READY", recovery: "Launch a fresh run (`session launch --replace`) for an empty conversation, or relaunch to see Home over a populated one.", retryable: false,
    });
  }
  const state = await waitForState(run, (value) => value.homeOpen);
  emitSuccess("nav.home", state, run, startedAt);
};

const cmdNavDestination = async (command, name) => {
  const startedAt = Date.now();
  const run = requireRun();
  const state = await openLauncherDestination(run, name);
  emitSuccess(command, { destination: name, state }, run, startedAt);
};

const ensureSettingsOpen = async (run) => {
  let state = await readShellState(run);
  if (!state.settingsOpen) {
    await clickQuery(run, { selector: 'button[aria-label="Settings"], button[aria-label^="Account,"]' });
    await waitQuery(run, { role: "menuitem", name: "Settings" });
    await clickQuery(run, { role: "menuitem", name: "Settings" });
    await waitQuery(run, { role: "tab", name: "General" });
    state = await readShellState(run);
  }
  return state;
};

const cmdSettingsOpen = async () => {
  const startedAt = Date.now();
  const run = requireRun();
  const state = await ensureSettingsOpen(run);
  emitSuccess("settings.open", state, run, startedAt);
};

const cmdSettingsTab = async (options, positionals) => {
  const startedAt = Date.now();
  const run = requireRun();
  const name = options.name ?? positionals.join(" ");
  if (!name) fail("settings tab requires --name <tab> or a positional tab name.");
  await ensureSettingsOpen(run);
  await clickQuery(run, { role: "tab", name });
  const selected = await waitForState(run, (state) =>
    state.selectedTabs.includes(name),
  );
  emitSuccess("settings.tab", { tab: name, state: selected }, run, startedAt);
};

const cmdSettingsSearch = async (options, positionals) => {
  const startedAt = Date.now();
  const run = requireRun();
  const query = options.query ?? positionals.join(" ");
  if (!query) fail("settings search requires --query <text> or positional text.");
  await ensureSettingsOpen(run);
  await fillQuery(run, { placeholder: "Search settings" }, query);
  await delay(250);
  emitSuccess(
    "settings.search",
    {
      query,
      resultText: await withCdp(run, (ws) =>
        runtimeEvaluate(
          ws,
          `(document.querySelector(".settings-search-results")?.innerText || "").slice(0, 2000)`,
        ),
      ),
    },
    run,
    startedAt,
  );
};

const cmdSettingsState = async () => {
  const startedAt = Date.now();
  const run = requireRun();
  emitSuccess("settings.state", await readShellState(run), run, startedAt);
};

const cmdSettingsClose = async () => {
  const startedAt = Date.now();
  const run = requireRun();
  if ((await readShellState(run)).settingsOpen) {
    const searchValue = await withCdp(run, (ws) =>
      runtimeEvaluate(
        ws,
        `document.querySelector('input[placeholder="Search settings"]')?.value || ""`,
      ),
    );
    if (searchValue) {
      await fillQuery(run, { placeholder: "Search settings" }, "");
    }
    await dispatchKey(run, KEY_CODES.Escape);
  }
  const state = await waitForState(run, (value) => !value.settingsOpen);
  emitSuccess("settings.close", state, run, startedAt);
};

const APPS_TEXT_JS = `(() => {
  const visible = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden"
      && !el.closest('[inert], [aria-hidden="true"]')
      && rect.width > 0 && rect.height > 0
      && rect.right > 0 && rect.bottom > 0
      && rect.left < window.innerWidth && rect.top < window.innerHeight;
  };
  const surface = [...document.querySelectorAll(".apps-section__body, .apps-screen")].find(visible);
  if (!surface) throw new Error("The Apps surface is not visibly selected.");
  return (surface.innerText || "").slice(0, 4000);
})()`;

const cmdAppsOpen = async () => {
  const startedAt = Date.now();
  const run = requireRun();
  await openLauncherDestination(run, "Apps");
  await delay(250);
  const text = await withCdp(run, (ws) =>
    runtimeEvaluate(ws, APPS_TEXT_JS),
  );
  emitSuccess(
    "apps.open",
    { text: redactText(text), classification: "not-assessed" },
    run,
    startedAt,
  );
};

const cmdAppsState = async () => {
  const startedAt = Date.now();
  const run = requireRun();
  const text = await withCdp(run, (ws) =>
    runtimeEvaluate(ws, APPS_TEXT_JS),
  );
  emitSuccess(
    "apps.state",
    { text: redactText(text), classification: "not-assessed" },
    run,
    startedAt,
  );
};

const cmdAppsAsk = async () => {
  const startedAt = Date.now();
  const run = requireRun();
  await clickQuery(run, { role: "button", name: "Ask Stella to create an app" });
  await waitQuery(run, { selector: "textarea.composer-input" });
  const draft = await withCdp(run, (ws) =>
    runtimeEvaluate(
      ws,
      `([...document.querySelectorAll("textarea.composer-input")].find((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
      })?.value || "")`,
    ),
  );
  emitSuccess("apps.ask", { draft, state: await readShellState(run) }, run, startedAt);
};

const cmdEval = async (options) => {
  const run = requireRun();
  if (!options.js) fail("eval requires --js");
  const value = await withCdp(run, (ws) => runtimeEvaluate(ws, options.js));
  respond({ value: value ?? null }, run);
};

const cmdScreenshot = async (options) => {
  const run = requireRun();
  if (!options.path) fail("screenshot requires --path");
  const outPath = path.resolve(options.path);
  mkdirSync(path.dirname(outPath), { recursive: true });
  const data = await withCdp(run, (ws) =>
    cdpSend(ws, 20, "Page.captureScreenshot", { format: "png" }),
  );
  writeFileSync(outPath, Buffer.from(data.data, "base64"));
  respond({ path: outPath }, run);
};

const SNAPSHOT_JS = `(() => {
  const lines = [];
  const implicitRole = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    if (el.tagName === "BUTTON") return "button";
    if (el.tagName === "A") return "link";
    if (el.tagName === "TEXTAREA") return "textbox";
    if (el.tagName === "INPUT") return el.type === "search" ? "searchbox" : "textbox";
    if (el.tagName === "H1" || el.tagName === "H2") return el.tagName.toLowerCase();
    return null;
  };
  const nameOf = (el) =>
    (el.getAttribute("aria-label")
      || el.getAttribute("placeholder")
      || (el.childNodes.length && [...el.childNodes].every((n) => n.nodeType === 3)
        ? el.textContent
        : "")
      || "")
      .replace(/\\s+/g, " ")
      .trim();
  const walk = (el, depth) => {
    if (!(el instanceof Element)) return;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (style.display === "none" || style.visibility === "hidden" || el.closest('[inert], [aria-hidden="true"]')) return;
    if (rect.width > 0 && rect.height > 0 && (rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth || rect.top >= window.innerHeight)) return;
    const role = implicitRole(el);
    const name = nameOf(el);
    const testId = el.getAttribute("data-testid");
    if (role || name || testId) {
      lines.push(
        "  ".repeat(depth)
          + (role || el.tagName.toLowerCase())
          + (name ? ': "' + name.slice(0, 100) + '"' : "")
          + (testId ? " [data-testid=" + testId + "]" : ""),
      );
    }
    for (const child of el.children) walk(child, depth + 1);
  };
  lines.push("title: " + document.title);
  lines.push("href: " + location.href);
  walk(document.body, 0);
  return lines.join("\\n");
})()`;

const cmdSnapshot = async (options) => {
  const run = requireRun();
  if (!options.path) fail("snapshot requires --path");
  const outPath = path.resolve(options.path);
  mkdirSync(path.dirname(outPath), { recursive: true });
  const text = await withCdp(run, (ws) => runtimeEvaluate(ws, SNAPSHOT_JS));
  writeFileSync(outPath, `${text}\n`);
  respond({ path: outPath, bytes: Buffer.byteLength(text) }, run);
};

const cmdComponents = async () => {
  const startedAt = Date.now();
  const run = requireRun();
  const components = await withCdp(run, (ws) => runtimeEvaluate(ws, `(${DOM_TOOLS_JS}).components()`));
  emitSuccess("inspect.components", { components }, run, startedAt);
};

const cmdObserve = async (options) => {
  const startedAt = Date.now();
  const run = requireRun();
  if (!options.path) fail("inspect observe requires --path <artifact-directory>.");
  const before = options.since ? JSON.parse(readFileSync(path.resolve(options.since), "utf8")) : null;
  if (before && (before.runId !== run.runId || before.schemaVersion !== 1 || !before.state || !Array.isArray(before.components))) {
    fail("--since must reference an observation from this run.");
  }
  const directory = path.resolve(options.path);
  const stem = `observation-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const paths = { observation: path.join(directory, `${stem}.json`), screenshot: path.join(directory, `${stem}.png`), aria: path.join(directory, `${stem}.aria.txt`) };
  const capture = await withCdp(run, async (ws) => {
    const observed = await runtimeEvaluate(ws, `({ state: ${SHELL_STATE_JS}, components: (${DOM_TOOLS_JS}).components() })`);
    const accessibility = await cdpSend(ws, 21, "Accessibility.getFullAXTree", {});
    const screenshot = await cdpSend(ws, 20, "Page.captureScreenshot", { format: "png" });
    return { ...observed, accessibility: accessibility.nodes.filter((node) => !node.ignored).map((node) => ({
      nodeId: node.nodeId, parentId: node.parentId ?? null,
      role: node.role?.value ?? null, name: redactText(node.name?.value ?? ""),
      properties: Object.fromEntries((node.properties ?? []).filter((property) =>
        ["disabled", "checked", "selected", "expanded", "focused", "required"].includes(property.name)
      ).map((property) => [property.name, property.value?.value])),
    })), screenshot: screenshot.data };
  });
  const observation = {
    schemaVersion: 1, runId: run.runId,
    startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(),
    captureMode: "sequential-semantic-state-then-screenshot",
    state: capture.state,
    accessibility: capture.accessibility,
    controlScope: "light-dom; accessibility tree and screenshot may expose additional controls",
    components: capture.components.map((component) => ({ ...component, name: redactText(component.name) })),
    paths,
  };
  if (before) observation.changes = compareObservations(before, observation);
  mkdirSync(directory, { recursive: true });
  writeFileSync(paths.screenshot, Buffer.from(capture.screenshot, "base64"));
  writeFileSync(paths.aria, capture.accessibility.map((node) => `${node.nodeId} parent=${node.parentId} ${node.role} ${JSON.stringify(node.name)} ${JSON.stringify(node.properties)}`).join("\n") + "\n");
  writeFileSync(paths.observation, JSON.stringify(observation, null, 2) + "\n");
  emitSuccess("inspect.observe", observation, run, startedAt);
};

const cmdClickXy = async (options, positionals) => {
  const startedAt = Date.now();
  const run = requireRun();
  const x = Number(options.x ?? positionals[0]);
  const y = Number(options.y ?? positionals[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
    fail("drive click-xy requires non-negative --x and --y coordinates.");
  }
  await withCdp(run, async (ws) => {
    await cdpSend(ws, 60, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await cdpSend(ws, 61, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await cdpSend(ws, 62, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  });
  emitSuccess("drive.click-xy", { x, y }, run, startedAt);
};

const cmdScroll = async (options) => {
  const startedAt = Date.now();
  const run = requireRun();
  const x = Number(options.x ?? 0);
  const y = Number(options.y ?? 0);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    fail("drive scroll requires numeric --x and --y values.");
  }
  const result = await withCdp(run, (ws) =>
    runtimeEvaluate(
      ws,
      `(() => {
        const target = ${options.selector ? `document.querySelector(${JSON.stringify(options.selector)})` : "document.scrollingElement"};
        if (!target) throw new Error("Scroll target was not found.");
        const before = { left: target.scrollLeft, top: target.scrollTop };
        target.scrollBy({ left: ${x}, top: ${y}, behavior: "instant" });
        const after = { left: target.scrollLeft, top: target.scrollTop };
        return {
          ...after,
          moved: after.left !== before.left || after.top !== before.top,
          scrollable: target.scrollHeight > target.clientHeight || target.scrollWidth > target.clientWidth,
          scrollHeight: target.scrollHeight,
          clientHeight: target.clientHeight,
        };
      })()`,
    ),
  );
  emitSuccess("drive.scroll", result, run, startedAt);
};

const cmdPerfMetrics = async () => {
  const run = requireRun();
  const report = await withCdp(run, async (ws) => {
    await cdpSend(ws, 40, "Performance.enable", {});
    const result = await cdpSend(ws, 41, "Performance.getMetrics", {});
    return Object.fromEntries(
      (result.metrics ?? []).map(({ name, value }) => [name, value]),
    );
  });
  respond(report, run);
};

const cmdTrace = async (options) => {
  const run = requireRun();
  if (!options.path) fail("trace requires --path");
  const durationMs = boundedInteger(options.duration, 3_000, {
    min: 250,
    max: 10_000,
    label: "--duration",
  });
  const outPath = path.resolve(options.path);
  mkdirSync(path.dirname(outPath), { recursive: true });
  const traceEvents = await withCdp(run, async (ws) => {
    const events = [];
    let complete;
    const completed = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out while finishing the performance trace.")),
        COMMAND_TIMEOUT_MS,
      );
      complete = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    const onMessage = (event) => {
      let parsed;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (parsed.method === "Tracing.dataCollected") {
        events.push(...(parsed.params?.value ?? []));
      } else if (parsed.method === "Tracing.tracingComplete") {
        complete();
      }
    };
    ws.addEventListener("message", onMessage);
    try {
      await cdpSend(ws, 50, "Tracing.start", {
        categories:
          "devtools.timeline,v8.execute,blink.user_timing,disabled-by-default-devtools.timeline",
        options: "sampling-frequency=10000",
        transferMode: "ReportEvents",
      });
      await delay(durationMs);
      await cdpSend(ws, 51, "Tracing.end", {});
      await completed;
      return events;
    } finally {
      ws.removeEventListener("message", onMessage);
    }
  });
  writeJson(outPath, {
    traceEvents,
    metadata: {
      app: "Stella",
      runId: run.runId,
      durationMs,
      capturedAt: new Date().toISOString(),
    },
  });
  respond({ path: outPath, events: traceEvents.length, durationMs }, run);
};

const cmdProfile = async (options) => {
  const startedAt = Date.now();
  const run = requireRun();
  if (!options.path) fail("performance profile requires --path <file>.");
  const durationMs = boundedInteger(options.duration, 3_000, {
    min: 250,
    max: 10_000,
    label: "--duration",
  });
  const profile = await withCdp(run, async (ws) => {
    await cdpSend(ws, 70, "Profiler.enable", {});
    await cdpSend(ws, 71, "Profiler.start", {});
    await delay(durationMs);
    return cdpSend(ws, 72, "Profiler.stop", {});
  });
  const outPath = path.resolve(options.path);
  writeJson(outPath, profile.profile ?? profile);
  emitSuccess(
    "performance.profile",
    { path: outPath, durationMs, nodes: profile.profile?.nodes?.length ?? 0 },
    run,
    startedAt,
  );
};

const redactText = (value) =>
  String(value)
    .replace(/(authorization|token|password|api[_-]?key|cookie)(["'=:\s]+)[^\s",}]+/gi, "$1$2[REDACTED]")
    .replace(/[A-Za-z0-9+/=_-]{120,}/g, "[REDACTED_BLOB]")
    .slice(0, 2_000);

const captureEvents = (run, durationMs, setup, accept, limit = 200) =>
  withCdp(run, async (ws) => {
    const events = [];
    let dropped = 0;
    const onMessage = (event) => {
      let parsed;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const accepted = accept(parsed);
      if (accepted) {
        if (events.length < limit) events.push(accepted);
        else dropped += 1;
      }
    };
    ws.addEventListener("message", onMessage);
    try {
      await setup(ws);
      await delay(durationMs);
      return { events, dropped };
    } finally {
      ws.removeEventListener("message", onMessage);
    }
  });

const cmdConsole = async (options) => {
  const startedAt = Date.now();
  const run = requireRun();
  const durationMs = boundedInteger(options.duration, 2_000, {
    min: 100,
    max: 10_000,
    label: "--duration",
  });
  const limit = boundedInteger(options.limit, 50, {
    min: 1,
    max: 1_000,
    label: "--limit",
  });
  const { events, dropped } = await captureEvents(
    run,
    durationMs,
    async (ws) => {
      await cdpSend(ws, 80, "Runtime.enable", {});
      await cdpSend(ws, 81, "Log.enable", {});
    },
    (event) => {
      if (event.method === "Runtime.consoleAPICalled") {
        return {
          source: "console",
          level: event.params?.type ?? "log",
          message: redactText(
            (event.params?.args ?? []).map((arg) => arg.value ?? arg.description ?? "").join(" "),
          ),
          timestamp: event.params?.timestamp ?? null,
        };
      }
      if (event.method === "Log.entryAdded") {
        return {
          source: event.params?.entry?.source ?? "log",
          level: event.params?.entry?.level ?? "info",
          message: redactText(event.params?.entry?.text ?? ""),
          timestamp: event.params?.entry?.timestamp ?? null,
        };
      }
      return null;
    },
    limit,
  );
  emitSuccess("diagnostics.console", { durationMs, limit, dropped, events }, run, startedAt);
};

const captureNetwork = async (run, durationMs, limit) => {
  const requestUrls = new Map();
  return captureEvents(
    run,
    durationMs,
    (ws) => cdpSend(ws, 90, "Network.enable", { maxTotalBufferSize: 0 }),
    (event) => {
      const params = event.params ?? {};
      if (event.method === "Network.requestWillBeSent") {
        const rawUrl = params.request?.url ?? "";
        let origin = "";
        try {
          origin = new URL(rawUrl).origin;
        } catch {
          origin = rawUrl.slice(0, 120);
        }
        requestUrls.set(params.requestId, origin);
        return {
          type: "request",
          requestId: params.requestId,
          method: params.request?.method ?? null,
          origin,
          resourceType: params.type ?? null,
        };
      }
      if (event.method === "Network.responseReceived") {
        return {
          type: "response",
          requestId: params.requestId,
          origin: requestUrls.get(params.requestId) ?? null,
          status: params.response?.status ?? null,
          resourceType: params.type ?? null,
        };
      }
      if (event.method === "Network.loadingFailed") {
        return {
          type: "failed",
          requestId: params.requestId,
          origin: requestUrls.get(params.requestId) ?? null,
          error: redactText(params.errorText ?? "unknown"),
          canceled: Boolean(params.canceled),
        };
      }
      return null;
    },
    limit,
  );
};

const cmdNetworkLog = async (options) => {
  const startedAt = Date.now();
  const run = requireRun();
  const durationMs = boundedInteger(options.duration, 2_000, {
    min: 100,
    max: 10_000,
    label: "--duration",
  });
  const limit = boundedInteger(options.limit, 100, {
    min: 1,
    max: 1_000,
    label: "--limit",
  });
  const { events, dropped } = await captureNetwork(run, durationMs, limit);
  emitSuccess("diagnostics.network-log", { durationMs, limit, dropped, events }, run, startedAt);
};

const cmdNetworkSummary = async (options) => {
  const startedAt = Date.now();
  const run = requireRun();
  const durationMs = boundedInteger(options.duration, 2_000, {
    min: 100,
    max: 10_000,
    label: "--duration",
  });
  const limit = boundedInteger(options.limit, 500, {
    min: 1,
    max: 2_000,
    label: "--limit",
  });
  const { events, dropped } = await captureNetwork(run, durationMs, limit);
  const responses = events.filter((event) => event.type === "response");
  const summary = {
    requests: events.filter((event) => event.type === "request").length,
    responses: responses.length,
    failures: events.filter((event) => event.type === "failed").length,
    statuses: Object.fromEntries(
      [...new Set(responses.map((event) => event.status))].map((status) => [
        status,
        responses.filter((event) => event.status === status).length,
      ]),
    ),
    origins: [...new Set(events.map((event) => event.origin).filter(Boolean))].sort(),
  };
  emitSuccess("diagnostics.network-summary", { durationMs, limit, dropped, summary }, run, startedAt);
};

const cmdLogs = (options) => {
  const run = requireRun();
  const tail = boundedInteger(options.tail, 200, {
    min: 1,
    max: 2_000,
    label: "--tail",
  });
  const readTail = (filePath) => {
    if (!existsSync(filePath)) return [];
    return readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .slice(-tail)
      .map(redactText);
  };
  const electronPath = path.join(run.runDir, "electron.log");
  respond(
    {
      runId: run.runId,
      tail,
      electron: { path: electronPath, lines: readTail(electronPath) },
    },
    run,
  );
};

const cmdCleanupPlan = () => {
  const startedAt = Date.now();
  const run = requireRun();
  emitSuccess(
    "cleanup.plan",
    {
      wouldStop: {
        electronPid: run.electronPid,
      },
      wouldRemove: [run.userDataDir, POINTER_PATH],
      wouldKeep: [run.dataDir, run.evidenceDir],
    },
    run,
    startedAt,
  );
};

const options = parseArgs(process.argv.slice(2));
const resolved = options._.length === 0 && options.help
  ? resolveCommand(["help"])
  : resolveCommand(options._);
if (!resolved) {
  fail(`Unknown command.\n${usage}`, options._.length > 0 ? 1 : 0, {
    errorCode: "USAGE",
    recovery: "Run `help` or `capabilities` to inspect the supported command surface.",
  });
}
const command = resolved.entry.handler;
const positionals = resolved.positionals;
activeCommandId = resolved.entry.id;
if (resolved.entry.group !== "meta") {
  activeHelpHint = `Run \`node .agents/skills/verify-stella/control-stella.mjs ${resolved.entry.group} ${resolved.entry.name} --help\` for its options.`;
  if (options.help) {
    process.stdout.write(commandHelp(resolved.entry));
    process.exit(0);
  }
  const unknown = unknownOptions(resolved.entry, options);
  if (unknown.length) {
    const accepted = [...resolved.entry.flags, ...resolved.entry.switches].map((flag) => `--${flag}`);
    fail(`Unknown option${unknown.length > 1 ? "s" : ""} ${unknown.map((key) => `--${key}`).join(", ")}. Accepted: ${accepted.join(", ") || "none"}.`);
  }
  const extra = unexpectedPositionals(resolved.entry, positionals);
  if (extra.length) fail(`Unexpected argument${extra.length > 1 ? "s" : ""}: ${extra.join(" ")}.`);
}
try {
  switch (command) {
    case "help":
      process.stdout.write(usage);
      break;
    case "capabilities":
      emitSuccess("capabilities", capabilities());
      break;
    case "launch":
      await cmdLaunch(options);
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "stop":
      await cmdStop(options);
      break;
    case "info":
      cmdInfo();
      break;
    case "chat-ready":
      await cmdChatReady();
      break;
    case "chat-send":
      await cmdChatSend(options, positionals);
      break;
    case "chat-state":
      await cmdChatState();
      break;
    case "nav-home":
      await cmdNavHome();
      break;
    case "nav-files":
      await cmdNavDestination("nav.files", "Files");
      break;
    case "nav-browser":
      await cmdNavDestination("nav.browser", "Browser");
      break;
    case "settings-open":
      await cmdSettingsOpen();
      break;
    case "settings-tab":
      await cmdSettingsTab(options, positionals);
      break;
    case "settings-search":
      await cmdSettingsSearch(options, positionals);
      break;
    case "settings-state":
      await cmdSettingsState();
      break;
    case "settings-close":
      await cmdSettingsClose();
      break;
    case "apps-open":
      await cmdAppsOpen();
      break;
    case "apps-state":
      await cmdAppsState();
      break;
    case "apps-ask":
      await cmdAppsAsk();
      break;
    case "inspect-state":
      await cmdInspectState();
      break;
    case "observe":
      await cmdObserve(options);
      break;
    case "components":
      await cmdComponents();
      break;
    case "eval":
      await cmdEval(options);
      break;
    case "click":
      await cmdClick(options);
      break;
    case "click-xy":
      await cmdClickXy(options, positionals);
      break;
    case "fill":
      await cmdFill(options);
      break;
    case "press":
      await cmdPress(options);
      break;
    case "scroll":
      await cmdScroll(options);
      break;
    case "wait":
      await cmdWait(options);
      break;
    case "wait-settle":
      await cmdWaitSettle(options);
      break;
    case "screenshot":
      await cmdScreenshot(options);
      break;
    case "snapshot":
      await cmdSnapshot(options);
      break;
    case "perf-metrics":
      await cmdPerfMetrics();
      break;
    case "trace":
      await cmdTrace(options);
      break;
    case "profile":
      await cmdProfile(options);
      break;
    case "logs":
      cmdLogs(options);
      break;
    case "console":
      await cmdConsole(options);
      break;
    case "network-log":
      await cmdNetworkLog(options);
      break;
    case "network-summary":
      await cmdNetworkSummary(options);
      break;
    case "cleanup-plan":
      cmdCleanupPlan();
      break;
    default:
      fail(`Command handler is missing for ${activeCommandId}.`, 1, {
        errorCode: "UNIMPLEMENTED_COMMAND",
      });
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error), 1, {
    errorCode: error.code ?? (/timed out/i.test(String(error)) ? "TIMEOUT" : "COMMAND_FAILED"),
    candidates: error.candidates, count: error.count,
    recovery: error.code === "AMBIGUOUS_TARGET" || error.code === "TARGET_NOT_FOUND" ? "Run `inspect observe` or `inspect components`; narrow the query with --within or --selector." : "Run `session doctor`. If the instance is unhealthy, run `cleanup plan` before `session launch --replace`.",
    retryable: true,
  });
}
