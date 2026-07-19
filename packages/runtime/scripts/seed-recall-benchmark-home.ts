/**
 * Seed an ISOLATED v2 dev home for the Recall parity benchmark.
 *
 * Written fresh for v2 (not derived from any v1 script): all writes go
 * through v2's production storage APIs (`initializeDesktopDatabase`,
 * `SessionStore`, `DreamInboxStore`) and the dream-storage path helpers, so
 * the seeded home matches exactly what packaged v2 would produce.
 *
 * Isolation contract (mirrors desktop/electron/data-paths.ts semantics):
 * `--data-dir` is required, must equal `STELLA_V2_DEV_DATA_DIR`, must not
 * overlap `~/.stella` (shared with the LIVE v1 app), must stay inside the
 * user home or OS temp, and must not traverse symlinks. The target directory
 * must not already contain a database (no accidental reseeding over data).
 *
 * The seeded content recreates the SHAPE of the certified v1 measurement
 * environment (certified design: memory_summary.md + memory_index.md +
 * MEMORY.md + profile.md + chronicle + conversations/threads relevant to the
 * ten canonical queries), not its bytes: the certified snapshot was a frozen
 * copy of a real 2.1 GB home and is not reproducible nor appropriate to
 * copy. Per-query intent:
 *
 * - memory_system     -> one memory_index.md entry carries all four anchors
 *                        (profile.md, memory_summary.md, MEMORY.md, Recall)
 *                        so the durable fast path can answer directly.
 * - carplay_thread    -> a CarPlay thread exists, but its identity line does
 *                        not carry all anchor groups -> deterministic no-match.
 * - utility_model_policy, release_workflow, radial_ui_decision -> related
 *                        words appear scattered, never co-occurring in one
 *                        evidence unit -> deterministic no-match.
 * - browser_cleanup_race, prompt_contract, episodic_drive -> only tangential
 *                        transcript evidence -> synthesis (model decides).
 * - billing_case      -> full story in transcripts -> synthesis can answer.
 * - no_match          -> nothing about Project Zephyr exists anywhere.
 *
 * Run from the repo root (Bun does not expose node:sqlite):
 *   node node_modules/esbuild/bin/esbuild packages/runtime/scripts/seed-recall-benchmark-home.ts --bundle --platform=node --format=esm --banner:js="import { createRequire as __stellaCreateRequire } from 'node:module'; const require = __stellaCreateRequire(import.meta.url);" --outfile=/tmp/stella-v2-recall-seed.mjs
 *   STELLA_V2_DEV_DATA_DIR=<dir> node /tmp/stella-v2-recall-seed.mjs --data-dir <dir>
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "../kernel/storage/database-init.js";
import { SessionStore } from "../kernel/storage/session-store.js";
import {
  memoriesRoot,
  memoryFilePath,
  memoryIndexPath,
  memorySummaryPath,
} from "../kernel/memory/dream-storage.js";

const readArg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const assertIsolatedSeedDataDir = (candidate: string): string => {
  const resolved = path.resolve(candidate);
  const declared = process.env.STELLA_V2_DEV_DATA_DIR?.trim();
  if (!declared || path.resolve(declared) !== resolved) {
    throw new Error(
      "--data-dir must equal STELLA_V2_DEV_DATA_DIR (isolated dev home only)",
    );
  }
  const liveDataDir = path.resolve(path.join(os.homedir(), ".stella"));
  const within = (child: string, root: string): boolean => {
    const relative = path.relative(
      path.resolve(root).toLowerCase(),
      path.resolve(child).toLowerCase(),
    );
    return (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
  };
  if (within(resolved, liveDataDir) || within(liveDataDir, resolved)) {
    throw new Error(
      "--data-dir must not overlap ~/.stella (shared with the LIVE v1 app)",
    );
  }
  const boundary = [os.homedir(), os.tmpdir()]
    .map((root) => path.resolve(root))
    .find((root) => within(resolved, root));
  if (!boundary) {
    throw new Error("--data-dir must stay within the user home or OS temp");
  }
  let cursor = boundary;
  for (const segment of path.relative(boundary, resolved).split(path.sep)) {
    if (!segment) continue;
    cursor = path.join(cursor, segment);
    try {
      if (lstatSync(cursor).isSymbolicLink()) {
        throw new Error("--data-dir must not use symlink aliases");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return resolved;
};

const dataDirArg = readArg("--data-dir");
if (!dataDirArg) throw new Error("--data-dir is required");
const DATA_DIR = assertIsolatedSeedDataDir(dataDirArg);
if (existsSync(getDesktopDatabasePath(DATA_DIR))) {
  throw new Error(
    `Refusing to reseed: ${DATA_DIR} already contains a database. Delete the directory first if a fresh seed is intended.`,
  );
}

/** Deterministic clock: fixed timestamps make the seed byte-reproducible. */
const T0 = Date.parse("2026-07-01T09:00:00-07:00");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// Memory files (certified design: summary + index + MEMORY.md + profile).
// ---------------------------------------------------------------------------

mkdirSync(memoriesRoot(DATA_DIR), { recursive: true });
mkdirSync(path.join(DATA_DIR, "memories_extensions", "chronicle"), {
  recursive: true,
});

const PROFILE_MD = `# Profile

- Name: Rahul
- Location: Los Angeles, CA (America/Los_Angeles)
- Role: builds and maintains the Stella desktop app
- Preference: terse status reports, no filler
`;

const MEMORY_SUMMARY_MD = `# Memory summary

- Active focus: v2 desktop hardening and the Recall latency overhaul port.
- Recent context: benchmark harness work on an isolated dev home; the live
  home is never touched by tests or measurements.
- Secondary: intermittent CarPlay screen debugging on the test vehicle.
`;

// The memory_system entry deliberately carries profile.md, memory_summary.md,
// MEMORY.md, and Recall in ONE entry so the durable fast path can return it
// directly. Other entries scatter their topic words so no other query's full
// anchor set co-occurs inside a single entry.
const MEMORY_INDEX_MD = `# Memory routing index

> What memory contains and where to find it. Pointer-only routing entries.
> Maximum 80 entries and 6000 characters. Each entry carries an
> updated date; prune entries older than 90 days unless recent usage shows they remain useful.

- Memory system layout: Recall searches profile.md, memory_summary.md, memory_index.md, and MEMORY.md; profile.md stays Remember-owned and Dream never edits it. (updated 2026-07-10)
- Vehicle debugging notes live in agent threads, newest first. (updated 2026-07-08)
- Release procedures: see MEMORY.md task blocks from early July. (updated 2026-07-06)
- Billing follow-ups are tracked in past chat transcripts. (updated 2026-07-12)
`;

const MEMORY_MD = `# MEMORY

## 2026-07-05 — desktop release pass

- Shipped the July desktop build after the usual verification pass.
- Follow-up: watch the crash reporter for the first 48 hours.

## 2026-07-09 — utility pass housekeeping

- Recall stays on the light utility tier; nothing else changed today.
- Chronicle rotation confirmed healthy.

## 2026-07-12 — UI review notes

- Reviewed the dial prototype with fresh eyes; decision still pending a
  usability session. Native menu comparison deferred.
`;

const CHRONICLE_MD = `# 2026-07-12

- Morning: benchmark harness cleanup.
- Afternoon: reviewed billing paperwork and filed the pending follow-up.
`;

writeFileSync(path.join(memoriesRoot(DATA_DIR), "profile.md"), PROFILE_MD);
writeFileSync(memorySummaryPath(DATA_DIR), MEMORY_SUMMARY_MD);
writeFileSync(memoryIndexPath(DATA_DIR), MEMORY_INDEX_MD);
writeFileSync(memoryFilePath(DATA_DIR), MEMORY_MD);
writeFileSync(
  path.join(DATA_DIR, "memories_extensions", "chronicle", "2026-07-12.md"),
  CHRONICLE_MD,
);
writeFileSync(
  path.join(DATA_DIR, "preferences.json"),
  `${JSON.stringify(
    {
      agentRuntimeEngine: "claude_code_local",
      // Saved adversarial preference: the certified never-fable invariant means
      // no Recall route may resolve to this saved model.
      claudeCodeModel: "fable",
    },
    null,
    2,
  )}\n`,
);

// ---------------------------------------------------------------------------
// Database content through production APIs.
// ---------------------------------------------------------------------------

const db = new DatabaseSync(getDesktopDatabasePath(DATA_DIR));
initializeDesktopDatabase(db as never);
const store = new SessionStore(db as never);
const conversationId = store.getOrCreateDefaultConversationId();

let eventOrdinal = 0;
const say = (text: string, atMs: number, type = "user_message"): void => {
  eventOrdinal += 1;
  store.appendEvent({
    conversationId,
    eventId: `seed-evt-${String(eventOrdinal).padStart(4, "0")}`,
    type,
    timestamp: atMs,
    payload: { text },
  });
};

// billing_case: complete story -> the synthesis route has enough to answer.
say(
  "Heads up: I noticed anomalous Vercel AI Gateway credit charges on the July statement — three duplicate $40 credit top-ups I never initiated.",
  T0 + 11 * DAY,
);
say(
  "Update on the Vercel AI Gateway charges: I sent the dispute through the Vercel dashboard billing support form on July 12 and attached the statement screenshots. Case number VER-88213.",
  T0 + 11 * DAY + 2 * HOUR,
  "assistant_message",
);

// browser_cleanup_race: tangential only — cleanup is mentioned, the actual
// finding is not recorded, matching the certified no-match synthesis shape.
say(
  "The browser session felt flaky again today; old tabs seem to linger longer than they should before cleanup kicks in.",
  T0 + 6 * DAY,
);

// prompt_contract: tangential only.
say(
  "We should tidy the orchestrator prompt at some point — it has grown a lot of sections.",
  T0 + 7 * DAY,
);

// episodic_drive: the car exists in history; the specific first destination
// drive is not recorded, matching the certified no-match synthesis shape.
say(
  "Picked up the blue Lotus Emira from the dealer this morning. Garage parking is going to be tight.",
  T0 + 2 * DAY,
);

// Filler volume so FTS search does non-trivial work.
for (let index = 0; index < 240; index += 1) {
  say(
    `Routine worklog entry ${index}: touched module ${index % 17}, reviewed notes, nothing memorable.`,
    T0 + 13 * DAY + index * 60_000,
    index % 3 === 0 ? "assistant_message" : "user_message",
  );
}

// Threads. The CarPlay thread's identity line (thread id + name) deliberately
// does not carry the full anchor set (no "connect replay", no "race"), so the
// delegated fast path must reject it instead of returning an unrelated row.
const saveThread = (
  nameHint: string,
  description: string,
  result: string,
  atMs: number,
  runId: string,
): string => {
  const thread = store.resolveOrCreateActiveThread({
    conversationId,
    agentType: "general",
    nameHint,
  });
  store.saveAgentRecord({
    threadId: thread.threadId,
    conversationId,
    agentType: "general",
    description,
    agentDepth: 0,
    attemptGeneration: 0,
    status: "completed",
    startedAt: atMs,
    completedAt: atMs + HOUR,
    result,
    updatedAt: atMs + HOUR,
  });
  store.dreamInboxStore.recordThreadSummary({
    threadId: thread.threadId,
    runId,
    agentType: "general",
    rolloutSummary: result,
  });
  return thread.threadId;
};

const carplayThreadId = saveThread(
  "CarPlay screen debugging",
  "Investigate the CarPlay screen going dark after startup",
  "Instrumented the head-unit handshake; captured logs for the dark-screen window. Root cause not yet isolated.",
  T0 + 5 * DAY,
  "seed-run-carplay",
);
saveThread(
  "July release verification",
  "Run the July desktop release verification pass",
  "Verification pass completed; build promoted.",
  T0 + 4 * DAY,
  "seed-run-release",
);
saveThread(
  "Dial prototype exploration",
  "Explore the dial interaction prototype",
  "Prototype exploration notes captured; usability session pending.",
  T0 + 9 * DAY,
  "seed-run-dial",
);

db.close();

// ---------------------------------------------------------------------------
// Manifest: every seeded file hashed, plus DB row counts, for the audit doc.
// ---------------------------------------------------------------------------

const fileSha = (filePath: string): string =>
  createHash("sha256").update(readFileSync(filePath)).digest("hex");

const countDb = new DatabaseSync(getDesktopDatabasePath(DATA_DIR), {
  readOnly: true,
});
const count = (table: string): number =>
  (countDb.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number })
    .c;
const manifest = {
  dataDir: DATA_DIR,
  conversationId,
  carplayThreadId,
  files: Object.fromEntries(
    [
      "preferences.json",
      "memories/profile.md",
      "memories/memory_summary.md",
      "memories/memory_index.md",
      "memories/MEMORY.md",
      "memories_extensions/chronicle/2026-07-12.md",
    ].map((relative) => [relative, fileSha(path.join(DATA_DIR, relative))]),
  ),
  dbRows: {
    messages: count("message"),
    runtime_agents: count("runtime_agents"),
    dream_inbox: count("dream_inbox"),
  },
};
countDb.close();
process.stdout.write(`SEED_MANIFEST ${JSON.stringify(manifest)}\n`);
