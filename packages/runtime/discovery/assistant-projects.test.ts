import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectAssistantProjects } from "./assistant-projects";
import { formatDevProjectsForSynthesis } from "./dev-projects";

const homes: string[] = [];
const now = Date.now();
const week = 7 * 86400_000;
async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "stella-projects-"));
  homes.push(home);
  return home;
}
async function write(home: string, name: string, text: string) {
  const file = path.join(home, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}
afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => fs.rm(home, { recursive: true, force: true })));
});

describe("assistant project metadata", () => {
  it("extracts only recent Claude directories, deduplicating sessions and tolerating partial records", async () => {
    const home = await fixture();
    const project = path.join(home, "app");
    await write(home, ".claude/history.jsonl", [
      JSON.stringify({ project, timestamp: now - week - 1, sessionId: "old" }),
      JSON.stringify({ project, timestamp: now - 10, sessionId: "one", display: "PRIVATE PROMPT" }),
      JSON.stringify({ project, timestamp: now - 5, sessionId: "one" }),
      JSON.stringify({ project, timestamp: now, sessionId: "two" }),
      JSON.stringify({ project: "relative/path", timestamp: now }),
      JSON.stringify({ project, timestamp: now + 1 }),
      '{"partial":',
    ].join("\n"));
    expect(await collectAssistantProjects({ home, env: {}, now })).toEqual([
      { path: project, source: "claude-code", activityCount: 2, lastActivity: now },
    ]);
  });

  it("bounds large history reads and skips an oversized config", async () => {
    const home = await fixture();
    await write(home, ".claude/history.jsonl", "x".repeat(600_000) + "\n" + JSON.stringify({ project: path.join(home, "app"), timestamp: now }));
    await write(home, ".openclaw/openclaw.json", " ".repeat(600_000));
    expect(await collectAssistantProjects({ home, env: {}, now })).toHaveLength(1);
  });

  it("reads Codex WAL metadata and Hermes activity with a legacy schema fallback", async () => {
    const home = await fixture();
    await fs.mkdir(path.join(home, ".codex"));
    await fs.mkdir(path.join(home, ".hermes"));
    const codex = new Database(path.join(home, ".codex/state_5.db"));
    const hermes = new Database(path.join(home, ".hermes/state.db"));
    try {
      codex.exec("PRAGMA journal_mode=WAL; CREATE TABLE threads(cwd TEXT, updated_at INTEGER); CREATE INDEX activity ON threads(updated_at DESC)");
      codex.query("INSERT INTO threads VALUES (?, ?)").run(path.join(home, "codex-app"), now / 1000);
      codex.query("INSERT INTO threads VALUES (?, ?)").run(path.join(home, "stale"), (now - week - 1) / 1000);
      hermes.exec("CREATE TABLE sessions(cwd TEXT, started_at REAL); CREATE INDEX activity ON sessions(started_at DESC)");
      hermes.query("INSERT INTO sessions VALUES (?, ?)").run(path.join(home, "hermes-app"), now / 1000);
      const results = await collectAssistantProjects({ home, env: {}, now });
      expect(results.map(row => row.source)).toEqual(["codex", "hermes"]);
      hermes.exec("ALTER TABLE sessions ADD COLUMN last_activity_at REAL");
      hermes.query("UPDATE sessions SET started_at = ?, last_activity_at = ?").run((now - week * 2) / 1000, now / 1000);
      expect((await collectAssistantProjects({ home, env: {}, now })).find(row => row.source === "hermes")?.lastActivity).toBe(now);
    } finally { codex.close(); hermes.close(); }
  });

  it("discovers JSON5 OpenClaw workspaces without treating config writes as activity", async () => {
    const home = await fixture();
    await write(home, ".openclaw/openclaw.json", `{ agents: { defaults: { workspace: '~/main' }, list: [{workspace: '~/second'}], entries: { third: {workspace: '~/third'} } } }`);
    const results = await collectAssistantProjects({ home, env: {}, now });
    expect(results.map(row => row.path)).toEqual(["main", "second", "third"].map(name => path.join(home, name)));
    expect(results.every(row => row.lastActivity === 0)).toBe(true);
  });

  it("filters stale and future projects before the eight-project synthesis cap and omits tech", () => {
    const projects = Array.from({ length: 12 }, (_, index) => ({ name: `app-${index}`, path: `/app-${index}`, lastActivity: now - index * 1000, tech: ["PRIVATE TECH"] }));
    const formatted = formatDevProjectsForSynthesis([
      { name: "old", path: "/old", lastActivity: now - week - 1000 },
      { name: "future", path: "/future", lastActivity: now + week }, ...projects,
    ]);
    expect(formatted.match(/^- /gm)).toHaveLength(8);
    expect(formatted).not.toContain("PRIVATE");
    expect(formatted).not.toContain("/old");
    expect(formatted).not.toContain("/future");
    expect(formatted).not.toContain("app-8");
  });

  it("collects only projects for developer onboarding and ranks repeated sessions above a newer one", async () => {
    const home = await fixture();
    const entries = [];
    for (let index = 0; index < 12; index++) {
      const project = path.join(home, `app-${index}`);
      await fs.mkdir(project);
      entries.push({ project, timestamp: now - index * 1000, sessionId: `session-${index}` });
    }
    const repo = path.join(home, "app-11");
    expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
    await fs.mkdir(path.join(repo, "src"));
    entries.push({ project: path.join(repo, "src"), timestamp: now - 10000, sessionId: "nested" });
    // Cursor's existing repository tracker remains a discovery source.
    await fs.mkdir(path.join(home, ".config/Cursor/User/globalStorage"), { recursive: true });
    const cursor = new Database(path.join(home, ".config/Cursor/User/globalStorage/state.vscdb"));
    cursor.exec("CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value TEXT)");
    cursor.query("INSERT INTO ItemTable VALUES (?, ?)").run("repositoryTracker.paths", JSON.stringify({ app: { localPath: path.join(home, "app-10"), lastAccessed: now } }));
    cursor.close();
    for (let index = 0; index < 5; index++) entries.push({ project: path.join(home, "app-11"), timestamp: now - 10000, sessionId: `extra-${index}` });
    await write(home, ".claude/history.jsonl", entries.map(row => JSON.stringify(row)).join("\n"));
    await write(home, ".bash_history", "SECRET_COMMAND\n");
    const modulePath = path.join(import.meta.dir, "collect-all.ts");
    const child = Bun.spawn([process.execPath, "-e", `import {collectAllSignals} from ${JSON.stringify(modulePath)}; const result = await collectAllSignals(process.env.HOME + '/stella', ['dev_environment']); process.stdout.write(JSON.stringify(result));`], {
      env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), CODEX_HOME: path.join(home, ".codex"), HERMES_HOME: path.join(home, ".hermes"), OPENCLAW_STATE_DIR: path.join(home, ".openclaw"), OPENCLAW_CONFIG_PATH: path.join(home, ".openclaw/openclaw.json") },
      stdout: "pipe", stderr: "pipe",
    });
    const [output, errors] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited, errors).toBe(0);
    const result = JSON.parse(output);
    expect(result.error).toBeUndefined();
    expect(result.data.devProjects).toHaveLength(8);
    expect(result.data.devProjects[0].name).toBe("app-11");
    expect(result.data.devProjects.filter((row: { path: string }) => row.path.startsWith(repo))).toHaveLength(1);
    expect(result.data.devProjects.some((row: { name: string }) => row.name === "app-10")).toBe(true);
    expect(result.data.shell).toEqual({ topCommands: [], projectPaths: [], toolsUsed: [] });
    expect(result.data.devEnvironment).toBeUndefined();
    expect(result.formatted).not.toContain("SECRET_COMMAND");
    expect(result.formattedSections.dev_environment).toStartWith("## Active Projects");
  });
});
