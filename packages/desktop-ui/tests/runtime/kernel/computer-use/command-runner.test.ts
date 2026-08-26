import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createInProcessComputerCommandRunner,
  runComputerCommandSubprocess,
  type ComputerCommandRequest,
} from "@stella/runtime/kernel/computer-use/command-runner";
import { createCliDiagnosticsComputerUseSession } from "@stella/runtime/kernel/computer-use/cli-diagnostics-session";
import type { ComputerUseRequest } from "@stella/runtime/kernel/computer-use/contract";
import { executeComputerUseRequest } from "@stella/runtime/kernel/computer-use/session";

describe("computer command runner", () => {
  it("terminates commands whose combined output exceeds the configured bound", async () => {
    await expect(
      runComputerCommandSubprocess({
        command: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(4096))"],
        cwd: process.cwd(),
        timeoutMs: 2_000,
        maxOutputBytes: 1_024,
      }),
    ).rejects.toThrow("output exceeded the 1024-byte limit");
  });

  it("routes process.execPath-shaped requests directly to the shared executor", async () => {
    const executor = vi.fn(async () => ({
      exitCode: 0,
      stdout: "direct\n",
      stderr: "",
    }));
    const runner = createInProcessComputerCommandRunner(executor);

    await expect(
      runner({
        command: process.execPath,
        args: [
          "/runtime/stella-computer.js",
          "--session",
          "session-1",
          "list-apps",
        ],
        cwd: "/workspace",
        env: { STELLA_DATA_DIR: "/data" },
        timeoutMs: 2_000,
        maxOutputBytes: 1_024,
      }),
    ).resolves.toEqual({ exitCode: 0, stdout: "direct\n", stderr: "" });

    expect(executor).toHaveBeenCalledOnce();
    expect(executor).toHaveBeenCalledWith(
      ["--session", "session-1", "list-apps"],
      expect.objectContaining({
        cwd: "/workspace",
        env: { STELLA_DATA_DIR: "/data" },
        timeoutMs: 2_000,
        maxOutputBytes: 1_024,
      }),
    );
  });

  it("rejects arbitrary executables instead of treating them as CLI argv", async () => {
    const runner = createInProcessComputerCommandRunner(vi.fn());
    await expect(
      runner({
        command: "/bin/sh",
        args: ["-c", "true"],
        cwd: "/workspace",
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow("only accepts process.execPath");
  });

  it("keeps typed-to-argv translation in the explicit CLI diagnostics adapter", async () => {
    const commands: ComputerCommandRequest[] = [];
    const root = mkdtempSync(path.join(os.tmpdir(), "cli-diagnostics-action-"));
    const screenshotPath = path.join(root, "state.png");
    writeFileSync(screenshotPath, "stable visual bytes");
    const runner = vi.fn(async (request: ComputerCommandRequest) => {
      commands.push(request);
      if (request.args.includes("shutdown-session")) {
        return { exitCode: 0, stdout: '{"ok":true}', stderr: "" };
      }
      if (request.args.includes("get-state")) {
        return {
          exitCode: 0,
          stdout: `<app_state>fresh ids</app_state>\n[stella-attach-image] path=${JSON.stringify(screenshotPath)}`,
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout: '{"ok":true,"deferred":true}',
        stderr: "",
      };
    });
    const session = createCliDiagnosticsComputerUseSession({
      cliPath: "/runtime/stella-computer.js",
      cwd: "/workspace",
      runner,
    });
    const baseline = await executeComputerUseRequest(session, {
      schemaVersion: 2,
      protocolVersion: "2.0",
      requestId: "request-baseline",
      sessionId: "session-1",
      type: "get_app_state",
      target: { type: "app", app: "Notes" },
      screenshotPolicy: "always",
      disableDiff: true,
    });
    const request = {
      schemaVersion: 2,
      protocolVersion: "2.0",
      requestId: "request-1",
      sessionId: "session-1",
      type: "action",
      execution: "background",
      command: {
        target: { type: "app", app: "Notes" },
        observedStateId: baseline.state.semanticStateId!,
        observedVisualStateId: baseline.state.visualStateId!,
        action: { type: "press_key", key: "ENTER" },
      },
    } as const satisfies ComputerUseRequest;

    await expect(
      executeComputerUseRequest(session, request),
    ).resolves.toMatchObject({
      receipt: { action: "press_key", deferred: true },
    });
    expect(commands).toHaveLength(4);
    expect(commands[1]?.args[2]).toMatch(/^diagnostics-action-/);
    expect(commands[1]?.args).toContain("--disable-diff");
    expect(commands[2]?.args).toContain("shutdown-session");
    expect(commands[3]?.args).toEqual([
      "/runtime/stella-computer.js",
      "--session",
      "session-1",
      "press",
      "ENTER",
      "--app",
      "Notes",
      "--allow-hid",
      "--observed-state-id",
      baseline.state.semanticStateId!,
      "--observed-visual-state-id",
      baseline.state.visualStateId!,
      "--defer-observation",
      "--json",
    ]);
    expect(commands[3]?.args).not.toContain("--raise");
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects stale action provenance before dispatch and tears down validation", async () => {
    const commands: ComputerCommandRequest[] = [];
    let stateReads = 0;
    const runner = vi.fn(async (request: ComputerCommandRequest) => {
      commands.push(request);
      if (request.args.includes("shutdown-session")) {
        return { exitCode: 0, stdout: '{"ok":true}', stderr: "" };
      }
      if (request.args.includes("get-state")) {
        stateReads += 1;
        return {
          exitCode: 0,
          stdout:
            stateReads === 1
              ? "<app_state>before</app_state>"
              : "<app_state>changed outside diagnostics</app_state>",
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: '{"ok":true}', stderr: "" };
    });
    const session = createCliDiagnosticsComputerUseSession({
      cwd: "/workspace",
      runner,
    });
    const baseline = await executeComputerUseRequest(session, {
      schemaVersion: 2,
      protocolVersion: "2.0",
      requestId: "stale-baseline",
      sessionId: "stale-action-session",
      type: "get_app_state",
      target: { type: "app", app: "Notes" },
      screenshotPolicy: "never",
      disableDiff: true,
    });

    await expect(
      session.request({
        schemaVersion: 2,
        protocolVersion: "2.0",
        requestId: "stale-action",
        sessionId: "stale-action-session",
        type: "action",
        execution: "background",
        command: {
          target: { type: "app", app: "Notes" },
          observedStateId: baseline.state.semanticStateId!,
          action: {
            type: "click_element",
            elementId: "1",
            mouseButton: "left",
            clickCount: 1,
          },
        },
      }),
    ).resolves.toMatchObject({
      type: "error",
      error: { code: "stale_observation", retryable: true },
    });
    expect(commands).toHaveLength(3);
    expect(commands[2]?.args).toContain("shutdown-session");
    expect(commands.some((command) => command.args.includes("click"))).toBe(
      false,
    );
  });

  it("confines legacy state marker parsing to the CLI diagnostics adapter", async () => {
    const runner = vi.fn(async () => ({
      exitCode: 0,
      stdout: [
        "<app_specific_instructions>",
        "Use Save.",
        "</app_specific_instructions>",
        "<app_state>fresh ids</app_state>",
        `[stella-attach-image] path=${JSON.stringify("/tmp/state image.png")}`,
      ].join("\n"),
      stderr: "",
    }));
    const session = createCliDiagnosticsComputerUseSession({
      cwd: "/workspace",
      runner,
    });
    const request = {
      schemaVersion: 2,
      protocolVersion: "2.0",
      requestId: "request-state",
      sessionId: "session-1",
      type: "get_app_state",
      target: { type: "app", app: "Notes" },
      screenshotPolicy: "always",
      disableDiff: true,
    } as const satisfies ComputerUseRequest;

    await expect(executeComputerUseRequest(session, request)).resolves.toEqual(
      expect.objectContaining({
        type: "app_state",
        state: expect.objectContaining({
          app: "Notes",
          text: "<app_state>fresh ids</app_state>",
          instructions: "Use Save.",
          stateId: expect.stringMatching(/^state_[a-f0-9]{20}$/),
          representation: "full",
          screenshot: {
            type: "image",
            url: "file:///tmp/state%20image.png",
          },
        }),
      }),
    );
  });

  it("keeps semantic identity stable across revision and screenshot metadata", async () => {
    let reads = 0;
    const runner = vi.fn(async () => {
      reads += 1;
      return {
        exitCode: 0,
        stdout: [
          "<app_state>",
          "App=com.example.Notes (pid 42)",
          `State revision: ${reads} (materialized ${reads}, cache_hit=${reads > 1 ? "true" : "false"}, pending_actions=${reads - 1}).`,
          `Screenshot context: method=${reads > 1 ? "cached" : "window"}, reliable_final_frame=true, exact_window=true.`,
          "0 standard window Notes",
          "\t1 text unchanged",
          "</app_state>",
        ].join("\n"),
        stderr: "",
      };
    });
    const session = createCliDiagnosticsComputerUseSession({
      cwd: "/workspace",
      runner,
    });
    const stateRequest = {
      schemaVersion: 2,
      protocolVersion: "2.0",
      requestId: "stable-one",
      sessionId: "stable-session",
      type: "get_app_state",
      target: { type: "app", app: "Notes" },
      screenshotPolicy: "never",
      disableDiff: true,
    } as const satisfies ComputerUseRequest;

    const first = await executeComputerUseRequest(session, stateRequest);
    const second = await executeComputerUseRequest(session, {
      ...stateRequest,
      requestId: "stable-two",
    });

    expect(second.state.semanticStateId).toBe(first.state.semanticStateId);
    expect(second.state.text).not.toBe(first.state.text);
  });

  it("waits through an isolated CLI session and keeps the final diff anchored to the original baseline", async () => {
    const commands: ComputerCommandRequest[] = [];
    const outputs = [
      "<app_state>before</app_state>",
      "<app_state>after</app_state>",
      '<app_state_diff status="changed">after</app_state_diff>',
    ];
    const runner = vi.fn(async (request: ComputerCommandRequest) => {
      commands.push(request);
      if (request.args.includes("shutdown-session")) {
        return { exitCode: 0, stdout: '{"ok":true}', stderr: "" };
      }
      return { exitCode: 0, stdout: outputs.shift() ?? "", stderr: "" };
    });
    const session = createCliDiagnosticsComputerUseSession({
      cwd: "/workspace",
      runner,
    });
    const baselineRequest = {
      schemaVersion: 2,
      protocolVersion: "2.0",
      requestId: "request-baseline",
      sessionId: "session-wait",
      type: "get_app_state",
      target: { type: "app", app: "Notes" },
      screenshotPolicy: "never",
      disableDiff: false,
    } as const satisfies ComputerUseRequest;
    const baseline = await executeComputerUseRequest(session, baselineRequest);
    const afterStateId = baseline.state.semanticStateId!;
    const waitRequest = {
      schemaVersion: 2,
      protocolVersion: "2.0",
      requestId: "request-wait",
      sessionId: "session-wait",
      type: "wait_for_change",
      target: { type: "app", app: "Notes" },
      afterStateId,
      timeoutMs: 2_000,
      screenshotPolicy: "never",
      disableDiff: false,
    } as const satisfies ComputerUseRequest;

    await expect(
      executeComputerUseRequest(session, waitRequest),
    ).resolves.toMatchObject({
      type: "wait_for_change",
      state: {
        semanticStateId: expect.stringMatching(/^state_[a-f0-9]{20}$/),
        representation: "diff",
        baseStateId: afterStateId,
        wait: {
          afterStateId,
          timeoutMs: 2_000,
          pollCount: 1,
          changeKinds: ["semantic"],
        },
      },
    });
    expect(commands).toHaveLength(4);
    expect(commands[1]?.args[2]).toMatch(/^diagnostics-wait-/);
    expect(commands[1]?.args).toContain("--disable-diff");
    expect(commands[2]?.args.slice(1, 3)).toEqual([
      "--session",
      "session-wait",
    ]);
    expect(commands[2]?.args).not.toContain("--disable-diff");
    expect(commands[3]?.args).toContain("shutdown-session");
  });

  it("returns a retryable protocol-v2 wait_timeout with polling provenance", async () => {
    const runner = vi.fn(async () => ({
      exitCode: 0,
      stdout: "<app_state>unchanged</app_state>",
      stderr: "",
    }));
    const session = createCliDiagnosticsComputerUseSession({
      cwd: "/workspace",
      runner,
    });
    const baselineRequest = {
      schemaVersion: 2,
      protocolVersion: "2.0",
      requestId: "request-timeout-baseline",
      sessionId: "session-timeout",
      type: "get_app_state",
      target: { type: "app", app: "Notes" },
      screenshotPolicy: "never",
      disableDiff: true,
    } as const satisfies ComputerUseRequest;
    const baseline = await executeComputerUseRequest(session, baselineRequest);
    const afterStateId = baseline.state.semanticStateId!;
    const waitRequest = {
      schemaVersion: 2,
      protocolVersion: "2.0",
      requestId: "request-timeout",
      sessionId: "session-timeout",
      type: "wait_for_change",
      target: { type: "app", app: "Notes" },
      afterStateId,
      timeoutMs: 5,
      screenshotPolicy: "never",
      disableDiff: true,
    } as const satisfies ComputerUseRequest;

    await expect(session.request(waitRequest)).resolves.toMatchObject({
      schemaVersion: 2,
      protocolVersion: "2.0",
      type: "error",
      error: {
        code: "wait_timeout",
        retryable: true,
        details: {
          timeoutMs: 5,
          afterStateId,
          pollCount: 1,
        },
      },
    });
  });

  it("rejects a wait whose semantic or visual baseline is stale", async () => {
    const runner = vi.fn(async () => ({
      exitCode: 0,
      stdout: "<app_state>baseline</app_state>",
      stderr: "",
    }));
    const session = createCliDiagnosticsComputerUseSession({
      cwd: "/workspace",
      runner,
    });
    const baseline = await executeComputerUseRequest(session, {
      schemaVersion: 2,
      protocolVersion: "2.0",
      requestId: "request-stale-baseline",
      sessionId: "session-stale",
      type: "get_app_state",
      target: { type: "app", app: "Notes" },
      screenshotPolicy: "never",
      disableDiff: true,
    });
    const staleWait = {
      schemaVersion: 2,
      protocolVersion: "2.0",
      requestId: "request-stale",
      sessionId: "session-stale",
      type: "wait_for_change",
      target: { type: "app", app: "Notes" },
      afterStateId: "state_stale",
      timeoutMs: 1_000,
      screenshotPolicy: "never",
      disableDiff: true,
    } as const satisfies ComputerUseRequest;

    await expect(session.request(staleWait)).resolves.toMatchObject({
      type: "error",
      error: {
        code: "stale_observation",
        retryable: true,
        details: {
          observedStateId: "state_stale",
          currentStateId: expect.stringMatching(/^state_[a-f0-9]{20}$/),
        },
      },
    });
    await expect(
      session.request({
        ...staleWait,
        requestId: "request-stale-visual",
        afterStateId: baseline.state.semanticStateId!,
        afterVisualStateId: "visual_stale",
      }),
    ).resolves.toMatchObject({
      type: "error",
      error: {
        code: "stale_observation",
        retryable: true,
        details: {
          observedStateId: "visual_stale",
          currentStateId: "visual_state_missing",
        },
      },
    });
    expect(runner).toHaveBeenCalledOnce();
  });
});
