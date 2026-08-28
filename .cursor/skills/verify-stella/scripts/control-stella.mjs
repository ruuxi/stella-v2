#!/usr/bin/env node
/**
 * Isolated launch/doctor/drive/cleanup helper for the Stella desktop app.
 * Invocation examples live in ../SKILL.md. Do not drive a session this
 * script did not start.
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import {
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
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const scriptPath = fileURLToPath(import.meta.url);
const skillRoot = path.resolve(path.dirname(scriptPath), "..");
const repoRoot = path.resolve(skillRoot, "../../..");
const POINTER_PATH = path.join(skillRoot, ".run", "current.json");
const DEFAULT_EVIDENCE_DIR = path.join(skillRoot, "artifacts");
const READY_SELECTOR = '[data-testid="conversation-topbar"]';
const LAUNCH_TIMEOUT_MS = 120_000;
const CDP_CONNECT_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 15_000;

const usage = `Usage: node .cursor/skills/verify-stella/scripts/control-stella.mjs <command> [options]

Commands:
  launch [--replace]
  doctor
  stop
  eval --js <javascript>
  click --name <accessible name> [--role <role>]
  fill --placeholder <text> --value <text>
  press --key <key>
  wait --selector <css> | --name <accessible name> | --text <substring>
  screenshot --path <file>
  snapshot --path <file>
  info
`;

const fail = (message, code = 1) => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};

const parseArgs = (argv) => {
  const options = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--replace") {
      options.replace = true;
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

const cdpTargets = async (cdpPort) => {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
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
  throw new Error(`Timed out waiting for Electron CDP on ${cdpPort} (${lastError}).`);
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
        reject(new Error(`${method}: ${parsed.error.message ?? JSON.stringify(parsed.error)}`));
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
    ws.addEventListener("error", () => reject(new Error("CDP websocket failed.")), {
      once: true,
    });
  });
  try {
    await cdpSend(ws, 1, "Runtime.enable", {});
    await cdpSend(ws, 2, "Page.enable", {});
    return await fn(ws);
  } finally {
    ws.close();
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
    assistantWorkingMode: "direct",
    assistantWorkingModeDefaultVersion: 1,
  });
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
  if (!run) fail("No verification instance. Run `control-stella launch` first.");
  return run;
};

const doctorReport = async (run) => {
  const report = {
    ok: false,
    runId: run.runId,
    dataDir: run.dataDir,
    userDataDir: run.userDataDir,
    viteUrl: run.viteUrl,
    cdpPort: run.cdpPort,
    vitePidAlive: isAlive(run.vitePid),
    electronPidAlive: isAlive(run.electronPid),
    viteHttp: false,
    cdp: false,
    shellReady: false,
    title: null,
    href: null,
    errors: [],
  };
  if (!report.vitePidAlive) report.errors.push("Vite process is not running.");
  if (!report.electronPidAlive) report.errors.push("Electron process is not running.");
  try {
    await waitForHttp(run.viteUrl, 2_000);
    report.viteHttp = true;
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
  }
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
          runtimeEvaluate(ws, `Boolean(document.querySelector(${JSON.stringify(READY_SELECTOR)}))`),
        ),
      );
      if (!report.shellReady) {
        report.errors.push(
          `Shell top bar ${READY_SELECTOR} is missing. Onboarding may still be covering the app.`,
        );
      }
    } catch (error) {
      report.errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  report.ok =
    report.vitePidAlive &&
    report.electronPidAlive &&
    report.viteHttp &&
    report.cdp &&
    report.shellReady;
  return report;
};

const cmdLaunch = async (options) => {
  const existing = currentRun();
  if (existing && (isAlive(existing.vitePid) || isAlive(existing.electronPid))) {
    if (!options.replace) {
      fail(
        `A verification instance is already running (runId ${existing.runId}). Pass --replace to stop it first, or drive that instance.`,
      );
    }
    await cmdStop({ silent: true });
  }

  const runId = randomUUID().slice(0, 8);
  const runDir = path.join(skillRoot, ".run", runId);
  const dataDir = path.join(runDir, "data");
  const userDataDir = path.join(runDir, "electron-user-data");
  mkdirSync(userDataDir, { recursive: true });
  seedDataDir(dataDir);

  const [vitePort, cdpPort] = await Promise.all([allocatePort(), allocatePort()]);
  const viteUrl = `http://127.0.0.1:${vitePort}`;
  const sharedEnv = {
    ...process.env,
    STELLA_SKIP_BROWSER_HYDRATE: "1",
    STELLA_DATA_DIR: dataDir,
    STELLA_V2_DEV_DATA_DIR: dataDir,
    STELLA_DEV_SERVER_URL: viteUrl,
  };

  process.stderr.write("Building Electron main bundle if needed...\n");
  const build = spawn(
    process.execPath,
    [path.join(repoRoot, "packages/desktop/scripts/dev-electron-build.mjs"), "--once"],
    { cwd: repoRoot, env: sharedEnv, stdio: "inherit" },
  );
  const buildCode = await new Promise((resolve) => build.on("exit", resolve));
  if (buildCode !== 0) fail(`dev-electron-build failed with exit ${buildCode}.`);

  process.stderr.write("Starting Vite under bun...\n");
  const vite = spawnLogged(
    bunBin(),
    [
      "--bun",
      path.join(repoRoot, "node_modules/vite/bin/vite.js"),
      "--host",
      "127.0.0.1",
      "--port",
      String(vitePort),
      "--strictPort",
    ],
    {
      cwd: path.join(repoRoot, "packages/desktop-ui"),
      env: sharedEnv,
      logPath: path.join(runDir, "vite.log"),
    },
  );

  const run = {
    runId,
    runDir,
    dataDir,
    userDataDir,
    viteUrl,
    vitePort,
    cdpPort,
    vitePid: vite.pid,
    electronPid: null,
    startedAt: new Date().toISOString(),
    evidenceDir: DEFAULT_EVIDENCE_DIR,
  };
  writeJson(POINTER_PATH, run);
  writeJson(path.join(runDir, "run.json"), run);

  try {
    await delay(400);
    if (!isAlive(vite.pid)) {
      const log = existsSync(path.join(runDir, "vite.log"))
        ? readFileSync(path.join(runDir, "vite.log"), "utf8")
        : "";
      throw new Error(`Vite exited before becoming ready.\n${log}`);
    }
    await waitForHttp(viteUrl, LAUNCH_TIMEOUT_MS);
    process.stderr.write("Starting Electron...\n");
    const electronArgs = [
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${cdpPort}`,
      "--no-sandbox",
      "--disable-gpu",
      "--disable-gpu-sandbox",
      "--in-process-gpu",
      "--enable-unsafe-swiftshader",
      "--disable-dev-shm-usage",
      "--ozone-platform=x11",
      ".",
      "--dev",
    ];
    const electron = spawnLogged(electronBin(), electronArgs, {
      cwd: repoRoot,
      env: {
        ...sharedEnv,
        NODE_ENV: "development",
        ELECTRON_OZONE_PLATFORM_HINT: "x11",
        LIBGL_ALWAYS_SOFTWARE: "1",
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
    if (!ready) throw new Error(`Electron window came up but the shell did not: ${lastError}`);
  } catch (error) {
    await stopPid(run.electronPid);
    await stopPid(run.vitePid);
    rmSync(POINTER_PATH, { force: true });
    throw error;
  }

  process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
};

const cmdStop = async ({ silent = false } = {}) => {
  const run = currentRun();
  if (!run) {
    if (!silent) process.stdout.write("No verification instance to stop.\n");
    return;
  }
  await stopPid(run.electronPid);
  await stopPid(run.vitePid);
  rmSync(POINTER_PATH, { force: true });
  if (!silent) {
    process.stdout.write(
      JSON.stringify(
        {
          stopped: true,
          runId: run.runId,
          evidenceDir: run.evidenceDir,
          dataDirKept: run.dataDir,
        },
        null,
        2,
      ) + "\n",
    );
  }
};

const cmdDoctor = async () => {
  const run = requireRun();
  const report = await doctorReport(run);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exit(2);
};

const cmdInfo = () => {
  const run = requireRun();
  process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
};

const FIND_ELEMENT_JS = String.raw`
({ role, name, placeholder, selector, text }) => {
  const visible = (el) => {
    if (!(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const implicitRole = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    if (el.tagName === "BUTTON") return "button";
    if (el.tagName === "A") return "link";
    if (el.tagName === "TEXTAREA") return "textbox";
    if (el.tagName === "INPUT") {
      if (el.type === "search") return "searchbox";
      if (el.type === "submit") return "button";
      return "textbox";
    }
    return el.tagName.toLowerCase();
  };
  const accessibleName = (el) =>
    (el.getAttribute("aria-label")
      || el.getAttribute("title")
      || el.getAttribute("placeholder")
      || el.textContent
      || "")
      .replace(/\s+/g, " ")
      .trim();
  if (selector) {
    const el = document.querySelector(selector);
    if (!el || !visible(el)) throw new Error("No visible node for " + selector);
    return el;
  }
  const nodes = [...document.querySelectorAll("button, a, input, textarea, [role], [aria-label], [placeholder]")];
  const match = nodes.find((el) => {
    if (!visible(el)) return false;
    if (placeholder && el.getAttribute("placeholder") !== placeholder) return false;
    if (role && implicitRole(el) !== role) return false;
    if (name && accessibleName(el) !== name) return false;
    if (text && !accessibleName(el).includes(text) && !(el.textContent || "").includes(text)) {
      return false;
    }
    return Boolean(role || name || placeholder || text);
  });
  if (!match) {
    throw new Error(
      "No visible match"
        + (role ? " role=" + role : "")
        + (name ? " name=" + name : "")
        + (placeholder ? " placeholder=" + placeholder : "")
        + (text ? " text=" + text : ""),
    );
  }
  return match;
}
`;

const evaluateFind = (ws, query) =>
  runtimeEvaluate(
    ws,
    `(${FIND_ELEMENT_JS})(${JSON.stringify(query)}); true`,
  );

const cmdClick = async (options) => {
  const run = requireRun();
  if (!options.name && !options.selector) fail("click requires --name or --selector");
  await withCdp(run, async (ws) => {
    const hit = await runtimeEvaluate(
      ws,
      `(() => {
        const el = (${FIND_ELEMENT_JS})(${JSON.stringify({
          role: options.role ?? null,
          name: options.name ?? null,
          selector: options.selector ?? null,
        })});
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
    process.stdout.write(`${JSON.stringify(hit)}\n`);
  });
};

const cmdFill = async (options) => {
  const run = requireRun();
  if (!options.value) fail("fill requires --value");
  if (!options.placeholder && !options.selector && !options.name) {
    fail("fill requires --placeholder, --name, or --selector");
  }
  await withCdp(run, (ws) =>
    runtimeEvaluate(
      ws,
      `(() => {
        const el = (${FIND_ELEMENT_JS})(${JSON.stringify({
          placeholder: options.placeholder ?? null,
          name: options.name ?? null,
          selector: options.selector ?? null,
          role: options.role ?? null,
        })});
        el.focus();
        const proto = el.tagName === "TEXTAREA"
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
        descriptor.set.call(el, ${JSON.stringify(options.value)});
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { value: el.value, placeholder: el.getAttribute("placeholder") };
      })()`,
    ),
  ).then((value) => process.stdout.write(`${JSON.stringify(value)}\n`));
};

const KEY_CODES = {
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  "/": { key: "/", code: "Slash", windowsVirtualKeyCode: 191 },
};

const cmdPress = async (options) => {
  const run = requireRun();
  const spec = KEY_CODES[options.key];
  if (!spec) fail(`Unknown key ${options.key}. Supported: ${Object.keys(KEY_CODES).join(", ")}`);
  await withCdp(run, async (ws) => {
    await cdpSend(ws, 10, "Input.dispatchKeyEvent", { type: "keyDown", ...spec });
    await cdpSend(ws, 11, "Input.dispatchKeyEvent", { type: "keyUp", ...spec });
  });
  process.stdout.write(`${JSON.stringify({ key: options.key })}\n`);
};

const cmdWait = async (options) => {
  const run = requireRun();
  const query = {
    selector: options.selector ?? null,
    name: options.name ?? null,
    text: options.text ?? null,
    placeholder: options.placeholder ?? null,
    role: options.role ?? null,
  };
  const deadline = Date.now() + (Number(options.timeout) || 10_000);
  let lastError = "not found";
  while (Date.now() < deadline) {
    try {
      await withCdp(run, (ws) => evaluateFind(ws, query));
      process.stdout.write(`${JSON.stringify({ ok: true, query })}\n`);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await delay(200);
    }
  }
  fail(`wait timed out: ${lastError}`);
};

const cmdEval = async (options) => {
  const run = requireRun();
  if (!options.js) fail("eval requires --js");
  const value = await withCdp(run, (ws) => runtimeEvaluate(ws, options.js));
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
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
  process.stdout.write(`${JSON.stringify({ path: outPath })}\n`);
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
    if (style.display === "none" || style.visibility === "hidden") return;
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
  process.stdout.write(`${JSON.stringify({ path: outPath, bytes: Buffer.byteLength(text) })}\n`);
};

const options = parseArgs(process.argv.slice(2));
const command = options._[0];
try {
  switch (command) {
    case "launch":
      await cmdLaunch(options);
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "stop":
      await cmdStop();
      break;
    case "info":
      cmdInfo();
      break;
    case "eval":
      await cmdEval(options);
      break;
    case "click":
      await cmdClick(options);
      break;
    case "fill":
      await cmdFill(options);
      break;
    case "press":
      await cmdPress(options);
      break;
    case "wait":
      await cmdWait(options);
      break;
    case "screenshot":
      await cmdScreenshot(options);
      break;
    case "snapshot":
      await cmdSnapshot(options);
      break;
    default:
      fail(usage, command ? 1 : 0);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
