import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NO_JS_SANDBOX_MESSAGE,
  NO_WORKSPACE_ATTACHED_MESSAGE,
} from "../src/general-agent-tools.js";
import { allocateWorkerdInspectorPort } from "./helpers/workerd-test-port.js";

const packageRoot = new URL("..", import.meta.url);
const port = 20_000 + Math.floor(Math.random() * 1_000);
const origin = `http://127.0.0.1:${port}`;
const wiredPort = port + 1_000;
const wiredOrigin = `http://127.0.0.1:${wiredPort}`;

const pause = async (delayMs: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};

const requestJsonFrom = async (
  base: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, any> }> => {
  const response = await fetch(`${base}${path}`, {
    method: body ? "POST" : "GET",
    ...(body
      ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>,
  };
};

const requestJson = async (
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, any> }> =>
  await requestJsonFrom(origin, path, body);

const spawnWorkerd = async (
  config: string,
  listenPort: number,
  persistTo: string,
  observe: (chunk: unknown) => void,
): Promise<ChildProcess> => {
  const inspectorPort = await allocateWorkerdInspectorPort();
  const child = spawn(
    process.execPath,
    [
      "x",
      "wrangler",
      "dev",
      "--config",
      config,
      "--ip",
      "127.0.0.1",
      "--port",
      String(listenPort),
      "--local",
      "--persist-to",
      persistTo,
      "--inspector-port",
      String(inspectorPort),
      "--show-interactive-dev-session=false",
    ],
    { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout?.on("data", observe);
  child.stderr?.on("data", observe);
  return child;
};

const awaitReady = async (
  child: ChildProcess,
  base: string,
  describeOutput: () => string,
): Promise<void> => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler exited before readiness:\n${describeOutput()}`);
    }
    try {
      const response = await fetch(`${base}/`);
      if (response.ok) return;
    } catch {
      // Workerd is still starting.
    }
    await pause(50);
  }
  throw new Error(`workerd did not become ready:\n${describeOutput()}`);
};

const stopChild = async (child: ChildProcess | null): Promise<void> => {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), pause(5_000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
};

describe("resident general-agent turn in workerd", () => {
  let persistencePath = "";
  let workerd: ChildProcess | null = null;
  let workerdOutput = "";

  const startWorkerd = async (): Promise<void> => {
    workerdOutput = "";
    const child = await spawnWorkerd(
      "tests/fixtures/general-agent-resident-workerd.wrangler.jsonc",
      port,
      persistencePath,
      (chunk) => {
        workerdOutput += String(chunk);
      },
    );
    workerd = child;
    await awaitReady(child, origin, () => workerdOutput);
  };

  const stopWorkerd = async (): Promise<void> => {
    const child = workerd;
    workerd = null;
    await stopChild(child);
  };

  beforeAll(async () => {
    persistencePath = await mkdtemp(
      join(tmpdir(), "stella-resident-turn-workerd-"),
    );
    await startWorkerd();
  });

  afterAll(async () => {
    try {
      await stopWorkerd();
    } finally {
      if (persistencePath.includes("stella-resident-turn-workerd-")) {
        await rm(persistencePath, { recursive: true, force: true });
      }
    }
  });

  test("registers provider adapters in a cold resident host without an orchestrator import", async () => {
    const response = await requestJson("/providers");
    expect(response.status).toBe(200);
    expect(response.body.providers).toEqual(
      [
        "anthropic-messages",
        "openai-completions",
        "openai-responses",
        "openai-codex-responses",
      ].map((api) => ({
        api,
        stream: "function",
        streamSimple: "function",
      })),
    );
  });

  test("completes a scripted resident turn against real Durable Object SQL", async () => {
    const turn = await requestJson("/turn", { script: "text" });

    expect(turn.status).toBe(200);
    expect(turn.body.result).toMatchObject({
      outcome: "completed",
      ok: true,
      finalText: "We decided to ship the ladder.",
      compute: { kind: "resident" },
      usage: { inputTokens: 13, outputTokens: 4, llmCalls: 1 },
      durability: { kind: "transcript_only" },
    });
    expect(
      turn.body.transcript.rows.map((row: { role: string }) => row.role),
    ).toEqual(["user", "assistant"]);
    expect(turn.body.result.durability.transcript.historyCursor).toBe(
      turn.body.transcript.historyCursor,
    );
    expect(turn.body.residualJournalRows).toBe(0);
    expect(turn.body.toolNames).toEqual([
      "exec_command",
      "write_stdin",
      "apply_patch",
      "web",
      "Read",
      "Write",
      "Edit",
      "Grep",
      "code",
      "spawn_agent",
      "send_input",
      "pause_agent",
      "agent_status",
      "merge_workspace",
    ]);
  }, 90_000);

  test("refuses a container tool without attaching a workspace", async () => {
    const turn = await requestJson("/turn", { script: "container_tool" });

    expect(turn.status).toBe(200);
    expect(turn.body.result.outcome).toBe("completed");
    const rows = turn.body.transcript.rows as {
      role: string;
      payloadJson: string;
    }[];
    expect(rows.map((row) => row.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(rows[2]?.payloadJson).toContain(NO_WORKSPACE_ATTACHED_MESSAGE);
  }, 90_000);

  test("runs code in a Dynamic Worker without attaching a workspace", async () => {
    const turn = await requestJson("/turn", { script: "code_tool" });

    expect(turn.status).toBe(200);
    expect(turn.body.result.outcome).toBe("completed");
    const rows = turn.body.transcript.rows as {
      role: string;
      payloadJson: string;
    }[];
    expect(rows.map((row) => row.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    // The value came back from the isolate, which has no Node globals, and
    // neither refusal reached the transcript.
    expect(rows[2]?.payloadJson).toContain("CL-RESIDENT-CODE-42");
    expect(rows[2]?.payloadJson).toMatch(/hasProcess\\?":\s*false/u);
    expect(rows[2]?.payloadJson).not.toContain(NO_WORKSPACE_ATTACHED_MESSAGE);
    expect(rows[2]?.payloadJson).not.toContain(NO_JS_SANDBOX_MESSAGE);
  }, 90_000);

  test("places a Stella turn resident and demotes it under the kill switch", async () => {
    const plan = await requestJson("/plan");

    expect(plan.body.resident).toEqual({
      kind: "resident_stella",
      execution: {
        engine: "stella",
        provider: "stella",
        model: "stella/resident-workerd",
        reasoningEffort: "default",
      },
    });
    expect(plan.body.disabled).toMatchObject({
      kind: "native_sandbox",
      reason: "resident_disabled",
    });
  }, 30_000);

  test("keeps journaled rows across an isolate restart", async () => {
    const appended = await requestJson("/journal/append", {});
    expect(appended.body.rowCount).toBe(1);

    await stopWorkerd();
    await startWorkerd();

    const staged = await requestJson("/journal/staged");
    expect(staged.body.sealed).toBe(false);
    expect(staged.body.rows).toHaveLength(1);
    expect(staged.body.rows[0]).toMatchObject({ ordinal: 0, role: "user" });
    expect(staged.body.rows[0].payloadJson).toContain(
      "staged before the restart",
    );
  }, 120_000);
});

describe("wired resident general-agent turn in workerd", () => {
  let persistencePath = "";
  let workerd: ChildProcess | null = null;
  let output = "";

  beforeAll(async () => {
    persistencePath = await mkdtemp(
      join(tmpdir(), "stella-wired-turn-workerd-"),
    );
    workerd = await spawnWorkerd(
      "tests/fixtures/general-agent-wired-workerd.wrangler.jsonc",
      wiredPort,
      persistencePath,
      (chunk) => {
        output += String(chunk);
      },
    );
    await awaitReady(workerd, wiredOrigin, () => output);
  });

  afterAll(async () => {
    try {
      await stopChild(workerd);
    } finally {
      workerd = null;
      if (persistencePath.includes("stella-wired-turn-workerd-")) {
        await rm(persistencePath, { recursive: true, force: true });
      }
    }
  });

  test("admits and runs a stella turn resident without asking for a container", async () => {
    const wired = await requestJsonFrom(wiredOrigin, "/wired");

    expect(wired.status).toBe(200);
    expect(wired.body.acceptedStatus).toBe(202);
    expect(wired.body.sandboxCalls).toBe(0);
    expect(wired.body.nativeDispatches).toBe(0);
    expect(wired.body.residentDispatches).toBe(1);
    expect(wired.body.turnError).toBeNull();
    expect(wired.body.reservedSandboxId).toBeNull();
    expect(wired.body.plan).toMatchObject({
      plan: { kind: "resident_stella" },
      engine: "stella",
      residentDisabled: false,
    });
    expect(
      wired.body.transcript.rows.map((row: { role: string }) => row.role),
    ).toEqual(["user", "assistant"]);
    expect(wired.body.residualJournalRows).toBe(0);
  }, 120_000);
});
