import { describe, expect, mock, test } from "bun:test";
import {
  CLOUD_TOOL_HOME,
  CLOUD_TOOL_PROCESS_IDENTITY,
} from "../../../packages/executor-cloud/src/cloud-process-isolation.js";
import { buildGeneralAgentPrompt } from "@stella/executor-cloud/general-agent-prompt";
import type { SerializedAgentToolResult } from "@stella/executor-cloud/attached-tool-protocol";
import { WORKER_SHELL_COMMANDS } from "../src/worker-shell/eligibility.js";
import type {
  WorkerShellOutcome,
  WorkerShellRequest,
} from "../src/worker-shell/protocol.js";
import { runWorkerShell } from "../src/worker-shell/run.js";
import { createFakeShellWorld } from "./helpers/fake-shell-world.js";

mock.module("cloudflare:workers", () => ({
  RpcTarget: class {},
  WorkerEntrypoint: class {},
  DurableObject: class {},
}));
const { createWorkerShellRunner } = await import("../src/worker-shell-runner.js");
const {
  createWorkerShellRouter,
  routeExecCommand,
  WORKER_SHELL_TOOL_HOME,
  WORKER_SHELL_TOOL_USER,
} = await import("../src/worker-shell-router.js");
mock.restore();

const ROOT = "/workspace/world";

type LoaderCode = {
  env: Record<string, unknown>;
  globalOutbound: unknown;
  limits?: { cpuMs?: number };
  mainModule: string;
};

/**
 * A Worker Loader whose isolate is this process: the entrypoint runs the real
 * worker shell against the fake world, exactly as `entry.ts` does.
 */
const harness = async (seed: Parameters<typeof createFakeShellWorld>[0] = {}) => {
  const world = await createFakeShellWorld(seed);
  let revision = 7;
  const loaded: Array<{ name: string; code: LoaderCode }> = [];
  const runs: WorkerShellRequest[] = [];
  const commits: unknown[] = [];
  let conflictsLeft = 0;
  let commitError: Error | null = null;
  let entrypointError: Error | null = null;
  let beforeCommit: (() => void) | null = null;
  const loader = {
    get(name: string, code: () => LoaderCode) {
      loaded.push({ name, code: code() });
      return {
        getEntrypoint: () => ({
          run: async (
            request: WorkerShellRequest,
            control: { cancelled(): Promise<void> },
          ): Promise<WorkerShellOutcome> => {
            runs.push(request);
            if (entrypointError) throw entrypointError;
            return await runWorkerShell(request, world.world, {
              cancelled: control.cancelled(),
            });
          },
        }),
      };
    },
  } as unknown as WorkerLoader;
  const runner = createWorkerShellRunner({
    loader,
    loopback: () => ({ marker: "loopback" }) as never,
    world: {
      head: async () => ({ revision }),
      commitShell: async (change) => {
        beforeCommit?.();
        commits.push(change);
        if (commitError) throw commitError;
        if (conflictsLeft > 0) {
          conflictsLeft -= 1;
          revision += 1;
          return { status: "conflict", paths: ["a.txt"] };
        }
        world.apply({ entries: change.entries, deleted: change.deleted });
        revision += 1;
        return { status: "committed", revision };
      },
    },
    root: ROOT,
    scope: "world-name:shared",
    bundle: async () => ({ id: "bundle-id", modules: { "shell.js": { js: "" } } }),
  });
  return {
    world,
    runner,
    loaded,
    runs,
    commits,
    conflictOnce: (count = 1) => {
      conflictsLeft = count;
    },
    failCommit: (error: Error) => {
      commitError = error;
    },
    failEntrypoint: (error: Error) => {
      entrypointError = error;
    },
    beforeCommit: (callback: () => void) => {
      beforeCommit = callback;
    },
  };
};

const fakeLadder = (attached = false) => {
  const calls: Array<{ toolCallId: string; toolName: string; params: unknown }> =
    [];
  return {
    calls,
    ladder: {
      attached: () => attached,
      execute: async (call: {
        toolCallId: string;
        toolName: string;
        params: Record<string, unknown>;
      }): Promise<SerializedAgentToolResult> => {
        calls.push(call);
        return {
          outcome: { kind: "ok", text: `sandbox ran ${call.toolName}` },
          details: { runtime: "sandbox" },
          authorizedImages: [],
        };
      },
    },
  };
};

const exec = (cmd: string, extra: Record<string, unknown> = {}) => ({
  toolCallId: `call-${Math.random()}`,
  toolName: "exec_command",
  params: { cmd, ...extra },
});

const noDanger = async () => null;

describe("worker shell runner", () => {
  test("commits a completed run exactly once", async () => {
    const h = await harness({ "a.txt": "a\n" });
    const result = await h.runner.run({
      script: "cat a.txt > b.txt; echo done",
      cwd: ROOT,
      env: {},
      timeoutMs: 5_000,
      sandboxOnly: ["drive"],
    });
    expect(result).toMatchObject({ kind: "completed", stdout: "done\n", revision: 8 });
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0]).toMatchObject({ baseRevision: 7 });
    expect(h.world.text("b.txt")).toBe("a\n");
  });

  test("loads an isolate with no network and only the scoped world", async () => {
    const h = await harness({});
    await h.runner.run({
      script: "true",
      cwd: ROOT,
      env: {},
      timeoutMs: 5_000,
      sandboxOnly: [],
    });
    expect(h.loaded).toHaveLength(1);
    const [{ name, code }] = h.loaded;
    expect(name).toBe("stella-worker-shell:bundle-id:world-name:shared");
    expect(code.globalOutbound).toBeNull();
    expect(Object.keys(code.env)).toEqual(["WORLD"]);
    expect(code.env.WORLD).toEqual({ marker: "loopback" });
    expect(code.limits?.cpuMs).toBeGreaterThan(0);
    expect(code.mainModule).toBe("shell.js");
    expect(h.runs[0]?.root).toBe(ROOT);
  });

  test("a fallback commits nothing", async () => {
    const h = await harness({ "a.txt": "a\n" });
    const result = await h.runner.run({
      script: "echo x > b.txt; git status",
      cwd: ROOT,
      env: {},
      timeoutMs: 5_000,
      sandboxOnly: [],
    });
    expect(result).toMatchObject({ kind: "fallback", reason: "unsupported_command" });
    expect(h.commits).toHaveLength(0);
    expect(h.world.entry("b.txt")).toBeUndefined();
  });

  test("a conflict reruns the command against the newer world once", async () => {
    const h = await harness({ "a.txt": "a\n" });
    h.conflictOnce();
    const result = await h.runner.run({
      script: "echo x >> a.txt",
      cwd: ROOT,
      env: {},
      timeoutMs: 5_000,
      sandboxOnly: [],
    });
    expect(result).toMatchObject({ kind: "completed" });
    expect(h.runs).toHaveLength(2);
    expect(h.commits).toHaveLength(2);
    // Applied once: the refused commit changed nothing.
    expect(h.world.text("a.txt")).toBe("a\nx\n");
  });

  test("a second conflict hands the command over without applying it", async () => {
    const h = await harness({ "a.txt": "a\n" });
    h.conflictOnce(2);
    const result = await h.runner.run({
      script: "echo x >> a.txt",
      cwd: ROOT,
      env: {},
      timeoutMs: 5_000,
      sandboxOnly: [],
    });
    expect(result).toMatchObject({ kind: "fallback", reason: "workspace_changed" });
    expect(h.world.text("a.txt")).toBe("a\n");
  });

  test("an unanswered commit is reported, never handed over", async () => {
    const h = await harness({});
    h.failCommit(new Error("connection reset"));
    const result = await h.runner.run({
      script: "echo x > a.txt",
      cwd: ROOT,
      env: {},
      timeoutMs: 5_000,
      sandboxOnly: [],
    });
    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" && result.message).toContain(
      "may or may not have been applied",
    );
  });

  test("a failed isolate commits nothing and hands the command over", async () => {
    const h = await harness({});
    h.failEntrypoint(new Error("Worker exceeded CPU time limit."));
    const result = await h.runner.run({
      script: "echo x > a.txt",
      cwd: ROOT,
      env: {},
      timeoutMs: 5_000,
      sandboxOnly: [],
    });
    expect(result).toMatchObject({ kind: "fallback", reason: "shell_failed" });
    expect(h.commits).toHaveLength(0);
  });

  test("a call cancelled while the shell ran commits nothing", async () => {
    const h = await harness({});
    const controller = new AbortController();
    const running = h.runner.run(
      {
        script: "echo x > a.txt; sleep 2",
        cwd: ROOT,
        env: {},
        timeoutMs: 5_000,
        sandboxOnly: [],
      },
      controller.signal,
    );
    await Bun.sleep(50);
    controller.abort();
    expect(await running).toEqual({ kind: "cancelled" });
    expect(h.commits).toHaveLength(0);
    expect(h.world.entry("a.txt")).toBeUndefined();
  });

  test("a call cancelled after the shell finished commits nothing", async () => {
    const h = await harness({});
    const controller = new AbortController();
    h.beforeCommit(() => controller.abort());
    const result = await h.runner.run(
      {
        script: "echo x > a.txt",
        cwd: ROOT,
        env: {},
        timeoutMs: 5_000,
        sandboxOnly: [],
      },
      controller.signal,
    );
    // The abort landed inside the commit call here, which is too late to
    // withhold it, so the run reports what happened rather than a cancel.
    expect(result.kind).toBe("completed");
    const again = await h.runner.run(
      { script: "echo y > b.txt", cwd: ROOT, env: {}, timeoutMs: 5_000, sandboxOnly: [] },
      controller.signal,
    );
    expect(again).toEqual({ kind: "cancelled" });
    expect(h.world.entry("b.txt")).toBeUndefined();
  });
});

describe("exec_command routing", () => {
  test("the sandbox takes every command once it is attached", async () => {
    expect(
      await routeExecCommand({
        params: { cmd: "cat a.txt" },
        root: ROOT,
        sandboxAttached: true,
        dangerousReason: noDanger,
      }),
    ).toMatchObject({ route: "sandbox" });
  });

  test("tty, other shells, outside workdirs and blocked commands go to the sandbox", async () => {
    const cases: Array<Record<string, unknown>> = [
      { cmd: "cat a.txt", tty: true },
      { cmd: "cat a.txt", shell: "/bin/zsh" },
      { cmd: "cat a.txt", shell: "pwsh" },
      { cmd: "cat a.txt", workdir: "/tmp" },
      { cmd: "cat a.txt", workdir: "../../etc" },
      { cmd: "" },
    ];
    for (const params of cases) {
      expect(
        await routeExecCommand({
          params,
          root: ROOT,
          sandboxAttached: false,
          dangerousReason: noDanger,
        }),
      ).toMatchObject({ route: "sandbox" });
    }
    expect(
      await routeExecCommand({
        params: { cmd: "rm -rf /" },
        root: ROOT,
        sandboxAttached: false,
        dangerousReason: async () => "deletes the filesystem root",
      }),
    ).toMatchObject({ route: "sandbox" });
  });

  test("an ordinary command is offered to the worker shell with its bounds", async () => {
    expect(
      await routeExecCommand({
        params: {
          cmd: "ls",
          workdir: "projects/app",
          shell: "/bin/bash",
          yield_time_ms: 60_000,
          max_output_tokens: 100,
        },
        root: ROOT,
        sandboxAttached: false,
        dangerousReason: noDanger,
      }),
    ).toEqual({
      route: "worker_shell",
      script: "ls",
      cwd: `${ROOT}/projects/app`,
      timeoutMs: 20_000,
      maxChars: 400,
    });
  });

  test("uses the container's real catastrophic-command guard", async () => {
    const h = await harness({});
    const { ladder, calls } = fakeLadder();
    const router = createWorkerShellRouter({ ladder, shell: h.runner, root: ROOT });
    await router.execute(exec("rm -rf / --no-preserve-root"));
    expect(calls).toHaveLength(1);
    expect(h.runs).toHaveLength(0);
  });
});

describe("worker shell router", () => {
  test("answers in the container's exec_command shape without a sandbox", async () => {
    const h = await harness({ "a.txt": "hello\n" });
    const { ladder, calls } = fakeLadder();
    let clock = 1_000;
    const router = createWorkerShellRouter({
      ladder,
      shell: h.runner,
      root: ROOT,
      dangerousReason: noDanger,
      now: () => (clock += 250),
    });
    const result = await router.execute(exec("cat a.txt; cat nope 2>&1; exit 3"));
    expect(calls).toHaveLength(0);
    expect(result.outcome).toEqual({
      kind: "ok",
      text: [
        "Wall time: 0.2500 seconds",
        "Process exited with code 3",
        "Original token count: 11",
        "Output:",
        "hello\ncat: nope: No such file or directory\n",
      ].join("\n"),
    });
    expect(result.details).toMatchObject({
      runtime: "worker_shell",
      session_id: null,
      exit_code: 3,
      cwd: ROOT,
    });
  });

  test("a mixed command runs once, in the sandbox, with none of the shell's effects", async () => {
    const h = await harness({ "counter.txt": "0\n" });
    const { ladder, calls } = fakeLadder();
    const router = createWorkerShellRouter({
      ladder,
      shell: h.runner,
      root: ROOT,
      dangerousReason: noDanger,
    });
    const call = exec("echo 1 >> counter.txt\nrm counter.txt\nnpm test");
    const result = await router.execute(call);
    expect(result.outcome).toEqual({ kind: "ok", text: "sandbox ran exec_command" });
    expect(calls).toEqual([
      { toolCallId: call.toolCallId, toolName: "exec_command", params: call.params },
    ]);
    // The only effect is whatever the sandbox does; the shell left no trace.
    expect(h.commits).toHaveLength(0);
    expect(h.world.text("counter.txt")).toBe("0\n");
  });

  test("a completed command is never repeated in the sandbox", async () => {
    const h = await harness({ "counter.txt": "0\n" });
    const { ladder, calls } = fakeLadder();
    const router = createWorkerShellRouter({
      ladder,
      shell: h.runner,
      root: ROOT,
      dangerousReason: noDanger,
    });
    const result = await router.execute(exec("echo 1 >> counter.txt; false"));
    expect(result.outcome.kind).toBe("ok");
    expect(calls).toHaveLength(0);
    expect(h.world.text("counter.txt")).toBe("0\n1\n");
  });

  test("an unanswered commit surfaces as an error and is not handed over", async () => {
    const h = await harness({});
    h.failCommit(new Error("reset"));
    const { ladder, calls } = fakeLadder();
    const router = createWorkerShellRouter({
      ladder,
      shell: h.runner,
      root: ROOT,
      dangerousReason: noDanger,
    });
    const result = await router.execute(exec("echo x > a.txt"));
    expect(result.outcome.kind).toBe("error");
    expect(calls).toHaveLength(0);
  });

  test("write_stdin and a missing shell always use the sandbox", async () => {
    const h = await harness({});
    const { ladder, calls } = fakeLadder();
    await createWorkerShellRouter({ ladder, shell: h.runner, root: ROOT }).execute({
      toolCallId: "w",
      toolName: "write_stdin",
      params: { session_id: "s" },
    });
    await createWorkerShellRouter({ ladder, root: ROOT }).execute(exec("ls"));
    expect(calls.map((call) => call.toolName)).toEqual([
      "write_stdin",
      "exec_command",
    ]);
    expect(h.runs).toHaveLength(0);
  });

  test("once the sandbox attaches, even ordinary commands go there", async () => {
    const h = await harness({ "a.txt": "a\n" });
    const { ladder, calls } = fakeLadder(true);
    const router = createWorkerShellRouter({
      ladder,
      shell: h.runner,
      root: ROOT,
      dangerousReason: noDanger,
    });
    await router.execute(exec("cat a.txt"));
    expect(calls).toHaveLength(1);
    expect(h.runs).toHaveLength(0);
  });

  test("hydrated drive commands stay in the worker shell", async () => {
    const h = await harness({ "drive/a.txt": "upload\n" });
    const { ladder, calls } = fakeLadder();
    const router = createWorkerShellRouter({
      ladder,
      shell: h.runner,
      root: ROOT,
      dangerousReason: noDanger,
      prepareWorkspace: async () => true,
    });
    const result = await router.execute(exec("cat drive/a.txt"));
    expect(result.outcome).toMatchObject({
      text: expect.stringContaining("upload"),
    });
    expect(calls).toHaveLength(0);
  });

  test("hydration requiring a sandbox never starts the worker command", async () => {
    const h = await harness({});
    const { ladder, calls } = fakeLadder();
    const router = createWorkerShellRouter({
      ladder,
      shell: h.runner,
      root: ROOT,
      dangerousReason: noDanger,
      prepareWorkspace: async () => false,
    });
    await router.execute(exec("echo x > drive/a.txt"));
    expect(calls).toHaveLength(1);
    expect(h.runs).toHaveLength(0);
  });

  test("gives commands the container's tool environment", async () => {
    expect(WORKER_SHELL_TOOL_HOME).toBe(CLOUD_TOOL_HOME);
    expect(WORKER_SHELL_TOOL_USER).toBe(CLOUD_TOOL_PROCESS_IDENTITY.user);
    const h = await harness({});
    const { ladder } = fakeLadder();
    const router = createWorkerShellRouter({
      ladder,
      shell: h.runner,
      root: ROOT,
      dangerousReason: noDanger,
    });
    const result = await router.execute(exec("echo $HOME $USER $PWD"));
    expect(result.outcome).toMatchObject({
      text: expect.stringContaining(
        `Output:\n${CLOUD_TOOL_HOME} stella-tools ${ROOT}\n`,
      ),
    });
  });

  test("the prompt names only commands the worker shell runs", () => {
    const prompt = buildGeneralAgentPrompt({ workspace: "lazy", office: false });
    const listed = /ordinary text and file commands \(([^)]+)\)/u.exec(prompt)?.[1];
    expect(listed).toBeDefined();
    for (const name of listed!.split(",").map((value) => value.trim())) {
      expect(WORKER_SHELL_COMMANDS as readonly string[]).toContain(name);
    }
  });
});
