#!/usr/bin/env bun
/**
 * Runtime-worker perf lab. Deterministic lab measurements for the journeys
 * that matter, a baseline, and a ratchet. See README.md next to this file.
 *
 *   bun packages/runtime/scripts/perf/bench.mjs <command> [options]
 *
 * Commands: boot | turn | history | memory | bundle | profile | validate |
 *           all | check
 *
 * Every worker this script spawns runs with a scratch HOME, data dir and
 * runtime-state dir under --lab-dir, a minimal allowlisted environment (no
 * inherited API keys or STELLA_* vars), and the probe preload
 * (probe-preload.ts): network guard + scripted fake model provider +
 * counters. Nothing touches ~/.stella and nothing leaves the machine.
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = import.meta.dirname;
const REPO = path.resolve(HERE, "..", "..", "..", "..");
const SOURCE_ENTRY = path.join(REPO, "packages", "runtime", "worker", "entry.ts");
const BUNDLE_ENTRY = path.join(
  REPO,
  "packages",
  "desktop",
  "dist-electron",
  "runtime",
  "worker",
  "entry.js",
);
const PRELOAD = path.join(HERE, "probe-preload.ts");
const BASELINE_PATH = path.join(HERE, "baseline.json");
const BUN = process.env.STELLA_PERF_BUN?.trim() || "bun";

// ------------------------------------------------------------------ cli
const parseCli = (argv) => {
  const [command = "help", ...rest] = argv;
  const opts = { _: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) {
      opts._.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = arg.slice(2, eq > 0 ? eq : undefined);
    if (eq > 0) opts[key] = arg.slice(eq + 1);
    else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith("--")) {
      opts[key] = rest[i + 1];
      i += 1;
    } else opts[key] = true;
  }
  return { command, opts };
};
const { command, opts } = parseCli(process.argv.slice(2));
const LAB_DIR = path.resolve(
  String(
    opts["lab-dir"] ??
      process.env.STELLA_PERF_LAB_DIR ??
      path.join(os.tmpdir(), "stella-perf-lab"),
  ),
);
const JSON_OUT = Boolean(opts.json);
const intOpt = (key, fallback) => {
  const value = Number.parseInt(String(opts[key] ?? ""), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const listOpt = (key, fallback) =>
  opts[key] === undefined
    ? fallback
    : String(opts[key])
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
const log = (...args) => {
  if (!opts.quiet) process.stderr.write(`[perf] ${args.join(" ")}\n`);
};

// ------------------------------------------------------------------ stats
const quantile = (values, q) => {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};
const summarize = (values) => {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return null;
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  return {
    n: clean.length,
    p50: round(quantile(clean, 0.5)),
    p95: round(quantile(clean, 0.95)),
    min: round(Math.min(...clean)),
    max: round(Math.max(...clean)),
    mean: round(mean),
  };
};
const round = (v, digits = 2) =>
  v == null ? v : Math.round(v * 10 ** digits) / 10 ** digits;
const pearson = (xs, ys) => {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return dx === 0 || dy === 0 ? null : round(num / Math.sqrt(dx * dy), 3);
};
const spearman = (xs, ys) => {
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const ranks = new Array(arr.length);
    idx.forEach(([, i], r) => (ranks[i] = r));
    return ranks;
  };
  return pearson(rank(xs), rank(ys));
};

// ------------------------------------------------------------------ fs helpers
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });
const mkdirp = (p) => fs.mkdirSync(p, { recursive: true });
const copyDir = (from, to) => {
  rmrf(to);
  fs.cpSync(from, to, { recursive: true });
};
let runCounter = 0;
const newRunDir = (label) => {
  runCounter += 1;
  const dir = path.join(LAB_DIR, "runs", `${Date.now().toString(36)}-${runCounter}-${label}`);
  mkdirp(dir);
  return dir;
};
const writeJson = (file, value) => {
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

/** Seed the scratch data dir: fake-provider model pin + a Read fixture. */
const prepareDataDir = (dataDir) => {
  mkdirp(dataDir);
  writeJson(path.join(dataDir, "models.json"), {
    providers: {
      perf: {
        name: "Perf lab (scripted)",
        baseUrl: "http://127.0.0.1:9",
        apiKey: "perf-lab-not-a-secret",
        api: "perf-scripted",
        models: [
          {
            id: "scripted",
            name: "Scripted",
            reasoning: false,
            input: ["text"],
            contextWindow: 200000,
            maxTokens: 8192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  });
  const prefsPath = path.join(dataDir, "preferences.json");
  if (!fs.existsSync(prefsPath)) {
    writeJson(prefsPath, {
      defaultModels: {},
      modelOverrides: {
        orchestrator: "perf/scripted",
        general: "perf/scripted",
        explore: "perf/scripted",
      },
    });
  }
  fs.writeFileSync(
    path.join(dataDir, "perf-fixture.txt"),
    "perf-lab fixture\nline two\nline three\n",
  );
};

const workerEnv = ({ runDir, dataDir, cacheDir, entryKind, census = false, sqlCounters = true }) => {
  const home = path.join(LAB_DIR, "home");
  mkdirp(home);
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: path.join(runDir, "tmp"),
    LANG: process.env.LANG ?? "en_US.UTF-8",
    USER: process.env.USER ?? "perf",
    HOME: home,
    TZ: "UTC",
    NO_COLOR: "1",
    STELLA_APP_DIR: REPO,
    STELLA_DATA_DIR: dataDir,
    STELLA_RUNTIME_STATE_DIR: path.join(runDir, "state"),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: cacheDir,
    STELLA_PERF_FAKE_PROVIDER: entryKind === "source" ? "1" : "0",
    STELLA_PERF_FAKE_TOOL: "Read",
    STELLA_PERF_FAKE_TOOL_ARGS: JSON.stringify({
      file_path: path.join(dataDir, "perf-fixture.txt"),
    }),
  };
  // Bundle runs resolve runtime assets (extensions, agent markdown) from the
  // dist-electron tree, exactly as a packaged app resolves Resources/runtime.
  if (entryKind === "bundle") {
    env.STELLA_APP_RESOURCES_PATH = path.join(REPO, "packages", "desktop", "dist-electron");
  }
  if (census) env.STELLA_PERF_MODULE_CENSUS = "1";
  if (!sqlCounters) env.STELLA_PERF_SQL_COUNTERS = "0";
  mkdirp(env.TMPDIR);
  return env;
};

// ------------------------------------------------------------------ boot rpc accounting
/**
 * Boot JSON-RPC accounting, bench side, in stdout order. Counts every line the
 * worker writes during boot EXCEPT the responses to the bench's own probes
 * (`internal.worker.readyz` and the 5ms `internal.worker.health` polls, whose
 * count depends on timing). What remains is deterministic per tree: the
 * initialize response, notifications, and worker→host requests.
 *
 * Bytes are measured after replacing the lab dir and repo paths with fixed
 * tokens (and a per-run dir with `<run>`), so a longer checkout or temp path
 * on a CI runner does not move the byte count.
 */
const PROBE_METHODS = new Set(["internal.worker.readyz", "internal.worker.health"]);
const newBootAccount = () => ({
  lines: 0,
  bytes: 0,
  notifications: {},
  notificationBytes: {},
  hostRequests: {},
});
let pathTokens = null;
const normalizePaths = (line) => {
  if (!pathTokens) {
    const real = (p) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return p;
      }
    };
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const labs = [...new Set([real(LAB_DIR), LAB_DIR])].sort((a, b) => b.length - a.length);
    const repos = [...new Set([real(REPO), REPO])].sort((a, b) => b.length - a.length);
    pathTokens = {
      run: new RegExp(`(?:${labs.map(esc).join("|")})/runs/[^/"\\\\]+`, "g"),
      lab: new RegExp(labs.map(esc).join("|"), "g"),
      repo: new RegExp(repos.map(esc).join("|"), "g"),
    };
  }
  return line
    .replace(pathTokens.run, "<run>")
    .replace(pathTokens.lab, "<lab>")
    .replace(pathTokens.repo, "<repo>");
};
const bootAccount = (acct, msg, line, responseMethod) => {
  if (responseMethod && PROBE_METHODS.has(responseMethod)) return;
  const bytes = Buffer.byteLength(normalizePaths(line)) + 1;
  acct.lines += 1;
  acct.bytes += bytes;
  if (!("method" in msg)) return;
  if ("id" in msg) {
    acct.hostRequests[msg.method] = (acct.hostRequests[msg.method] ?? 0) + 1;
    return;
  }
  const key = msg.method === "run.event" ? `run.event:${msg.params?.type ?? "?"}` : msg.method;
  acct.notifications[key] = (acct.notifications[key] ?? 0) + 1;
  acct.notificationBytes[key] = (acct.notificationBytes[key] ?? 0) + bytes;
};
/** Notifications always reported (0 when absent) so a baseline key never goes missing. */
const TRACKED_BOOT_NOTIFICATIONS = ["modelCatalog.updated"];
/**
 * Fold per-run boot accounts into max values (the gate is conservative) and
 * list every field whose value differed between runs (should be empty).
 */
const foldBootAccounts = (accounts) => {
  const out = { lines: 0, bytes: 0, notificationsTotal: 0, hostRequestsTotal: 0, notifications: {}, notificationBytes: {}, hostRequests: {} };
  const seen = {};
  const note = (key, value) => {
    (seen[key] ??= new Set()).add(value);
  };
  const keysOf = (field) => new Set(accounts.flatMap((a) => Object.keys(a[field])));
  for (const name of TRACKED_BOOT_NOTIFICATIONS) out.notifications[name] = 0;
  for (const a of accounts) {
    const notifTotal = Object.values(a.notifications).reduce((x, y) => x + y, 0);
    const hostTotal = Object.values(a.hostRequests).reduce((x, y) => x + y, 0);
    for (const [key, value] of [["lines", a.lines], ["bytes", a.bytes], ["notificationsTotal", notifTotal], ["hostRequestsTotal", hostTotal]]) {
      out[key] = Math.max(out[key], value);
      note(key, value);
    }
  }
  for (const field of ["notifications", "notificationBytes", "hostRequests"]) {
    for (const key of keysOf(field)) {
      for (const a of accounts) {
        const value = a[field][key] ?? 0;
        out[field][key] = Math.max(out[field][key] ?? 0, value);
        note(`${field}.${key}`, value);
      }
    }
  }
  out.nondeterministic = Object.entries(seen)
    .filter(([, values]) => values.size > 1)
    .map(([key, values]) => `${key}=${[...values].join("/")}`);
  return out;
};

// ------------------------------------------------------------------ worker client
const PERF_PREFIX = "@@PERF ";
const hostIdentity = (() => {
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  return {
    deviceId: "perf-lab-device",
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
})();

class WorkerClient {
  constructor({ entry, entryKind, env, cpuProfDir = null, cpuProfInterval = 500 }) {
    this.entry = entry;
    this.entryKind = entryKind;
    this.env = env;
    this.cpuProfDir = cpuProfDir;
    this.cpuProfInterval = cpuProfInterval;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.perfWaiters = [];
    this.stderrTail = [];
    this.rx = { lines: 0, bytes: 0, byMethod: {} };
    this.hostRequests = {};
    this.lastMessageAt = 0;
    this.exited = null;
    // Boot accounting (see bootAccount): active from spawn until endBootAccounting().
    this.bootAcct = newBootAccount();
    this.bootAcctAtReady = null;
  }

  endBootAccounting() {
    const settled = this.bootAcct;
    this.bootAcct = null;
    return settled;
  }

  now() {
    return performance.now();
  }

  start() {
    const args = ["--preload", PRELOAD];
    if (this.cpuProfDir) {
      mkdirp(this.cpuProfDir);
      args.push(
        "--cpu-prof",
        `--cpu-prof-dir=${this.cpuProfDir}`,
        `--cpu-prof-interval=${this.cpuProfInterval}`,
      );
    }
    args.push(this.entry);
    this.spawnAt = this.now();
    this.spawnEpoch = performance.timeOrigin + this.spawnAt;
    this.child = spawn(BUN, args, {
      cwd: REPO,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exitPromise = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        this.exited = { code, signal };
        for (const [, p] of this.pending) p.reject(new Error(`worker exited (${code ?? signal})`));
        this.pending.clear();
        resolve(this.exited);
      });
    });
    let outBuf = "";
    this.child.stdout.on("data", (chunk) => {
      const at = this.now();
      if (this.firstByteAt === undefined) this.firstByteAt = at;
      outBuf += chunk.toString("utf8");
      let nl;
      while ((nl = outBuf.indexOf("\n")) >= 0) {
        const line = outBuf.slice(0, nl);
        outBuf = outBuf.slice(nl + 1);
        if (line.trim()) this.onLine(line, at);
      }
    });
    let errBuf = "";
    this.child.stderr.on("data", (chunk) => {
      errBuf += chunk.toString("utf8");
      let nl;
      while ((nl = errBuf.indexOf("\n")) >= 0) {
        const line = errBuf.slice(0, nl);
        errBuf = errBuf.slice(nl + 1);
        if (line.startsWith(PERF_PREFIX)) {
          const waiter = this.perfWaiters.shift();
          const parsed = JSON.parse(line.slice(PERF_PREFIX.length));
          waiter?.(parsed);
        } else {
          this.stderrTail.push(line);
          if (this.stderrTail.length > 200) this.stderrTail.shift();
          if (opts.verbose) process.stderr.write(`[worker] ${line}\n`);
        }
      }
    });
    return this;
  }

  onLine(line, at) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    this.lastMessageAt = at;
    const bytes = Buffer.byteLength(line) + 1;
    this.rx.lines += 1;
    this.rx.bytes += bytes;
    let key;
    if ("method" in msg) {
      key =
        msg.method === "run.event" ? `run.event:${msg.params?.type ?? "?"}` : msg.method;
    } else key = msg.error ? "(response:error)" : "(response)";
    const bucket = (this.rx.byMethod[key] ??= { lines: 0, bytes: 0 });
    bucket.lines += 1;
    bucket.bytes += bytes;

    if (this.bootAcct) {
      const pollMethod =
        "id" in msg && !("method" in msg) ? this.pending.get(msg.id)?.method : undefined;
      bootAccount(this.bootAcct, msg, line, pollMethod);
      // Snapshot in stdout order, at the exact line that first reports ready:
      // later lines in the same chunk are processed before the awaiting
      // boot() resumes, so a snapshot taken there would not be deterministic.
      if (
        this.bootAcctAtReady == null &&
        pollMethod === "internal.worker.health" &&
        msg.result?.health?.ready
      ) {
        this.bootAcctAtReady = structuredClone(this.bootAcct);
      }
    }
    if ("id" in msg && !("method" in msg)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      pending.at = at;
      if (msg.error) pending.reject(Object.assign(new Error(msg.error.message), { rpc: msg.error, at }));
      else pending.resolve({ result: msg.result, at });
      return;
    }
    if ("id" in msg) {
      this.hostRequests[msg.method] = (this.hostRequests[msg.method] ?? 0) + 1;
      this.write({ id: msg.id, result: this.answerHost(msg.method, msg.params) });
      return;
    }
    for (const listener of this.listeners) listener(msg, at);
  }

  answerHost(method, params) {
    switch (method) {
      case "host.deviceIdentity.get":
        return hostIdentity;
      case "host.llmCredentials.request":
        return params?.operation === "list"
          ? { ok: true, apiKeyProviders: [], oauthProviders: [] }
          : { ok: true, value: null };
      case "host.runtimeAuth.refresh":
        return { authenticated: false, token: null, hasConnectedAccount: false };
      default:
        return null;
    }
  }

  write(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, { timeoutMs = 60_000 } = {}) {
    const id = this.nextId++;
    const sentAt = this.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(timer);
          resolve({ ...v, sentAt });
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.write(params === undefined ? { id, method } : { id, method, params });
    });
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("probe snapshot timeout")), timeoutMs);
      this.perfWaiters.push((snap) => {
        clearTimeout(timer);
        resolve(snap);
      });
      this.child.kill("SIGUSR2");
    });
  }

  initializeParams(dataDir) {
    return {
      protocolVersion: "v1",
      clientVersion: "perf-lab",
      isDev: false,
      stellaAppDir: REPO,
      stellaDataDirPath: dataDir,
      stellaWorkspacePath: path.join(dataDir, "workspace"),
      authToken: null,
      convexUrl: null,
      convexSiteUrl: null,
      hasConnectedAccount: false,
      cloudSyncEnabled: false,
      localLlmCredentialsUpdatedAt: null,
    };
  }

  /**
   * Boot marks. The stdio transport only answers once the whole entry module
   * graph is evaluated and main() has attached the JSON-RPC peer, so the
   * first response to a probe written at spawn time is the "transport
   * attached" mark. `internal.worker.readyz` is answered pre-attach only by
   * the socket transport; over stdio it returns METHOD_NOT_FOUND, which is
   * exactly the cheap round trip we want.
   */
  async boot(dataDir, { pollMs = 5, readyTimeoutMs = 30_000, keepBootAccounting = false } = {}) {
    const probe = this.request("internal.worker.readyz", {}).catch((e) => ({ at: e.at }));
    const probeRes = await probe;
    const transportAt = probeRes.at ?? this.now();
    const init = await this.request("internal.worker.initialize", this.initializeParams(dataDir));
    const deadline = this.now() + readyTimeoutMs;
    let readyAt = null;
    let polls = 0;
    let lastHealth = null;
    while (this.now() < deadline) {
      polls += 1;
      const h = await this.request("internal.worker.health");
      lastHealth = h.result;
      if (h.result?.health?.ready) {
        readyAt = h.at;
        break;
      }
      await sleep(pollMs);
    }
    if (readyAt == null) {
      throw new Error(`worker never became ready: ${JSON.stringify(lastHealth)}\n${this.stderrTail.slice(-20).join("\n")}`);
    }
    // Path normalization is per line; stop it before any timed turn traffic.
    if (!keepBootAccounting) this.endBootAccounting();
    return {
      spawnToFirstByteMs: this.firstByteAt - this.spawnAt,
      spawnToTransportMs: transportAt - this.spawnAt,
      initializeRttMs: init.at - init.sentAt,
      spawnToInitializedMs: init.at - this.spawnAt,
      initializedToReadyMs: readyAt - init.at,
      spawnToReadyMs: readyAt - this.spawnAt,
      readyPolls: polls,
    };
  }

  async waitQuiet(quietMs = 150, maxMs = 5_000) {
    const start = this.now();
    while (this.now() - start < maxMs) {
      const since = this.now() - Math.max(this.lastMessageAt, start);
      if (since >= quietMs) return;
      await sleep(Math.max(5, quietMs - since));
    }
  }

  async stop(timeoutMs = 10_000) {
    if (this.exited) return this.exited;
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), timeoutMs);
    const result = await this.exitPromise;
    clearTimeout(timer);
    return result;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ snapshot diffs
const diffSnap = (a, b) => {
  const sqlDelta = {};
  for (const [key, stat] of Object.entries(b.sqlite.byStatement)) {
    const prev = a.sqlite.byStatement[key] ?? { count: 0, ms: 0 };
    const count = stat.count - prev.count;
    if (count > 0) sqlDelta[key] = { count, ms: round(stat.ms - prev.ms, 3) };
  }
  const outDelta = {};
  for (const [key, stat] of Object.entries(b.stdout.byMethod)) {
    const prev = a.stdout.byMethod[key] ?? { lines: 0, bytes: 0 };
    if (stat.lines - prev.lines > 0) {
      outDelta[key] = { lines: stat.lines - prev.lines, bytes: stat.bytes - prev.bytes };
    }
  }
  return {
    sqlStatements: b.sqlite.statements - a.sqlite.statements,
    sqlMs: round(b.sqlite.ms - a.sqlite.ms, 3),
    sqlRows: b.sqlite.rows - a.sqlite.rows,
    sqlPrepares: b.sqlite.prepares - a.sqlite.prepares,
    sqlPrepareMs: round(b.sqlite.prepareMs - a.sqlite.prepareMs, 3),
    rpcLinesOut: b.stdout.lines - a.stdout.lines,
    rpcBytesOut: b.stdout.bytes - a.stdout.bytes,
    fetchBlocked: b.fetch.blocked - a.fetch.blocked,
    // lower bound on JS heap bytes allocated in the window (see probe)
    heapAllocLowerBound: b.memory.jscHeapSizeBeforeGc - a.memory.jscHeapSize,
    objectsAllocLowerBound: b.memory.jscObjectCountBeforeGc - a.memory.jscObjectCount,
    retainedHeapDelta: b.memory.jscHeapSize - a.memory.jscHeapSize,
    byStatement: sqlDelta,
    byMethod: outDelta,
  };
};
const mergeCounts = (target, source, fields = ["count", "ms"]) => {
  for (const [key, stat] of Object.entries(source)) {
    const entry = (target[key] ??= Object.fromEntries(fields.map((f) => [f, 0])));
    for (const f of fields) entry[f] += stat[f] ?? 0;
  }
  return target;
};
const topStatements = (byStatement, n = 15, divisor = 1) =>
  Object.entries(byStatement)
    .sort((a, b) => b[1].count - a[1].count || b[1].ms - a[1].ms)
    .slice(0, n)
    .map(([key, stat]) => {
      const bar = key.indexOf("|");
      return {
        db: key.slice(0, bar),
        sql: key.slice(bar + 1),
        count: round(stat.count / divisor, 2),
        ms: round(stat.ms / divisor, 3),
      };
    });

// ------------------------------------------------------------------ templates
const TEMPLATE_VERSION = 1;
/**
 * A "returning user" data dir: booted once and one turn run, then shut down
 * cleanly. Boot and turn journeys copy it so every run starts from the same
 * bytes (schema migrated, catalog refresh stamped, one conversation).
 */
const ensureBaseTemplate = async () => {
  const dir = path.join(LAB_DIR, "templates", `base-v${TEMPLATE_VERSION}`);
  if (fs.existsSync(path.join(dir, ".complete")) && !opts.reseed) return dir;
  log("seeding base template data dir");
  rmrf(dir);
  const runDir = newRunDir("seed-base");
  prepareDataDir(dir);
  const client = new WorkerClient({
    entry: SOURCE_ENTRY,
    entryKind: "source",
    env: workerEnv({ runDir, dataDir: dir, cacheDir: warmCacheDir("source"), entryKind: "source" }),
  }).start();
  await client.boot(dir);
  await runTurn(client, { conversationId: "perf-conv", prompt: "seed turn" });
  await client.waitQuiet();
  // A fresh data dir refreshes the pi.dev catalog once; the probe answers it
  // with a local 404 (never a real request). Anything else is blocked.
  const { fetch: seedFetch } = await client.snapshot();
  log(
    `seed network guard: catalog requests answered locally=${seedFetch.catalog404}, other fetches blocked=${seedFetch.blocked}` +
      `${seedFetch.blockedUrls.length ? ` (${seedFetch.blockedUrls.join(", ")})` : ""}`,
  );
  await client.stop();
  fs.writeFileSync(path.join(dir, ".complete"), new Date().toISOString());
  return dir;
};
const warmCacheDir = (entryKind) => {
  const dir = path.join(LAB_DIR, "cache", `transpiler-${entryKind}`);
  mkdirp(dir);
  return dir;
};

// ------------------------------------------------------------------ turn driver
let turnSeq = 0;
// Request ids must be unique across invocations: a reused template already
// holds the seed turn's run_admission row, and startChat answers a repeated
// (conversation, request id) as a duplicate without starting a run.
const TURN_RUN_TAG = Date.now().toString(36);
/**
 * One chat turn through `internal.worker.startChat`. Marks come from the
 * worker's own notifications, timestamped on arrival:
 *   send → ack (startChat response) → run-started → first assistant-message
 *   (the only assistant-text carrier; there is no separate STREAM chunk
 *   event any more) → run-finished. Tool turns add tool-start/tool-end.
 * `settledMs` is when the worker went quiet (>=150ms without a message),
 * which captures post-turn tail work (thread activity, persistence fan-out).
 */
const runTurn = async (client, { conversationId, prompt, timeoutMs = 30_000 }) => {
  turnSeq += 1;
  const requestId = `perf-req-${TURN_RUN_TAG}-${turnSeq}`;
  const marks = {};
  const toolSpans = [];
  let runId = null;
  let resolveFinished;
  const finished = new Promise((r) => (resolveFinished = r));
  const off = client.on((msg, at) => {
    if (msg.method !== "run.event") return;
    const ev = msg.params ?? {};
    if (ev.requestId !== requestId && (runId == null || ev.runId !== runId)) return;
    if (ev.type === "run-started" && marks.runStarted == null) {
      marks.runStarted = at;
      runId = ev.runId;
    } else if (ev.type === "assistant-message" && marks.firstAssistant == null) {
      marks.firstAssistant = at;
    } else if (ev.type === "tool-start") {
      toolSpans.push({ name: ev.toolName, start: at });
    } else if (ev.type === "tool-end") {
      const span = toolSpans.find((s) => s.end == null);
      if (span) span.end = at;
    } else if (ev.type === "run-finished") {
      marks.runFinished = at;
      marks.outcome = ev.outcome;
      marks.error = ev.error;
      // Event-loop availability probe: a health RPC written the instant the
      // run finishes is answered only once synchronous post-turn work
      // (completion hooks, compaction checks, run-log writes) yields.
      marks.idle = client
        .request("internal.worker.health")
        .then((r) => r.at)
        .catch(() => null);
      resolveFinished();
    }
  });
  const sendAt = client.now();
  const ack = await client.request("internal.worker.startChat", {
    conversationId,
    userPrompt: prompt,
    requestId,
    platform: process.platform,
    timezone: "UTC",
    storageMode: "local",
  });
  runId ??= ack.result?.runId ?? null;
  const timer = setTimeout(() => resolveFinished(), timeoutMs);
  await finished;
  clearTimeout(timer);
  off();
  if (marks.runFinished == null) throw new Error(`turn ${requestId} did not finish`);
  if (marks.outcome && marks.outcome !== "completed") {
    throw new Error(`turn ${requestId} outcome=${marks.outcome} error=${marks.error ?? ""}`);
  }
  const idleAt = marks.idle ? await marks.idle : null;
  await client.waitQuiet();
  const toolMs = toolSpans.reduce((a, s) => a + ((s.end ?? s.start) - s.start), 0);
  return {
    ackMs: ack.at - sendAt,
    toRunStartedMs: marks.runStarted - sendAt,
    toFirstAssistantMs: marks.firstAssistant != null ? marks.firstAssistant - sendAt : null,
    toRunFinishedMs: marks.runFinished - sendAt,
    toolCount: toolSpans.length,
    toolMs,
    nonToolMs: marks.runFinished - sendAt - toolMs,
    toIdleMs: idleAt != null ? idleAt - sendAt : null,
    settledMs: client.lastMessageAt - sendAt,
  };
};

// ------------------------------------------------------------------ J1 boot
const bootOnce = async ({ entryKind, cache, dataTemplate, cpuProfDir = null, census = false }) => {
  const entry = entryKind === "bundle" ? BUNDLE_ENTRY : SOURCE_ENTRY;
  const runDir = newRunDir(`boot-${entryKind}-${cache}`);
  const dataDir = path.join(runDir, "data");
  copyDir(dataTemplate, dataDir);
  const cacheDir =
    cache === "cold" ? path.join(runDir, "transpiler-cache") : warmCacheDir(entryKind);
  mkdirp(cacheDir);
  const client = new WorkerClient({
    entry,
    entryKind,
    env: workerEnv({ runDir, dataDir, cacheDir, entryKind, census }),
    cpuProfDir,
  }).start();
  try {
    const marks = await client.boot(dataDir, { keepBootAccounting: true });
    const snap = await client.snapshot();
    // Boot RPC windows: `ready` = spawn → the first health response reporting
    // ready (what the host's runtime-ready waits on); `settled` = through the
    // first 250ms of stdout silence after ready (debounced post-ready work
    // such as the background catalog warm lands here).
    await client.waitQuiet(250);
    const settledSnap = await client.snapshot();
    const bootRpc = { ready: client.bootAcctAtReady, settled: client.endBootAccounting() };
    const workerStartEpoch = snap.timeOriginEpochMs;
    const breakdown = {
      execToProcessStartMs: workerStartEpoch - client.spawnEpoch,
      processStartToPreloadMs: snap.preloadStartMs,
      preloadMs: snap.preloadDoneMs - snap.preloadStartMs,
      // entry module graph load + evaluate + main() prelude up to transport attach
      entryGraphToTransportMs:
        marks.spawnToTransportMs - (workerStartEpoch - client.spawnEpoch) - snap.preloadDoneMs,
    };
    return {
      marks,
      breakdown,
      rssAfterReady: snap.memory.rss,
      heapAfterReady: snap.memory.heapUsed,
      bootSql: snap.sqlite.statements,
      bootRpcBytesOut: snap.stdout.bytes,
      bootRpc,
      bootFetch: {
        catalog404: settledSnap.fetch.catalog404,
        blocked: settledSnap.fetch.blocked,
        blockedUrls: settledSnap.fetch.blockedUrls,
      },
      census: snap.census,
      censusAnchor: census
        ? {
            // convert census `at` (ms since preload start) to spawn-relative
            offsetMs: workerStartEpoch - client.spawnEpoch + snap.preloadStartMs,
            transportMs: marks.spawnToTransportMs,
            initializedMs: marks.spawnToInitializedMs,
            readyMs: marks.spawnToReadyMs,
          }
        : undefined,
      client,
    };
  } finally {
    await client.stop();
  }
};

const cmdBoot = async () => {
  const repeat = intOpt("repeat", 8);
  const entries = listOpt("entry", ["source", "bundle"]);
  const caches = listOpt("cache", ["warm", "cold"]);
  const template = await ensureBaseTemplate();
  const results = {};
  for (const entryKind of entries) {
    if (entryKind === "bundle" && !fs.existsSync(BUNDLE_ENTRY)) {
      log(`bundle entry missing (${BUNDLE_ENTRY}); build it with: node packages/desktop/scripts/dev-electron-build.mjs --once`);
      continue;
    }
    // Prime the warm cache once, discarded.
    await bootOnce({ entryKind, cache: "warm", dataTemplate: template });
    for (const cache of caches) {
      const runs = [];
      for (let i = 0; i < repeat; i += 1) {
        const r = await bootOnce({ entryKind, cache, dataTemplate: template });
        runs.push(r);
      }
      const pick = (fn) => summarize(runs.map(fn));
      results[`${entryKind}.${cache}`] = {
        entry: entryKind === "bundle" ? path.relative(REPO, BUNDLE_ENTRY) : path.relative(REPO, SOURCE_ENTRY),
        spawnToTransportMs: pick((r) => r.marks.spawnToTransportMs),
        initializeRttMs: pick((r) => r.marks.initializeRttMs),
        initializedToReadyMs: pick((r) => r.marks.initializedToReadyMs),
        spawnToReadyMs: pick((r) => r.marks.spawnToReadyMs),
        execToProcessStartMs: pick((r) => r.breakdown.execToProcessStartMs),
        processStartToPreloadMs: pick((r) => r.breakdown.processStartToPreloadMs),
        preloadMs: pick((r) => r.breakdown.preloadMs),
        entryGraphToTransportMs: pick((r) => r.breakdown.entryGraphToTransportMs),
        rssAfterReadyMB: pick((r) => r.rssAfterReady / 1048576),
        heapAfterReadyMB: pick((r) => r.heapAfterReady / 1048576),
        bootSqlStatements: pick((r) => r.bootSql),
        bootRpcBytesOut: pick((r) => r.bootRpcBytesOut),
        // Deterministic boot RPC counts (max over runs; `nondeterministic`
        // lists any field that differed between runs and should be empty).
        bootRpc: {
          ready: foldBootAccounts(runs.map((r) => r.bootRpc.ready)),
          settled: foldBootAccounts(runs.map((r) => r.bootRpc.settled)),
        },
        bootFetch: {
          catalog404: Math.max(...runs.map((r) => r.bootFetch.catalog404)),
          blocked: Math.max(...runs.map((r) => r.bootFetch.blocked)),
          blockedUrls: [...new Set(runs.flatMap((r) => r.bootFetch.blockedUrls))],
        },
      };
      for (const [window, folded] of Object.entries(results[`${entryKind}.${cache}`].bootRpc)) {
        if (folded.nondeterministic.length) {
          log(`WARNING boot ${entryKind}.${cache} ${window} counts varied across runs: ${folded.nondeterministic.join(", ")}`);
        }
      }
      log(`boot ${entryKind}.${cache}: ready p50=${results[`${entryKind}.${cache}`].spawnToReadyMs?.p50}ms`);
    }
  }
  if (!opts["no-census"]) {
    results.census = {};
    for (const entryKind of entries) {
      if (entryKind === "bundle" && !fs.existsSync(BUNDLE_ENTRY)) continue;
      results.census[entryKind] = await moduleCensus(entryKind, template);
    }
  }
  return results;
};

const classifyModule = (file) => {
  const rel = file.startsWith(REPO) ? path.relative(REPO, file) : file;
  const nm = rel.lastIndexOf("node_modules/");
  if (nm >= 0) {
    const rest = rel.slice(nm + "node_modules/".length).split("/");
    return { rel, pkg: rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0] };
  }
  const parts = rel.split("/");
  if (parts[0] === "packages") return { rel, pkg: `packages/${parts[1]}/${parts[2] ?? ""}`.replace(/\/$/, "") };
  return { rel, pkg: parts[0] };
};

/**
 * esbuild metafile of the SOURCE worker graph (everything bundled except
 * bun:* / electron), used only for its import edges and input byte sizes.
 */
let sourceGraphPromise = null;
const sourceGraph = () =>
  (sourceGraphPromise ??= (async () => {
    const esbuild = await import("esbuild");
    const build = await esbuild.build({
      absWorkingDir: REPO,
      alias: {
        "@stella/contracts": path.join(REPO, "packages", "contracts"),
        "@stella/runtime": path.join(REPO, "packages", "runtime"),
      },
      bundle: true,
      entryPoints: [
        "packages/runtime/worker/entry.ts",
        "packages/runtime/extensions/stella-runtime/index.ts",
      ],
      external: ["electron", "bun:*", "*.node"],
      format: "esm",
      splitting: true,
      metafile: true,
      write: false,
      logLevel: "silent",
      outdir: path.join(LAB_DIR, "source-graph-out"),
      platform: "node",
      target: "node22",
      tsconfig: path.join("packages", "desktop", "tsconfig.electron.json"),
    });
    return build.metafile;
  })());
const staticClosure = (meta, startRel, seen = new Set()) => {
  const out = [];
  const stack = [startRel];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur) || !meta.inputs[cur]) continue;
    seen.add(cur);
    out.push(cur);
    for (const imp of meta.inputs[cur].imports ?? []) {
      if (!imp.external && imp.kind !== "dynamic-import") stack.push(imp.path);
    }
  }
  return out;
};

/**
 * Module census: one untimed run with the loader plugin. The plugin sees
 * every TypeScript module (source entry) or bundle chunk (bundle entry) as
 * it loads, timestamped; for the source entry each observed module is
 * expanded to its static import closure from the esbuild metafile so
 * node_modules JS is counted too (a static import graph is evaluated in
 * full before the importer runs). Phases: before transport attach / before
 * initialize returned / before runner ready / during the first two turns.
 */
const moduleCensus = async (entryKind, template) => {
  const entry = entryKind === "bundle" ? BUNDLE_ENTRY : SOURCE_ENTRY;
  const runDir = newRunDir(`census-${entryKind}`);
  const dataDir = path.join(runDir, "data");
  copyDir(template, dataDir);
  const client = new WorkerClient({
    entry,
    entryKind,
    env: workerEnv({ runDir, dataDir, cacheDir: warmCacheDir(entryKind), entryKind, census: true }),
  }).start();
  let marks;
  let bootSnap;
  let turnSnap = null;
  try {
    marks = await client.boot(dataDir);
    bootSnap = await client.snapshot();
    if (entryKind === "source") {
      await runTurn(client, { conversationId: "perf-conv", prompt: "census turn" });
      await runTurn(client, { conversationId: "perf-conv", prompt: "census tool [perf:tool]" });
      turnSnap = await client.snapshot();
    }
  } finally {
    await client.stop();
  }
  const offset = bootSnap.timeOriginEpochMs - client.spawnEpoch + bootSnap.preloadStartMs;
  const phaseOf = (entryAt) => {
    const t = entryAt + offset;
    if (t <= marks.spawnToTransportMs) return "transport";
    if (t <= marks.spawnToInitializedMs) return "initialize";
    if (t <= marks.spawnToReadyMs) return "ready";
    return "firstTurns";
  };
  const observed = ((turnSnap ?? bootSnap).census ?? []).filter(
    (m) => !m.path.endsWith("probe-preload.ts"),
  );
  let modules;
  if (entryKind === "source") {
    const meta = await sourceGraph();
    const seen = new Set();
    modules = [];
    for (const m of observed) {
      const rel = path.relative(REPO, m.path);
      const phase = phaseOf(m.at);
      const members = staticClosure(meta, rel, seen);
      for (const member of members) {
        const { pkg } = classifyModule(path.join(REPO, member));
        modules.push({
          rel: member,
          pkg,
          bytes: meta.inputs[member].bytes,
          phase,
          atMs: round(m.at + offset, 1),
          observed: member === rel,
        });
      }
      if (!meta.inputs[rel] && !seen.has(rel)) {
        seen.add(rel);
        modules.push({ rel, pkg: classifyModule(m.path).pkg, bytes: m.bytes, phase, atMs: round(m.at + offset, 1), observed: true });
      }
    }
  } else {
    modules = observed.map((m) => ({
      rel: path.relative(REPO, m.path),
      pkg: "bundle-chunk",
      bytes: m.bytes,
      phase: phaseOf(m.at),
      atMs: round(m.at + offset, 1),
      observed: true,
    }));
  }
  const phases = {};
  const byPkg = {};
  for (const m of modules) {
    const bucket = (phases[m.phase] ??= { modules: 0, bytes: 0 });
    bucket.modules += 1;
    bucket.bytes += m.bytes;
    if (m.phase !== "firstTurns") {
      const pb = (byPkg[m.pkg] ??= { modules: 0, bytes: 0 });
      pb.modules += 1;
      pb.bytes += m.bytes;
    }
  }
  const bootModules = modules.filter((m) => m.phase !== "firstTurns");
  // Each observed module's load gap = time until the next observed module
  // started loading (fetch+transpile order); a coarse per-module load-time
  // signal to pair with the CPU profile's per-module self time.
  const obs = modules.filter((m) => m.observed).sort((a, b) => a.atMs - b.atMs);
  for (let i = 0; i < obs.length; i += 1) {
    obs[i].gapMs = round((obs[i + 1]?.atMs ?? obs[i].atMs) - obs[i].atMs, 2);
  }
  return {
    marks: {
      transportMs: round(marks.spawnToTransportMs),
      initializedMs: round(marks.spawnToInitializedMs),
      readyMs: round(marks.spawnToReadyMs),
    },
    totalModules: modules.length,
    totalBytes: modules.reduce((a, m) => a + m.bytes, 0),
    bootModules: bootModules.length,
    bootBytes: bootModules.reduce((a, m) => a + m.bytes, 0),
    phases,
    topPackagesAtBoot: Object.entries(byPkg)
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .slice(0, 30)
      .map(([pkg, v]) => ({ pkg, ...v })),
    topModulesAtBootByBytes: [...bootModules]
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 30)
      .map(({ rel, bytes, phase }) => ({ rel, bytes, phase })),
    topObservedByLoadGap: obs
      .filter((m) => m.phase !== "firstTurns")
      .sort((a, b) => b.gapMs - a.gapMs)
      .slice(0, 30)
      .map(({ rel, bytes, phase, gapMs }) => ({ rel, bytes, phase, gapMs })),
    firstTurnModules: modules
      .filter((m) => m.phase === "firstTurns")
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 30)
      .map(({ rel, bytes }) => ({ rel, bytes })),
    firstTurnModuleCount: modules.filter((m) => m.phase === "firstTurns").length,
  };
};

// ------------------------------------------------------------------ J2/3/5 turns
const bootForTurns = async (label, template) => {
  const runDir = newRunDir(label);
  const dataDir = path.join(runDir, "data");
  copyDir(template, dataDir);
  const client = new WorkerClient({
    entry: SOURCE_ENTRY,
    entryKind: "source",
    env: workerEnv({ runDir, dataDir, cacheDir: warmCacheDir("source"), entryKind: "source" }),
    cpuProfDir: opts["cpu-prof-dir"] ? path.resolve(String(opts["cpu-prof-dir"]), label) : null,
  }).start();
  await client.boot(dataDir);
  return { client, dataDir, runDir };
};

const counterRow = (d, { rxLines, hostRequests, turns = 1, rssMB }) => {
  const per = (v) => round(v / turns, 2);
  return {
    sqlStatements: per(d.sqlStatements),
    sqlMs: per(d.sqlMs),
    sqlRows: per(d.sqlRows),
    sqlPrepares: per(d.sqlPrepares),
    sqlPrepareMs: per(d.sqlPrepareMs),
    rpcLinesOut: per(d.rpcLinesOut),
    rpcBytesOut: per(d.rpcBytesOut),
    rpcLinesIn: per(rxLines),
    hostRequests: per(hostRequests),
    writeStatements: per(
      Object.entries(d.byStatement)
        .filter(([k]) => /\|(INSERT|UPDATE|DELETE|REPLACE)/i.test(k))
        .reduce((a, [, v]) => a + v.count, 0),
    ),
    commits: per(
      Object.entries(d.byStatement)
        .filter(([k]) => /\|COMMIT/i.test(k))
        .reduce((a, [, v]) => a + v.count, 0),
    ),
    heapAllocKBLowerBound: per(d.heapAllocLowerBound / 1024),
    objectsAllocLowerBound: per(d.objectsAllocLowerBound),
    retainedHeapKB: per(d.retainedHeapDelta / 1024),
    rssMB: round(rssMB),
  };
};
const hostTotal = (client) => Object.values(client.hostRequests).reduce((a, b) => a + b, 0);

/**
 * Turn measurement. The first turn is bracketed by probe snapshots on its
 * own (first-turn-after-boot cost incl. lazy imports). Then `warmup` turns,
 * one snapshot, `repeat` timed turns back to back with NO snapshot in
 * between (a snapshot forces a full GC, which would flatter turn latency),
 * and a closing snapshot: counters are per-turn means over that window
 * (they are deterministic per turn shape), timings are per-turn p50/p95.
 */
const measureTurns = async (client, { prompt, repeat, warmup, conversationId }) => {
  const s0 = await client.snapshot();
  const rx0 = client.rx.lines;
  const h0 = hostTotal(client);
  const firstTiming = await runTurn(client, { conversationId, prompt });
  const s1 = await client.snapshot();
  const d1 = diffSnap(s0, s1);
  const first = {
    ...firstTiming,
    ...counterRow(d1, { rxLines: client.rx.lines - rx0, hostRequests: hostTotal(client) - h0, rssMB: s1.memory.rss / 1048576 }),
    byStatement: topStatements(d1.byStatement, 40),
    byMethod: d1.byMethod,
  };
  for (let i = 1; i < warmup; i += 1) await runTurn(client, { conversationId, prompt });
  const a = await client.snapshot();
  const rxA = client.rx.lines;
  const hA = hostTotal(client);
  const rows = [];
  for (let i = 0; i < repeat; i += 1) {
    // --gc-each-turn: force a full GC before every timed turn (diagnostic;
    // shows how much of turn latency is GC debt from earlier turns).
    if (opts["gc-each-turn"]) await client.snapshot();
    // --turn-gap-ms: idle time between timed turns (diagnostic; separates GC
    // debt from timer-driven background work spilling into the next turn).
    if (opts["turn-gap-ms"]) await sleep(Number(opts["turn-gap-ms"]));
    rows.push(await runTurn(client, { conversationId, prompt }));
  }
  const b = await client.snapshot();
  const d = diffSnap(a, b);
  const counters = counterRow(d, {
    rxLines: client.rx.lines - rxA,
    hostRequests: hostTotal(client) - hA,
    turns: repeat,
    rssMB: b.memory.rss / 1048576,
  });
  const timingKeys = Object.keys(rows[0]);
  const steady = Object.fromEntries(timingKeys.map((k) => [k, summarize(rows.map((r) => r[k]))]));
  for (const [k, v] of Object.entries(counters)) {
    steady[k] = { n: repeat, p50: v, p95: v, mean: v, perTurnMean: true };
  }
  return {
    repeat,
    warmup,
    firstTurn: first,
    steady,
    topStatementsPerTurn: topStatements(d.byStatement, 25, repeat),
    rpcOutPerTurn: Object.fromEntries(
      Object.entries(d.byMethod).map(([k, v]) => [k, { lines: round(v.lines / repeat), bytes: round(v.bytes / repeat) }]),
    ),
  };
};

const cmdTurn = async () => {
  const repeat = intOpt("repeat", 20);
  const warmup = intOpt("warmup", 3);
  const template = await ensureBaseTemplate();
  const { client } = await bootForTurns("turns", template);
  try {
    const plain = await measureTurns(client, {
      prompt: "perf plain turn",
      repeat,
      warmup,
      conversationId: "perf-turns-plain",
    });
    const tool = await measureTurns(client, {
      prompt: "perf tool turn [perf:tool]",
      repeat,
      warmup,
      conversationId: "perf-turns-tool",
    });
    // Journey 5: persistence cost per persisted event, derived from J2.
    const s = plain.steady;
    const eventsPerTurn =
      (plain.rpcOutPerTurn["localChat.updated"]?.lines ?? 0) +
      (plain.rpcOutPerTurn["localChat.threadActivityUpdated"]?.lines ?? 0);
    const persistence = {
      note: "derived from plain-turn deltas; 'events' = localChat.updated + threadActivityUpdated notifications (one per persisted row fan-out)",
      writeStatementsPerTurn: s.writeStatements?.p50,
      commitsPerTurn: s.commits?.p50,
      sqlMsPerTurn: s.sqlMs?.p50,
      persistedEventNotificationsPerTurn: eventsPerTurn,
      writeStatementsPerEvent: eventsPerTurn ? round(s.writeStatements.p50 / eventsPerTurn) : null,
      rpcBytesPerTurn: s.rpcBytesOut?.p50,
    };
    return { plain, tool, persistence };
  } finally {
    await client.stop();
  }
};

// ------------------------------------------------------------------ J4 history
// --history-shape legacy (default): events only, so every event predates the
// orchestrator thread and the pre-transition shim projects them into the
// prompt. modern: one real turn first, then N events after it, so the durable
// thread is the history and the events only feed reminders/locale (the shape
// of a conversation that started after the durable-store transition).
const historyShape = () => (String(opts["history-shape"] ?? "legacy") === "modern" ? "modern" : "legacy");
const ensureHistoryTemplate = async (n) => {
  const shape = historyShape();
  const dir = path.join(
    LAB_DIR,
    "templates",
    shape === "modern" ? `history-modern-${n}-v${TEMPLATE_VERSION}` : `history-${n}-v${TEMPLATE_VERSION}`,
  );
  if (fs.existsSync(path.join(dir, ".complete")) && !opts.reseed) {
    return { dir, seed: JSON.parse(fs.readFileSync(path.join(dir, ".complete"), "utf8")) };
  }
  const base = await ensureBaseTemplate();
  rmrf(dir);
  copyDir(base, dir);
  rmrf(path.join(dir, ".complete"));
  const runDir = newRunDir(`seed-history-${n}`);
  const client = new WorkerClient({
    entry: SOURCE_ENTRY,
    entryKind: "source",
    env: workerEnv({ runDir, dataDir: dir, cacheDir: warmCacheDir("source"), entryKind: "source" }),
  }).start();
  await client.boot(dir);
  if (shape === "modern") {
    await runTurn(client, { conversationId: "perf-history", prompt: "perf modern history head" });
  }
  log(`seeding ${shape} history N=${n} through internal.worker.localChat.appendEvent`);
  const before = await client.snapshot();
  const start = client.now();
  const batch = 256;
  const baseTs = shape === "modern" ? Date.now() + 1000 : Date.UTC(2026, 0, 1);
  for (let i = 0; i < n; i += batch) {
    const inflight = [];
    for (let j = i; j < Math.min(n, i + batch); j += 1) {
      const user = j % 2 === 0;
      inflight.push(
        client.request("internal.worker.localChat.appendEvent", {
          conversationId: "perf-history",
          type: user ? "user_message" : "assistant_message",
          timestamp: baseTs + j * (shape === "modern" ? 1 : 1000),
          payload: {
            text: `${user ? "user" : "assistant"} message ${j}: ${"lorem ipsum dolor sit amet ".repeat(6)}`,
          },
        }),
      );
    }
    await Promise.all(inflight);
  }
  const seedMs = client.now() - start;
  const after = await client.snapshot();
  const d = diffSnap(before, after);
  await client.waitQuiet();
  await client.stop();
  const seed = {
    n,
    seedMs: round(seedMs),
    appendMsPerEvent: round(seedMs / n, 4),
    sqlStatementsPerAppend: round(d.sqlStatements / n, 2),
    sqlMsPerAppend: round(d.sqlMs / n, 4),
    rpcBytesOutPerAppend: round(d.rpcBytesOut / n, 1),
    topStatementsPerAppend: topStatements(d.byStatement, 12, n),
  };
  fs.writeFileSync(path.join(dir, ".complete"), JSON.stringify(seed));
  return { dir, seed };
};

const cmdHistory = async () => {
  const sizes = listOpt("sizes", ["1000", "10000", "100000"]).map(Number);
  const repeat = intOpt("repeat", 20);
  const results = {};
  for (const n of sizes) {
    const { dir, seed } = await ensureHistoryTemplate(n);
    const runDir = newRunDir(`history-${n}`);
    const dataDir = path.join(runDir, "data");
    copyDir(dir, dataDir);
    const client = new WorkerClient({
      entry: SOURCE_ENTRY,
      entryKind: "source",
      env: workerEnv({ runDir, dataDir, cacheDir: warmCacheDir("source"), entryKind: "source" }),
    }).start();
    try {
      const bootMarks = await client.boot(dataDir);
      const bootSnap = await client.snapshot();
      await client.waitQuiet();
      const measure = async (method, params) => {
        const times = [];
        let firstMs = null;
        const before = await client.snapshot();
        let resultSize = 0;
        for (let i = 0; i < repeat + 1; i += 1) {
          const r = await client.request(method, params);
          const ms = r.at - r.sentAt;
          if (i === 0) firstMs = ms;
          else times.push(ms);
          resultSize = JSON.stringify(r.result).length;
        }
        const after = await client.snapshot();
        const d = diffSnap(before, after);
        const calls = repeat + 1;
        return {
          firstCallMs: round(firstMs),
          ms: summarize(times),
          sqlStatementsPerCall: round(d.sqlStatements / calls, 2),
          sqlMsPerCall: round(d.sqlMs / calls, 3),
          sqlRowsPerCall: round(d.sqlRows / calls, 1),
          responseBytes: resultSize,
          topStatements: topStatements(d.byStatement, 8, calls),
        };
      };
      results[n] = {
        seed,
        spawnToReadyMs: round(bootMarks.spawnToReadyMs),
        bootMarks: Object.fromEntries(Object.entries(bootMarks).map(([k, v]) => [k, round(v)])),
        bootSql: {
          statements: bootSnap.sqlite.statements,
          ms: round(bootSnap.sqlite.ms),
          rows: bootSnap.sqlite.rows,
          top: topStatements(bootSnap.sqlite.byStatement, 5).sort((a, b) => b.ms - a.ms),
        },
        listEvents: await measure("internal.worker.localChat.listEvents", {
          conversationId: "perf-history",
        }),
        getEventCount: await measure("internal.worker.localChat.getEventCount", {
          conversationId: "perf-history",
        }),
      };
      // A turn on the large conversation: does history size leak into turn cost?
      const t = await measureTurns(client, {
        prompt: "perf turn on seeded history",
        repeat: 5,
        warmup: 1,
        conversationId: "perf-history",
      });
      results[n].turnOnHistory = {
        toRunFinishedMs: t.steady.toRunFinishedMs,
        sqlStatements: t.steady.sqlStatements,
        sqlRows: t.steady.sqlRows,
      };
      log(`history N=${n}: listEvents p50=${results[n].listEvents.ms?.p50}ms count p50=${results[n].getEventCount.ms?.p50}ms`);
    } finally {
      await client.stop();
    }
  }
  return results;
};

// ------------------------------------------------------------------ J6 memory
const psRssMB = (pid) => {
  const r = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
  const kb = Number.parseInt(r.stdout.trim(), 10);
  return Number.isFinite(kb) ? round(kb / 1024) : null;
};
const cmdMemory = async () => {
  const checkpoints = listOpt("turns", ["10", "100"]).map(Number).sort((a, b) => a - b);
  const template = await ensureBaseTemplate();
  const { client } = await bootForTurns("memory", template);
  try {
    const points = [];
    const record = async (turns) => {
      await client.waitQuiet(300);
      const psBeforeGc = psRssMB(client.child.pid);
      const snap = await client.snapshot();
      points.push({
        turns,
        rssMB: round(snap.memory.rss / 1048576),
        psRssNoGcMB: psBeforeGc,
        heapUsedMB: round(snap.memory.heapUsed / 1048576),
        externalMB: round(snap.memory.external / 1048576),
        jscObjects: snap.memory.jscObjectCount,
      });
    };
    await record(0);
    let done = 0;
    const turnTimes = [];
    for (const target of checkpoints) {
      while (done < target) {
        const t = await runTurn(client, {
          conversationId: "perf-memory",
          prompt: done % 5 === 4 ? "memory tool turn [perf:tool]" : `memory turn ${done}`,
        });
        turnTimes.push(t.toRunFinishedMs);
        done += 1;
      }
      await record(done);
    }
    const last = points[points.length - 1];
    const mid = points[points.length - 2];
    return {
      points,
      heapGrowthPerTurnKB:
        last.turns > mid.turns ? round(((last.heapUsedMB - mid.heapUsedMB) * 1024) / (last.turns - mid.turns)) : null,
      rssGrowthPerTurnKB:
        last.turns > mid.turns ? round(((last.rssMB - mid.rssMB) * 1024) / (last.turns - mid.turns)) : null,
      objectGrowthPerTurn:
        last.turns > mid.turns ? round((last.jscObjects - mid.jscObjects) / (last.turns - mid.turns)) : null,
      turnMsFirst10: summarize(turnTimes.slice(0, 10)),
      turnMsLast10: summarize(turnTimes.slice(-10)),
    };
  } finally {
    await client.stop();
  }
};

// ------------------------------------------------------------------ J7 bundle
const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push({ path: p, bytes: fs.statSync(p).size });
  }
  return out;
};
const cmdBundle = async () => {
  const result = {};
  const distRuntime = path.join(REPO, "packages", "desktop", "dist-electron", "runtime");
  if (fs.existsSync(distRuntime)) {
    const files = walk(distRuntime);
    const byDir = {};
    for (const f of files) {
      const rel = path.relative(distRuntime, f.path);
      const top = rel.split("/").slice(0, rel.startsWith("worker/") ? 2 : 1).join("/");
      byDir[top] = (byDir[top] ?? 0) + f.bytes;
    }
    const workerFiles = files.filter((f) => f.path.includes(`${path.sep}worker${path.sep}`) && f.path.endsWith(".js"));
    result.dist = {
      builtAt: fs.statSync(BUNDLE_ENTRY).mtime.toISOString(),
      totalBytes: files.reduce((a, f) => a + f.bytes, 0),
      fileCount: files.length,
      workerJsBytes: workerFiles.reduce((a, f) => a + f.bytes, 0),
      workerJsFiles: workerFiles.length,
      byTopDir: Object.fromEntries(Object.entries(byDir).sort((a, b) => b[1] - a[1])),
      largestFiles: files
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 20)
        .map((f) => ({ file: path.relative(distRuntime, f.path), bytes: f.bytes })),
    };
  } else {
    result.dist = { missing: distRuntime };
  }
  // Replicates the worker build options of
  // packages/desktop/scripts/dev-electron-build.mjs (read-only; that script
  // does not export them) with write:false to obtain a metafile.
  const esbuild = await import("esbuild");
  const build = await esbuild.build({
    absWorkingDir: REPO,
    alias: {
      "@stella/contracts": path.join(REPO, "packages", "contracts"),
      "@stella/runtime": path.join(REPO, "packages", "runtime"),
    },
    bundle: true,
    entryPoints: {
      "runtime/worker/entry": "packages/runtime/worker/entry.ts",
      "runtime/extensions/stella-runtime/index": "packages/runtime/extensions/stella-runtime/index.ts",
    },
    external: ["electron", "bun:*", "undici", "@silvia-odwyer/photon-node"],
    format: "esm",
    splitting: true,
    chunkNames: "runtime/worker/chunks/[name]-[hash]",
    metafile: true,
    write: false,
    logLevel: "silent",
    outdir: path.join(LAB_DIR, "bundle-out"),
    platform: "node",
    target: `node${process.versions.node?.split(".")[0] ?? "22"}`,
    tsconfig: path.join("packages", "desktop", "tsconfig.electron.json"),
  });
  const meta = build.metafile;
  writeJson(path.join(LAB_DIR, "bundle-metafile.json"), meta);
  const outputs = meta.outputs;
  const entryOut = Object.keys(outputs).find((o) => o.endsWith("runtime/worker/entry.js"));
  // Outputs reachable from entry.js via static imports = parsed at boot.
  const bootOutputs = new Set();
  const stack = [entryOut];
  while (stack.length) {
    const o = stack.pop();
    if (!o || bootOutputs.has(o)) continue;
    bootOutputs.add(o);
    for (const imp of outputs[o]?.imports ?? []) {
      if (imp.kind === "import-statement" && !imp.external) stack.push(imp.path);
    }
  }
  const byPkgAll = {};
  const byPkgBoot = {};
  let totalBytes = 0;
  let bootBytes = 0;
  for (const [outPath, out] of Object.entries(outputs)) {
    if (!outPath.endsWith(".js")) continue;
    totalBytes += out.bytes;
    const isBoot = bootOutputs.has(outPath);
    if (isBoot) bootBytes += out.bytes;
    for (const [input, info] of Object.entries(out.inputs)) {
      const { pkg } = classifyModule(path.join(REPO, input));
      byPkgAll[pkg] = (byPkgAll[pkg] ?? 0) + info.bytesInOutput;
      if (isBoot) byPkgBoot[pkg] = (byPkgBoot[pkg] ?? 0) + info.bytesInOutput;
    }
  }
  const top = (m) =>
    Object.entries(m)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([pkg, bytes]) => ({ pkg, bytes }));
  result.metafile = {
    note: "fresh esbuild build of current sources with the worker options replicated from dev-electron-build.mjs",
    outputJsBytes: totalBytes,
    outputJsFiles: Object.keys(outputs).filter((o) => o.endsWith(".js")).length,
    bootReachableBytes: bootBytes,
    bootReachableFiles: bootOutputs.size,
    inputModules: Object.keys(meta.inputs).length,
    topDependenciesByBytes: top(byPkgAll),
    topDependenciesInBootChunks: top(byPkgBoot),
  };
  return result;
};

// ------------------------------------------------------------------ profiles
const aggregateCpuProfile = (file, { topN = 30, intervalUs = 250 } = {}) => {
  const prof = JSON.parse(fs.readFileSync(file, "utf8"));
  const nodes = new Map(prof.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const deltas = prof.timeDeltas ?? [];
  for (let i = 0; i < prof.samples.length; i += 1) {
    // JSC records no idle samples: the gap after a turn's last sample would
    // otherwise be billed to that frame. Clamp to 3 sampling intervals.
    const dt = Math.min(deltas[i + 1] ?? deltas[i] ?? 0, 3 * intervalUs);
    self.set(prof.samples[i], (self.get(prof.samples[i]) ?? 0) + dt);
  }
  const byFn = new Map();
  const byUrl = new Map();
  const byPkg = new Map();
  let total = 0;
  for (const [id, us] of self) {
    const n = nodes.get(id);
    const cf = n?.callFrame ?? {};
    const url = (cf.url || "").replace(/^file:\/\//, "");
    const fnName = cf.functionName || "(anonymous)";
    total += us;
    const rel = url ? classifyModule(url) : { rel: `(${fnName})`, pkg: "(native/vm)" };
    const fnKey = `${fnName} ${rel.rel}${cf.lineNumber != null && url ? `:${cf.lineNumber + 1}` : ""}`;
    byFn.set(fnKey, (byFn.get(fnKey) ?? 0) + us);
    byUrl.set(rel.rel, (byUrl.get(rel.rel) ?? 0) + us);
    byPkg.set(rel.pkg, (byPkg.get(rel.pkg) ?? 0) + us);
  }
  const top = (m) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([k, us]) => ({ key: k, ms: round(us / 1000, 1), pct: round((100 * us) / total, 1) }));
  return {
    file,
    totalSampledMs: round(total / 1000, 1),
    topFunctions: top(byFn),
    topModules: top(byUrl),
    topPackages: top(byPkg),
  };
};
const newestProfile = (dir) => {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".cpuprofile")) : [];
  if (!files.length) return null;
  return files
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
};
const cmdProfile = async () => {
  // --template NAME profiles against a seeded template (e.g. history-100000-v1)
  const template = opts.template
    ? path.join(LAB_DIR, "templates", String(opts.template))
    : await ensureBaseTemplate();
  const interval = intOpt("interval", 250);
  const out = {};
  // Boot-only profile (source + bundle), process exits right after ready.
  for (const entryKind of listOpt("entry", ["source", "bundle"])) {
    if (entryKind === "bundle" && !fs.existsSync(BUNDLE_ENTRY)) continue;
    const dir = path.join(LAB_DIR, "profiles", `boot-${entryKind}-${Date.now().toString(36)}`);
    const runDir = newRunDir(`profile-boot-${entryKind}`);
    const dataDir = path.join(runDir, "data");
    copyDir(template, dataDir);
    const client = new WorkerClient({
      entry: entryKind === "bundle" ? BUNDLE_ENTRY : SOURCE_ENTRY,
      entryKind,
      env: workerEnv({ runDir, dataDir, cacheDir: warmCacheDir(entryKind), entryKind, sqlCounters: false }),
      cpuProfDir: dir,
      cpuProfInterval: interval,
    }).start();
    const marks = await client.boot(dataDir);
    await client.stop();
    const file = newestProfile(dir);
    out[`boot.${entryKind}`] = file
      ? { spawnToReadyMs: round(marks.spawnToReadyMs), ...aggregateCpuProfile(file, { intervalUs: interval }) }
      : { error: "no profile written" };
  }
  // Turn profile: boot + N turns minus boot-only (subtraction; inferred).
  const turns = intOpt("turns", 40);
  const dir = path.join(LAB_DIR, "profiles", `turns-${Date.now().toString(36)}`);
  const runDir = newRunDir("profile-turns");
  const dataDir = path.join(runDir, "data");
  copyDir(template, dataDir);
  const client = new WorkerClient({
    entry: SOURCE_ENTRY,
    entryKind: "source",
    env: workerEnv({ runDir, dataDir, cacheDir: warmCacheDir("source"), entryKind: "source", sqlCounters: false }),
    cpuProfDir: dir,
    cpuProfInterval: interval,
  }).start();
  await client.boot(dataDir);
  for (let i = 0; i < turns; i += 1) {
    await runTurn(client, {
      conversationId: "perf-profile",
      prompt: i % 2 ? "profile tool turn [perf:tool]" : `profile turn ${i}`,
    });
  }
  await client.stop();
  const file = newestProfile(dir);
  if (file) {
    const turnAgg = aggregateCpuProfile(file, { topN: 80, intervalUs: interval });
    const bootAgg = out["boot.source"];
    const subtract = (list, baseList) => {
      const base = new Map((baseList ?? []).map((r) => [r.key, r.ms]));
      return list
        .map((r) => ({ key: r.key, msPerTurn: round((r.ms - (base.get(r.key) ?? 0)) / turns, 2) }))
        .filter((r) => r.msPerTurn > 0)
        .sort((a, b) => b.msPerTurn - a.msPerTurn)
        .slice(0, 30);
    };
    out.turns = {
      turns,
      file,
      totalSampledMs: turnAgg.totalSampledMs,
      note: "per-turn = (boot+N turns profile − boot-only profile) / N; inferred by subtraction",
      topFunctionsPerTurn: subtract(turnAgg.topFunctions, bootAgg?.topFunctions),
      topModulesPerTurn: subtract(turnAgg.topModules, bootAgg?.topModules),
      topPackagesPerTurn: subtract(turnAgg.topPackages, bootAgg?.topPackages),
    };
  }
  return out;
};

// ------------------------------------------------------------------ validation
/**
 * Proxy validation: each proxy must move with wall-clock across >= 3
 * configurations. Reports Pearson r and Spearman rho per proxy.
 */
const cmdValidate = async () => {
  const template = await ensureBaseTemplate();
  const repeat = intOpt("repeat", 5);
  const out = {};

  // (a) boot: module bytes loaded vs spawn-to-phase wall-clock, across phases
  //     and entries (source/bundle) and cache states.
  const bootPoints = [];
  for (const entryKind of ["source", "bundle"]) {
    if (entryKind === "bundle" && !fs.existsSync(BUNDLE_ENTRY)) continue;
    const census = await moduleCensus(entryKind, template);
    for (const cache of ["warm", "cold"]) {
      const runs = [];
      for (let i = 0; i < repeat; i += 1) runs.push(await bootOnce({ entryKind, cache, dataTemplate: template }));
      const p = (fn) => quantile(runs.map(fn), 0.5);
      const cumBytes = (phases) => phases.reduce((a, ph) => a + (census.phases[ph]?.bytes ?? 0), 0);
      bootPoints.push(
        { config: `${entryKind}.${cache}.transport`, proxyBytes: cumBytes(["transport"]), wallMs: p((r) => r.marks.spawnToTransportMs) },
        { config: `${entryKind}.${cache}.ready`, proxyBytes: cumBytes(["transport", "initialize", "ready"]), wallMs: p((r) => r.marks.spawnToReadyMs) },
      );
    }
  }
  out.bootModuleBytes = {
    points: bootPoints.map((p) => ({ ...p, wallMs: round(p.wallMs) })),
    pearson: pearson(bootPoints.map((p) => p.proxyBytes), bootPoints.map((p) => p.wallMs)),
    spearman: spearman(bootPoints.map((p) => p.proxyBytes), bootPoints.map((p) => p.wallMs)),
  };

  // (b) turns: sql statements / rpc bytes vs turn wall-clock across turn
  //     shapes (plain, tool, turn on 1k/10k history).
  const turnPoints = [];
  {
    const { client } = await bootForTurns("validate-turns", template);
    try {
      for (const [config, prompt] of [
        ["plain", "validate plain"],
        ["tool", "validate tool [perf:tool]"],
      ]) {
        const r = await measureTurns(client, { prompt, repeat: 10, warmup: 2, conversationId: `validate-${config}` });
        turnPoints.push({ config, sql: r.steady.sqlStatements.p50, sqlRows: r.steady.sqlRows.p50, rpcBytes: r.steady.rpcBytesOut.p50, wallMs: r.steady.toRunFinishedMs.p50 });
      }
    } finally {
      await client.stop();
    }
  }
  for (const n of listOpt("sizes", ["1000", "10000"]).map(Number)) {
    const { dir } = await ensureHistoryTemplate(n);
    const runDir = newRunDir(`validate-history-${n}`);
    const dataDir = path.join(runDir, "data");
    copyDir(dir, dataDir);
    const client = new WorkerClient({
      entry: SOURCE_ENTRY,
      entryKind: "source",
      env: workerEnv({ runDir, dataDir, cacheDir: warmCacheDir("source"), entryKind: "source" }),
    }).start();
    try {
      await client.boot(dataDir);
      const r = await measureTurns(client, { prompt: "validate history turn", repeat: 6, warmup: 1, conversationId: "perf-history" });
      turnPoints.push({ config: `history-${n}`, sql: r.steady.sqlStatements.p50, sqlRows: r.steady.sqlRows.p50, rpcBytes: r.steady.rpcBytesOut.p50, wallMs: r.steady.toRunFinishedMs.p50 });
    } finally {
      await client.stop();
    }
  }
  out.turnSqlStatements = {
    points: turnPoints,
    pearson: pearson(turnPoints.map((p) => p.sql), turnPoints.map((p) => p.wallMs)),
    spearman: spearman(turnPoints.map((p) => p.sql), turnPoints.map((p) => p.wallMs)),
  };
  out.turnSqlRows = {
    pearson: pearson(turnPoints.map((p) => p.sqlRows), turnPoints.map((p) => p.wallMs)),
    spearman: spearman(turnPoints.map((p) => p.sqlRows), turnPoints.map((p) => p.wallMs)),
  };
  out.turnRpcBytes = {
    pearson: pearson(turnPoints.map((p) => p.rpcBytes), turnPoints.map((p) => p.wallMs)),
    spearman: spearman(turnPoints.map((p) => p.rpcBytes), turnPoints.map((p) => p.wallMs)),
  };
  return out;
};

// ------------------------------------------------------------------ baseline / check
/**
 * Metrics the ratchet tracks. kind decides the default tolerance:
 *   time  -> +35% and +3ms slack (machine noise)
 *   count -> +5%  and +2 slack   (near-deterministic)
 *   exact -> no slack            (identical on every run: boot notifications,
 *                                 host requests, blocked fetches)
 *   bytes -> +5%  and +1KB slack (deterministic byte counts)
 *   mem   -> +20% and +2 slack   (RSS/heap in MB or KB; GC-timing noise)
 */
const TOLERANCE = {
  time: { rel: 0.35, abs: 3 },
  count: { rel: 0.05, abs: 2 },
  exact: { rel: 0, abs: 0 },
  bytes: { rel: 0.05, abs: 1024 },
  mem: { rel: 0.2, abs: 2 },
};
/** Kinds that gate by default and under --counts-only (machine-independent). */
const DETERMINISTIC_KINDS = new Set(["count", "exact", "bytes"]);
const extractMetrics = (report) => {
  const m = {};
  const put = (key, value, kind) => {
    if (value != null && Number.isFinite(value)) m[key] = { value: round(value, 2), kind };
  };
  const boot = report.boot ?? {};
  for (const cfg of ["source.warm", "source.cold", "bundle.warm", "bundle.cold"]) {
    const b = boot[cfg];
    if (!b) continue;
    put(`boot.${cfg}.spawnToTransportMs.p50`, b.spawnToTransportMs?.p50, "time");
    put(`boot.${cfg}.spawnToReadyMs.p50`, b.spawnToReadyMs?.p50, "time");
    put(`boot.${cfg}.spawnToReadyMs.p95`, b.spawnToReadyMs?.p95, "time");
    put(`boot.${cfg}.rssAfterReadyMB.p50`, b.rssAfterReadyMB?.p50, "mem");
    // Boot JSON-RPC (bench side, probe responses excluded, paths normalized).
    const ready = b.bootRpc?.ready;
    const settled = b.bootRpc?.settled;
    if (ready) {
      put(`boot.${cfg}.bootRpc.linesOut`, ready.lines, "exact");
      put(`boot.${cfg}.bootRpc.bytesOut`, ready.bytes, "bytes");
      put(`boot.${cfg}.bootRpc.notificationsTotal`, ready.notificationsTotal, "exact");
      for (const [name, n] of Object.entries(ready.notifications)) {
        put(`boot.${cfg}.bootRpc.notifications.${name}`, n, "exact");
      }
      put(`boot.${cfg}.bootRpc.hostRequests`, ready.hostRequestsTotal, "exact");
      for (const [name, n] of Object.entries(ready.hostRequests)) {
        put(`boot.${cfg}.bootRpc.hostRequests.${name}`, n, "exact");
      }
    }
    if (ready && settled) {
      // Work that moves from before ready to just after it must not escape
      // the gate: lines/bytes emitted in the post-ready settle window.
      put(`boot.${cfg}.bootRpc.postReadyLinesOut`, settled.lines - ready.lines, "exact");
      put(`boot.${cfg}.bootRpc.postReadyBytesOut`, settled.bytes - ready.bytes, "bytes");
    }
    if (b.bootFetch) {
      put(`boot.${cfg}.fetch.blocked`, b.bootFetch.blocked, "exact");
      put(`boot.${cfg}.fetch.catalogRequests`, b.bootFetch.catalog404, "exact");
    }
  }
  for (const entry of ["source", "bundle"]) {
    const c = boot.census?.[entry];
    if (!c) continue;
    put(`boot.census.${entry}.bootModules`, c.bootModules, "count");
    put(`boot.census.${entry}.bootBytes`, c.bootBytes, "bytes");
  }
  const turn = report.turn;
  for (const kind of ["plain", "tool"]) {
    const t = turn?.[kind];
    if (!t) continue;
    put(`turn.${kind}.toRunFinishedMs.p50`, t.steady.toRunFinishedMs?.p50, "time");
    put(`turn.${kind}.toRunFinishedMs.p95`, t.steady.toRunFinishedMs?.p95, "time");
    put(`turn.${kind}.toRunStartedMs.p50`, t.steady.toRunStartedMs?.p50, "time");
    put(`turn.${kind}.nonToolMs.p50`, t.steady.nonToolMs?.p50, "time");
    put(`turn.${kind}.toIdleMs.p50`, t.steady.toIdleMs?.p50, "time");
    put(`turn.${kind}.sqlStatements.p50`, t.steady.sqlStatements?.p50, "count");
    put(`turn.${kind}.writeStatements.p50`, t.steady.writeStatements?.p50, "count");
    put(`turn.${kind}.sqlRows.p50`, t.steady.sqlRows?.p50, "count");
    put(`turn.${kind}.rpcLinesOut.p50`, t.steady.rpcLinesOut?.p50, "count");
    put(`turn.${kind}.rpcBytesOut.p50`, t.steady.rpcBytesOut?.p50, "bytes");
    put(`turn.${kind}.firstTurn.toRunFinishedMs`, t.firstTurn?.toRunFinishedMs, "time");
  }
  for (const [n, h] of Object.entries(report.history ?? {})) {
    put(`history.${n}.listEvents.p50`, h.listEvents?.ms?.p50, "time");
    put(`history.${n}.getEventCount.p50`, h.getEventCount?.ms?.p50, "time");
    put(`history.${n}.turnOnHistory.toRunFinishedMs.p50`, h.turnOnHistory?.toRunFinishedMs?.p50, "time");
    put(`history.${n}.turnOnHistory.sqlRows`, h.turnOnHistory?.sqlRows?.p50, "count");
    put(`history.${n}.listEvents.sqlStatementsPerCall`, h.listEvents?.sqlStatementsPerCall, "count");
    put(`history.${n}.appendMsPerEvent`, h.seed?.appendMsPerEvent, "time");
    put(`history.${n}.sqlStatementsPerAppend`, h.seed?.sqlStatementsPerAppend, "count");
  }
  const mem = report.memory;
  if (mem) {
    for (const p of mem.points) put(`memory.rssMB.after${p.turns}Turns`, p.rssMB, "mem");
    for (const p of mem.points) put(`memory.heapUsedMB.after${p.turns}Turns`, p.heapUsedMB, "mem");
  }
  const bundle = report.bundle;
  if (bundle?.metafile) {
    put("bundle.outputJsBytes", bundle.metafile.outputJsBytes, "bytes");
    put("bundle.bootReachableBytes", bundle.metafile.bootReachableBytes, "bytes");
    put("bundle.bootReachableFiles", bundle.metafile.bootReachableFiles, "count");
  }
  return m;
};
const ceilingFor = (value, kind) => {
  const tol = TOLERANCE[kind] ?? TOLERANCE.time;
  return round(value * (1 + tol.rel) + tol.abs, 2);
};
const isGating = (kind) => {
  // --counts-only (CI): only machine-independent kinds gate; wall-clock and
  // memory are reported as warnings on any runner.
  if (opts["counts-only"]) return DETERMINISTIC_KINDS.has(kind);
  // Default: counts, bytes and memory gate; wall-clock gates only with
  // --strict-time (same machine class, quiet host).
  return kind !== "time" || Boolean(opts["strict-time"]);
};
const checkAgainstBaseline = (metrics, baseline) => {
  const failures = [];
  const rows = [];
  const skipped = [];
  for (const [key, base] of Object.entries(baseline.metrics)) {
    const cur = metrics[key];
    if (!cur) {
      skipped.push(key);
      continue;
    }
    const ok = cur.value <= base.ceiling;
    const gating = isGating(base.kind);
    rows.push({ key, kind: base.kind, baseline: base.value, ceiling: base.ceiling, current: cur.value, ok, gating });
    if (!ok && gating) failures.push(key);
  }
  const untracked = Object.keys(metrics).filter((key) => !baseline.metrics[key]);
  return { rows, failures, skipped, untracked };
};

// ------------------------------------------------------------------ main
const machine = () => ({
  platform: `${process.platform}-${process.arch}`,
  cpu: os.cpus()[0]?.model,
  cores: os.cpus().length,
  memGB: Math.round(os.totalmem() / 1073741824),
  bun: spawnSync(BUN, ["--version"], { encoding: "utf8" }).stdout.trim(),
  gitHead: spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" }).stdout.trim(),
  // Uncommitted runtime/contracts edits change what is measured; record them.
  dirtyRuntimeFiles: spawnSync("git", ["status", "--porcelain", "--", "packages/runtime", "packages/contracts"], { cwd: REPO, encoding: "utf8" })
    .stdout.split("\n")
    .filter((l) => l.trim() && !l.includes("scripts/perf/")).length,
});

const COMMANDS = {
  boot: cmdBoot,
  turn: cmdTurn,
  history: cmdHistory,
  memory: cmdMemory,
  bundle: cmdBundle,
  profile: cmdProfile,
  validate: cmdValidate,
};

const printHelp = () => {
  process.stderr.write(`Usage: bun packages/runtime/scripts/perf/bench.mjs <command> [options]

Commands
  boot       J1 worker cold start (source + bundle, warm + cold transpiler cache) + module census
  turn       J2 chat-turn overhead, J3 tool-call overhead, J5 persistence (derived)
  history    J4 listEvents/getEventCount at N=1k,10k,100k (seeded via appendEvent)
  memory     J6 RSS/heap after boot, 10 and 100 turns
  bundle     J7 dist-electron/runtime sizes + esbuild metafile dependency breakdown
  profile    --cpu-prof top functions/modules for boot (source+bundle) and turns
  validate   proxy-vs-wall-clock correlation across configurations
  all        boot + turn + history + memory + bundle (the baseline suite)
  check      run the CI suite and fail if any metric exceeds baseline.json ceilings

Options
  --lab-dir DIR       scratch root (default $STELLA_PERF_LAB_DIR or $TMPDIR/stella-perf-lab)
  --json              print the JSON report on stdout
  --out FILE          also write the JSON report to FILE
  --repeat N          measured repetitions (boot 8, turn 20, history 20)
  --warmup N          warmup turns before measuring (turn: 3)
  --entry a,b         boot/profile entries: source,bundle
  --cache a,b         boot cache states: warm,cold
  --sizes a,b         history sizes (default 1000,10000,100000)
  --history-shape S   (history) legacy (default; events predate the thread) or modern
  --turns a,b         memory checkpoints (default 10,100)
  --reseed            rebuild seeded template data dirs
  --template NAME     (profile) profile against templates/NAME, e.g. history-100000-v1
  --turns N           (profile) turns in the turn profile (default 40)
  --gc-each-turn      (turn) force a full GC before every timed turn (diagnostic)
  --turn-gap-ms N     (turn) idle gap between timed turns (diagnostic)
  --write-baseline    (all/check) write baseline.json from this run
  --ratchet           (check) lower ceilings where this run beat them
  --strict-time       (check) wall-clock regressions fail instead of warn
  --counts-only       (check) only count/exact/bytes metrics gate; wall-clock and
                      memory warn on any runner (the CI mode)
  --add-missing       (any) add metrics this run measured that baseline.json lacks
  --keep-runs         keep <lab-dir>/runs (per-run data dir copies) for inspection
  --verbose           echo worker stderr
`);
};

const main = async () => {
  if (command === "help" || opts.help) return printHelp();
  mkdirp(LAB_DIR);
  const report = { machine: machine(), recordedAt: new Date().toISOString(), labDir: LAB_DIR };
  const started = performance.now();
  if (command === "all" || command === "check") {
    const suite = command === "check" ? ["boot", "turn", "history", "bundle"] : ["boot", "turn", "history", "memory", "bundle"];
    if (command === "check") {
      opts.sizes ??= "1000,10000";
      opts.entry ??= "source";
      opts.cache ??= "warm";
      opts["no-census"] ??= false;
    }
    for (const name of suite) {
      log(`== ${name}`);
      report[name] = await COMMANDS[name]();
    }
  } else if (COMMANDS[command]) {
    report[command] = await COMMANDS[command]();
  } else {
    printHelp();
    process.exit(2);
  }
  report.elapsedMs = round(performance.now() - started);
  const metrics = extractMetrics(report);
  report.metrics = metrics;
  let exitCode = 0;
  if (command === "check") {
    if (!fs.existsSync(BASELINE_PATH)) throw new Error(`no baseline at ${BASELINE_PATH}`);
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
    const { rows, failures, skipped, untracked } = checkAgainstBaseline(metrics, baseline);
    report.check = { rows, failures, skipped, untracked };
    for (const r of rows) {
      const tag = r.ok ? (r.gating ? "ok  " : "ok ~") : r.gating ? "FAIL" : "warn";
      process.stderr.write(`${tag} ${r.key}: ${r.current} (ceiling ${r.ceiling}, baseline ${r.baseline})\n`);
    }
    process.stderr.write(
      `[perf] check: ${rows.filter((r) => r.gating).length} gating, ${rows.filter((r) => !r.gating).length} advisory (~), ` +
        `${failures.length} failed, ${skipped.length} baseline metrics not measured by this run` +
        `${untracked.length ? `, ${untracked.length} measured but not in baseline: ${untracked.join(", ")}` : ""}\n`,
    );
    // Deterministic boot counts must not vary between runs of one check.
    const varied = Object.entries(report.boot ?? {}).flatMap(([cfg, b]) =>
      Object.entries(b?.bootRpc ?? {}).flatMap(([window, f]) => f.nondeterministic.map((x) => `${cfg}.${window}.${x}`)),
    );
    if (varied.length) {
      process.stderr.write(`FAIL boot RPC counts varied across runs: ${varied.join(", ")}\n`);
      failures.push(...varied);
    }
    if (failures.length) exitCode = 1;
    if (opts.ratchet) {
      for (const r of rows) {
        const base = baseline.metrics[r.key];
        const next = ceilingFor(r.current, base.kind);
        if (next < base.ceiling) {
          base.ceiling = next;
          base.value = r.current;
        }
      }
      writeJson(BASELINE_PATH, baseline);
      log(`ratcheted ${BASELINE_PATH}`);
    }
  }
  if (opts["add-missing"] && !opts["write-baseline"]) {
    // Add metrics this run measured that baseline.json lacks (fresh ceilings);
    // never touches an existing entry.
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
    const added = [];
    for (const [k, v] of Object.entries(metrics)) {
      if (baseline.metrics[k]) continue;
      baseline.metrics[k] = { ...v, ceiling: ceilingFor(v.value, v.kind) };
      added.push(k);
    }
    writeJson(BASELINE_PATH, baseline);
    log(`added ${added.length} metrics to ${BASELINE_PATH}${added.length ? `: ${added.join(", ")}` : ""}`);
  }
  if (opts["write-baseline"]) {
    const baseline = {
      schema: 1,
      note: "Ceilings are value*(1+rel)+abs per kind (see TOLERANCE in bench.mjs). Lower a ceiling by editing it or running `check --ratchet`; never raise one without a written reason in the PR.",
      machine: report.machine,
      recordedAt: report.recordedAt,
      metrics: Object.fromEntries(
        Object.entries(metrics).map(([k, v]) => [k, { ...v, ceiling: ceilingFor(v.value, v.kind) }]),
      ),
    };
    writeJson(BASELINE_PATH, baseline);
    log(`wrote ${BASELINE_PATH}`);
  }
  // Per-run scratch (copied data dirs, cold transpiler caches) is disposable;
  // templates/, cache/ and profiles/ are kept.
  if (!opts["keep-runs"]) rmrf(path.join(LAB_DIR, "runs"));
  if (opts.out) writeJson(path.resolve(String(opts.out)), report);
  if (JSON_OUT) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stderr.write(`${JSON.stringify(metrics, null, 2)}\n`);
  process.exit(exitCode);
};

// Importable for ad-hoc experiments (bun only): the CLI runs when executed.
export {
  WorkerClient,
  workerEnv,
  prepareDataDir,
  copyDir,
  newRunDir,
  warmCacheDir,
  ensureBaseTemplate,
  ensureHistoryTemplate,
  runTurn,
  measureTurns,
  diffSnap,
  topStatements,
  summarize,
  SOURCE_ENTRY,
  BUNDLE_ENTRY,
  LAB_DIR,
};
if (import.meta.main ?? true) {
  main().catch((error) => {
    process.stderr.write(`[perf] fatal: ${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
