/** Bounded reads of local assistant metadata. Never returns prompts or messages. */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { z } from "zod";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 512 * 1024;
const MAX_ROWS = 500;
const rowSchema = z.object({ cwd: z.string(), activity: z.number() });
const claudeSchema = z.object({ project: z.string(), timestamp: z.number(), sessionId: z.string().optional() });
const workspaceSchema = z.object({ workspace: z.string().optional() });
const openClawSchema = z.object({ agents: z.object({
  defaults: workspaceSchema.optional(),
  list: z.array(workspaceSchema).optional(),
  entries: z.record(z.string(), workspaceSchema).optional(),
}).optional() });

export type AssistantProject = {
  path: string;
  source: string;
  lastActivity: number;
  activityCount: number;
};

/** Read only a bounded tail; discard an incomplete first record. */
const readBounded = async (file: string, tail = false): Promise<string> => {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    if (!tail && size > MAX_BYTES) return "";
    const offset = tail ? Math.max(0, size - MAX_BYTES) : 0;
    const buffer = Buffer.alloc(Math.min(size, MAX_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return offset > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await handle.close();
  }
};

export async function collectAssistantProjects({
  home = os.homedir(), env = process.env, now = Date.now(),
}: { home?: string; env?: NodeJS.ProcessEnv; now?: number } = {}): Promise<AssistantProject[]> {
  const projects = new Map<string, AssistantProject>();
  const add = (cwd: string, source: string, activity: number, count = 1) => {
    const expanded = cwd.startsWith("~/") ? path.join(home, cwd.slice(2)) : cwd;
    if (!path.isAbsolute(expanded) || expanded === home || expanded.length > 4096) return;
    if (activity && (activity < now - WEEK_MS || activity > now)) return;
    const normalized = path.normalize(expanded);
    const key = `${source}:${process.platform === "win32" ? normalized.toLowerCase() : normalized}`;
    const previous = projects.get(key);
    projects.set(key, { path: normalized, source,
      lastActivity: Math.max(previous?.lastActivity ?? 0, activity),
      activityCount: Math.min(20, (previous?.activityCount ?? 0) + count),
    });
  };

  // Claude's history has directory and timestamp metadata on each entry. Read
  // at most 512 KiB and count distinct sessions, discarding all prompt fields.
  try {
    const text = await readBounded(path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "history.jsonl"), true);
    const seen = new Set<string>();
    for (const line of text.split("\n").slice(-MAX_ROWS).reverse()) {
      try {
        const row = claudeSchema.safeParse(JSON.parse(line));
        if (!row.success) continue;
        const { project, timestamp, sessionId } = row.data;
        const key = `${project}:${sessionId ?? timestamp}`;
        if (seen.has(key)) continue;
        seen.add(key);
        add(project, "claude-code", timestamp);
      } catch { /* Partial or malformed record. */ }
    }
  } catch { /* Tool not installed or history unreadable. */ }

  // Read indexed session metadata, never the messages tables. LIMIT bounds
  // materialization; each query uses the tool's activity/start-time index.
  const readSessions = async (file: string, source: string, queries: string[]) => {
    if (!(await fs.stat(file).catch(() => null))?.isFile()) return;
    try {
      const { Database } = await import("bun:sqlite");
      const db = new Database(file, { readonly: true });
      try {
        db.exec("PRAGMA busy_timeout = 25");
        for (const query of queries) {
          try {
            const rows = db.query(query).all((now - WEEK_MS) / 1000, MAX_ROWS);
            for (const raw of rows) {
              const row = rowSchema.safeParse(raw);
              if (row.success) add(row.data.cwd, source, row.data.activity * 1000);
            }
            break;
          } catch { /* Older schemas may lack the newer activity column. */ }
        }
      } finally { db.close(); }
    } catch { /* Missing SQLite support, locked or incompatible store. */ }
  };

  const codexHome = env.CODEX_HOME || path.join(home, ".codex");
  try {
    // A handful of versioned stores can coexist after upgrades. Use newest.
    const dir = await fs.opendir(codexHome);
    const stores: string[] = [];
    let visited = 0;
    for await (const entry of dir) {
      if (/^state_\d+\.db$/.test(entry.name) && entry.isFile()) stores.push(entry.name);
      if (++visited >= 256) break;
    }
    stores.sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]));
    if (stores[0]) await readSessions(path.join(codexHome, stores[0]), "codex", [
      "SELECT cwd, updated_at AS activity FROM threads WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT ?",
    ]);
  } catch { /* Tool not installed. */ }
  await readSessions(path.join(env.HERMES_HOME || path.join(home, ".hermes"), "state.db"), "hermes", [
    "SELECT cwd, COALESCE(last_activity_at, started_at) AS activity FROM sessions WHERE COALESCE(last_activity_at, started_at) >= ? ORDER BY COALESCE(last_activity_at, started_at) DESC, started_at DESC LIMIT ?",
    "SELECT cwd, started_at AS activity FROM sessions WHERE started_at >= ? ORDER BY started_at DESC LIMIT ?",
  ]);

  // OpenClaw exposes configured workspace directories. Configuration mtime is
  // not activity: let the repository's metadata establish recency later.
  const openClawHome = env.OPENCLAW_STATE_DIR || path.join(home, ".openclaw");
  try {
    const raw = await readBounded(env.OPENCLAW_CONFIG_PATH || path.join(openClawHome, "openclaw.json"));
    const config = openClawSchema.safeParse(JSON5.parse(raw));
    if (config.success) {
      const agents = config.data.agents;
      const workspaces = [agents?.defaults ?? { workspace: path.join(openClawHome, "workspace") },
        ...agents?.list ?? [], ...Object.values(agents?.entries ?? {})];
      for (const workspace of workspaces.slice(0, 64)) {
        if (workspace.workspace) add(workspace.workspace, "openclaw", 0);
      }
    }
  } catch { /* Tool not installed or config unreadable. */ }
  return [...projects.values()];
}
