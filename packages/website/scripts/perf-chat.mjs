#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http2 from "node:http2";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEBSITE = path.resolve(HERE, "..");
const REPO = path.resolve(WEBSITE, "../..");
const PUBLIC = path.join(WEBSITE, "public");
const HOST = "stella.sh";
const DEV_BACKEND = "https://stella-v2-cloud-builder-dev.fromyou.workers.dev";
const builtBackend = () => {
  const html = fs.readFileSync(path.join(PUBLIC, "chat-app", "index.html"), "utf8");
  return /<link rel="preconnect" href="([^"]+)"/.exec(html)?.[1]?.replace(/\/+$/, "") ?? "";
};
let BACKEND = DEV_BACKEND;

const HELP = `Lab benchmark for the web chat (packages/website/public/chat-app).

  VITE_STELLA_BACKEND_URL=${DEV_BACKEND} bun run build:chat
  node scripts/perf-chat.mjs --runs 9 --label before --out .perf/chat-before.json
  node scripts/perf-chat.mjs --compare .perf/chat-before.json .perf/chat-after.json

Serves public/ over HTTP/2 with brotli and the site's cache headers, maps
${HOST} to it in a throwaway headless Chromium, and loads /chat-app/ the way a
returning visitor does: a fresh HTTP cache, a signed-in session already in
storage (one dev test account, minted once through the admin API), CPU and
network throttled. Each run then reloads with a warm cache and types into the
composer.

Options:
  --runs N        runs (default 9)
  --cpu N         CPU throttling rate (default 4)
  --net NAME      fast4g | slow4g | none (default fast4g)
  --keys N        characters typed into the composer (default 40)
  --settle MS     time observed after the composer is typeable (default 3000)
  --label NAME    label stored in the result
  --out FILE      write raw runs as JSON
  --chrome PATH   Chrome/Chromium binary (or CHROME_PATH)
  --no-gpu        use SwiftShader instead of the hardware GPU
  --next URL      also proxy everything outside /chat-app/ to a running
                  \`next start\` and load the real /chat page around the frame
  --start-next    run \`next start\` on --port (default 3140) and use it as --next
`;

const NETWORKS = {
  none: null,
  fast4g: { offline: false, latency: 165, downloadThroughput: ((9e6 / 8) * 0.9), uploadThroughput: ((1.5e6 / 8) * 0.9) },
  slow4g: { offline: false, latency: 562.5, downloadThroughput: ((1.6e6 / 8) * 0.9), uploadThroughput: ((750e3 / 8) * 0.9) },
};

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".ico": "image/x-icon",
};
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".ttf", ".wasm"]);

const parseArgs = (argv) => {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
    else {
      out[a.slice(2)] = next;
      i += 1;
    }
  }
  return out;
};

const readDevVar = (name) => {
  if (process.env[name]) return process.env[name];
  const file = path.join(REPO, "workers/cloud-builder/.dev.vars");
  if (!fs.existsSync(file)) return "";
  const line = fs.readFileSync(file, "utf8").split("\n").find((entry) => entry.trim().startsWith(`${name}=`));
  return line ? line.trim().slice(name.length + 1).replace(/^["']|["']$/g, "") : "";
};

const sessionToken = async () => {
  const cache = path.join(os.tmpdir(), "stella-perf-chat-session.json");
  if (fs.existsSync(cache)) {
    const saved = JSON.parse(fs.readFileSync(cache, "utf8"));
    if (saved.backend === BACKEND) {
      const check = await fetch(`${BACKEND}/api/auth/get-session`, { headers: { authorization: `Bearer ${saved.token}` } });
      if (check.ok && (await check.json())?.user) return saved.token;
    }
  }
  const secret = readDevVar("STELLA_ADMIN_API_SECRET");
  if (!secret) throw new Error("Set STELLA_ADMIN_API_SECRET (or workers/cloud-builder/.dev.vars) to mint the dev test account.");
  const response = await fetch(`${BACKEND}/api/admin/test-accounts/session`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ email: "perf-chat@test.stella.local", plan: "pro", usageMode: "unlimited" }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.sessionToken) throw new Error(`Test account mint failed: HTTP ${response.status}`);
  fs.writeFileSync(cache, JSON.stringify({ backend: BACKEND, token: payload.sessionToken }), { mode: 0o600 });
  return payload.sessionToken;
};

const proxyNext = async (nextBase, req, res, url) => {
  const upstream = await fetch(`${nextBase}${url.pathname}${url.search}`, {
    headers: { accept: String(req.headers.accept ?? "*/*"), "accept-encoding": "identity" },
    redirect: "manual",
  });
  const body = Buffer.from(await upstream.arrayBuffer());
  const type = upstream.headers.get("content-type") ?? "application/octet-stream";
  const brotli = /text|javascript|json|svg|xml/.test(type) && /\bbr\b/.test(String(req.headers["accept-encoding"] ?? ""));
  const headers = { "content-type": type, vary: "accept-encoding" };
  for (const name of ["cache-control", "location", "content-security-policy"]) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  if (brotli) headers["content-encoding"] = "br";
  res.writeHead(upstream.status, headers);
  res.end(brotli ? zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }) : body);
};

const startServer = async (nextBase) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-chat-tls-"));
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", `/CN=${HOST}`,
    "-addext", `subjectAltName=DNS:${HOST}`, "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"),
  ], { stdio: "ignore" });
  const cache = new Map();
  const load = (file, ext) => {
    let entry = cache.get(file);
    if (!entry) {
      const raw = fs.readFileSync(file);
      entry = {
        raw,
        br: COMPRESSIBLE.has(ext)
          ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })
          : null,
      };
      cache.set(file, entry);
    }
    return entry;
  };
  const server = http2.createSecureServer({
    key: fs.readFileSync(path.join(dir, "key.pem")),
    cert: fs.readFileSync(path.join(dir, "cert.pem")),
    allowHTTP1: true,
  });
  server.on("request", (req, res) => {
    const url = new URL(req.url, `https://${HOST}`);
    let rel = decodeURIComponent(url.pathname);
    if (nextBase && !rel.startsWith("/chat-app/")) {
      proxyNext(nextBase, req, res, url).catch((error) => {
        res.writeHead(502);
        res.end(String(error));
      });
      return;
    }
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const entry = load(file, ext);
    const brotli = entry.br && /\bbr\b/.test(String(req.headers["accept-encoding"] ?? ""));
    res.writeHead(200, {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "cache-control": rel.startsWith("/chat-app/assets/")
        ? "public, max-age=31536000, immutable"
        : "public, max-age=0, must-revalidate",
      ...(brotli ? { "content-encoding": "br" } : {}),
      vary: "accept-encoding",
    });
    res.end(brotli ? entry.br : entry.raw);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, stop: () => server.close(), dir };
};

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener("message", (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result);
      } else for (const l of this.listeners) l(msg);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

const findChrome = (explicit) => {
  const found = [explicit, process.env.CHROME_PATH, "/usr/bin/chromium", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    .filter(Boolean)
    .find((c) => fs.existsSync(c));
  if (!found) throw new Error("No Chrome/Chromium found; pass --chrome <path> or set CHROME_PATH");
  return found;
};

const launchBrowser = async (chromePath, port, gpu) => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-chat-"));
  const proc = spawn(chromePath, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDir}`,
    `--host-resolver-rules=MAP ${HOST} 127.0.0.1:${port}`,
    "--ignore-certificate-errors",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    "--hide-scrollbars",
    "--mute-audio",
    ...(gpu ? ["--enable-gpu", "--ignore-gpu-blocklist"] : []),
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`Chrome did not start: ${buf}`)), 30000);
    proc.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.on("exit", (code) => reject(new Error(`Chrome exited ${code}: ${buf}`)));
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const cdp = new CDP(ws);
  return {
    cdp,
    close: async () => {
      try {
        await Promise.race([cdp.send("Browser.close"), sleep(3000)]);
      } catch {}
      ws.close();
      proc.kill();
      fs.rmSync(userDir, { recursive: true, force: true });
    },
  };
};

const probe = (token) => `(() => {
  if (!location.pathname.startsWith("/chat-app/")) return;
  try {
    if (!localStorage.getItem("better-auth_session_token")) {
      localStorage.setItem("better-auth_session_token", ${JSON.stringify(token)});
      localStorage.setItem("stella_auth_identity_intent", "connected");
      localStorage.setItem("stella-onboarding-complete", "true");
    }
  } catch (e) {}
  const pb = (window.__pb = { marks: {}, longtasks: [], loafs: [], events: [], commits: 0, lcp: 0 });
  const mark = (name) => { if (!(name in pb.marks)) pb.marks[name] = performance.now(); };
  const po = (type, fn, opts) => {
    try { new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe(Object.assign({ type, buffered: true }, opts || {})); } catch (e) {}
  };
  po("paint", (e) => { if (e.name === "first-contentful-paint") pb.marks.fcp = e.startTime; });
  po("largest-contentful-paint", (e) => { pb.lcp = e.startTime; });
  po("longtask", (e) => pb.longtasks.push([e.startTime, e.duration]));
  po("long-animation-frame", (e) => pb.loafs.push([e.startTime, e.duration, e.blockingDuration]));
  po("event", (e) => { if (e.interactionId) pb.events.push([e.name, e.startTime, e.duration, e.processingStart - e.startTime, e.processingEnd - e.processingStart]); }, { durationThreshold: 16 });
  const hook = {
    supportsFiber: true, renderers: new Map(),
    inject(r) { const id = hook.renderers.size + 1; hook.renderers.set(id, r); return id; },
    onCommitFiberRoot() { pb.commits += 1; },
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onScheduleFiberRoot() {}, checkDCE() {}, isDisabled: false,
  };
  try { Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", { value: hook, configurable: true }); } catch (e) {}
  window.__pbComposer = () => {
    for (const field of document.querySelectorAll("textarea.chat-composer-textarea")) {
      if (field.disabled || field.offsetParent === null) continue;
      const r = field.getBoundingClientRect();
      if (document.elementFromPoint(r.left + Math.min(40, r.width / 2), r.top + r.height / 2) === field) return field;
    }
    return null;
  };
  const tick = () => {
    if (document.querySelector(".shell-topbar-full, .shell-topbar")) mark("shell");
    if (window.__pbComposer()) mark("composer");
    const splash = document.getElementById("stella-launch");
    if (!splash || splash.dataset.exiting === "true") mark("splashExit");
    if ("composer" in pb.marks && "splashExit" in pb.marks) { mark("typeable"); return; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

const WIN = (opts) => (opts.page ? `document.getElementById("stella-chat-frame")?.contentWindow` : "window");

const COLLECT = (opts) => `((w) => {
  if (!w || !w.__pb) return null;
  const pb = w.__pb;
  const offset = w.performance.timeOrigin - performance.timeOrigin;
  const shift = (t) => t + offset;
  const res = [...w.performance.getEntriesByType("resource"), ...(w === window ? [] : performance.getEntriesByType("resource"))];
  const isJs = (r) => /\\.m?js(\\?|$)/.test(r.name);
  const isFont = (r) => /\\.(woff2?|ttf|otf)(\\?|$)/.test(r.name);
  const js = res.filter(isJs);
  return {
    marks: Object.fromEntries(Object.entries(pb.marks).map(([k, v]) => [k, shift(v)])),
    longtasks: pb.longtasks.map(([t, d]) => [shift(t), d]),
    commits: pb.commits,
    jsDecoded: js.reduce((a, r) => a + (r.decodedBodySize || 0), 0),
    jsEncoded: js.reduce((a, r) => a + (r.encodedBodySize || 0), 0),
    jsCount: js.length,
    fonts: res.filter(isFont).map((r) => [r.name.split("/").pop(), Math.round(r.encodedBodySize / 1024), Math.round(r.responseEnd)]),
    requests: res.length,
    domNodes: w.document.getElementsByTagName("*").length + (w === window ? 0 : document.getElementsByTagName("*").length),
    heapMB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null,
  };
})(${WIN(opts)})`;

const openPage = async (cdp, token, opts) => {
  const { browserContextId } = await cdp.send("Target.createBrowserContext", { disposeOnDetach: true });
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const s = (method, params) => cdp.send(method, params, sessionId);
  const events = [];
  const off = cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    events.push(msg);
    if (!opts.debug) return;
    if (msg.method === "Runtime.consoleAPICalled") {
      process.stderr.write(`[console.${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300)}\n`);
    } else if (msg.method === "Network.responseReceived" && !msg.params.response.url.includes("/chat-app/")) {
      process.stderr.write(`[net] ${msg.params.response.status} ${msg.params.response.url.slice(0, 160)}\n`);
    } else if (msg.method === "Network.loadingFailed") {
      process.stderr.write(`[net-fail] ${msg.params.errorText} ${msg.params.blockedReason ?? ""} ${msg.params.corsErrorStatus ? JSON.stringify(msg.params.corsErrorStatus) : ""}\n`);
    }
  });
  await Promise.all([s("Page.enable"), s("Network.enable"), s("Runtime.enable"), s("Performance.enable", { timeDomain: "timeTicks" })]);
  await s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  if (opts.cpu > 1) await s("Emulation.setCPUThrottlingRate", { rate: opts.cpu });
  if (NETWORKS[opts.net]) await s("Network.emulateNetworkConditions", NETWORKS[opts.net]);
  await s("Page.addScriptToEvaluateOnNewDocument", { source: probe(token) });
  const evaluate = async (expression) => {
    const r = await s("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`evaluate: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
    return r.result.value;
  };
  const metrics = async () => Object.fromEntries((await s("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  const transferred = () => {
    let bytes = 0;
    for (const e of events) if (e.method === "Network.loadingFinished") bytes += e.params.encodedDataLength;
    return bytes;
  };
  const close = async () => {
    off();
    try { await cdp.send("Target.disposeBrowserContext", { browserContextId }); } catch {}
  };
  return { s, evaluate, metrics, transferred, events, close };
};

const measureLoad = async (page, navigate, opts) => {
  page.events.length = 0;
  await navigate();
  const t0 = Date.now();
  let marks = null;
  while (Date.now() - t0 < 60000) {
    marks = await page.evaluate(`(() => { const w = ${WIN(opts)}; return w && w.__pb ? w.__pb.marks : null; })()`).catch(() => null);
    if (marks && "typeable" in marks) break;
    await sleep(50);
  }
  if (!marks || !("typeable" in marks)) throw new Error(`never typeable: ${JSON.stringify(marks)}`);
  await sleep(opts.settle);
  const d = await page.evaluate(COLLECT(opts));
  const m1 = await page.metrics();
  const typeable = Math.max(d.marks.typeable, d.marks.fcp ?? 0);
  if (opts.debug) process.stderr.write(`[fonts] ${JSON.stringify(d.fonts)}\n`);
  const blocking = (from, to) => d.longtasks.filter(([t]) => t >= from && t < to).reduce((a, [, dur]) => a + Math.max(0, dur - 50), 0);
  return {
    fcp: d.marks.fcp ?? null,
    composer: d.marks.composer,
    typeable,
    tbtBeforeTypeable: blocking(0, typeable),
    tbtAfterTypeable: blocking(typeable, typeable + opts.settle),
    longTasks: d.longtasks.filter(([t]) => t < typeable + opts.settle).length,
    reactCommits: d.commits,
    transferKB: page.transferred() / 1024,
    jsKB: d.jsEncoded / 1024,
    fontKB: d.fonts.reduce((a, [, kb]) => a + kb, 0),
    jsDecodedKB: d.jsDecoded / 1024,
    jsRequests: d.jsCount,
    requests: d.requests,
    domNodes: d.domNodes,
    scriptMs: m1.ScriptDuration * 1000,
    taskMs: m1.TaskDuration * 1000,
    styleMs: m1.RecalcStyleDuration * 1000,
    layoutMs: m1.LayoutDuration * 1000,
    heapMB: d.heapMB,
  };
};

const measureTyping = async (page, opts) => {
  const box = await page.evaluate(`(() => {
    const w = ${WIN(opts)};
    const el = w.__pbComposer();
    if (!el) return null;
    el.dataset.pbTarget = "1";
    const frame = w === window ? { left: 0, top: 0 } : w.frameElement.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { x: frame.left + r.left + Math.min(40, r.width / 2), y: frame.top + r.top + r.height / 2 };
  })()`);
  if (!box) return null;
  await page.s("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await page.s("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await sleep(500);
  const pbRef = `(${WIN(opts)}).__pb`;
  const before = await page.evaluate(`${pbRef}.events.length`);
  const lt0 = await page.evaluate(`${pbRef}.longtasks.length`);
  const m0 = await page.metrics();
  const text = "the quick brown fox jumps over the lazy dog again and again".slice(0, opts.keys);
  for (const ch of text) {
    await page.s("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch });
    await page.s("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
    await sleep(60);
  }
  await sleep(800);
  const m1 = await page.metrics();
  const events = await page.evaluate(`${pbRef}.events.slice(${before})`);
  const longtasks = await page.evaluate(`${pbRef}.longtasks.slice(${lt0})`);
  const value = await page.evaluate(`(${WIN(opts)}).document.querySelector("textarea[data-pb-target]")?.value ?? ""`);
  const byInteraction = new Map();
  for (const [, , dur] of events) byInteraction.set(byInteraction.size, dur);
  const durations = events.filter(([name]) => name === "keydown" || name === "keypress" || name === "input").map(([, , dur]) => dur).sort((a, b) => a - b);
  const pct = (q) => (durations.length ? durations[Math.min(durations.length - 1, Math.floor(q * durations.length))] : 16);
  return {
    typedOk: value.endsWith(text) ? 1 : 0,
    keyP50: pct(0.5),
    keyP90: pct(0.9),
    keyMax: durations.at(-1) ?? 16,
    slowKeys: durations.filter((d) => d > 50).length,
    typingScriptMs: (m1.ScriptDuration - m0.ScriptDuration) * 1000,
    typingStyleMs: (m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000,
    typingLayoutMs: (m1.LayoutDuration - m0.LayoutDuration) * 1000,
    typingLongTasks: longtasks.length,
  };
};

const quantile = (sorted, q) => {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};
const summarize = (values) => {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  return { n: v.length, median: quantile(v, 0.5), p25: quantile(v, 0.25), p75: quantile(v, 0.75), min: v[0], max: v.at(-1), values: v };
};
const fmt = (x) => {
  if (x === undefined || x === null || Number.isNaN(x)) return "-";
  const a = Math.abs(x);
  return a >= 100 ? x.toFixed(0) : a >= 10 ? x.toFixed(1) : a >= 1 ? x.toFixed(2) : x.toFixed(3);
};
const significant = (a, b) => {
  const all = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))].sort((x, y) => x.v - y.v);
  const ranks = new Array(all.length);
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].v === all[i].v) j += 1;
    for (let k = i; k <= j; k += 1) ranks[k] = (i + j) / 2 + 1;
    i = j + 1;
  }
  const r1 = all.reduce((acc, x, k) => acc + (x.g === 0 ? ranks[k] : 0), 0);
  const n1 = a.length;
  const n2 = b.length;
  const u1 = r1 - (n1 * (n1 + 1)) / 2;
  const u = Math.min(u1, n1 * n2 - u1);
  const mu = (n1 * n2) / 2;
  const sigma = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);
  return sigma > 0 && Math.abs(u - mu) / sigma > 1.96;
};

const printSummary = (result) => {
  console.log(`# ${result.meta.label || "run"} (${result.meta.date}, cpu ${result.meta.cpu}x, net ${result.meta.net})`);
  for (const [key, runs] of Object.entries(result.journeys)) {
    if (!runs.length) continue;
    console.log(`\n## ${key} (${runs.length} runs)\n| metric | median | p25–p75 | min–max |\n|---|---|---|---|`);
    for (const n of Object.keys(runs[0])) {
      const s = summarize(runs.map((r) => r[n]));
      console.log(`| ${n} | ${fmt(s.median)} | ${fmt(s.p25)}–${fmt(s.p75)} | ${fmt(s.min)}–${fmt(s.max)} |`);
    }
  }
};

const compare = (aPath, bPath) => {
  const a = JSON.parse(fs.readFileSync(aPath, "utf8"));
  const b = JSON.parse(fs.readFileSync(bPath, "utf8"));
  console.log(`# ${a.meta.label || aPath} → ${b.meta.label || bPath}`);
  for (const key of Object.keys(a.journeys)) {
    if (!a.journeys[key]?.length || !b.journeys[key]?.length) continue;
    console.log(`\n## ${key} (${a.journeys[key].length} vs ${b.journeys[key].length} runs)\n| metric | before median [p25–p75] | after median [p25–p75] | Δ% | verdict |\n|---|---|---|---|---|`);
    for (const n of Object.keys(a.journeys[key][0])) {
      const sa = summarize(a.journeys[key].map((r) => r[n]));
      const sb = summarize(b.journeys[key].map((r) => r[n]));
      const pct = sa.median ? ((sb.median - sa.median) / Math.abs(sa.median)) * 100 : 0;
      const verdict = sa.median === sb.median ? "same" : !significant(sa.values, sb.values) ? "noise" : n === "typedOk" ? (sb.median > sa.median ? "BETTER" : "WORSE") : sb.median < sa.median ? "BETTER" : "WORSE";
      console.log(`| ${n} | ${fmt(sa.median)} [${fmt(sa.p25)}–${fmt(sa.p75)}] | ${fmt(sb.median)} [${fmt(sb.p25)}–${fmt(sb.p75)}] | ${pct.toFixed(1)}% | ${verdict} |`);
    }
  }
};

const startNext = async (port) => {
  const local = path.join(WEBSITE, "node_modules", ".bin", "next");
  const nextBin = fs.existsSync(local) ? local : path.join(REPO, "node_modules", ".bin", "next");
  const proc = spawn(nextBin, ["start", "-p", String(port)], { cwd: WEBSITE, stdio: ["ignore", "ignore", "inherit"] });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 200; i += 1) {
    try {
      if ((await fetch(`${base}/chat`)).ok) return { base, stop: () => proc.kill() };
    } catch {}
    await sleep(150);
  }
  proc.kill();
  throw new Error(`next start did not come up on ${base}`);
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(HELP);
  if (args.compare) return compare(args.compare, args._[0]);
  if (!fs.existsSync(path.join(PUBLIC, "chat-app", "index.html"))) throw new Error("Build the chat first: bun run build:chat");
  const opts = {
    runs: Number(args.runs ?? 9),
    cpu: Number(args.cpu ?? 4),
    net: args.net ?? "fast4g",
    keys: Number(args.keys ?? 40),
    settle: Number(args.settle ?? 3000),
    debug: Boolean(args.debug),
    next: typeof args.next === "string" ? args.next.replace(/\/+$/, "") : "",
  };
  const nextServer = args["start-next"] ? await startNext(Number(args.port ?? 3140)) : null;
  if (nextServer) opts.next = nextServer.base;
  opts.page = Boolean(opts.next);
  BACKEND = builtBackend();
  if (BACKEND !== DEV_BACKEND) {
    throw new Error(`chat-app was built against ${BACKEND || "no backend"}; rebuild against dev: VITE_STELLA_BACKEND_URL=${DEV_BACKEND} bun run build:chat`);
  }
  const token = await sessionToken();
  const server = await startServer(opts.next);
  const browser = await launchBrowser(findChrome(typeof args.chrome === "string" ? args.chrome : ""), server.port, !args["no-gpu"]);
  const url = opts.page ? `https://${HOST}/chat` : `https://${HOST}/chat-app/index.html`;
  const result = {
    meta: { label: args.label || "", date: new Date().toISOString(), ...opts, backend: BACKEND },
    journeys: { cold: [], warm: [], typing: [] },
  };
  try {
    for (let i = 0; i < opts.runs; i += 1) {
      const page = await openPage(browser.cdp, token, opts);
      try {
        const cold = await measureLoad(page, () => page.s("Page.navigate", { url }), opts);
        const warm = await measureLoad(page, () => page.s("Page.reload", { ignoreCache: false }), opts);
        const typing = await measureTyping(page, opts);
        result.journeys.cold.push(cold);
        result.journeys.warm.push(warm);
        if (typing) result.journeys.typing.push(typing);
        process.stderr.write(
          `[${i + 1}/${opts.runs}] cold typeable=${fmt(cold.typeable)} fcp=${fmt(cold.fcp)} js=${fmt(cold.jsKB)}KB tbt=${fmt(cold.tbtBeforeTypeable)} | warm typeable=${fmt(warm.typeable)} | key p90=${fmt(typing?.keyP90)} max=${fmt(typing?.keyMax)} ok=${typing?.typedOk}\n`,
        );
        if (args.inspect && i === 0) {
          process.stderr.write(`${JSON.stringify(await page.evaluate(`[...document.querySelectorAll("textarea")].map((t) => ({ cls: t.className, ph: t.placeholder, val: t.value, dis: t.disabled, vis: t.offsetParent !== null, rect: t.getBoundingClientRect().toJSON(), focused: document.activeElement === t }))`), null, 1)}\n`);
        }
        if (args.screenshot && i === 0) {
          const shot = await page.s("Page.captureScreenshot", { format: "png" });
          fs.writeFileSync(args.screenshot, Buffer.from(shot.data, "base64"));
        }
      } catch (error) {
        process.stderr.write(`[${i + 1}/${opts.runs}] FAILED ${error.message}\n`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    server.stop();
    nextServer?.stop();
    fs.rmSync(server.dir, { recursive: true, force: true });
  }
  if (typeof args.out === "string") {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(result));
  }
  printSummary(result);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
