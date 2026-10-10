/**
 * Perf-lab probe, loaded ONLY by `scripts/perf/bench.mjs` via
 * `bun --preload`. Nothing in the production worker imports this file; the
 * worker behaves exactly as shipped except for what is listed here.
 *
 *   1. Network guard (always on). `fetch` never leaves the machine. The
 *      pi.dev model-catalog refresh answers 404 (the runtime records an
 *      empty refreshed catalog and moves on, deterministically); anything
 *      else throws and is counted in `fetch.blocked`.
 *   2. Scripted model server (STELLA_PERF_FAKE_PROVIDER=1). The guard
 *      answers OpenAI-compatible chat completions at
 *      `http://perf-scripted.invalid/v1` in process; the bench pins the
 *      orchestrator to `local/<that base URL>/scripted` in preferences.json,
 *      which pi-durable runs on its `local` provider exactly as it runs a
 *      user's Ollama or LM Studio model. Responses are instant streams, so a
 *      turn's wall-clock is pure runtime overhead:
 *        - last message is a tool result        -> text "done", stop
 *        - user text contains "[perf:tool]"     -> one tool call
 *          (STELLA_PERF_FAKE_TOOL / STELLA_PERF_FAKE_TOOL_ARGS, JSON)
 *        - otherwise                            -> fixed text in
 *          STELLA_PERF_FAKE_CHUNKS deltas (default 8)
 *   3. Counters (always on): bun:sqlite statements (count + time per SQL
 *      shape, split by database file), stdout bytes/lines/method (the stdio
 *      JSON-RPC channel), blocked fetches.
 *   4. Module census (STELLA_PERF_MODULE_CENSUS=1): a Bun loader plugin that
 *      records every TS source / bundle chunk the runtime loads, with byte
 *      size and load time. It re-reads sources through the plugin path, so
 *      census runs are for counting only and are never timed.
 *
 * Snapshots: on SIGUSR2 the probe writes one line
 *   `@@PERF {json}\n`
 * to stderr (after a full GC so RSS/heap are comparable). The bench diffs
 * consecutive snapshots; nothing is ever reset in-process.
 */
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";

const bootAt = performance.now();
const env = process.env;

// ---------------------------------------------------------------- census
type CensusEntry = { path: string; bytes: number; at: number };
const census: CensusEntry[] = [];
if (env.STELLA_PERF_MODULE_CENSUS === "1") {
  // Only ESM-safe files are intercepted: TypeScript sources and the esbuild
  // ESM bundle chunks. Plugin-loaded `.js` loses Bun's CommonJS detection,
  // so node_modules JS is left to the default loader and the bench expands
  // each observed module to its static import closure from an esbuild
  // metafile instead.
  const filter = new RegExp(
    env.STELLA_PERF_MODULE_CENSUS_FILTER ??
      "(\\.(m|c)?tsx?$)|(dist-electron/runtime/.*\\.js$)",
  );
  const loaderFor = (file: string): "ts" | "tsx" | "js" => {
    if (file.endsWith(".tsx")) return "tsx";
    if (/\.(m|c)?ts$/.test(file)) return "ts";
    return "js";
  };
  Bun.plugin({
    name: "stella-perf-census",
    setup(build) {
      build.onLoad({ filter }, (args) => {
        const contents = readFileSync(args.path, "utf8");
        census.push({
          path: args.path,
          bytes: Buffer.byteLength(contents),
          at: performance.now() - bootAt,
        });
        return { contents, loader: loaderFor(args.path) };
      });
    },
  });
}

// ---------------------------------------------------------------- fetch
const fetchStats = { catalog404: 0, blocked: 0, blockedUrls: [] as string[] };
const fakeStats = { calls: 0, toolCalls: 0, lastToolNames: [] as string[], lastSystemPromptChars: 0, lastMessageCount: 0 };
const SCRIPTED_BASE_URL = "http://perf-scripted.invalid/v1";
const scriptedModel = env.STELLA_PERF_FAKE_PROVIDER === "1" ? createScriptedModel() : null;
const guardedFetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : ((input as { url?: string })?.url ?? String(input));
  if (url.startsWith("https://pi.dev/api/models/providers/")) {
    fetchStats.catalog404 += 1;
    return new Response("not found", { status: 404 });
  }
  if (scriptedModel && url === `${SCRIPTED_BASE_URL}/chat/completions`) {
    const body =
      typeof init?.body === "string"
        ? init.body
        : input instanceof Request
          ? await input.text()
          : String(init?.body ?? "");
    return scriptedModel(JSON.parse(body));
  }
  fetchStats.blocked += 1;
  if (fetchStats.blockedUrls.length < 20) fetchStats.blockedUrls.push(url);
  throw new Error(`perf-lab: network blocked: ${url}`);
};
(globalThis as { fetch: unknown }).fetch = guardedFetch;

/** The scripted model: one OpenAI chat-completions stream per request. */
function createScriptedModel() {
  const chunkCount = Math.max(1, Number(env.STELLA_PERF_FAKE_CHUNKS ?? "8") || 8);
  const toolName = env.STELLA_PERF_FAKE_TOOL ?? "Bash";
  const toolArgs = env.STELLA_PERF_FAKE_TOOL_ARGS ?? '{"cmd":"true"}';
  const replyText = "Scripted perf-lab reply. ".repeat(4).trim();
  let callSeq = 0;
  type ChatMessage = { role?: string; content?: unknown };
  const textOf = (message: ChatMessage | undefined): string => {
    const content = message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => (part && part.type === "text" ? String(part.text) : ""))
        .join("\n");
    }
    return "";
  };
  return (request: {
    model?: string;
    messages?: ChatMessage[];
    tools?: Array<{ function?: { name?: string } }>;
  }): Response => {
    const messages = request.messages ?? [];
    const last = messages[messages.length - 1];
    const lastUser = [...messages].reverse().find((m) => m?.role === "user");
    const wantsTool = last?.role !== "tool" && textOf(lastUser).includes("[perf:tool]");
    callSeq += 1;
    fakeStats.calls += 1;
    if (wantsTool) fakeStats.toolCalls += 1;
    fakeStats.lastToolNames = (request.tools ?? []).map((tool) => String(tool.function?.name));
    fakeStats.lastSystemPromptChars = messages
      .filter((m) => m?.role === "system" || m?.role === "developer")
      .reduce((total, m) => total + textOf(m).length, 0);
    fakeStats.lastMessageCount = messages.length;
    const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
      `data: ${JSON.stringify({
        id: `perf-${callSeq}`,
        object: "chat.completion.chunk",
        created: 0,
        model: request.model ?? "scripted",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`;
    const events: string[] = [];
    if (wantsTool) {
      events.push(
        chunk({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `perf_call_${callSeq}`,
              type: "function",
              function: { name: toolName, arguments: toolArgs },
            },
          ],
        }),
        chunk({}, "tool_calls"),
      );
    } else {
      const text = last?.role === "tool" ? "done" : replyText;
      const size = Math.ceil(text.length / chunkCount);
      for (let i = 0; i < text.length; i += size) {
        events.push(chunk(i === 0 ? { role: "assistant", content: text.slice(i, i + size) } : { content: text.slice(i, i + size) }));
      }
      events.push(chunk({}, "stop"));
    }
    events.push("data: [DONE]\n\n");
    return new Response(events.join(""), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
}

// ---------------------------------------------------------------- sqlite
type SqlStat = { count: number; ms: number };
const sqlStats = new Map<string, SqlStat>();
const sqlTotals = { statements: 0, ms: 0, rows: 0, prepares: 0, queryCalls: 0, prepareMs: 0 };
const dbNames = new WeakMap<object, string>();
const shapeCache = new Map<string, string>();
const normalizeSql = (sql: string): string => {
  let shape = shapeCache.get(sql);
  if (shape === undefined) {
    shape = sql.replace(/\s+/g, " ").trim().slice(0, 200);
    if (shapeCache.size < 5000) shapeCache.set(sql, shape);
  }
  return shape;
};
const record = (db: string, sql: string, ms: number) => {
  const key = `${db}|${sql}`;
  const stat = sqlStats.get(key);
  if (stat) {
    stat.count += 1;
    stat.ms += ms;
  } else {
    sqlStats.set(key, { count: 1, ms });
  }
  sqlTotals.statements += 1;
  sqlTotals.ms += ms;
};
const dbLabel = (db: object): string => {
  const known = dbNames.get(db);
  if (known) return known;
  const filename = String((db as { filename?: string }).filename ?? "?");
  const label = filename.split("/").pop() || filename;
  dbNames.set(db, label);
  return label;
};
const STATEMENT_METHODS = ["run", "all", "get", "values", "iterate"] as const;
const wrapped = new WeakSet<object>();
const wrapStatement = <T extends object>(db: object, sql: string, stmt: T): T => {
  // db.query() returns a cached statement; wrap each object exactly once.
  if (wrapped.has(stmt)) return stmt;
  wrapped.add(stmt);
  const shape = normalizeSql(sql);
  const target = stmt as Record<string, unknown>;
  for (const method of STATEMENT_METHODS) {
    const original = target[method];
    if (typeof original !== "function") continue;
    target[method] = function (this: unknown, ...args: unknown[]) {
      const start = performance.now();
      try {
        const result = (original as (...a: unknown[]) => unknown).apply(stmt, args);
        if (Array.isArray(result)) sqlTotals.rows += result.length;
        else if (result != null && method === "get") sqlTotals.rows += 1;
        return result;
      } finally {
        record(dbLabel(db), shape, performance.now() - start);
      }
    };
  }
  return stmt;
};
const proto = Database.prototype as unknown as Record<string, unknown>;
// STELLA_PERF_SQL_COUNTERS=0 leaves bun:sqlite untouched (profile runs, so
// the wrapper never shows up in a flame graph).
const sqlCounters = env.STELLA_PERF_SQL_COUNTERS !== "0";
for (const method of sqlCounters ? (["prepare", "query"] as const) : []) {
  const original = proto[method] as (sql: string, ...rest: unknown[]) => object;
  proto[method] = function (this: object, sql: string, ...rest: unknown[]) {
    if (method === "prepare") sqlTotals.prepares += 1;
    else sqlTotals.queryCalls += 1;
    const start = performance.now();
    const stmt = original.call(this, sql, ...rest);
    sqlTotals.prepareMs += performance.now() - start;
    return wrapStatement(this, sql, stmt);
  };
}
for (const method of sqlCounters ? (["exec", "run"] as const) : []) {
  const original = proto[method] as (sql: string, ...rest: unknown[]) => unknown;
  proto[method] = function (this: object, sql: string, ...rest: unknown[]) {
    const start = performance.now();
    try {
      return original.call(this, sql, ...rest);
    } finally {
      record(dbLabel(this), normalizeSql(String(sql)), performance.now() - start);
    }
  };
}

// ---------------------------------------------------------------- stdout
const outStats = {
  bytes: 0,
  lines: 0,
  writes: 0,
  byMethod: {} as Record<string, { lines: number; bytes: number }>,
};
const METHOD_RE = /"method":"([^"]+)"/;
const bump = (key: string, bytes: number) => {
  const entry = (outStats.byMethod[key] ??= { lines: 0, bytes: 0 });
  entry.lines += 1;
  entry.bytes += bytes;
};
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
(process.stdout as { write: unknown }).write = (
  chunk: unknown,
  ...rest: unknown[]
) => {
  const text =
    typeof chunk === "string"
      ? chunk
      : chunk instanceof Uint8Array
        ? Buffer.from(chunk).toString("utf8")
        : String(chunk);
  outStats.writes += 1;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const bytes = Buffer.byteLength(line) + 1;
    outStats.lines += 1;
    outStats.bytes += bytes;
    const head = line.slice(0, 400);
    const method = METHOD_RE.exec(head)?.[1];
    bump(method ?? (head.includes('"error"') ? "(response:error)" : "(response)"), bytes);
  }
  return (originalStdoutWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
};

// ---------------------------------------------------------------- snapshots
const preloadDoneAt = performance.now();
const snapshot = () => {
  const { heapStats } = require("bun:jsc") as {
    heapStats: () => { heapSize: number; heapCapacity: number; objectCount: number; extraMemorySize: number };
  };
  // Pre-GC heap: live + not-yet-collected garbage. Diffed against the
  // previous snapshot's post-GC heap it is a lower bound on bytes allocated
  // in the window (eden collections inside the window reclaim some).
  const preGc = heapStats();
  Bun.gc(true);
  const heap = heapStats();
  const mem = process.memoryUsage();
  return {
    uptimeMs: performance.now() - bootAt,
    // Epoch anchors so the bench can place worker-internal marks on its own
    // clock: process start (timeOrigin), preload start, preload end.
    timeOriginEpochMs: performance.timeOrigin,
    preloadStartMs: bootAt,
    preloadDoneMs: preloadDoneAt,
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      jscHeapSize: heap.heapSize,
      jscObjectCount: heap.objectCount,
      jscExtraMemory: heap.extraMemorySize,
      jscHeapSizeBeforeGc: preGc.heapSize,
      jscObjectCountBeforeGc: preGc.objectCount,
    },
    sqlite: {
      ...sqlTotals,
      byStatement: Object.fromEntries(sqlStats),
    },
    stdout: outStats,
    fetch: fetchStats,
    fakeProvider: fakeStats,
    census: census.length > 0 ? census : undefined,
  };
};
process.on("SIGUSR2", () => {
  process.stderr.write(`@@PERF ${JSON.stringify(snapshot())}\n`);
});
