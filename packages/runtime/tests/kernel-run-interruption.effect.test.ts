import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

import {
  createSupervisedScope,
  joinWithTimeout,
} from "../kernel/shared/supervised-scope.js";
import { createKernelRunSupervisor } from "../kernel/runner/supervision/run-supervisor.js";
import { BackgroundCompactionScheduler } from "../kernel/agent-runtime/compaction-scheduler.js";
import {
  executePreparedToolCall,
  type PreparedToolCall,
} from "../kernel/agent-core/agent-loop.js";
import type {
  AgentTool,
  AgentToolResult,
} from "../kernel/agent-core/types.js";
import {
  LocalAgentManager,
  type AgentLifecycleEvent,
} from "../kernel/agents/local-agent-manager.js";
import type { ToolResult } from "../kernel/tools/types.js";

/**
 * Interruption-proof tests for the M5 surface-3 kernel supervision tree.
 * These live inside packages/runtime because `effect` (used by the modules
 * under test) is fenced there — check-boundary.mjs bans it from desktop-ui,
 * tests included. Every test asserts REAL teardown: child-process exit,
 * stream destruction, lock release, pending-tool settlement, and join
 * ordering — not merely the absence of errors.
 */

const pidIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for predicate");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** Spawn a real child process that idles until killed. */
const spawnHangingChild = async (): Promise<{
  child: ChildProcess;
  pid: number;
  exited: Promise<void>;
}> => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  if (child.pid === undefined) throw new Error("Child had no pid");
  return { child, pid: child.pid, exited };
};

const spawnedChildren: ChildProcess[] = [];
afterEach(() => {
  for (const child of spawnedChildren.splice(0, spawnedChildren.length)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already dead
    }
  }
});

describe("SupervisedScope", () => {
  it("close() aborts supervised work, kills its child process, and joins teardown before resolving", async () => {
    const scope = createSupervisedScope("test-close");
    const { child, pid, exited } = await spawnHangingChild();
    spawnedChildren.push(child);
    const order: string[] = [];

    let releaseSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      releaseSettled = resolve;
    }).then(() => {
      order.push("settled");
    });
    scope.supervise({
      label: "child-process-holder",
      abort: () => {
        order.push("abort");
        child.kill("SIGKILL");
        void exited.then(() => releaseSettled());
      },
      settled,
    });

    expect(scope.liveCount()).toBe(1);
    expect(pidIsAlive(pid)).toBe(true);

    await scope.close("test");

    // close() resolved => abort fired, the process is dead, and the work's
    // own teardown (settled) completed BEFORE the join finished.
    expect(order).toEqual(["abort", "settled"]);
    expect(pidIsAlive(pid)).toBe(false);
    expect(scope.liveCount()).toBe(0);
  });

  it("natural completion never fires abort and quiesces the scope", async () => {
    const scope = createSupervisedScope("test-natural");
    const abort = vi.fn();
    let release!: () => void;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    scope.supervise({ label: "natural", abort, settled });
    expect(scope.liveCount()).toBe(1);

    release();
    await scope.quiesced();

    expect(scope.liveCount()).toBe(0);
    expect(abort).not.toHaveBeenCalled();
    await scope.close();
    expect(abort).not.toHaveBeenCalled();
  });

  it("aborts work admitted after close instead of orphaning it", async () => {
    const scope = createSupervisedScope("test-late");
    await scope.close();
    const abort = vi.fn();
    scope.supervise({
      label: "late",
      abort,
      settled: Promise.resolve(),
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(scope.liveCount()).toBe(0);
  });

  it("joinWithTimeout bounds a join on work that ignores interruption", async () => {
    const scope = createSupervisedScope("test-stuck");
    const abort = vi.fn();
    // Never settles and ignores abort: the strongest cap we can offer is a
    // bounded join after interruption was delivered.
    scope.supervise({
      label: "stuck",
      abort,
      settled: new Promise<never>(() => {}),
    });
    const onTimeout = vi.fn();
    const outcome = await joinWithTimeout(scope.close("cap"), 200, onTimeout);
    expect(outcome).toBe("timeout");
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledOnce();
  });
});

describe("KernelRunSupervisor", () => {
  it("cancelRun interrupts the root turn and its adopted subagent, closing streams and reaping processes before resolving", async () => {
    const supervisor = createKernelRunSupervisor();
    const runId = "local:run-cascade";
    const order: string[] = [];

    // Root turn holds an open stream (stands in for the provider SSE
    // stream); its abort destroys the stream, teardown resolves settled.
    const stream = new PassThrough();
    let releaseRoot!: () => void;
    const rootSettled = new Promise<void>((resolve) => {
      releaseRoot = resolve;
    }).then(() => {
      order.push("root-settled");
    });
    supervisor.startRun(runId, {
      abort: () => {
        order.push("root-abort");
        stream.destroy();
        releaseRoot();
      },
      settled: rootSettled,
    });

    // Child subagent attempt holds a real child process.
    const { child, pid, exited } = await spawnHangingChild();
    spawnedChildren.push(child);
    let releaseChild!: () => void;
    const childSettled = new Promise<void>((resolve) => {
      releaseChild = resolve;
    }).then(() => {
      order.push("child-settled");
    });
    supervisor.adoptChild(runId, "thread-1", {
      abort: () => {
        order.push("child-abort");
        child.kill("SIGKILL");
        void exited.then(() => releaseChild());
      },
      settled: childSettled,
    });

    expect(supervisor.liveFiberCount()).toBe(2);
    expect(stream.destroyed).toBe(false);
    expect(pidIsAlive(pid)).toBe(true);

    await supervisor.cancelRun(runId, "Canceled");

    // Both units were aborted AND joined before cancelRun resolved.
    expect(order).toContain("root-abort");
    expect(order).toContain("child-abort");
    expect(order.indexOf("root-settled")).toBeGreaterThan(
      order.indexOf("root-abort"),
    );
    expect(order.indexOf("child-settled")).toBeGreaterThan(
      order.indexOf("child-abort"),
    );
    expect(stream.destroyed).toBe(true);
    expect(pidIsAlive(pid)).toBe(false);
    expect(supervisor.liveFiberCount()).toBe(0);
  });

  it("natural root completion leaves background children running; a late cancelRun still reaps them", async () => {
    const supervisor = createKernelRunSupervisor();
    const runId = "local:run-background";

    const rootAbort = vi.fn();
    supervisor.startRun(runId, {
      abort: rootAbort,
      settled: Promise.resolve(),
    });

    const { child, pid, exited } = await spawnHangingChild();
    spawnedChildren.push(child);
    let releaseChild!: () => void;
    const childSettled = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    supervisor.adoptChild(runId, "thread-bg", {
      abort: () => {
        child.kill("SIGKILL");
        void exited.then(() => releaseChild());
      },
      settled: childSettled,
    });

    // Root finished; the deliberately detached background child stays live.
    await waitFor(() => supervisor.liveFiberCount() === 1);
    expect(pidIsAlive(pid)).toBe(true);
    expect(rootAbort).not.toHaveBeenCalled();

    await supervisor.cancelRun(runId, "Canceled");
    expect(pidIsAlive(pid)).toBe(false);
    expect(supervisor.liveFiberCount()).toBe(0);
  });

  it("concurrent double-cancel joins ONE close: neither caller resolves before teardown", async () => {
    const supervisor = createKernelRunSupervisor();
    const runId = "local:run-double-cancel";
    let abortCount = 0;
    let teardownComplete = false;
    let releaseWork!: () => void;
    const settled = new Promise<void>((resolve) => {
      releaseWork = resolve;
    }).then(async () => {
      // Slow asynchronous teardown the close must join.
      await new Promise((resolve) => setTimeout(resolve, 30));
      teardownComplete = true;
    });
    supervisor.startRun(runId, {
      abort: () => {
        abortCount += 1;
        releaseWork();
      },
      settled,
    });

    // Two cancels in the same tick: both must join the SAME close and
    // resolve only after the work's teardown completed. Before the
    // memoization, the second caller saw the deleted entry and resolved
    // immediately — releasing the lane mid-close.
    const first = supervisor.cancelRun(runId, "Canceled").then(() => {
      expect(teardownComplete).toBe(true);
    });
    const second = supervisor.cancelRun(runId, "Canceled").then(() => {
      expect(teardownComplete).toBe(true);
    });
    // awaitRunTermination during the close joins it too.
    const observer = supervisor.awaitRunTermination(runId).then(() => {
      expect(teardownComplete).toBe(true);
    });
    await Promise.all([first, second, observer]);
    expect(abortCount).toBe(1);
    expect(supervisor.liveFiberCount()).toBe(0);
    // A third cancel after completion is a resolved no-op (stale-run
    // semantics preserved).
    await supervisor.cancelRun(runId, "Canceled");
  });

  it("shutdown interrupts and joins children spawned without a root run", async () => {
    const supervisor = createKernelRunSupervisor();
    const { child, pid, exited } = await spawnHangingChild();
    spawnedChildren.push(child);
    let release!: () => void;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    supervisor.adoptChild(undefined, "thread-detached", {
      abort: () => {
        child.kill("SIGKILL");
        void exited.then(() => release());
      },
      settled,
    });
    expect(pidIsAlive(pid)).toBe(true);

    await supervisor.shutdown();
    expect(pidIsAlive(pid)).toBe(false);
    expect(supervisor.liveFiberCount()).toBe(0);
  });
});

describe("LocalAgentManager attempt supervision", () => {
  it("cancelRun on the root run cancels the supervised subagent attempt: abort delivered, process reaped, terminal event emitted, attempt joined", async () => {
    const supervisor = createKernelRunSupervisor();
    const rootRunId = "local:root-1";
    const events: AgentLifecycleEvent[] = [];
    const { child, pid, exited } = await spawnHangingChild();
    spawnedChildren.push(child);

    let attemptSettled = false;
    const manager = new LocalAgentManager({
      maxConcurrent: 2,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 2,
      }),
      superviseAttempt: (attempt) =>
        supervisor.adoptChild(attempt.rootRunId, attempt.threadId, {
          abort: attempt.abort,
          settled: attempt.settled.then(() => {
            attemptSettled = true;
          }),
        }),
      runSubagent: async (args) => {
        // Stand-in for a real subagent turn: holds a child process until
        // the manager-owned abort signal fires, then reaps it and reports
        // the interruption — the same cooperative contract as runSubagentTask.
        await new Promise<void>((resolve) => {
          if (args.abortSignal.aborted) return resolve();
          args.abortSignal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        child.kill("SIGKILL");
        await exited;
        return { runId: args.runId ?? "run", result: "", interrupted: true };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      onAgentEvent: (event) => {
        events.push(event);
      },
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    await manager.createAgent({
      conversationId: "conv-1",
      description: "hold a process",
      prompt: "hold",
      agentType: "exec",
      agentDepth: 1,
      storageMode: "local",
      rootRunId,
    });
    await waitFor(() =>
      events.some((event) => event.type === "agent-started"),
    );
    expect(pidIsAlive(pid)).toBe(true);

    await supervisor.cancelRun(rootRunId, "Canceled");

    // The cascade delivered a real cancelAgent: terminal lifecycle event,
    // process reaped, and the attempt promise joined before cancelRun
    // resolved.
    expect(
      events.some(
        (event) =>
          event.type === "agent-canceled" && event.rootRunId === rootRunId,
      ),
    ).toBe(true);
    expect(pidIsAlive(pid)).toBe(false);
    expect(attemptSettled).toBe(true);
    expect(manager.getActiveAgentCount()).toBe(0);
  });
});

describe("BackgroundCompactionScheduler shutdown", () => {
  it("interrupts the active run via its abort signal, joins it, and drops the queued follow-up", async () => {
    const scheduler = new BackgroundCompactionScheduler();
    const order: string[] = [];
    let activeSignal: AbortSignal | undefined;

    const activePromise = scheduler.schedule({
      threadKey: "thread-a",
      run: (signal) =>
        new Promise<void>((resolve) => {
          activeSignal = signal;
          if (signal?.aborted) return resolve();
          signal?.addEventListener(
            "abort",
            () => {
              order.push("active-aborted");
              // Simulate teardown work after the abort lands.
              setTimeout(() => {
                order.push("active-torn-down");
                resolve();
              }, 20);
            },
            { once: true },
          );
        }),
    });

    let queuedRan = false;
    const queuedPromise = scheduler.schedule({
      threadKey: "thread-a",
      run: async () => {
        queuedRan = true;
      },
    });

    await waitFor(() => activeSignal !== undefined);

    await scheduler.shutdown();
    order.push("shutdown-resolved");

    // Interruption was delivered and JOINED (teardown finished before
    // shutdown resolved); the queued follow-up never ran but its waiter
    // resolved.
    expect(order).toEqual([
      "active-aborted",
      "active-torn-down",
      "shutdown-resolved",
    ]);
    expect(queuedRan).toBe(false);
    await queuedPromise;
    await activePromise;
    expect(scheduler.pending("thread-a")).toBeNull();
  });

  it("rejects work scheduled after shutdown without running it", async () => {
    const scheduler = new BackgroundCompactionScheduler();
    await scheduler.shutdown();
    let ran = false;
    await scheduler.schedule({
      threadKey: "thread-b",
      run: async () => {
        ran = true;
      },
    });
    expect(ran).toBe(false);
    expect(scheduler.pending("thread-b")).toBeNull();
  });
});

describe("agent-loop pending tool teardown", () => {
  const makePrepared = (execute: AgentTool["execute"]): PreparedToolCall => ({
    kind: "prepared",
    toolCall: {
      type: "toolCall",
      id: "tool-call-1",
      name: "exec_command",
      arguments: {},
    } as never,
    tool: {
      name: "exec_command",
      label: "Exec",
      description: "test tool",
      parameters: { type: "object", properties: {} } as never,
      execute,
    } as AgentTool,
    args: {},
  });

  it("outer abort tears down a cooperative tool's child process and settles the pending call", async () => {
    const { child, pid, exited } = await spawnHangingChild();
    spawnedChildren.push(child);
    const prepared = makePrepared(
      (_id, _args, signal) =>
        new Promise<AgentToolResult<unknown>>((_resolve, reject) => {
          const teardown = () => {
            child.kill("SIGKILL");
            void exited.then(() =>
              reject(new Error("Tool canceled by abort signal")),
            );
          };
          if (signal?.aborted) return teardown();
          signal?.addEventListener("abort", teardown, { once: true });
        }),
    );

    const controller = new AbortController();
    const outcomePromise = executePreparedToolCall(
      prepared,
      controller.signal,
      vi.fn(),
    );
    expect(pidIsAlive(pid)).toBe(true);
    controller.abort(new Error("Canceled"));

    const outcome = await outcomePromise;
    // The pending tool call settled as an error AND its child process is
    // gone — the settlement waited for the tool's actual teardown.
    expect(outcome.isError).toBe(true);
    expect(pidIsAlive(pid)).toBe(false);
  });

  it("abandons an abort-ignoring tool after the bounded cancellation grace, not the full inactivity window", async () => {
    const prepared = makePrepared(
      () => new Promise<AgentToolResult<unknown>>(() => {}),
    );
    const controller = new AbortController();
    const startedAt = Date.now();
    const outcomePromise = executePreparedToolCall(
      prepared,
      controller.signal,
      vi.fn(),
      60_000,
      100,
    );
    controller.abort(new Error("Canceled"));

    const outcome = await outcomePromise;
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(outcome.isError).toBe(true);
    const text = outcome.result.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join(" ");
    expect(text).toContain("ignored cancellation");
  });
});
