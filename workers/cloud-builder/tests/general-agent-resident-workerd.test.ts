import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_WORKSPACE_ATTACHED_MESSAGE } from "../src/general-agent-tools.js";

const packageRoot = new URL("..", import.meta.url);
const port = 20_000 + Math.floor(Math.random() * 1_000);
const origin = `http://127.0.0.1:${port}`;

const pause = async (delayMs: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};

const requestJson = async (
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, any> }> => {
  const response = await fetch(`${origin}${path}`, {
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

describe("resident general-agent turn in workerd", () => {
  let persistencePath = "";
  let workerd: ChildProcess | null = null;
  let workerdOutput = "";

  const startWorkerd = async (): Promise<void> => {
    workerdOutput = "";
    const child = spawn(
      process.execPath,
      [
        "x",
        "wrangler",
        "dev",
        "--config",
        "tests/fixtures/general-agent-resident-workerd.wrangler.jsonc",
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--local",
        "--persist-to",
        persistencePath,
        "--show-interactive-dev-session=false",
      ],
      { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    workerd = child;
    const observe = (chunk: unknown): void => {
      workerdOutput += String(chunk);
    };
    child.stdout?.on("data", observe);
    child.stderr?.on("data", observe);

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`wrangler exited before readiness:\n${workerdOutput}`);
      }
      try {
        const response = await fetch(`${origin}/`);
        if (response.ok) return;
      } catch {
        // Workerd is still starting.
      }
      await pause(50);
    }
    throw new Error(`workerd did not become ready:\n${workerdOutput}`);
  };

  const stopWorkerd = async (): Promise<void> => {
    const child = workerd;
    workerd = null;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), pause(5_000)]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  };

  beforeAll(async () => {
    persistencePath = await mkdtemp(
      join(tmpdir(), "stella-resident-turn-workerd-"),
    );
    await startWorkerd();
  });

  afterAll(async () => {
    await stopWorkerd();
    if (persistencePath.includes("stella-resident-turn-workerd-")) {
      await rm(persistencePath, { recursive: true, force: true });
    }
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
    expect(turn.body.transcript.rows.map((row: { role: string }) => row.role)).toEqual([
      "user",
      "assistant",
    ]);
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
      "code",
      "publish_stella_interior",
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
