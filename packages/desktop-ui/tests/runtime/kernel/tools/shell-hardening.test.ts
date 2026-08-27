import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
}));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  mocks.spawn.mockImplementation((...args: Parameters<typeof actual.spawn>) =>
    actual.spawn(...args),
  );
  return { ...actual, spawn: mocks.spawn };
});

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  mocks.readdir.mockImplementation(
    (...args: Parameters<typeof actual.readdir>) => actual.readdir(...args),
  );
  mocks.stat.mockImplementation((...args: Parameters<typeof actual.stat>) =>
    actual.stat(...args),
  );
  return { ...actual, readdir: mocks.readdir, stat: mocks.stat };
});

import {
  COMPLETED_SHELL_TTL_MS,
  EXEC_UPDATE_MAX_BYTES,
  MAX_RETAINED_COMPLETED_SHELLS,
  MAX_SNAPSHOT_ENTRIES,
  PRUNED_SHELL_RECEIPT_TTL_MS,
  PRODUCED_FILE_COLLECTION_ATTEMPT_MS,
  cleanupShellSessions,
  createShellState,
  drainCompletedProducedFiles,
  handleBash,
  handleExecCommand,
  handleKillShell,
  handleShellStatus,
  handleWriteStdin,
  listRunningShellSessionsOwnedBy,
  resolveToolProcessIdentity,
  runShell,
  startShell,
} from "@stella/runtime/kernel/tools/shell";
import type { ToolContext } from "@stella/runtime/kernel/tools/types";

const tempDirs: string[] = [];

const statWithoutPromisesModuleMock = (filePath: string): Promise<fs.Stats> =>
  new Promise((resolve, reject) => {
    fs.stat(filePath, (error, info) => {
      if (error) reject(error);
      else resolve(info);
    });
  });

const createTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stella-shell-hardening-"));
  tempDirs.push(dir);
  return dir;
};

const toolContext = (
  conversationId: string,
  options: { requestId?: string; runId?: string; agentId?: string } = {},
): ToolContext => ({
  conversationId,
  deviceId: "test-device",
  requestId: options.requestId ?? `request-${conversationId}`,
  ...(options.runId ? { runId: options.runId } : {}),
  ...(options.agentId ? { agentId: options.agentId } : {}),
});

afterEach(() => {
  mocks.spawn.mockClear();
  mocks.readdir.mockClear();
  mocks.stat.mockClear();
  mocks.stat.mockImplementation((filePath) =>
    statWithoutPromisesModuleMock(String(filePath)),
  );
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("shell hardening", () => {
  it("rejects privileged or workspace-escaping tool process identities", () => {
    const root = createTempDir();
    expect(() =>
      resolveToolProcessIdentity({
        ...toolContext("identity-root"),
        toolWorkspaceRoot: root,
        toolProcessIdentity: {
          uid: 0,
          gid: 42424,
          home: root,
          user: "stella-tools",
        },
      }),
    ).toThrow("invalid or privileged");
    expect(() =>
      resolveToolProcessIdentity({
        ...toolContext("identity-escape"),
        toolWorkspaceRoot: root,
        toolProcessIdentity: {
          uid: 42424,
          gid: 42424,
          home: path.dirname(root),
          user: "stella-tools",
        },
      }),
    ).toThrow("must stay inside the workspace");
    expect(() =>
      resolveToolProcessIdentity(
        {
          ...toolContext("identity-windows"),
          toolWorkspaceRoot: root,
          toolProcessIdentity: {
            uid: 42424,
            gid: 42424,
            home: root,
            user: "stella-tools",
          },
        },
        "win32",
      ),
    ).toThrow("only on POSIX");
  });

  it("drops shell credentials and moves its writable home into the workspace", async () => {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (!uid || !gid) return;
    const root = createTempDir();
    const home = path.join(root, ".tool-home");
    fs.mkdirSync(home);
    const context: ToolContext = {
      ...toolContext("identity-spawn"),
      toolWorkspaceRoot: root,
      toolProcessIdentity: {
        uid,
        gid,
        home,
        user: "stella-tools",
      },
    };
    const result = await handleExecCommand(
      createShellState(root),
      {
        cmd: "printf identity-boundary",
        workdir: root,
        yield_time_ms: 1_000,
      },
      context,
    );
    expect(result.result).toContain("identity-boundary");
    const spawnOptions = mocks.spawn.mock.calls.at(-1)?.[2] as
      | {
          uid?: number;
          gid?: number;
          env?: NodeJS.ProcessEnv;
        }
      | undefined;
    expect(spawnOptions).toMatchObject({ uid, gid });
    expect(spawnOptions?.env).toMatchObject({
      HOME: home,
      USER: "stella-tools",
      LOGNAME: "stella-tools",
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      XDG_STATE_HOME: path.join(home, ".local", "state"),
    });
  });

  it("sets deterministic non-TTY output environment defaults", async () => {
    const root = createTempDir();
    const result = await handleExecCommand(createShellState(root), {
      cmd: `node -e 'console.log(JSON.stringify({NO_COLOR:process.env.NO_COLOR,TERM:process.env.TERM,COLORTERM:process.env.COLORTERM,LANG:process.env.LANG,LC_ALL:process.env.LC_ALL,LC_CTYPE:process.env.LC_CTYPE,PAGER:process.env.PAGER,GIT_PAGER:process.env.GIT_PAGER,GH_PAGER:process.env.GH_PAGER}))'`,
      workdir: root,
      yield_time_ms: 1_000,
    });

    expect(result.result).toContain(
      '"NO_COLOR":"1","TERM":"dumb","COLORTERM":"","LANG":"C.UTF-8","LC_ALL":"C.UTF-8","LC_CTYPE":"C.UTF-8","PAGER":"cat","GIT_PAGER":"cat","GH_PAGER":"cat"',
    );
  });

  it("caps streaming updates without losing original output accounting", async () => {
    const root = createTempDir();
    const onUpdate = vi.fn();
    const state = createShellState(root);
    const result = await handleExecCommand(
      state,
      {
        cmd: `node -e 'process.stdout.write("x".repeat(20000)); setTimeout(()=>{},500)'`,
        workdir: root,
        yield_time_ms: 50,
      },
      undefined,
      undefined,
      onUpdate,
    );

    const updateDeadline = Date.now() + 1_000;
    while (onUpdate.mock.calls.length === 0 && Date.now() < updateDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(onUpdate).toHaveBeenCalled();
    const dataUpdates = onUpdate.mock.calls
      .map(([update]) => update)
      .filter((update) => update.details.chunk_receipt.kind === "stream_delta");
    expect(dataUpdates).toHaveLength(3);
    let cursor = 0;
    let streamed = "";
    for (const update of dataUpdates) {
      expect(Buffer.byteLength(update.result, "utf8")).toBeLessThan(
        EXEC_UPDATE_MAX_BYTES + 1_024,
      );
      expect(update.details.raw_output_truncated).toBe(false);
      expect(update.details.presentation_output_truncated).toBe(false);
      expect(update.result).not.toContain("exceeded the 1 MiB collection cap");
      expect(update.details.chunk_receipt.start_byte).toBe(cursor);
      cursor = update.details.chunk_receipt.end_byte;
      streamed += String(update.result).split("\nOutput:\n")[1] ?? "";
    }
    expect(cursor).toBe(20_000);
    expect(streamed).toBe("x".repeat(20_000));
    const sessionId = (result.details as { session_id: string }).session_id;
    state.shells.get(sessionId)?.kill();
  });

  it("keeps raw-cap truncation distinct from update framing", async () => {
    const root = createTempDir();
    const result = await handleExecCommand(createShellState(root), {
      cmd: `node -e 'process.stdout.write("🙂".repeat(300000))'`,
      workdir: root,
      yield_time_ms: 2_000,
    });

    expect(result.details).toMatchObject({
      running: false,
      raw_output_truncated: true,
      presentation_output_truncated: false,
    });
    expect(result.result).toContain("exceeded the 1 MiB collection cap");
    expect(result.result).not.toContain("�");
  });

  it("diagnoses missing sessions with worker provenance and recent ids", async () => {
    const root = createTempDir();
    const state = createShellState(root);
    const record = startShell(state, "printf done", root);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const result = await handleWriteStdin(state, {
      session_id: "missing-session",
      chars: "",
    });
    expect(result.error).toContain(
      `not found in runtime worker generation ${state.workerGeneration}`,
    );
    expect(result.error).toContain(`runtime_pid=${process.pid}`);
    expect(result.error).toContain(record.id);
  });

  it("returns an empty poll on first subprocess activity while the session remains alive", async () => {
    const root = createTempDir();
    const state = createShellState(root);
    const started = await handleExecCommand(state, {
      cmd: `node -e 'setTimeout(() => process.stdout.write("progress\\n"), 75); setTimeout(() => {}, 5000)'`,
      workdir: root,
      yield_time_ms: 10,
    });
    const sessionId = (started.details as { session_id: string }).session_id;

    const pollStartedAt = Date.now();
    const result = await handleWriteStdin(state, {
      session_id: sessionId,
      chars: "",
      yield_time_ms: 1_000,
    });
    const elapsedMs = Date.now() - pollStartedAt;

    expect(result.error).toBeUndefined();
    expect(result.result).toContain("progress");
    expect(result.details).toMatchObject({
      operation: "poll",
      running: true,
      shell_session_id: sessionId,
    });
    expect(elapsedMs).toBeLessThan(750);
    state.shells.get(sessionId)?.kill();
  });

  it("lets a concurrent write wake a passive poll without reserving the interaction gate", async () => {
    const root = createTempDir();
    const state = createShellState(root);
    const started = await handleExecCommand(state, {
      cmd: `node -e 'process.stdin.on("data", chunk => process.stdout.write("got:" + chunk)); setInterval(() => {}, 1000)'`,
      workdir: root,
      yield_time_ms: 100,
    });
    const sessionId = (started.details as { session_id: string }).session_id;
    const record = state.shells.get(sessionId);
    if (!record) throw new Error("missing passive-poll shell record");

    try {
      const poll = handleWriteStdin(state, {
        session_id: sessionId,
        operation: "poll",
        yield_time_ms: 3_000,
      });
      const waiterDeadline = Date.now() + 1_000;
      while (record.waiters.size === 0 && Date.now() < waiterDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(record.waiters.size).toBeGreaterThan(0);

      const writeStartedAt = Date.now();
      const write = await handleWriteStdin(state, {
        session_id: sessionId,
        chars: "hello\n",
        yield_time_ms: 500,
      });
      const writeElapsedMs = Date.now() - writeStartedAt;
      const polled = await poll;

      expect(write.error).toBeUndefined();
      expect(polled.error).toBeUndefined();
      expect(writeElapsedMs).toBeLessThan(1_500);
      expect(write.result).toContain("got:hello");
      expect(polled.result).not.toContain("got:hello");

      const writeDetails = write.details as {
        interaction_sequence: number;
        chunk_receipt: { start_byte: number; end_byte: number };
      };
      const pollDetails = polled.details as {
        interaction_sequence: number;
        chunk_receipt: { start_byte: number; end_byte: number };
      };
      expect(writeDetails.interaction_sequence).toBe(2);
      expect(pollDetails.interaction_sequence).toBe(3);
      expect(pollDetails.chunk_receipt.start_byte).toBe(
        writeDetails.chunk_receipt.end_byte,
      );
      expect(pollDetails.chunk_receipt.end_byte).toBe(
        writeDetails.chunk_receipt.end_byte,
      );
    } finally {
      record.kill();
    }
  });

  it("scopes session lookup, diagnostics, listing, and termination to the owning thread", async () => {
    const root = createTempDir();
    const state = createShellState(root);
    const ownerAtStart = toolContext("conversation-a", {
      requestId: "request-a-1",
      runId: "run-a-1",
    });
    const ownerOnLaterRun = toolContext("conversation-a", {
      requestId: "request-a-2",
      runId: "run-a-2",
    });
    const foreign = toolContext("conversation-b", {
      requestId: "request-b-1",
      runId: "run-b-1",
    });
    const started = await handleExecCommand(
      state,
      {
        cmd: `node -e 'process.stdin.on("data", chunk => process.stdout.write("got:" + chunk)); setTimeout(() => {}, 5000)'`,
        workdir: root,
        yield_time_ms: 10,
      },
      ownerAtStart,
    );
    const sessionId = (started.details as { session_id: string }).session_id;

    const foreignWrite = await handleWriteStdin(
      state,
      {
        session_id: sessionId,
        chars: "foreign\\n",
        yield_time_ms: 100,
      },
      foreign,
    );
    const foreignTerminate = await handleWriteStdin(
      state,
      { session_id: sessionId, operation: "terminate", yield_time_ms: 100 },
      foreign,
    );
    const foreignList = await handleShellStatus(state, {}, foreign);
    const foreignStatus = await handleShellStatus(
      state,
      { shell_id: sessionId },
      foreign,
    );
    const foreignKill = await handleKillShell(
      state,
      { shell_id: sessionId },
      foreign,
    );

    expect(foreignWrite.error).toContain("Session not found");
    expect(foreignWrite.error).not.toContain("Recent sessions:");
    expect(foreignTerminate.error).toContain("Session not found");
    expect(foreignList.result).toBe("No active shells.");
    expect(foreignStatus.error).toBe(`Shell not found: ${sessionId}`);
    expect(foreignKill.error).toBe(`Shell not found: ${sessionId}`);
    expect(state.shells.get(sessionId)?.running).toBe(true);
    expect(
      listRunningShellSessionsOwnedBy(state, {
        conversationId: ownerAtStart.conversationId,
      }),
    ).toEqual([sessionId]);
    expect(
      listRunningShellSessionsOwnedBy(state, {
        conversationId: foreign.conversationId,
      }),
    ).toEqual([]);

    const sameOwnerWrite = await handleWriteStdin(
      state,
      {
        session_id: sessionId,
        chars: "owner\\n",
        yield_time_ms: 250,
      },
      ownerOnLaterRun,
    );
    expect(sameOwnerWrite.error).toBeUndefined();
    expect(sameOwnerWrite.result).toContain("got:owner");
    expect(
      await handleShellStatus(state, { shell_id: sessionId }, ownerOnLaterRun),
    ).toMatchObject({ result: expect.stringContaining("running") });

    const ownerTerminate = await handleWriteStdin(
      state,
      { session_id: sessionId, operation: "terminate", yield_time_ms: 1_000 },
      ownerOnLaterRun,
    );
    expect(ownerTerminate.error).toBeUndefined();
    expect(ownerTerminate.details).toMatchObject({ running: false });
  });

  it("does not reveal another agent thread's sessions within one conversation", async () => {
    const root = createTempDir();
    const state = createShellState(root);
    const agentA = toolContext("shared-conversation", { agentId: "agent-a" });
    const agentB = toolContext("shared-conversation", { agentId: "agent-b" });
    const started = await handleExecCommand(
      state,
      {
        cmd: `node -e 'setTimeout(() => {}, 5000)'`,
        workdir: root,
        yield_time_ms: 10,
      },
      agentA,
    );
    const sessionId = (started.details as { session_id: string }).session_id;

    expect(
      listRunningShellSessionsOwnedBy(state, {
        conversationId: agentA.conversationId,
        agentId: agentA.agentId,
      }),
    ).toEqual([sessionId]);
    expect(
      listRunningShellSessionsOwnedBy(state, {
        conversationId: agentB.conversationId,
        agentId: agentB.agentId,
      }),
    ).toEqual([]);

    const foreign = await handleWriteStdin(
      state,
      { session_id: sessionId, operation: "terminate" },
      agentB,
    );
    expect(foreign.error).toContain("Session not found");
    expect(state.shells.get(sessionId)?.running).toBe(true);

    await handleWriteStdin(
      state,
      { session_id: sessionId, operation: "terminate", yield_time_ms: 1_000 },
      agentA,
    );
  });

  it("serializes same-session writes and returns stable interaction receipts", async () => {
    const root = createTempDir();
    const state = createShellState(root);
    const started = await handleExecCommand(state, {
      cmd: `node -e 'let input=""; process.stdin.on("data", chunk => { input += chunk; const lines = input.split("\\n"); input = lines.pop(); for (const line of lines) setTimeout(() => process.stdout.write("got:" + line + "\\n"), line === "first" ? 25 : 0); }); setTimeout(() => {}, 5000)'`,
      workdir: root,
      yield_time_ms: 25,
    });
    const sessionId = (started.details as { session_id: string }).session_id;

    const [first, second] = await Promise.all([
      handleWriteStdin(state, {
        session_id: sessionId,
        chars: "first\n",
        yield_time_ms: 75,
      }),
      handleWriteStdin(state, {
        session_id: sessionId,
        chars: "second\n",
        yield_time_ms: 75,
      }),
    ]);

    expect(first.result).toContain("got:first");
    expect(first.result).not.toContain("got:second");
    expect(second.result).toContain("got:second");
    expect(first.details).toMatchObject({
      shell_session_id: sessionId,
      interaction_sequence: 2,
    });
    expect(second.details).toMatchObject({
      shell_session_id: sessionId,
      interaction_sequence: 3,
    });
    state.shells.get(sessionId)?.kill();
  });

  it("deduplicates retried write ids without swallowing later output", async () => {
    const root = createTempDir();
    const state = createShellState(root);
    const started = await handleExecCommand(state, {
      cmd: `count=0; while IFS= read -r line; do count=$((count + 1)); printf 'seen:%s:%s\n' "$count" "$line"; [ "$line" = done ] && break; done`,
      workdir: root,
      yield_time_ms: 25,
    });
    const sessionId = (started.details as { session_id: string }).session_id;

    const first = await handleWriteStdin(state, {
      session_id: sessionId,
      chars: "alpha\n",
      write_id: "write-alpha",
      yield_time_ms: 75,
    });
    const retried = await handleWriteStdin(state, {
      session_id: sessionId,
      chars: "alpha\n",
      write_id: "write-alpha",
      yield_time_ms: 75,
    });
    const abortedController = new AbortController();
    const abortTimer = setTimeout(
      () => abortedController.abort(new Error("ambiguous response")),
      25,
    );
    const ambiguous = await handleWriteStdin(
      state,
      {
        session_id: sessionId,
        chars: "beta\n",
        write_id: "write-beta",
        yield_time_ms: 1_000,
      },
      undefined,
      abortedController.signal,
    );
    clearTimeout(abortTimer);
    const recovered = await handleWriteStdin(state, {
      session_id: sessionId,
      chars: "beta\n",
      write_id: "write-beta",
      yield_time_ms: 75,
    });
    const collision = await handleWriteStdin(state, {
      session_id: sessionId,
      chars: "different\n",
      write_id: "write-alpha",
      yield_time_ms: 75,
    });
    const finished = await handleWriteStdin(state, {
      session_id: sessionId,
      chars: "done\n",
      write_id: "write-done",
      yield_time_ms: 1_000,
    });

    expect(first.result).toContain("seen:1:alpha");
    expect(first.details).toMatchObject({
      operation: "write",
      write_id: "write-alpha",
      write_deduplicated: false,
      chunk_receipt: {
        write_id: "write-alpha",
        write_deduplicated: false,
      },
    });
    expect(retried.result).not.toContain("seen:");
    expect(retried.details).toMatchObject({
      write_id: "write-alpha",
      write_deduplicated: true,
      chunk_receipt: { write_deduplicated: true },
    });
    expect(ambiguous.error).toContain("ambiguous response");
    expect(recovered.result).toContain("seen:2:beta");
    expect(recovered.details).toMatchObject({
      write_id: "write-beta",
      write_deduplicated: true,
    });
    expect(collision.error).toContain("already accepted with different");
    expect(finished.result).toContain("seen:3:done");
    expect(finished.result).not.toContain("different");
  });

  it("supports explicit close_stdin and terminate controls for pipe sessions", async () => {
    const root = createTempDir();
    const state = createShellState(root);
    const eofStarted = await handleExecCommand(state, {
      cmd: `node -e 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("EOF\\n"))'`,
      workdir: root,
      yield_time_ms: 25,
    });
    const eofId = (eofStarted.details as { session_id: string }).session_id;
    const closed = await handleWriteStdin(state, {
      session_id: eofId,
      operation: "close_stdin",
      yield_time_ms: 1_000,
    });
    expect(closed.error).toBeUndefined();
    expect(closed.result).toContain("EOF");
    expect(closed.details).toMatchObject({
      operation: "close_stdin",
      running: false,
    });

    const longStarted = await handleExecCommand(state, {
      cmd: `node -e 'setInterval(() => {}, 1000)'`,
      workdir: root,
      yield_time_ms: 25,
    });
    const longId = (longStarted.details as { session_id: string }).session_id;
    const terminated = await handleWriteStdin(state, {
      session_id: longId,
      operation: "terminate",
      yield_time_ms: 1_000,
    });
    expect(terminated.error).toBeUndefined();
    expect(terminated.details).toMatchObject({
      operation: "terminate",
      running: false,
      shell_session_id: longId,
    });
  });

  it("bounds completed records and diagnoses pruned ids by generation", async () => {
    const root = createTempDir();
    const state = createShellState(root);
    for (let index = 0; index < MAX_RETAINED_COMPLETED_SHELLS + 3; index += 1) {
      startShell(state, `printf ${index}`, root);
    }
    const deadline = Date.now() + 2_000;
    while (
      [...state.shells.values()].some((record) => record.running) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const completed = [...state.shells.values()].filter(
      (record) => !record.running,
    );
    expect(completed.length).toBeLessThanOrEqual(MAX_RETAINED_COMPLETED_SHELLS);
    const prunedId = state.prunedSessions.keys().next().value as string;
    expect(prunedId).toBeTruthy();
    const result = await handleWriteStdin(state, {
      session_id: prunedId,
      chars: "",
    });
    expect(result.error).toContain("was pruned from runtime worker generation");
    expect(result.error).toContain(state.workerGeneration);
  });

  it("expires completed records and tombstones through explicit cleanup", async () => {
    const root = createTempDir();
    const state = createShellState(root);
    const record = startShell(state, "printf ttl", root);
    const deadline = Date.now() + 1_000;
    while (record.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(record.running).toBe(false);

    const now = Date.now();
    record.completedAt = now - COMPLETED_SHELL_TTL_MS - 1;
    cleanupShellSessions(state, now);
    expect(state.shells.has(record.id)).toBe(false);
    const tombstone = state.prunedSessions.get(record.id);
    expect(tombstone).toBeDefined();
    if (!tombstone) throw new Error("missing pruned session tombstone");
    tombstone.prunedAt = now - PRUNED_SHELL_RECEIPT_TTL_MS - 1;
    cleanupShellSessions(state, now);
    expect(state.prunedSessions.has(record.id)).toBe(false);
  });

  it("keeps pruned-session provenance private to its owner", async () => {
    const root = createTempDir();
    const state = createShellState(root);
    const owner = toolContext("tombstone-owner", { runId: "origin-run" });
    const foreign = toolContext("tombstone-foreign", { runId: "foreign-run" });
    const started = await handleExecCommand(
      state,
      { cmd: "printf tombstone", workdir: root, yield_time_ms: 1_000 },
      owner,
    );
    const sessionId = (started.details as { shell_session_id: string })
      .shell_session_id;
    const record = state.shells.get(sessionId);
    if (!record) throw new Error("missing completed shell record");
    const now = Date.now();
    record.completedAt = now - COMPLETED_SHELL_TTL_MS - 1;
    cleanupShellSessions(state, now);
    expect(state.prunedSessions.has(sessionId)).toBe(true);

    const hidden = await handleWriteStdin(
      state,
      { session_id: sessionId, chars: "" },
      foreign,
    );
    const visible = await handleWriteStdin(
      state,
      { session_id: sessionId, chars: "" },
      toolContext("tombstone-owner", { runId: "later-run" }),
    );

    expect(hidden.error).toContain("Session not found");
    expect(hidden.error).not.toContain("was pruned");
    expect(visible.error).toContain("was pruned");
  });

  it("routes a synchronous spawn throw through the managed diagnostic record", () => {
    const root = createTempDir();
    const spawnError = Object.assign(new Error("posix_spawn '/bin/bash'"), {
      code: "ENOTDIR",
    });
    mocks.spawn.mockImplementationOnce(() => {
      throw spawnError;
    });

    const state = createShellState(root);
    const record = startShell(state, "printf unreachable", root);

    expect(record).toMatchObject({
      running: false,
      exitCode: 1,
      cwd: root,
    });
    expect(record.output).toContain("Failed to start exec_command shell");
    expect(record.output).toContain(`cwd=${JSON.stringify(root)}`);
    expect(record.output).toContain("cause=Error: posix_spawn '/bin/bash'");
    expect(state.shells.get(record.id)).toBe(record);
  });

  it("routes a synchronous one-shot spawn throw through the same diagnostic", async () => {
    const root = createTempDir();
    mocks.spawn.mockImplementationOnce(() => {
      throw new Error("synchronous spawn failure");
    });

    const output = await runShell(
      createShellState(root),
      "printf unreachable",
      root,
      500,
    );

    expect(output).toContain("Failed to start exec_command shell");
    expect(output).toContain(`cwd=${JSON.stringify(root)}`);
    expect(output).toContain("cause=Error: synchronous spawn failure");
  });

  it("returns a running session by the yield deadline when the pre-snapshot stalls", async () => {
    const root = createTempDir();
    mocks.readdir.mockImplementationOnce(
      () => new Promise<never>(() => undefined),
    );
    const state = createShellState(root);
    const startedAt = Date.now();

    const result = await handleExecCommand(
      state,
      {
        cmd: 'node -e "setTimeout(() => {}, 5000)"',
        workdir: root,
        yield_time_ms: 25,
      },
      {
        conversationId: "c-slow-snapshot",
        deviceId: "d-slow-snapshot",
        requestId: "r-slow-snapshot",
        stellaAppDir: root,
      },
    );

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(result.error).toBeUndefined();
    expect(result.details).toMatchObject({ running: true, cwd: root });
    const sessionId = (result.details as { session_id: string }).session_id;
    expect(typeof sessionId).toBe("string");
    state.shells.get(sessionId)?.kill();
  });

  it("bounds snapshot traversal even when a tree contains no files", async () => {
    const root = createTempDir();
    const entries = Array.from(
      { length: MAX_SNAPSHOT_ENTRIES + 1 },
      (_, index) => ({
        name: `socket-${index}`,
        isDirectory: () => false,
        isFile: () => false,
      }),
    );
    mocks.readdir.mockImplementationOnce(async () => entries as never);

    const result = await handleExecCommand(createShellState(root), {
      cmd: `node -e 'process.stdout.write("bounded")'`,
      workdir: root,
      yield_time_ms: 30_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toContain("bounded");
    expect(mocks.readdir).toHaveBeenCalledTimes(1);
  });

  it("bounds directory traversal concurrency inside one absolute snapshot budget", async () => {
    const root = createTempDir();
    const directories = Array.from({ length: 24 }, (_, index) => ({
      name: `dir-${index}`,
      isDirectory: () => true,
      isFile: () => false,
    }));
    let activeReads = 0;
    let maxActiveReads = 0;
    const readChildDirectory = async () => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeReads -= 1;
      return [] as never;
    };
    // Baseline and completion snapshots each read the root once, then the 24
    // synthetic children. `mockImplementationOnce` preserves the suite's
    // real-fs default for every later test.
    for (let phase = 0; phase < 2; phase += 1) {
      mocks.readdir.mockImplementationOnce(async () => directories as never);
      for (let index = 0; index < directories.length; index += 1) {
        mocks.readdir.mockImplementationOnce(readChildDirectory);
      }
    }

    const result = await handleExecCommand(createShellState(root), {
      cmd: `node -e 'process.stdout.write("bounded-concurrency")'`,
      workdir: root,
      yield_time_ms: 2_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toContain("bounded-concurrency");
    expect(maxActiveReads).toBeGreaterThan(1);
    expect(maxActiveReads).toBeLessThanOrEqual(8);
  });

  it("aborts a stalled mentioned-external candidate before spawning", async () => {
    const root = createTempDir();
    const externalRoot = createTempDir();
    const externalPath = path.join(externalRoot, "never-read.txt");
    let markCandidateStarted!: () => void;
    const candidateStarted = new Promise<void>((resolve) => {
      markCandidateStarted = resolve;
    });
    mocks.stat.mockImplementationOnce(() => {
      markCandidateStarted();
      return new Promise<never>(() => undefined);
    });
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const pending = handleExecCommand(
      createShellState(root),
      {
        cmd: `printf unreachable > ${JSON.stringify(externalPath)}`,
        workdir: root,
        yield_time_ms: 5_000,
      },
      toolContext("c-external-candidate-abort"),
      controller.signal,
    );
    await candidateStarted;
    const abortedAt = Date.now();
    controller.abort(new Error("cancel external candidate"));

    const result = await pending;
    expect(Date.now() - abortedAt).toBeLessThan(500);
    expect(result.error).toContain("cancel external candidate");
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(removeListener).toHaveBeenCalledTimes(addListener.mock.calls.length);
  });

  it("treats external EACCES as unavailable and only ENOENT as missing", async () => {
    const root = createTempDir();
    const externalRoot = createTempDir();
    const unavailablePath = path.join(externalRoot, "unavailable.txt");
    const missingPath = path.join(externalRoot, "missing.txt");
    const denied = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    let deniedOnce = false;
    mocks.stat.mockImplementation(async (filePath) => {
      if (
        !deniedOnce &&
        path.resolve(String(filePath)) === path.resolve(unavailablePath)
      ) {
        deniedOnce = true;
        throw denied;
      }
      return await statWithoutPromisesModuleMock(String(filePath));
    });

    const unavailable = await handleExecCommand(createShellState(root), {
      cmd: `printf private > ${JSON.stringify(unavailablePath)}`,
      workdir: root,
      yield_time_ms: 2_000,
    });
    expect(unavailable.error).toBeUndefined();
    expect(deniedOnce).toBe(true);
    expect(unavailable.producedFiles).toBeUndefined();
    expect(fs.readFileSync(unavailablePath, "utf8")).toBe("private");

    const missing = await handleExecCommand(createShellState(root), {
      cmd: `printf public > ${JSON.stringify(missingPath)}`,
      workdir: root,
      yield_time_ms: 2_000,
    });
    expect(missing.error).toBeUndefined();
    expect(missing.producedFiles).toEqual([
      { path: missingPath, kind: { type: "add" } },
    ]);
  });

  it("keeps a stalled external after-snapshot recoverable for a later drain", async () => {
    const root = createTempDir();
    const externalRoot = createTempDir();
    const externalPath = path.join(externalRoot, "eventual.txt");
    let externalStatCalls = 0;
    let markAfterStatStarted!: () => void;
    const afterStatStarted = new Promise<void>((resolve) => {
      markAfterStatStarted = resolve;
    });
    let releaseAfterStat!: (info: fs.Stats) => void;
    const delayedAfterStat = new Promise<fs.Stats>((resolve) => {
      releaseAfterStat = resolve;
    });
    mocks.stat.mockImplementation(async (filePath) => {
      if (path.resolve(String(filePath)) === path.resolve(externalPath)) {
        externalStatCalls += 1;
        if (externalStatCalls === 2) {
          markAfterStatStarted();
          return await delayedAfterStat;
        }
      }
      return await statWithoutPromisesModuleMock(String(filePath));
    });

    const state = createShellState(root);
    const pending = handleExecCommand(state, {
      cmd: `printf eventual > ${JSON.stringify(externalPath)}`,
      workdir: root,
      yield_time_ms: 250,
    });
    await afterStatStarted;
    const result = await pending;

    expect(result.error).toBeUndefined();
    expect(result.producedFiles).toBeUndefined();
    const sessionId = (result.details as { shell_session_id: string })
      .shell_session_id;
    const record = state.shells.get(sessionId);
    expect(record?.producedFilesReported).not.toBe(true);

    releaseAfterStat(await statWithoutPromisesModuleMock(externalPath));
    const recovered = await drainCompletedProducedFiles(state, null, [
      sessionId,
    ]);
    expect(recovered.files).toEqual([
      { path: externalPath, kind: { type: "add" } },
    ]);
    expect(
      (await drainCompletedProducedFiles(state, null, [sessionId])).files,
    ).toEqual([]);
  });

  it("releases every snapshot abort listener after successful completion", async () => {
    const root = createTempDir();
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");

    const result = await handleBash(
      createShellState(root),
      {
        cmd: "printf complete > listener-cleanup.txt",
        workdir: root,
        timeout: 2_000,
      },
      toolContext("c-snapshot-listener-cleanup"),
      controller.signal,
    );

    expect(result.error).toBeUndefined();
    expect(addListener.mock.calls.length).toBeGreaterThan(0);
    expect(removeListener).toHaveBeenCalledTimes(addListener.mock.calls.length);
  });

  it("aborts a stalled legacy Bash snapshot before spawning", async () => {
    const root = createTempDir();
    let markSnapshotStarted!: () => void;
    const snapshotStarted = new Promise<void>((resolve) => {
      markSnapshotStarted = resolve;
    });
    mocks.readdir.mockImplementationOnce(() => {
      markSnapshotStarted();
      return new Promise<never>(() => undefined);
    });
    const controller = new AbortController();
    const pending = handleBash(
      createShellState(root),
      {
        cmd: `node -e 'process.stdout.write("must-not-run")'`,
        workdir: root,
      },
      toolContext("c-bash-snapshot-abort"),
      controller.signal,
    );
    await snapshotStarted;
    const abortedAt = Date.now();
    controller.abort(new Error("cancel Bash snapshot"));

    const result = await pending;
    expect(Date.now() - abortedAt).toBeLessThan(500);
    expect(result.error).toContain("cancel Bash snapshot");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("does not run a completion walk when the start snapshot is null", async () => {
    const root = createTempDir();
    mocks.readdir.mockClear();

    const result = await handleExecCommand(
      createShellState(root),
      { cmd: "pwd", workdir: root, yield_time_ms: 500 },
      {
        conversationId: "c-null-snapshot",
        deviceId: "d-null-snapshot",
        requestId: "r-null-snapshot",
        stellaAppDir: root,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.details).toMatchObject({ running: false, exit_code: 0 });
    expect(mocks.readdir).not.toHaveBeenCalled();
  });

  it("keeps a slow completion snapshot recoverable after the original caller times out", async () => {
    const root = createTempDir();
    const artifactPath = path.join(root, "completed.txt");
    let releaseCompletion!: (entries: unknown[]) => void;
    const completionWalk = new Promise<unknown[]>((resolve) => {
      releaseCompletion = resolve;
    });
    mocks.readdir
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(() => completionWalk as never);
    const state = createShellState(root);
    const context = {
      conversationId: "c-slow-post-snapshot",
      deviceId: "d-slow-post-snapshot",
      requestId: "r-slow-post-snapshot",
      stellaAppDir: root,
    };
    const startedAt = Date.now();

    const result = await handleExecCommand(
      state,
      {
        cmd: "printf artifact > completed.txt",
        workdir: root,
        yield_time_ms: 500,
      },
      context,
    );

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(result.error).toBeUndefined();
    expect(result.details).toMatchObject({ running: false, exit_code: 0 });
    expect(result.producedFiles).toBeUndefined();
    const sessionId = (result.details as { shell_session_id: string })
      .shell_session_id;
    const record = state.shells.get(sessionId);
    expect(record?.producedFilesCollection).toBeDefined();

    const wallClock = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + 60 * 60_000);
    try {
      releaseCompletion([
        {
          name: "completed.txt",
          isDirectory: () => false,
          isFile: () => true,
        },
      ]);
      const recovered = await drainCompletedProducedFiles(
        state,
        { conversationId: context.conversationId },
        [sessionId],
      );
      expect(recovered.files).toEqual([
        { path: artifactPath, kind: { type: "add" } },
      ]);
      expect(
        (
          await drainCompletedProducedFiles(
            state,
            { conversationId: context.conversationId },
            [sessionId],
          )
        ).files,
      ).toEqual([]);
    } finally {
      wallClock.mockRestore();
    }
  });

  it(
    "resets a permanently stuck completion attempt and retries from its baseline",
    async () => {
      const root = createTempDir();
      const artifactPath = path.join(root, "retry-after-stall.txt");
      mocks.readdir
        .mockImplementationOnce(async () => [])
        .mockImplementationOnce(() => new Promise<never>(() => undefined));
      const state = createShellState(root);
      const result = await handleExecCommand(state, {
        cmd: "printf artifact > retry-after-stall.txt",
        workdir: root,
        yield_time_ms: 500,
      });
      const sessionId = (result.details as { shell_session_id: string })
        .shell_session_id;
      const record = state.shells.get(sessionId);
      if (!record) throw new Error("missing permanently-stalled shell record");
      expect(result.error).toBeUndefined();
      expect(result.producedFiles).toBeUndefined();
      expect(record.producedFilesCollection).toBeDefined();

      await expect
        .poll(() => record.producedFilesCollection, {
          timeout: PRODUCED_FILE_COLLECTION_ATTEMPT_MS + 2_000,
          interval: 25,
        })
        .toBeUndefined();
      expect(record.startSnapshot?.complete).toBe(true);

      const recovered = await drainCompletedProducedFiles(state, null, [
        sessionId,
      ]);
      expect(recovered.files).toContainEqual({
        path: artifactPath,
        kind: { type: "add" },
      });
      expect(
        recovered.files.filter((file) => file.path === artifactPath),
      ).toHaveLength(1);
      expect(
        (await drainCompletedProducedFiles(state, null, [sessionId])).files,
      ).toEqual([]);
    },
    PRODUCED_FILE_COLLECTION_ATTEMPT_MS + 10_000,
  );

  it("bounds a stalled write completion snapshot by the interaction deadline", async () => {
    const root = createTempDir();
    const artifactPath = path.join(root, "deadline.txt");
    let markCompletionStarted!: () => void;
    const completionStarted = new Promise<void>((resolve) => {
      markCompletionStarted = resolve;
    });
    let releaseCompletion!: (entries: unknown[]) => void;
    const completionWalk = new Promise<unknown[]>((resolve) => {
      releaseCompletion = resolve;
    });
    mocks.readdir
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(() => {
        markCompletionStarted();
        return completionWalk as never;
      });
    const state = createShellState(root);
    const started = await handleExecCommand(state, {
      cmd: "read line; printf artifact > deadline.txt",
      workdir: root,
      yield_time_ms: 500,
    });
    const sessionId = (started.details as { session_id: string }).session_id;
    const record = state.shells.get(sessionId);
    if (!record) throw new Error("missing deadline-bounded shell record");

    const writeStartedAt = Date.now();
    const pendingWrite = handleWriteStdin(state, {
      session_id: sessionId,
      chars: "go\n",
      yield_time_ms: 250,
    });
    await completionStarted;
    const result = await pendingWrite;

    expect(Date.now() - writeStartedAt).toBeLessThan(1_000);
    expect(result.error).toBeUndefined();
    expect(record.pendingInteractions).toBe(0);
    expect(record.producedFilesReported).not.toBe(true);

    releaseCompletion([
      {
        name: "deadline.txt",
        isDirectory: () => false,
        isFile: () => true,
      },
    ]);
    const recovered = await drainCompletedProducedFiles(state, null, [
      sessionId,
    ]);
    expect(recovered.files).toEqual([
      { path: artifactPath, kind: { type: "add" } },
    ]);
    expect(
      (await drainCompletedProducedFiles(state, null, [sessionId])).files,
    ).toEqual([]);
  });

  it("aborts a stalled write completion snapshot, releases its lease, and preserves later delivery", async () => {
    const root = createTempDir();
    const artifactPath = path.join(root, "interactive.txt");
    let markCompletionStarted!: () => void;
    const completionStarted = new Promise<void>((resolve) => {
      markCompletionStarted = resolve;
    });
    let releaseCompletion!: (entries: unknown[]) => void;
    const completionWalk = new Promise<unknown[]>((resolve) => {
      releaseCompletion = resolve;
    });
    mocks.readdir
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(() => {
        markCompletionStarted();
        return completionWalk as never;
      });
    const state = createShellState(root);
    const started = await handleExecCommand(state, {
      cmd: "read line; printf artifact > interactive.txt",
      workdir: root,
      yield_time_ms: 500,
    });
    const sessionId = (started.details as { session_id: string }).session_id;
    const record = state.shells.get(sessionId);
    if (!record) throw new Error("missing completion-snapshot shell record");

    const controller = new AbortController();
    const pendingWrite = handleWriteStdin(
      state,
      {
        session_id: sessionId,
        chars: "go\n",
        yield_time_ms: 1_000,
      },
      undefined,
      controller.signal,
    );
    await completionStarted;
    const abortedAt = Date.now();
    controller.abort(new Error("cancel completion snapshot"));
    const aborted = await pendingWrite;

    expect(Date.now() - abortedAt).toBeLessThan(500);
    expect(aborted.error).toContain("cancel completion snapshot");
    expect(record.pendingInteractions).toBe(0);
    expect(record.activeInteractionSequence).toBeNull();
    expect(record.activeInteractionReceipt).toBeUndefined();
    expect(record.producedFilesReported).not.toBe(true);
    await expect(record.interactionTail).resolves.toBeUndefined();

    releaseCompletion([
      {
        name: "interactive.txt",
        isDirectory: () => false,
        isFile: () => true,
      },
    ]);
    const recovered = await handleWriteStdin(state, {
      session_id: sessionId,
      operation: "poll",
      yield_time_ms: 1_000,
    });
    expect(recovered.error).toBeUndefined();
    expect(recovered.details).toMatchObject({ interaction_sequence: 3 });
    expect(recovered.producedFiles).toEqual([
      { path: artifactPath, kind: { type: "add" } },
    ]);
    expect(
      (await drainCompletedProducedFiles(state, null, [sessionId])).files,
    ).toEqual([]);
  });
});
