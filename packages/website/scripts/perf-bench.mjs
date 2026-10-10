#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEBSITE = path.resolve(HERE, "..");

const DEFAULT_JOURNEYS = [
  "load:/@desktop",
  "load:/@mobile",
  "load:/pricing@desktop",
  "load:/how-it-works@desktop",
  "scroll:/@desktop",
  "inp:/@desktop",
];

const PROFILES = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  mobile: {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36",
  },
};

const NETWORKS = {
  none: null,
  fast4g: {
    offline: false,
    latency: 165,
    downloadThroughput: ((9 * 1000 * 1000) / 8) * 0.9,
    uploadThroughput: ((1.5 * 1000 * 1000) / 8) * 0.9,
  },
  slow4g: {
    offline: false,
    latency: 562.5,
    downloadThroughput: ((1.6 * 1000 * 1000) / 8) * 0.9,
    uploadThroughput: ((750 * 1000) / 8) * 0.9,
  },
};

const INTERACTIONS = {
  "/": [
    { name: "makes-word", selector: '[aria-labelledby="makes-title"] h2 button:nth-of-type(2)' },
    { name: "faq-toggle", selector: "#faq details:nth-of-type(2) > summary" },
    { name: "header-get", selector: 'header a[href="#get"]' },
  ],
};

const HIGHER_IS_BETTER = new Set(["fps"]);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

const INSTRUMENT = `
(() => {
  const pb = (window.__pb = { fcp: 0, lcp: 0, lcpEl: "", lcpUrl: "", shifts: [], longtasks: [], loafs: [], events: [], commits: [] });
  const region = (n) => {
    const r = n && n.closest ? n.closest("section, header, footer, nav, [data-region]") : null;
    if (!r) return "(page)";
    const id = r.getAttribute("aria-labelledby") || r.id || r.getAttribute("data-region");
    if (id) return r.tagName.toLowerCase() + "#" + id;
    const c = typeof r.className === "string" ? r.className.trim().split(/\\s+/)[0] : "";
    return r.tagName.toLowerCase() + (c ? "." + c : "");
  };
  const desc = (n) => {
    if (!n) return "";
    if (n.nodeType !== 1) return n.nodeName || "";
    let s = n.tagName.toLowerCase();
    if (n.id) s += "#" + n.id;
    const c = typeof n.className === "string" ? n.className.trim().split(/\\s+/).slice(0, 2).join(".") : "";
    if (c) s += "." + c;
    return s;
  };
  const po = (type, fn, opts) => {
    try {
      new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe(Object.assign({ type, buffered: true }, opts || {}));
    } catch (e) {}
  };
  po("paint", (e) => { if (e.name === "first-contentful-paint") pb.fcp = e.startTime; });
  po("largest-contentful-paint", (e) => {
    pb.lcp = e.startTime;
    pb.lcpEl = region(e.element) + " :: " + desc(e.element);
    pb.lcpUrl = e.url || "";
  });
  po("layout-shift", (e) => {
    if (e.hadRecentInput) return;
    pb.shifts.push({ t: e.startTime, v: e.value, src: (e.sources || []).map((s) => region(s.node) + " :: " + desc(s.node)) });
  });
  po("longtask", (e) => pb.longtasks.push({ t: e.startTime, d: e.duration }));
  po("long-animation-frame", (e) => pb.loafs.push({ t: e.startTime, d: e.duration, b: e.blockingDuration }));
  po("event", (e) => {
    if (!e.interactionId) return;
    pb.events.push({ name: e.name, t: e.startTime, d: e.duration, id: e.interactionId, delay: e.processingStart - e.startTime, proc: e.processingEnd - e.processingStart, target: desc(e.target) });
  }, { durationThreshold: 16 });
  const hook = {
    supportsFiber: true,
    renderers: new Map(),
    inject(r) { const id = hook.renderers.size + 1; hook.renderers.set(id, r); return id; },
    onCommitFiberRoot() { pb.commits.push(performance.now()); },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onScheduleFiberRoot() {},
    checkDCE() {},
    isDisabled: false,
  };
  try { Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", { value: hook, configurable: true }); } catch (e) {}
})();
`;

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
        if (msg.error) p.reject(new Error(p.method + ": " + msg.error.message));
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

function findChrome(explicit) {
  const candidates = [
    explicit,
    process.env.CHROME_PATH,
    "/usr/bin/chromium",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) throw new Error("No Chrome/Chromium found; pass --chrome <path> or set CHROME_PATH");
  return found;
}

async function launchBrowser(chromePath, gpu) {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-bench-"));
  const flags = [
    "--headless=new",
    "--remote-debugging-port=0",
    "--user-data-dir=" + userDir,
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
  ];
  const proc = spawn(chromePath, flags, { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("Chrome did not start: " + buf)), 30000);
    proc.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.on("exit", (code) => reject(new Error("Chrome exited " + code + ": " + buf)));
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const cdp = new CDP(ws);
  const close = async () => {
    try {
      await Promise.race([cdp.send("Browser.close"), sleep(3000)]);
    } catch {}
    ws.close();
    proc.kill();
    fs.rmSync(userDir, { recursive: true, force: true });
  };
  return { cdp, close };
}

async function openPage(cdp, profileName, opts) {
  const profile = PROFILES[profileName];
  const { browserContextId } = await cdp.send("Target.createBrowserContext", { disposeOnDetach: true });
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const s = (method, params) => cdp.send(method, params, sessionId);
  const events = [];
  const requests = new Map();
  const off = cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    const p = msg.params;
    if (msg.method === "Network.requestWillBeSent") {
      if (p.request.url.startsWith("data:")) return;
      requests.set(p.requestId, { url: p.request.url, type: p.type, bytes: 0, done: false });
    } else if (msg.method === "Network.responseReceived") {
      const r = requests.get(p.requestId);
      if (r) {
        r.type = p.type;
        r.status = p.response.status;
      }
    } else if (msg.method === "Network.loadingFinished") {
      const r = requests.get(p.requestId);
      if (r) {
        r.bytes = p.encodedDataLength;
        r.done = true;
      }
    } else if (msg.method === "Network.loadingFailed") {
      const r = requests.get(p.requestId);
      if (r) {
        r.failed = true;
        r.done = true;
      }
    } else events.push(msg);
  });
  await Promise.all([
    s("Page.enable"),
    s("Network.enable"),
    s("Runtime.enable"),
    s("Performance.enable", { timeDomain: "timeTicks" }),
  ]);
  await s("Emulation.setDeviceMetricsOverride", {
    width: profile.width,
    height: profile.height,
    deviceScaleFactor: profile.deviceScaleFactor,
    mobile: profile.mobile,
  });
  if (profile.mobile) {
    await s("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await s("Network.setUserAgentOverride", { userAgent: profile.userAgent });
  }
  if (opts.cpu > 1) await s("Emulation.setCPUThrottlingRate", { rate: opts.cpu });
  const net = NETWORKS[opts.net];
  if (net) await s("Network.emulateNetworkConditions", net);
  await s("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT });
  const evaluate = async (expression) => {
    const r = await s("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("evaluate: " + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  };
  const metrics = async () => {
    const { metrics: list } = await s("Performance.getMetrics");
    return Object.fromEntries(list.map((m) => [m.name, m.value]));
  };
  const waitFor = async (method, timeout) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const i = events.findIndex((e) => e.method === method);
      if (i >= 0) return events.splice(i, 1)[0];
      await sleep(25);
    }
    throw new Error("timeout waiting for " + method);
  };
  const inflight = () => [...requests.values()].filter((r) => !r.done).length;
  const close = async () => {
    off();
    try {
      await cdp.send("Target.disposeBrowserContext", { browserContextId });
    } catch {}
  };
  return { s, evaluate, metrics, waitFor, requests, inflight, close, profile };
}

async function loadAndSettle(page, url, windowMs) {
  const t0 = Date.now();
  await page.s("Page.navigate", { url });
  await page.waitFor("Page.loadEventFired", 90000);
  let quietSince = Date.now();
  while (Date.now() - t0 < windowMs + 20000) {
    if (page.inflight() > 0) quietSince = Date.now();
    if (Date.now() - t0 >= windowMs && Date.now() - quietSince >= 1000) break;
    await sleep(50);
  }
}

function sessionCls(shifts) {
  let best = 0;
  let cur = 0;
  let first = -1;
  let prev = -1;
  for (const s of shifts) {
    if (prev >= 0 && s.t - prev < 1000 && s.t - first < 5000) cur += s.v;
    else {
      cur = s.v;
      first = s.t;
    }
    prev = s.t;
    if (cur > best) best = cur;
  }
  return best;
}

function bytesByType(requests) {
  const out = { js: 0, css: 0, font: 0, img: 0, media: 0, doc: 0, other: 0, total: 0, requests: 0, jsRequests: 0 };
  for (const r of requests.values()) {
    if (!r.done || r.failed) continue;
    out.requests += 1;
    out.total += r.bytes;
    const k =
      { Script: "js", Stylesheet: "css", Font: "font", Image: "img", Media: "media", Document: "doc" }[r.type] ||
      "other";
    out[k] += r.bytes;
    if (k === "js") out.jsRequests += 1;
  }
  return out;
}

const COLLECT = `(() => {
  const pb = window.__pb;
  const nav = performance.getEntriesByType("navigation")[0] || {};
  const res = performance.getEntriesByType("resource");
  const jsDecoded = res
    .filter((r) => r.initiatorType === "script" || /\\.js(\\?|$)/.test(r.name))
    .reduce((a, r) => a + (r.decodedBodySize || 0), 0);
  return {
    fcp: pb.fcp, lcp: pb.lcp, lcpEl: pb.lcpEl, lcpUrl: pb.lcpUrl,
    shifts: pb.shifts, longtasks: pb.longtasks, loafs: pb.loafs, commits: pb.commits,
    ttfb: nav.finalResponseHeadersStart || nav.responseStart, dcl: nav.domContentLoadedEventEnd, load: nav.loadEventEnd,
    jsDecoded,
    domNodes: document.getElementsByTagName("*").length,
  };
})()`;

async function runLoad(page, url, opts) {
  await loadAndSettle(page, url, opts.windowMs);
  const d = await page.evaluate(COLLECT);
  const m = await page.metrics();
  const bytes = bytesByType(page.requests);
  const lt = d.longtasks.filter((t) => t.t >= d.fcp && t.t < opts.windowMs);
  return {
    metrics: {
      ttfb: d.ttfb,
      fcp: d.fcp,
      lcp: d.lcp,
      hydrated: d.commits[0] ?? null,
      load: d.load,
      cls: sessionCls(d.shifts),
      tbt: lt.reduce((a, t) => a + Math.max(0, t.d - 50), 0),
      longTasks: lt.length,
      loafBlocking: d.loafs.filter((l) => l.t < opts.windowMs).reduce((a, l) => a + (l.b || 0), 0),
      reactCommits: d.commits.length,
      jsKB: bytes.js / 1024,
      jsDecodedKB: d.jsDecoded / 1024,
      cssKB: bytes.css / 1024,
      fontKB: bytes.font / 1024,
      imgKB: bytes.img / 1024,
      mediaKB: bytes.media / 1024,
      docKB: bytes.doc / 1024,
      totalKB: bytes.total / 1024,
      requests: bytes.requests,
      jsRequests: bytes.jsRequests,
      domNodes: d.domNodes,
      layouts: m.LayoutCount,
      styleRecalcs: m.RecalcStyleCount,
      layoutMs: m.LayoutDuration * 1000,
      styleMs: m.RecalcStyleDuration * 1000,
      scriptMs: m.ScriptDuration * 1000,
      taskMs: m.TaskDuration * 1000,
      heapMB: m.JSHeapUsedSize / 1048576,
    },
    info: { lcpEl: d.lcpEl, lcpUrl: d.lcpUrl, shifts: d.shifts },
  };
}

const SCROLL_START = `(() => {
  const sc = (window.__sc = { frames: [], stop: false, lt: __pb.longtasks.length, lo: __pb.loafs.length, c: __pb.commits.length, sh: __pb.shifts.length });
  const f = (t) => { sc.frames.push(t); if (!sc.stop) requestAnimationFrame(f); };
  requestAnimationFrame(f);
})()`;

const SCROLL_STOP = `(() => {
  const sc = window.__sc;
  sc.stop = true;
  const t0 = sc.frames[0];
  return {
    frames: sc.frames,
    longtasks: __pb.longtasks.slice(sc.lt).filter((t) => t.t >= t0),
    loafs: __pb.loafs.slice(sc.lo).filter((t) => t.t >= t0),
    commits: __pb.commits.length - sc.c,
    shifts: __pb.shifts.slice(sc.sh),
    scrollY: scrollY,
  };
})()`;

async function runScroll(page, url, opts) {
  await loadAndSettle(page, url, opts.windowMs);
  await page.evaluate("window.scrollTo(0, 0)");
  await sleep(500);
  const height = await page.evaluate("document.documentElement.scrollHeight - innerHeight");
  await page.evaluate(SCROLL_START);
  const m0 = await page.metrics();
  await page.s("Input.synthesizeScrollGesture", {
    x: Math.round(page.profile.width / 2),
    y: Math.round(page.profile.height / 2),
    yDistance: -height,
    speed: opts.scrollSpeed,
    gestureSourceType: page.profile.mobile ? "touch" : "mouse",
    preventFling: true,
  });
  await sleep(300);
  const m1 = await page.metrics();
  const d = await page.evaluate(SCROLL_STOP);
  const deltas = [];
  for (let i = 1; i < d.frames.length; i += 1) deltas.push(d.frames[i] - d.frames[i - 1]);
  const dur = (d.frames.at(-1) - d.frames[0]) / 1000;
  const sorted = [...deltas].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  return {
    metrics: {
      fps: deltas.length / dur,
      frameP50: pct(0.5),
      frameP95: pct(0.95),
      frameP99: pct(0.99),
      frameMax: sorted.at(-1) ?? 0,
      droppedFrames: deltas.reduce((a, x) => a + Math.max(0, Math.round(x / (1000 / 60)) - 1), 0),
      slowFrames: deltas.filter((x) => x > 25).length,
      jankMs: deltas.reduce((a, x) => a + Math.max(0, x - 1000 / 60), 0),
      longTasks: d.longtasks.length,
      longTaskMs: d.longtasks.reduce((a, t) => a + t.d, 0),
      loafBlocking: d.loafs.reduce((a, l) => a + (l.b || 0), 0),
      reactCommits: d.commits,
      layouts: m1.LayoutCount - m0.LayoutCount,
      styleRecalcs: m1.RecalcStyleCount - m0.RecalcStyleCount,
      layoutMs: (m1.LayoutDuration - m0.LayoutDuration) * 1000,
      styleMs: (m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000,
      scriptMs: (m1.ScriptDuration - m0.ScriptDuration) * 1000,
      taskMs: (m1.TaskDuration - m0.TaskDuration) * 1000,
      cls: sessionCls(d.shifts),
    },
    info: { scrolled: d.scrollY, height, seconds: dur, shifts: d.shifts },
  };
}

async function runInp(page, url, route, opts) {
  await loadAndSettle(page, url, opts.windowMs);
  const list = INTERACTIONS[route] || [];
  const metrics = {};
  const info = {};
  for (const it of list) {
    const box = await page.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(it.selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center", behavior: "instant" });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) {
      info[it.name] = "missing";
      continue;
    }
    await sleep(1200);
    const before = await page.evaluate("__pb.events.length");
    await page.s("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    await page.s("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await page.s("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await sleep(1500);
    const evs = await page.evaluate(`__pb.events.slice(${before})`);
    metrics["inp_" + it.name] = evs.reduce((a, e) => Math.max(a, e.d), 0) || 16;
    info[it.name] = evs;
  }
  metrics.inpWorst = Math.max(0, ...Object.values(metrics));
  return { metrics, info };
}

async function startServer(port) {
  const local = path.join(WEBSITE, "node_modules", ".bin", "next");
  const nextBin = fs.existsSync(local) ? local : path.resolve(WEBSITE, "../../node_modules/.bin/next");
  const proc = spawn(nextBin, ["start", "-p", String(port)], { cwd: WEBSITE, stdio: ["ignore", "ignore", "inherit"] });
  const base = "http://localhost:" + port;
  for (let i = 0; i < 200; i += 1) {
    try {
      const r = await fetch(base + "/");
      if (r.ok) return { base, stop: () => proc.kill() };
    } catch {}
    await sleep(150);
  }
  proc.kill();
  throw new Error("next start did not come up on " + base);
}

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function summarize(values) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  return { n: v.length, median: quantile(v, 0.5), p25: quantile(v, 0.25), p75: quantile(v, 0.75), min: v[0], max: v.at(-1), values: v };
}

function fmt(x) {
  if (x === undefined || x === null || Number.isNaN(x)) return "-";
  const a = Math.abs(x);
  if (a >= 100) return x.toFixed(0);
  if (a >= 10) return x.toFixed(1);
  if (a >= 1) return x.toFixed(2);
  return x.toFixed(3);
}

function mannWhitneySignificant(a, b) {
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
  const critical = { 5: 2, 6: 5, 7: 8, 8: 13, 9: 17, 10: 23, 11: 30, 12: 37 };
  if (n1 === n2 && critical[n1] !== undefined) return u <= critical[n1];
  const mu = (n1 * n2) / 2;
  const sigma = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);
  return sigma > 0 && Math.abs(u - mu) / sigma > 1.96;
}

function verdict(name, base, after) {
  if (!base.n || !after.n) return "";
  if (base.median === after.median) return "same";
  if (!mannWhitneySignificant(base.values, after.values)) return "noise";
  const improved = HIGHER_IS_BETTER.has(name) ? after.median > base.median : after.median < base.median;
  return improved ? "BETTER" : "WORSE";
}

function mostCommon(list) {
  const c = {};
  for (const x of list) c[x] = (c[x] || 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
}

function printSummary(result) {
  console.log("# " + (result.meta.label || "run") + " (" + result.meta.date + ", cpu " + result.meta.cpu + "x, net " + result.meta.net + ")");
  for (const [key, runs] of Object.entries(result.journeys)) {
    if (!runs.length) continue;
    console.log("\n## " + key + " (" + runs.length + " runs)");
    console.log("| metric | median | p25–p75 | min–max |");
    console.log("|---|---|---|---|");
    for (const n of Object.keys(runs[0].metrics)) {
      const s = summarize(runs.map((r) => r.metrics[n]));
      console.log("| " + n + " | " + fmt(s.median) + " | " + fmt(s.p25) + "–" + fmt(s.p75) + " | " + fmt(s.min) + "–" + fmt(s.max) + " |");
    }
    const lcpEls = runs.map((r) => r.info?.lcpEl).filter(Boolean);
    if (lcpEls.length) console.log("\nLCP element: " + mostCommon(lcpEls) + " " + (runs[0].info.lcpUrl || ""));
    const regions = {};
    for (const r of runs) {
      for (const sh of r.info?.shifts ?? []) {
        const srcs = sh.src.length ? sh.src : ["(unattributed)"];
        for (const src of srcs) {
          const k = src.split(" :: ")[0];
          regions[k] = (regions[k] || 0) + sh.v / runs.length / srcs.length;
        }
      }
    }
    const top = Object.entries(regions).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (top.length) console.log("Layout shift by region (mean per run): " + top.map(([k, v]) => k + "=" + v.toFixed(4)).join(", "));
  }
}

function compare(aPath, bPath) {
  const a = JSON.parse(fs.readFileSync(aPath, "utf8"));
  const b = JSON.parse(fs.readFileSync(bPath, "utf8"));
  console.log("# " + (a.meta.label || aPath) + " → " + (b.meta.label || bPath));
  for (const key of Object.keys(a.journeys)) {
    if (!b.journeys[key]?.length || !a.journeys[key].length) continue;
    console.log("\n## " + key + " (" + a.journeys[key].length + " vs " + b.journeys[key].length + " runs)");
    console.log("| metric | before median [p25–p75] | after median [p25–p75] | Δ | Δ% | verdict |");
    console.log("|---|---|---|---|---|---|");
    for (const n of Object.keys(a.journeys[key][0].metrics)) {
      const sa = summarize(a.journeys[key].map((r) => r.metrics[n]));
      const sb = summarize(b.journeys[key].map((r) => r.metrics[n]));
      const delta = sb.median - sa.median;
      const pct = sa.median ? (delta / Math.abs(sa.median)) * 100 : 0;
      console.log(
        "| " + n + " | " + fmt(sa.median) + " [" + fmt(sa.p25) + "–" + fmt(sa.p75) + "] | " + fmt(sb.median) + " [" + fmt(sb.p25) + "–" + fmt(sb.p75) + "] | " + fmt(delta) + " | " + pct.toFixed(1) + "% | " + verdict(n, sa, sb) + " |",
      );
    }
  }
}

const HELP = `Lab benchmark for the Stella website (production build).

  bun run build
  node scripts/perf-bench.mjs --start --runs 7 --label before --out .perf/before.json
  node scripts/perf-bench.mjs --compare .perf/before.json .perf/after.json

Options:
  --start               run "next start" on --port (default 3123) for the duration
  --base URL            benchmark an already running server instead
  --targets A=URL,B=URL interleave two running servers run by run (ABBA order),
                        write <out-dir>/A.json and B.json and print the comparison
  --out-dir DIR         where --targets writes results (default .perf)
  --runs N              runs per journey (default 7)
  --journeys LIST       comma list of kind:route@profile, kind = load | scroll | inp,
                        profile = desktop | mobile (default ${DEFAULT_JOURNEYS.join(",")})
  --cpu N               CPU throttling rate (default 4)
  --net NAME            fast4g | slow4g | none (default fast4g)
  --window MS           observation window per load (default 12000)
  --scroll-speed PX     scroll gesture speed in px/s (default 1600)
  --no-gpu              use SwiftShader instead of the hardware GPU
  --chrome PATH         Chrome/Chromium binary (or CHROME_PATH)
  --label NAME          label stored in the result
  --out FILE            write raw runs as JSON
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.compare) {
    compare(args.compare, args._[0]);
    return;
  }
  const runs = Number(args.runs ?? 7);
  const opts = {
    cpu: Number(args.cpu ?? 4),
    net: args.net ?? "fast4g",
    windowMs: Number(args.window ?? 12000),
    scrollSpeed: Number(args["scroll-speed"] ?? 1600),
  };
  const journeys = (typeof args.journeys === "string" ? args.journeys.split(",") : DEFAULT_JOURNEYS).map((j) => {
    const m = j.match(/^(load|scroll|inp):([^@]+)(?:@(\w+))?$/);
    if (!m) throw new Error("bad journey " + j);
    return { key: j, kind: m[1], route: m[2], profile: m[3] || "desktop" };
  });
  let server = null;
  let targets;
  if (typeof args.targets === "string") {
    targets = args.targets.split(",").map((t) => {
      const [name, url] = t.split("=");
      return { name, base: url.replace(/\/$/, "") };
    });
  } else {
    let base = typeof args.base === "string" ? args.base.replace(/\/$/, "") : "";
    if (args.start || !base) {
      server = await startServer(Number(args.port ?? 3123));
      base = server.base;
    }
    targets = [{ name: typeof args.label === "string" ? args.label : "run", base }];
  }
  for (const t of targets) for (const j of journeys) await fetch(t.base + j.route).then((r) => r.text());
  const chrome = findChrome(typeof args.chrome === "string" ? args.chrome : "");
  const browser = await launchBrowser(chrome, !args["no-gpu"]);
  const results = targets.map((t) => ({
    meta: { label: targets.length > 1 ? t.name : args.label || "", date: new Date().toISOString(), base: t.base, runs, ...opts, chrome, gpu: !args["no-gpu"] },
    journeys: Object.fromEntries(journeys.map((j) => [j.key, []])),
  }));
  try {
    for (let i = 0; i < runs; i += 1) {
      for (const j of journeys) {
        const order = targets.map((_, k) => k);
        if (i % 2 === 1) order.reverse();
        for (const k of order) {
          const page = await openPage(browser.cdp, j.profile, opts);
          const tag = targets.length > 1 ? " " + targets[k].name : "";
          try {
            const url = targets[k].base + j.route;
            const r =
              j.kind === "load"
                ? await runLoad(page, url, opts)
                : j.kind === "scroll"
                  ? await runScroll(page, url, opts)
                  : await runInp(page, url, j.route, opts);
            results[k].journeys[j.key].push(r);
            const brief = Object.entries(r.metrics).slice(0, 7).map(([key, v]) => key + "=" + fmt(v)).join(" ");
            process.stderr.write("[" + (i + 1) + "/" + runs + "]" + tag + " " + j.key + " " + brief + "\n");
          } catch (e) {
            process.stderr.write("[" + (i + 1) + "/" + runs + "]" + tag + " " + j.key + " FAILED " + e.message + "\n");
          } finally {
            await page.close();
          }
        }
      }
    }
  } finally {
    await browser.close();
    server?.stop();
  }
  if (targets.length > 1) {
    const dir = typeof args["out-dir"] === "string" ? args["out-dir"] : ".perf";
    fs.mkdirSync(dir, { recursive: true });
    const files = targets.map((t, k) => {
      const file = path.join(dir, t.name + ".json");
      fs.writeFileSync(file, JSON.stringify(results[k]));
      return file;
    });
    compare(files[0], files[1]);
    return;
  }
  if (typeof args.out === "string") {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(results[0]));
  }
  printSummary(results[0]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
