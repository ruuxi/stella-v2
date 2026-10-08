import { describe, expect, it } from "vitest";

import {
  CLAUDE_CODE_ORCHESTRATOR_NATIVE_TOOLS,
  CLAUDE_CODE_WORKER_NATIVE_TOOLS,
  isClaudeCodeNativeToolName,
  resolveClaudeCodeNativeTools,
  withoutToolsReplacedByNative,
} from "@stella/runtime/kernel/integrations/claude-code-native-tools";

const catalog = [
  "Read",
  "Write",
  "Edit",
  "apply_patch",
  "Grep",
  "Bash",
  "write_stdin",
  "code",
  "html",
  "web",
  "spawn_agent",
].map((name) => ({ name }));

describe("claude code native tools", () => {
  it("lets the orchestrator look but never gives it a shell or a writer", () => {
    const tools = resolveClaudeCodeNativeTools("orchestrator");
    expect(tools).toEqual(CLAUDE_CODE_ORCHESTRATOR_NATIVE_TOOLS);
    expect(tools).toContain("Read");
    expect(tools).toContain("Grep");
    expect(tools).toContain("Glob");
    expect(tools).not.toContain("Bash");
    expect(tools).not.toContain("Write");
    expect(tools).not.toContain("Edit");
  });

  it("gives workers the full file and shell set", () => {
    expect(resolveClaudeCodeNativeTools("worker")).toEqual(
      CLAUDE_CODE_WORKER_NATIVE_TOOLS,
    );
    expect(CLAUDE_CODE_WORKER_NATIVE_TOOLS).toEqual(
      expect.arrayContaining(["Read", "Edit", "Write", "Bash", "Grep", "Glob"]),
    );
  });

  it("drops only the Stella tools a native built-in supersedes", () => {
    const worker = withoutToolsReplacedByNative(
      catalog,
      CLAUDE_CODE_WORKER_NATIVE_TOOLS,
    ).map((tool) => tool.name);
    expect(worker).toEqual([
      "apply_patch",
      "code",
      "html",
      "web",
      "spawn_agent",
    ]);

    const orchestrator = withoutToolsReplacedByNative(
      catalog,
      CLAUDE_CODE_ORCHESTRATOR_NATIVE_TOOLS,
      "orchestrator",
    ).map((tool) => tool.name);
    // The orchestrator never writes files, over MCP or natively, and never
    // gets a shell: memory edits and everything else are delegated.
    expect(orchestrator).toEqual(["code", "html", "web", "spawn_agent"]);
  });

  it("withholds writers and shells from the orchestrator even when its definition lists them", () => {
    expect(
      withoutToolsReplacedByNative(
        catalog,
        CLAUDE_CODE_ORCHESTRATOR_NATIVE_TOOLS,
        "orchestrator",
      ).map((tool) => tool.name),
    ).toEqual(["code", "html", "web", "spawn_agent"]);
    expect(
      withoutToolsReplacedByNative(catalog, [], "orchestrator").map(
        (tool) => tool.name,
      ),
    ).toEqual(["Read", "Grep", "code", "html", "web", "spawn_agent"]);
  });

  it("leaves the catalog untouched when no built-in is enabled", () => {
    expect(withoutToolsReplacedByNative(catalog, [])).toEqual(catalog);
  });

  it("tells MCP tool names apart from CLI built-ins", () => {
    expect(isClaudeCodeNativeToolName("Bash")).toBe(true);
    expect(isClaudeCodeNativeToolName("mcp__stella__Read")).toBe(false);
  });

  it("treats the shell tool's old exec_command name as superseded by native Bash too", () => {
    const legacy = [{ name: "exec_command" }, { name: "write_stdin" }, { name: "code" }];
    expect(
      withoutToolsReplacedByNative(legacy, CLAUDE_CODE_WORKER_NATIVE_TOOLS).map(
        (tool) => tool.name,
      ),
    ).toEqual(["code"]);
  });
});
