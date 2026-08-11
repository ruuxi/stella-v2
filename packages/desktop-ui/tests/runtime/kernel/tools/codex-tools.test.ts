import path from "node:path";
import os from "node:os";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { handleApplyPatch } from "@stella/runtime/kernel/tools/apply-patch";
import { createToolHost } from "@stella/runtime/kernel/tools/host";
import { createExecCommandTool } from "@stella/runtime/kernel/tools/defs/exec-command";
import {
  createShellState,
  handleExecCommand,
  handleWriteStdin,
} from "@stella/runtime/kernel/tools/shell";
import { createAsyncTempDirTracker } from "../../../helpers/temp.js";

const tempDirs = createAsyncTempDirTracker();
const repoRoot = path.resolve(import.meta.dirname, "../../../../../..");

afterEach(() => tempDirs.cleanup());

const createTempDir = async () => {
  return await tempDirs.create("stella-general-tools-");
};

describe("general agent tools", () => {
  it("exec_command advertises its pipe-backed, non-TTY contract", async () => {
    const root = await createTempDir();
    const definition = createExecCommandTool(createShellState(root));
    const properties = definition.parameters.properties as Record<
      string,
      { description?: string }
    >;

    expect(definition.description).toContain("pipe-backed shell process");
    expect(definition.description).toContain("tty: true is rejected");
    expect(definition.description).not.toContain("in a PTY");
    expect(properties.tty?.description).toContain("not available");
    expect(properties.login?.description).toContain("-lc");
    expect(properties.login?.description).toContain("-c");
  });

  it("exec_command returns one-shot output inline", async () => {
    const root = await createTempDir();
    const shellState = createShellState(root);

    const result = await handleExecCommand(
      shellState,
      {
        cmd: "printf ready",
        yield_time_ms: 500,
      },
      {
        conversationId: "c1",
        deviceId: "d1",
        requestId: "r1",
        stellaAppDir: root,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({
      session_id: null,
      running: false,
      exit_code: 0,
      output: "ready",
    });
  });

  it("exec_command defaults to the turn workspace and rejects poisoned runtime cwd fallbacks", async () => {
    const root = await createTempDir();
    const workspaceRoot = await createTempDir();
    const appAsar = path.join(root, "app.asar");
    await writeFile(appAsar, "packaged archive", "utf-8");

    const workspaceResult = await handleExecCommand(
      createShellState(root),
      { cmd: "pwd", yield_time_ms: 500 },
      {
        conversationId: "c-workspace-cwd",
        deviceId: "d-workspace-cwd",
        requestId: "r-workspace-cwd",
        stellaAppDir: root,
        toolWorkspaceRoot: workspaceRoot,
      },
    );
    expect(workspaceResult.result).toMatchObject({
      cwd: workspaceRoot,
      output: expect.stringContaining(path.basename(workspaceRoot)),
    });

    const fallbackResult = await handleExecCommand(
      createShellState(root),
      { cmd: "pwd", yield_time_ms: 500 },
      {
        conversationId: "c-fallback-cwd",
        deviceId: "d-fallback-cwd",
        requestId: "r-fallback-cwd",
        stellaAppDir: appAsar,
      },
    );
    expect(fallbackResult.result).toMatchObject({
      cwd: os.homedir(),
      output: expect.stringContaining(path.basename(os.homedir())),
    });
  });

  it("exec_command honors an explicit shell and non-login mode", async () => {
    if (process.platform === "win32") return;
    const root = await createTempDir();
    const shellState = createShellState(root);

    const result = await handleExecCommand(
      shellState,
      {
        cmd: 'printf "%s|%s" "$0" "$-"',
        shell: "/bin/sh",
        login: false,
        yield_time_ms: 500,
      },
      {
        conversationId: "c-explicit-shell",
        deviceId: "d-explicit-shell",
        requestId: "r-explicit-shell",
        stellaAppDir: root,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({
      session_id: null,
      running: false,
      exit_code: 0,
    });
    expect((result.result as { output: string }).output).toMatch(
      /^\/bin\/sh\|/,
    );
    expect((result.result as { output: string }).output).not.toContain("l");
  });

  it("exec_command spawn failures identify the runner and resolved executable", async () => {
    if (process.platform === "win32") return;
    const root = await createTempDir();
    const shellState = createShellState(root);
    const missingShell = path.join(root, "missing-shell");

    const result = await handleExecCommand(
      shellState,
      {
        cmd: "printf unreachable",
        shell: missingShell,
        login: false,
        yield_time_ms: 500,
      },
      {
        conversationId: "c-shell-failure",
        deviceId: "d-shell-failure",
        requestId: "r-shell-failure",
        stellaAppDir: root,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({
      session_id: null,
      running: false,
      exit_code: 1,
    });
    const output = (result.result as { output: string }).output;
    expect(output).toContain("Failed to start exec_command shell");
    expect(output).toContain("runner=node:child_process.spawn");
    expect(output).toContain("namespace=runtime-worker");
    expect(output).toContain(`executable=${JSON.stringify(missingShell)}`);
    expect(output).toContain("login=false");
  });

  it("exec_command diagnostics name an explicit file used as cwd", async () => {
    const root = await createTempDir();
    const cwdFile = path.join(root, "not-a-directory");
    await writeFile(cwdFile, "file cwd", "utf-8");

    const result = await handleExecCommand(
      createShellState(root),
      {
        cmd: "printf unreachable",
        workdir: cwdFile,
        yield_time_ms: 500,
      },
      {
        conversationId: "c-file-cwd",
        deviceId: "d-file-cwd",
        requestId: "r-file-cwd",
        stellaAppDir: root,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({
      session_id: null,
      running: false,
      exit_code: 1,
      cwd: cwdFile,
    });
    const output = (result.result as { output: string }).output;
    expect(output).toContain("Failed to start exec_command shell");
    expect(output).toContain(`cwd=${JSON.stringify(cwdFile)}`);
  });

  it("exec_command rejects unsupported tty allocation instead of silently using pipes", async () => {
    const root = await createTempDir();
    const result = await handleExecCommand(
      createShellState(root),
      { cmd: "printf unreachable", tty: true },
      {
        conversationId: "c-tty",
        deviceId: "d-tty",
        requestId: "r-tty",
        stellaAppDir: root,
      },
    );

    expect(result.result).toBeUndefined();
    expect(result.error).toContain("does not provide a pseudo-terminal");
    expect(result.error).toContain("tty: false");
  });

  it("exec_command exposes the bundled Node.js runtime", async () => {
    const root = await createTempDir();
    const shellState = createShellState(root);

    const result = await handleExecCommand(
      shellState,
      {
        cmd: 'node -e "process.stdout.write(String(6 * 7))"',
        yield_time_ms: 500,
      },
      {
        conversationId: "c-node",
        deviceId: "d-node",
        requestId: "r-node",
        agentType: "general",
        stellaAppDir: root,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({
      session_id: null,
      running: false,
      exit_code: 0,
      output: "42",
    });
  });

  it("General launches Node.js through the ToolHost exec_command boundary", async () => {
    const root = await createTempDir();
    const host = createToolHost({ stellaAppDir: root });

    try {
      const result = await host.executeTool(
        "exec_command",
        {
          cmd: 'node -e "process.stdout.write(JSON.stringify({runtime: process.release.name}))"',
          yield_time_ms: 500,
        },
        {
          conversationId: "c-general-node",
          deviceId: "d-general-node",
          requestId: "r-general-node",
          agentType: "general",
          stellaAppDir: root,
          allowedToolNames: ["exec_command"],
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toMatchObject({
        running: false,
        exit_code: 0,
        output: '{"runtime":"node"}',
      });
    } finally {
      await host.shutdown();
    }
  });

  it("exec_command exposes Node.js to env shebang scripts", async () => {
    const root = await createTempDir();
    const scriptPath = path.join(root, "answer.js");
    await writeFile(
      scriptPath,
      "#!/usr/bin/env node\nprocess.stdout.write(String(7 * 6));\n",
      "utf-8",
    );
    await chmod(scriptPath, 0o700);
    const shellState = createShellState(root);

    const result = await handleExecCommand(
      shellState,
      { cmd: JSON.stringify(scriptPath), yield_time_ms: 500 },
      {
        conversationId: "c-node-shebang",
        deviceId: "d-node-shebang",
        requestId: "r-node-shebang",
        agentType: "general",
        stellaAppDir: root,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({
      session_id: null,
      running: false,
      exit_code: 0,
      output: "42",
    });
  });

  it("write_stdin drives an interactive Node.js REPL", async () => {
    const root = await createTempDir();
    const shellState = createShellState(root);
    const context = {
      conversationId: "c-node-repl",
      deviceId: "d-node-repl",
      requestId: "r-node-repl",
      agentType: "general",
      stellaAppDir: root,
    };

    const started = await handleExecCommand(
      shellState,
      { cmd: "node -i", yield_time_ms: 100 },
      context,
    );
    expect(started.error).toBeUndefined();
    const sessionId = (started.result as { session_id: string | null })
      .session_id;
    expect(typeof sessionId).toBe("string");

    const finished = await handleWriteStdin(
      shellState,
      {
        session_id: sessionId,
        chars: "console.log(21 * 2)\n.exit\n",
        yield_time_ms: 1_000,
      },
      context,
    );

    expect(finished.error).toBeUndefined();
    expect(finished.result).toMatchObject({
      session_id: null,
      running: false,
      exit_code: 0,
    });
    expect((finished.result as { output: string }).output).toContain("42");
  });

  it("write_stdin continues an interactive exec_command session", async () => {
    const root = await createTempDir();
    const shellState = createShellState(root);
    const context = {
      conversationId: "c1",
      deviceId: "d1",
      requestId: "r1",
      stellaAppDir: root,
    };

    const started = await handleExecCommand(
      shellState,
      {
        cmd: 'read line; printf "echo:%s" "$line"',
        yield_time_ms: 100,
      },
      context,
    );

    expect(started.error).toBeUndefined();
    const sessionId = (started.result as { session_id: string | null })
      .session_id;
    expect(typeof sessionId).toBe("string");

    const finished = await handleWriteStdin(
      shellState,
      {
        session_id: sessionId,
        chars: "hello world\n",
        yield_time_ms: 500,
      },
      context,
    );

    expect(finished.error).toBeUndefined();
    expect(finished.result).toMatchObject({
      session_id: null,
      running: false,
      exit_code: 0,
    });
    expect((finished.result as { output: string }).output).toContain(
      "echo:hello world",
    );
  });

  it("apply_patch updates an existing file", async () => {
    const root = await createTempDir();
    const filePath = path.join(root, "notes.txt");
    await writeFile(filePath, "hello\nworld\n", "utf-8");

    const result = await handleApplyPatch({
      patch: `*** Begin Patch
*** Update File: ${filePath}
@@
 hello
-world
+stella
*** End Patch`,
    });

    expect(result.error).toBeUndefined();
    expect(await readFile(filePath, "utf-8")).toBe("hello\nstella\n");
  });

  it("apply_patch accepts the `input` key with an absolute path", async () => {
    const root = await createTempDir();
    const absPath = path.join(root, "nested", "notes.txt");
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, "hello\nworld\n", "utf-8");

    const result = await handleApplyPatch(
      {
        input: `*** Begin Patch
*** Update File: ${absPath}
@@
 hello
-world
+stella
*** End Patch`,
      },
      {
        conversationId: "c1",
        deviceId: "d1",
        requestId: "r1",
        stellaAppDir: root,
      },
    );

    expect(result.error).toBeUndefined();
    expect(await readFile(absPath, "utf-8")).toBe("hello\nstella\n");
  });

  it("apply_patch rejects a relative path with a clear error", async () => {
    const root = await createTempDir();
    const filePath = path.join(root, "notes.txt");
    await writeFile(filePath, "hello\nworld\n", "utf-8");

    const result = await handleApplyPatch(
      {
        input: `*** Begin Patch
*** Update File: notes.txt
@@
 hello
-world
+stella
*** End Patch`,
        workdir: root,
      },
      {
        conversationId: "c1",
        deviceId: "d1",
        requestId: "r1",
        stellaAppDir: root,
      },
    );

    expect(result.error).toMatch(
      /File tool paths must be absolute. Received relative path 'notes\.txt'/,
    );
    // The original file is left untouched when the path is rejected.
    expect(await readFile(filePath, "utf-8")).toBe("hello\nworld\n");
  });

  it("apply_patch tolerates trailing whitespace and unicode dashes", async () => {
    const root = await createTempDir();
    const filePath = path.join(root, "fuzz.py");
    // Source has a trailing tab and a Unicode en-dash (U+2013) in the line we replace.
    await writeFile(
      filePath,
      "import asyncio\nimport os  # local import \u2013 keep\t\n",
      "utf-8",
    );

    // Patch authored with no trailing whitespace and an ASCII hyphen — only
    // the tolerant matcher (rstrip / fuzzy) can locate the second line.
    const result = await handleApplyPatch({
      input: `*** Begin Patch
*** Update File: ${filePath}
@@
 import asyncio
-import os  # local import - keep
+import os  # HELLO
*** End Patch`,
    });

    expect(result.error).toBeUndefined();
    expect(await readFile(filePath, "utf-8")).toBe(
      "import asyncio\nimport os  # HELLO\n",
    );
  });

  it("apply_patch uses @@ <header> as a pre-seek anchor for non-unique context", async () => {
    const root = await createTempDir();
    const filePath = path.join(root, "Dup.ts");
    await writeFile(
      filePath,
      "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 1;\n}\n",
      "utf-8",
    );

    // Both functions return the same line; the @@ header line ("function b() {")
    // disambiguates by advancing the cursor past the second declaration.
    const result = await handleApplyPatch({
      input: `*** Begin Patch
*** Update File: ${filePath}
@@ function b() {
-  return 1;
+  return 2;
*** End Patch`,
    });

    expect(result.error).toBeUndefined();
    expect(await readFile(filePath, "utf-8")).toBe(
      "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n",
    );
  });

  it("apply_patch supports pure-addition hunks at end of file", async () => {
    const root = await createTempDir();
    const filePath = path.join(root, "log.txt");
    await writeFile(filePath, "alpha\nbeta\n", "utf-8");

    const result = await handleApplyPatch({
      input: `*** Begin Patch
*** Update File: ${filePath}
@@
+gamma
*** End of File
*** End Patch`,
    });

    expect(result.error).toBeUndefined();
    expect(await readFile(filePath, "utf-8")).toBe("alpha\nbeta\ngamma\n");
  });

  it("apply_patch allows the first chunk to omit the @@ header", async () => {
    const root = await createTempDir();
    const filePath = path.join(root, "first.py");
    await writeFile(filePath, "import foo\n", "utf-8");

    const result = await handleApplyPatch({
      input: `*** Begin Patch
*** Update File: ${filePath}
 import foo
+import bar
*** End Patch`,
    });

    expect(result.error).toBeUndefined();
    expect(await readFile(filePath, "utf-8")).toBe("import foo\nimport bar\n");
  });

  it("apply_patch unwraps a heredoc-wrapped envelope", async () => {
    const root = await createTempDir();
    const filePath = path.join(root, "wrap.txt");
    await writeFile(filePath, "hello\nworld\n", "utf-8");

    const result = await handleApplyPatch({
      input: `<<EOF
*** Begin Patch
*** Update File: ${filePath}
@@
 hello
-world
+stella
*** End Patch
EOF`,
    });

    expect(result.error).toBeUndefined();
    expect(await readFile(filePath, "utf-8")).toBe("hello\nstella\n");
  });

  it("apply_patch applies multiple chunks and preserves order via reverse-apply", async () => {
    const root = await createTempDir();
    const filePath = path.join(root, "multi.txt");
    await writeFile(filePath, "a\nb\nc\nd\ne\nf\n", "utf-8");

    const result = await handleApplyPatch({
      input: `*** Begin Patch
*** Update File: ${filePath}
@@
 a
-b
+B
@@
 c
 d
-e
+E
@@
 f
+g
*** End of File
*** End Patch`,
    });

    expect(result.error).toBeUndefined();
    expect(await readFile(filePath, "utf-8")).toBe("a\nB\nc\nd\nE\nf\ng\n");
  });

  it("apply_patch returns a clear error when context cannot be located", async () => {
    const root = await createTempDir();
    const filePath = path.join(root, "miss.txt");
    await writeFile(filePath, "alpha\nbeta\n", "utf-8");

    const result = await handleApplyPatch({
      input: `*** Begin Patch
*** Update File: ${filePath}
@@
-gamma
+delta
*** End Patch`,
    });

    expect(result.error).toMatch(
      /failed to find expected lines in .*miss\.txt:\s*gamma/,
    );
  });

  it("exec_command payload reports wall_time_seconds and original_token_count", async () => {
    const root = await createTempDir();
    const shellState = createShellState(root);

    const result = await handleExecCommand(
      shellState,
      {
        // Emit ~6KB of output, well above the small budget below so we trigger truncation.
        cmd: "printf %.0s_ {1..6000}; echo done",
        yield_time_ms: 1000,
        max_output_tokens: 256,
      },
      {
        conversationId: "c1",
        deviceId: "d1",
        requestId: "r1",
        stellaAppDir: root,
      },
    );

    expect(result.error).toBeUndefined();
    const payload = result.result as Record<string, unknown>;
    expect(typeof payload.wall_time_seconds).toBe("number");
    expect(payload.wall_time_seconds as number).toBeGreaterThanOrEqual(0);
    expect(typeof payload.original_token_count).toBe("number");
    expect(payload.original_token_count as number).toBeGreaterThan(256);
  });

  it("exec_command payload includes original_token_count even when output is small", async () => {
    const root = await createTempDir();
    const shellState = createShellState(root);

    const result = await handleExecCommand(
      shellState,
      {
        cmd: "printf ok",
        yield_time_ms: 1000,
      },
      {
        conversationId: "c1",
        deviceId: "d1",
        requestId: "r1",
        stellaAppDir: root,
      },
    );

    expect(result.error).toBeUndefined();
    const payload = result.result as Record<string, unknown>;
    expect(payload.output).toBe("ok");
    expect(typeof payload.original_token_count).toBe("number");
    expect((payload.original_token_count as number) >= 1).toBe(true);
  });

  it("multi_tool_use_parallel rejects write_stdin (non-parallel-safe)", async () => {
    const root = await createTempDir();
    const host = createToolHost({ stellaAppDir: root });

    try {
      const result = await host.executeTool(
        "multi_tool_use_parallel",
        {
          tool_uses: [
            {
              recipient_name: "write_stdin",
              parameters: { session_id: "s1", chars: "" },
            },
            {
              recipient_name: "write_stdin",
              parameters: { session_id: "s1", chars: "" },
            },
          ],
        },
        {
          conversationId: "c1",
          deviceId: "d1",
          requestId: "r1",
          agentType: "general",
          stellaAppDir: root,
          allowedToolNames: ["write_stdin", "multi_tool_use_parallel"],
        },
      );

      expect(result.error).toBeUndefined();
      const text = String(result.result ?? "");
      expect(text).toContain(
        "write_stdin is not safe to run inside multi_tool_use_parallel",
      );
    } finally {
      await host.shutdown();
    }
  });

  it("multi_tool_use_parallel rejects apply_patch", async () => {
    const root = await createTempDir();
    const host = createToolHost({ stellaAppDir: root });

    try {
      const result = await host.executeTool(
        "multi_tool_use_parallel",
        {
          tool_uses: [
            {
              recipient_name: "apply_patch",
              parameters: {
                input:
                  "*** Begin Patch\n*** Add File: foo.txt\n+hello\n*** End Patch",
              },
            },
          ],
        },
        {
          conversationId: "c1",
          deviceId: "d1",
          requestId: "r1",
          agentType: "general",
          stellaAppDir: root,
          allowedToolNames: ["apply_patch", "multi_tool_use_parallel"],
        },
      );

      expect(result.error).toBeUndefined();
      const text = String(result.result ?? "");
      expect(text).toContain(
        "apply_patch is not safe to run inside multi_tool_use_parallel",
      );
    } finally {
      await host.shutdown();
    }
  });

  it("multi_tool_use_parallel rejects the full batch before starting valid siblings", async () => {
    const root = await createTempDir();
    const host = createToolHost({ stellaAppDir: root });
    const markerPath = path.join(root, "parallel-ran.txt");

    try {
      const result = await host.executeTool(
        "multi_tool_use_parallel",
        {
          tool_uses: [
            {
              recipient_name: "exec_command",
              parameters: {
                cmd: "printf ran > parallel-ran.txt",
                workdir: root,
                yield_time_ms: 1000,
              },
            },
            {
              recipient_name: "apply_patch",
              parameters: {
                input:
                  "*** Begin Patch\n*** Add File: foo.txt\n+hello\n*** End Patch",
              },
            },
          ],
        },
        {
          conversationId: "c1",
          deviceId: "d1",
          requestId: "r1",
          agentType: "general",
          stellaAppDir: root,
          allowedToolNames: [
            "exec_command",
            "apply_patch",
            "multi_tool_use_parallel",
          ],
        },
      );

      expect(result.error).toBeUndefined();
      const text = String(result.result ?? "");
      expect(text).toContain(
        "apply_patch is not safe to run inside multi_tool_use_parallel",
      );
      await expect(access(markerPath)).rejects.toThrow();
    } finally {
      await host.shutdown();
    }
  });

  it("multi_tool_use_parallel runs independent tool calls", async () => {
    const root = await createTempDir();
    const host = createToolHost({ stellaAppDir: root });

    try {
      const result = await host.executeTool(
        "multi_tool_use_parallel",
        {
          tool_uses: [
            {
              recipient_name: "exec_command",
              parameters: { cmd: "printf one", yield_time_ms: 500 },
            },
            {
              recipient_name: "functions.exec_command",
              parameters: { cmd: "printf two", yield_time_ms: 500 },
            },
          ],
        },
        {
          conversationId: "c1",
          deviceId: "d1",
          requestId: "r1",
          agentType: "general",
          stellaAppDir: root,
          allowedToolNames: ["exec_command", "multi_tool_use_parallel"],
        },
      );

      expect(result.error).toBeUndefined();
      expect(typeof result.result).toBe("string");
      expect(result.result as string).toContain("one");
      expect(result.result as string).toContain("two");
    } finally {
      await host.shutdown();
    }
  });

  it("node_repl preserves file tracking from nested tool calls", async () => {
    const root = await createTempDir();
    const target = path.join(root, "nested-edit.txt");
    const host = createToolHost({ stellaAppDir: root });
    const patch = `*** Begin Patch\n*** Add File: ${target}\n+tracked through node repl\n*** End Patch`;

    try {
      const result = await host.executeTool(
        "node_repl",
        {
          code: `await tools.apply_patch({input: ${JSON.stringify(patch)}})`,
        },
        {
          conversationId: "c-node-tools",
          deviceId: "d-node-tools",
          requestId: "r-node-tools",
          agentId: "a-node-tools",
          agentType: "general",
          stellaAppDir: root,
          toolWorkspaceRoot: root,
          allowedToolNames: ["node_repl", "apply_patch"],
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.fileChanges).toEqual([
        { path: target, kind: { type: "add" } },
      ]);
      await expect(readFile(target, "utf8")).resolves.toBe(
        "tracked through node repl\n",
      );
    } finally {
      await host.shutdown();
    }
  });

  it("web uses the configured search backend", async () => {
    const root = await createTempDir();
    const host = createToolHost({
      stellaAppDir: root,
      webSearch: async (query) => ({
        text: `results for ${query}`,
        results: [
          { title: "Stella", url: "https://stella.sh", snippet: "assistant" },
        ],
      }),
    });

    try {
      const result = await host.executeTool(
        "web",
        { query: "stella assistant" },
        {
          conversationId: "c1",
          deviceId: "d1",
          requestId: "r1",
          agentType: "general",
          stellaAppDir: root,
          allowedToolNames: ["web"],
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toBe("results for stella assistant");
      expect(result.details).toMatchObject({
        mode: "search",
        query: "stella assistant",
      });
    } finally {
      await host.shutdown();
    }
  });

  it("exposes persistent Computer Use through node_repl in the general agent metadata", async () => {
    const metadataPath = path.join(
      repoRoot,
      "packages/runtime/extensions/stella-runtime/agent-metadata/general.md",
    );
    const metadata = await readFile(metadataPath, "utf-8");
    const toolsLine = metadata
      .split(/\r?\n/)
      .find((line) => line.startsWith("tools: "));

    expect(toolsLine).not.toContain("MCP");
    expect(toolsLine).not.toContain("computer_list_apps");
    expect(toolsLine).not.toContain("computer_get_app_state");
    expect(toolsLine).not.toContain("computer_click");
    expect(toolsLine).toContain("node_repl");
  });

  it("RequestCredential delegates to the device callback", async () => {
    const root = await createTempDir();
    const host = createToolHost({
      stellaAppDir: root,
      requestCredential: async (payload) => ({
        secretId: `secret:${payload.provider}`,
        provider: payload.provider,
        label: payload.label ?? payload.provider,
      }),
    });

    try {
      const result = await host.executeTool(
        "RequestCredential",
        {
          provider: "github_token",
          label: "GitHub Token",
          description: "Needed for API access",
        },
        {
          conversationId: "c1",
          deviceId: "d1",
          requestId: "r1",
          agentType: "general",
          stellaAppDir: root,
          allowedToolNames: ["RequestCredential"],
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({
        secretId: "secret:github_token",
        provider: "github_token",
        label: "GitHub Token",
      });
    } finally {
      await host.shutdown();
    }
  });
});
