import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadParsedAgentsFromDir } from "@stella/runtime/kernel/agents/markdown-agent-loader";
import { createSyncTempDirTracker } from "../../../helpers/temp.js";

const tempDirs = createSyncTempDirTracker();

afterEach(() => tempDirs.cleanup());

const AGENT_MD = [
  "---",
  "name: Orchestrator",
  "description: Coordinates user-facing work.",
  "tools: spawn_agent, web",
  "---",
  "",
  "You are Stella.",
  "",
].join("\n");

describe("loadParsedAgentsFromDir", () => {
  it("loads every shipped capability record through the standard agent markdown contract", () => {
    const agents = loadParsedAgentsFromDir(
      path.resolve(
        process.cwd(),
        "..",
        "runtime",
        "extensions",
        "stella-runtime",
        "agent-metadata",
      ),
    );

    expect(agents.map((agent) => agent.id).sort()).toEqual(
      [
        "explore",
        "fashion",
        "general",
        "orchestrator",
        "orchestrator-orchestrated",
        "social_session",
      ].sort(),
    );
    expect(agents.every((agent) => agent.systemPrompt.length > 0)).toBe(true);
  });

  it("loads distinct direct and orchestrated capability records", () => {
    const agents = loadParsedAgentsFromDir(
      path.resolve(
        process.cwd(),
        "..",
        "runtime",
        "extensions",
        "stella-runtime",
        "agent-metadata",
      ),
    );
    const direct = agents.find((agent) => agent.id === "orchestrator");
    const orchestrated = agents.find(
      (agent) => agent.id === "orchestrator-orchestrated",
    );

    expect(direct?.toolsAllowlist).toContain("exec_command");
    expect(direct?.maxAgentDepth).toBe(1);
    expect(orchestrated?.toolsAllowlist).not.toContain("exec_command");
    expect(orchestrated?.toolsAllowlist).toEqual(
      expect.arrayContaining(["spawn_agent", "send_input", "pause_agent"]),
    );
    expect(orchestrated?.maxAgentDepth).toBe(2);
  });

  it("loads agents when given a directory string path", () => {
    const dir = tempDirs.create("agent-loader-");
    writeFileSync(path.join(dir, "orchestrator.md"), AGENT_MD, "utf-8");

    const agents = loadParsedAgentsFromDir(dir);

    expect(agents.map((agent) => agent.id)).toEqual(["orchestrator"]);
    expect(agents[0]?.toolsAllowlist).toContain("spawn_agent");
  });

  // Production callers pass a `file://` URL built from `import.meta.url`.
  // On Windows that URL's `pathname` is `/C:/...` with `%20`-encoded
  // characters, which `URL.pathname` (the old impl) turned into an
  // unreadable path so every agent was silently skipped — collapsing the
  // orchestrator to only the universal RequestCredential/no_response
  // tools. A directory containing a space reproduces the encoding half of
  // that failure on any platform.
  it("loads agents from a file:// URL whose path needs decoding", () => {
    const base = tempDirs.create("agent loader url-");
    const dir = path.join(base, "agents dir");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "orchestrator.md"), AGENT_MD, "utf-8");

    // Trailing slash so `new URL` treats it as a directory, matching the
    // `new URL("./agents/", import.meta.url)` production callers.
    const dirUrl = pathToFileURL(`${dir}${path.sep}`);
    expect(dirUrl.pathname).toContain("%20");

    const agents = loadParsedAgentsFromDir(dirUrl);

    expect(agents.map((agent) => agent.id)).toEqual(["orchestrator"]);
    expect(agents[0]?.toolsAllowlist).toContain("spawn_agent");
  });
});
