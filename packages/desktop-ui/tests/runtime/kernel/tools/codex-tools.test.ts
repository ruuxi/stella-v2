import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { handleApplyPatch } from "@stella/runtime/kernel/tools/apply-patch";
import { createToolHost } from "@stella/runtime/kernel/tools/host";
import { createExecCommandTool } from "@stella/runtime/kernel/tools/defs/exec-command";
import { createWriteStdinTool } from "@stella/runtime/kernel/tools/defs/write-stdin";
import {
  createShellState,
  handleExecCommand,
  handleWriteStdin,
  resolveDefaultShell,
  resolveShellLaunch,
} from "@stella/runtime/kernel/tools/shell";
import { createAsyncTempDirTracker } from "../../../helpers/temp.js";

const tempDirs = createAsyncTempDirTracker();
const repoRoot = path.resolve(import.meta.dirname, "../../../../../..");
const execFileAsync = promisify(execFile);

afterEach(() => tempDirs.cleanup());

const createTempDir = async () => {
  return await tempDirs.create("stella-general-tools-");
};

type ExecDetails = {
  session_id: string | null;
  running: boolean;
  exit_code: number | null;
  wall_time_seconds: number;
  original_token_count: number;
  cwd: string;
  command: string;
  original_output_bytes: number;
  raw_output_truncated: boolean;
};

const execDetailsOf = (result: { details?: unknown }): ExecDetails =>
  result.details as ExecDetails;

const execTextOf = (result: { result?: unknown }): string =>
  result.result as string;

describe("general agent tools", () => {
  it("write_stdin advertises idempotent writes and explicit controls", async () => {
    const root = await createTempDir();
    const definition = createWriteStdinTool(createShellState(root));
    const properties = definition.parameters.properties as Record<
      string,
      Record<string, unknown>
    >;

    expect(properties.write_id).toMatchObject({ type: "string" });
    expect(properties.operation).toMatchObject({
      enum: ["write", "poll", "terminate", "close_stdin", "resize"],
    });
    expect(properties.cols).toMatchObject({ minimum: 1, maximum: 1000 });
    expect(properties.rows).toMatchObject({ minimum: 1, maximum: 1000 });
  });

  it("exec_command advertises pipes by default and a cross-platform opt-in PTY", async () => {
    const root = await createTempDir();
    const definition = createExecCommandTool(createShellState(root));
    const properties = definition.parameters.properties as Record<
      string,
      { description?: string }
    >;

    expect(definition.description).toContain("ordinary pipes");
    expect(definition.description).toContain("tty: true");
    expect(definition.description).toContain("ConPTY");
    expect(properties.tty?.description).toContain("real pseudo-terminal");
    expect(properties.tty?.description).toContain("ConPTY");
    expect(properties.login?.description).toContain("-lc");
    expect(properties.login?.description).toContain("-c");
    expect(properties.max_output_tokens).toMatchObject({
      type: "integer",
      minimum: 0,
    });
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
    expect(result.details).toMatchObject({
      session_id: null,
      running: false,
      exit_code: 0,
    });
    expect(result.details).not.toHaveProperty("output");
    expect(execTextOf(result)).toContain("\nOutput:\nready");
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
    expect(workspaceResult.details).toMatchObject({
      cwd: workspaceRoot,
    });
    expect(execTextOf(workspaceResult)).toContain(path.basename(workspaceRoot));

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
    expect(fallbackResult.details).toMatchObject({
      cwd: os.homedir(),
    });
    expect(execTextOf(fallbackResult)).toContain(path.basename(os.homedir()));
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
    expect(result.details).toMatchObject({
      session_id: null,
      running: false,
      exit_code: 0,
    });
    expect(execTextOf(result)).toMatch(/\nOutput:\n\/bin\/sh\|/);
    expect(execTextOf(result).split("\nOutput:\n").at(-1)).not.toContain("l");
  });

  it("exec_command follows the Unix login shell with Codex-style fallbacks", () => {
    const macFiles = new Set(["/bin/zsh", "/bin/bash", "/bin/sh"]);
    const macExists = (candidate: string) => macFiles.has(candidate);
    expect(
      resolveDefaultShell(
        "darwin",
        {},
        {
          userShell: "/bin/bash",
          executableExists: macExists,
        },
      ),
    ).toBe("/bin/bash");
    expect(
      resolveDefaultShell(
        "darwin",
        {},
        {
          userShell: "/usr/local/bin/fish",
          executableExists: macExists,
        },
      ),
    ).toBe("/bin/zsh");

    const linuxFiles = new Set(["/bin/bash", "/bin/zsh", "/bin/sh"]);
    const linuxExists = (candidate: string) => linuxFiles.has(candidate);
    expect(
      resolveDefaultShell(
        "linux",
        {},
        {
          userShell: "/bin/zsh",
          executableExists: linuxExists,
        },
      ),
    ).toBe("/bin/zsh");
    const pwsh = "/usr/local/bin/pwsh";
    const powerShellLaunch = resolveShellLaunch(
      "Get-ChildItem Env:",
      {},
      "linux",
      {},
      {
        userShell: pwsh,
        executableExists: (candidate) => candidate === pwsh,
      },
    );
    if ("error" in powerShellLaunch) {
      throw new Error(powerShellLaunch.error);
    }
    expect(powerShellLaunch.shell).toBe(pwsh);
    expect(powerShellLaunch.args).toContain("-EncodedCommand");
    expect(
      resolveDefaultShell(
        "linux",
        {},
        {
          userShell: "/usr/bin/fish",
          executableExists: linuxExists,
        },
      ),
    ).toBe("/bin/bash");
    expect(
      resolveDefaultShell(
        "linux",
        {},
        {
          userShell: null,
          executableExists: () => false,
        },
      ),
    ).toBe("/bin/sh");
  });

  it("exec_command defaults Windows to pwsh, then Windows PowerShell, then cmd", () => {
    const pwshPath = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    const windowsPowerShellPath =
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

    expect(
      resolveDefaultShell(
        "win32",
        {},
        {
          executableExists: (candidate) => candidate === pwshPath,
        },
      ),
    ).toBe(pwshPath);
    expect(
      resolveDefaultShell(
        "win32",
        {},
        {
          executableExists: (candidate) => candidate === windowsPowerShellPath,
        },
      ),
    ).toBe(windowsPowerShellPath);
    expect(
      resolveDefaultShell(
        "win32",
        {},
        {
          executableExists: () => false,
        },
      ),
    ).toBe("cmd.exe");

    const command = "Get-ChildItem Env:";
    const launch = resolveShellLaunch(
      command,
      {},
      "win32",
      {},
      {
        executableExists: (candidate) => candidate === windowsPowerShellPath,
      },
    );
    if ("error" in launch) throw new Error(launch.error);
    expect(launch.shell).toBe(windowsPowerShellPath);
    expect(Buffer.from(launch.args.at(-1)!, "base64").toString("utf16le")).toBe(
      command,
    );
  });

  it("exec_command uses PowerShell-native arguments on Windows", () => {
    const command =
      'git --version; & "C:\\Program Files\\GitHub CLI\\gh.exe" --version';
    const launch = resolveShellLaunch(
      command,
      {
        shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      },
      "win32",
      {},
    );
    if ("error" in launch) throw new Error(launch.error);

    expect(launch.args.slice(0, -1)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
    ]);
    expect(Buffer.from(launch.args.at(-1)!, "base64").toString("utf16le")).toBe(
      command,
    );
    expect(launch.args).not.toContain("/d");
    expect(launch.args).not.toContain("/s");
    expect(launch.args).not.toContain("/c");
    expect(launch.windowsVerbatimArguments).toBeUndefined();

    const interactiveLaunch = resolveShellLaunch(
      command,
      { shell: "powershell.exe", tty: true },
      "win32",
      {},
    );
    if ("error" in interactiveLaunch) {
      throw new Error(interactiveLaunch.error);
    }
    expect(interactiveLaunch.args).not.toContain("-NonInteractive");
    expect(interactiveLaunch.args).toContain("-EncodedCommand");
  });

  it("exec_command preserves quoted source for an explicit cmd.exe shell", () => {
    const command =
      '"C:\\Program Files\\GitHub CLI\\gh.exe" --version & cd /d "C:\\Program Files\\Git"';
    const launch = resolveShellLaunch(
      command,
      { shell: "C:\\Windows\\System32\\cmd.exe" },
      "win32",
      {},
    );
    if ("error" in launch) throw new Error(launch.error);

    expect(launch).toEqual({
      shell: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", `"${command}"`],
      windowsVerbatimArguments: true,
    });
    expect(launch.args.at(-1)).not.toContain('\\"');
  });

  it("exec_command uses Unix command flags for Git Bash on Windows", () => {
    const launch = resolveShellLaunch(
      'printf "%s" ready',
      { shell: "C:\\Program Files\\Git\\bin\\bash.exe", login: false },
      "win32",
      {},
    );
    if ("error" in launch) throw new Error(launch.error);

    expect(launch).toEqual({
      shell: "C:\\Program Files\\Git\\bin\\bash.exe",
      args: ["-c", 'printf "%s" ready'],
    });
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
    expect(result.details).toMatchObject({
      session_id: null,
      running: false,
      exit_code: 1,
    });
    const output = execTextOf(result);
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
    expect(result.details).toMatchObject({
      session_id: null,
      running: false,
      exit_code: 1,
      cwd: cwdFile,
    });
    const output = execTextOf(result);
    expect(output).toContain("Failed to start exec_command shell");
    expect(output).toContain(`cwd=${JSON.stringify(cwdFile)}`);
  });

  it("exec_command uses a real PTY and keeps write_stdin session semantics", async () => {
    const root = await createTempDir();
    const bunExecutable = path.join(
      repoRoot,
      "packages/desktop/resources/bun/current",
      process.platform === "win32" ? "bun.exe" : "bun",
    );
    await access(bunExecutable);
    const shellModuleUrl = pathToFileURL(
      path.join(repoRoot, "packages/runtime/kernel/tools/shell.ts"),
    ).href;
    const source = `
      import {
        createShellState,
        handleExecCommand,
        handleWriteStdin,
      } from ${JSON.stringify(shellModuleUrl)};

      const root = ${JSON.stringify(root)};
      const state = createShellState(root);
      const context = {
        conversationId: "c-tty",
        deviceId: "d-tty",
        requestId: "r-tty",
        stellaAppDir: root,
      };
      const windows = process.platform === "win32";
      const shell = windows ? "powershell.exe" : "/bin/bash";
      const probeCommand = windows
        ? 'if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) { Write-Output pipe } else { Write-Output tty-ready }'
        : 'if test -t 0 && test -t 1; then printf tty-ready; else printf pipe; fi';
      const interactiveCommand = windows
        ? '$value = Read-Host; Write-Output "got:$value"'
        : 'read value; printf "got:%s" "$value"';

      const probe = await handleExecCommand(
        state,
        { cmd: probeCommand, shell, tty: true, yield_time_ms: 2_000 },
        context,
      );
      const started = await handleExecCommand(
        state,
        { cmd: interactiveCommand, shell, tty: true, yield_time_ms: 50 },
        context,
      );
      const sessionId = started.details?.session_id;
      if (!sessionId) throw new Error("interactive PTY did not stay running");
      const resized = await handleWriteStdin(
        state,
        {
          session_id: sessionId,
          operation: "resize",
          cols: 100,
          rows: 40,
          yield_time_ms: 0,
        },
        context,
      );
      const writes = [];
      writes.push(
        await handleWriteStdin(
          state,
          { session_id: sessionId, chars: "hello\\n", yield_time_ms: 2_000 },
          context,
        ),
      );
      if (writes.at(-1)?.details?.running) {
        writes.push(
          await handleWriteStdin(
            state,
            { session_id: sessionId, chars: "", yield_time_ms: 2_000 },
            context,
          ),
        );
      }
      console.log(
        "STELLA_PTY_RESULT=" + JSON.stringify({ probe, started, resized, writes }),
      );
    `;
    const { stdout } = await execFileAsync(bunExecutable, ["-e", source], {
      cwd: repoRoot,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const marker = "STELLA_PTY_RESULT=";
    const markerIndex = stdout.lastIndexOf(marker);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    const fixture = JSON.parse(
      stdout.slice(markerIndex + marker.length).trim(),
    );
    expect(fixture.probe.error).toBeUndefined();
    expect(fixture.probe.details).toMatchObject({
      running: false,
      exit_code: 0,
    });
    expect(fixture.probe.result).toContain("tty-ready");
    expect(fixture.resized.error).toBeUndefined();
    expect(fixture.resized.details).toMatchObject({
      operation: "resize",
      terminal_size: { cols: 100, rows: 40 },
      chunk_receipt: {
        operation: "resize",
        terminal_size: { cols: 100, rows: 40 },
      },
    });
    const interactionOutput = [
      fixture.started?.result,
      ...fixture.writes.map((write: { result?: string }) => write.result),
    ]
      .filter(Boolean)
      .join("");
    expect(interactionOutput).toContain("got:hello");
    expect(fixture.writes.at(-1)?.details).toMatchObject({
      running: false,
      exit_code: 0,
    });
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
    expect(result.details).toMatchObject({
      session_id: null,
      running: false,
      exit_code: 0,
    });
    expect(execTextOf(result)).toContain("\nOutput:\n42");
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
      expect(result.details).toMatchObject({
        running: false,
        exit_code: 0,
      });
      expect(execTextOf(result)).toContain('\nOutput:\n{"runtime":"node"}');
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
    expect(result.details).toMatchObject({
      session_id: null,
      running: false,
      exit_code: 0,
    });
    expect(execTextOf(result)).toContain("\nOutput:\n42");
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
    const sessionId = execDetailsOf(started).session_id;
    expect(typeof sessionId).toBe("string");

    const finished = await handleWriteStdin(
      shellState,
      {
        session_id: sessionId,
        chars: "console.log(21 * 2)\n.exit\n",
        yield_time_ms: 1_000,
        max_output_tokens: 128,
      },
      context,
    );

    expect(finished.error).toBeUndefined();
    expect(finished.details).toMatchObject({
      session_id: null,
      running: false,
      exit_code: 0,
    });
    expect(finished.modelOutputTokens).toBe(128);
    expect(execTextOf(finished)).toContain("42");
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
    const sessionId = execDetailsOf(started).session_id;
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
    expect(finished.details).toMatchObject({
      session_id: null,
      running: false,
      exit_code: 0,
    });
    expect(execTextOf(finished)).toContain("echo:hello world");
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
    const payload = execDetailsOf(result);
    expect(typeof payload.wall_time_seconds).toBe("number");
    expect(payload.wall_time_seconds).toBeGreaterThanOrEqual(0);
    expect(typeof payload.original_token_count).toBe("number");
    expect(payload.original_token_count).toBeGreaterThan(256);
    expect(result.modelOutputTokens).toBe(256);
  });

  it("exec_command accepts zero and rejects invalid max_output_tokens before execution", async () => {
    const root = await createTempDir();
    const shellState = createShellState(root);
    const markerPath = path.join(root, "should-not-exist.txt");
    const context = {
      conversationId: "c-output-budget-validation",
      deviceId: "d-output-budget-validation",
      requestId: "r-output-budget-validation",
      stellaAppDir: root,
    };

    const zero = await handleExecCommand(
      shellState,
      { cmd: "printf zero", yield_time_ms: 1_000, max_output_tokens: 0 },
      context,
    );
    expect(zero.error).toBeUndefined();
    expect(zero.modelOutputTokens).toBe(0);

    for (const invalid of [-1, 1.5, Number.POSITIVE_INFINITY]) {
      const rejected = await handleExecCommand(
        shellState,
        {
          cmd: `touch ${JSON.stringify(markerPath)}`,
          max_output_tokens: invalid,
        },
        context,
      );
      expect(rejected.error).toBe(
        "max_output_tokens must be a non-negative safe integer.",
      );
    }
    await expect(access(markerPath)).rejects.toThrow();
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
    const payload = execDetailsOf(result);
    expect(execTextOf(result)).toContain("\nOutput:\nok");
    expect(typeof payload.original_token_count).toBe("number");
    expect(payload.original_token_count >= 1).toBe(true);
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
              parameters: {
                cmd: "printf one",
                yield_time_ms: 500,
                max_output_tokens: 128,
              },
            },
            {
              recipient_name: "functions.exec_command",
              parameters: {
                cmd: "printf two",
                yield_time_ms: 500,
                max_output_tokens: 256,
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
          allowedToolNames: ["exec_command", "multi_tool_use_parallel"],
        },
      );

      expect(result.error).toBeUndefined();
      expect(typeof result.result).toBe("string");
      expect(result.result as string).toContain("one");
      expect(result.result as string).toContain("two");
      expect(result.modelOutputTokens).toBe(384);
      const details = result.details as {
        results: Array<{
          tool_name: string;
          result?: unknown;
          details?: unknown;
          modelOutputTokens?: number;
        }>;
      };
      expect(details.results).toHaveLength(2);
      for (const [index, nested] of details.results.entries()) {
        expect(nested.tool_name).toBe("exec_command");
        expect(nested).not.toHaveProperty("result");
        expect(nested.details).not.toHaveProperty("output");
        expect(nested.modelOutputTokens).toBe(index === 0 ? 128 : 256);
      }
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
