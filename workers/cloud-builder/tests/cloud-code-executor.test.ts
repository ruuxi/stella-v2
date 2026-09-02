import { describe, expect, mock, test } from "bun:test";
import type {
  CloudCodeExecutorFactory,
  CloudCodeToolDefinition,
} from "../src/cloud-code-executor.js";

// The production package runs in workerd and imports this built-in module.
// These policy tests inject a fake Executor, so only the two base classes that
// the package evaluates at import time need lightweight Bun stand-ins.
mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));

const {
  CLOUD_CODE_MAX_CONCURRENT_TOOL_CALLS,
  CLOUD_CODE_MAX_TOOL_CALLS,
  CloudCodeConfigurationError,
  executeCloudCodeWithExecutorFactory,
  prepareCloudCodeTools,
} = await import("../src/cloud-code-executor.js");
const { loadCloudflareCodeMode } = await import(
  "../src/cloud-code-worker-executor.js"
);
mock.restore();

const loader = {} as WorkerLoader;

const tool = (
  overrides: Partial<CloudCodeToolDefinition> = {},
): CloudCodeToolDefinition => ({
  rawName: "read-value",
  description: "Read one value.",
  inputSchema: {
    type: "object",
    properties: { key: { type: "string" } },
    required: ["key"],
    additionalProperties: false,
  },
  outputSchema: { type: "string" },
  approval: "not_required",
  execute: async (input) => {
    const key =
      input && typeof input === "object" && "key" in input
        ? (input as { key?: unknown }).key
        : undefined;
    return `value:${String(key)}`;
  },
  ...overrides,
});

const callOnlyTool: CloudCodeExecutorFactory = () => ({
  async execute(_code, providersOrFns) {
    if (!Array.isArray(providersOrFns)) {
      return { result: undefined, error: "Expected providers" };
    }
    const provider = providersOrFns[0];
    const fn = provider?.fns[Object.keys(provider.fns)[0] ?? ""];
    if (!fn) return { result: undefined, error: "Missing tool" };
    try {
      return { result: await fn({ key: "alpha" }) };
    } catch (error) {
      return {
        result: undefined,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

describe("cloud code executor", () => {
  test("loads the Code Mode SDK through one shared promise", async () => {
    const firstLoad = loadCloudflareCodeMode();
    expect(loadCloudflareCodeMode()).toBe(firstLoad);
    await expect(firstLoad).resolves.toBeDefined();
  });

  test("uses Cloudflare's exact sanitized name while dispatching to the raw name", async () => {
    let callContext:
      | Readonly<{ rawName: string; sanitizedName: string }>
      | undefined;
    const prepared = await prepareCloudCodeTools([
      tool({
        rawName: "read-value.v2",
        execute: async (_input, context) => {
          callContext = context;
          return "ok";
        },
      }),
    ]);

    expect(prepared.nameMappings).toEqual([
      {
        rawName: "read-value.v2",
        sanitizedName: "read_value_v2",
        approval: "not_required",
      },
    ]);
    expect(prepared.typeDeclarations).toContain(
      "read_value_v2: (input: ReadValueV2Input)",
    );

    const result = await executeCloudCodeWithExecutorFactory(
      {
        loader,
        code: "async () => codemode.read_value_v2({ key: 'alpha' })",
        tools: prepared,
        executionId: "run:name-map",
      },
      callOnlyTool,
    );

    expect(result).toEqual({ ok: true, result: "ok" });
    expect(callContext).toMatchObject({
      rawName: "read-value.v2",
      sanitizedName: "read_value_v2",
    });
  });

  test("rejects raw names whose sanitized identifiers collide", async () => {
    await expect(
      prepareCloudCodeTools([
        tool({ rawName: "send-email" }),
        tool({ rawName: "send.email" }),
      ]),
    ).rejects.toThrow(
      'Cloud code tools "send-email" and "send.email" both sanitize to "send_email".',
    );
    await expect(
      prepareCloudCodeTools([tool({ rawName: "__proto__" })]),
    ).rejects.toThrow(CloudCodeConfigurationError);
  });

  test("pins globalOutbound to null and passes no ambient modules or bindings", async () => {
    let receivedOptions: Record<string, unknown> | undefined;
    const factory: CloudCodeExecutorFactory = (options) => {
      receivedOptions = options as unknown as Record<string, unknown>;
      return {
        async execute() {
          return { result: 42 };
        },
      };
    };

    const result = await executeCloudCodeWithExecutorFactory(
      {
        loader,
        code: "async () => 42",
        tools: await prepareCloudCodeTools([]),
        timeoutMs: 1_234,
      },
      factory,
    );

    expect(result).toEqual({ ok: true, result: 42 });
    expect(receivedOptions).toEqual({
      loader,
      timeout: 1_234,
      globalOutbound: null,
    });
    expect(receivedOptions).not.toHaveProperty("modules");
    expect(receivedOptions).not.toHaveProperty("bindings");
  });

  test("denies approval-required tools when there is no explicit gate", async () => {
    let executed = false;
    const prepared = await prepareCloudCodeTools([
      tool({
        rawName: "send-email",
        approval: "required",
        execute: async () => {
          executed = true;
        },
      }),
    ]);

    const result = await executeCloudCodeWithExecutorFactory(
      {
        loader,
        code: "async () => codemode.send_email({})",
        tools: prepared,
        executionId: "run:no-approval",
      },
      callOnlyTool,
    );

    expect(executed).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      code: "approval_required",
      tool: { rawName: "send-email", sanitizedName: "send_email" },
    });
  });

  test("runs an approval-required tool only with the gate's opaque approval id", async () => {
    let executedApprovalId: string | undefined;
    let gateName: string | undefined;
    const prepared = await prepareCloudCodeTools([
      tool({
        rawName: "send-email",
        approval: "required",
        execute: async (_input, context) => {
          executedApprovalId = context.approvalId;
          return "sent";
        },
      }),
    ]);

    const result = await executeCloudCodeWithExecutorFactory(
      {
        loader,
        code: "async () => codemode.send_email({})",
        tools: prepared,
        executionId: "run:approved",
        approvalGate: async (request) => {
          gateName = request.rawName;
          return { status: "approved", approvalId: "approval-123" };
        },
      },
      callOnlyTool,
    );

    expect(result).toEqual({ ok: true, result: "sent" });
    expect(gateName).toBe("send-email");
    expect(executedApprovalId).toBe("approval-123");
  });

  test("a denied or malformed approval never reaches the tool", async () => {
    let executed = false;
    const prepared = await prepareCloudCodeTools([
      tool({
        approval: "required",
        execute: async () => {
          executed = true;
        },
      }),
    ]);

    const result = await executeCloudCodeWithExecutorFactory(
      {
        loader,
        code: "async () => codemode.read_value({ key: 'alpha' })",
        tools: prepared,
        approvalGate: async () => ({ status: "approved", approvalId: " " }),
      },
      callOnlyTool,
    );

    expect(executed).toBe(false);
    expect(result).toMatchObject({ ok: false, code: "approval_denied" });
  });

  test("keeps host tool errors out of the sandbox result", async () => {
    const observed: unknown[] = [];
    const result = await executeCloudCodeWithExecutorFactory(
      {
        loader,
        code: "async () => codemode.read_value({ key: 'alpha' })",
        tools: await prepareCloudCodeTools([
          tool({
            execute: async () => {
              throw new Error("secret host diagnostic");
            },
          }),
        ]),
        onToolError: (error) => {
          observed.push(error);
        },
      },
      callOnlyTool,
    );

    expect(result).toMatchObject({
      ok: false,
      code: "tool_failed",
      error: 'Cloud code tool "read-value" failed.',
    });
    expect(JSON.stringify(result)).not.toContain("secret host diagnostic");
    expect(observed[0]).toBeInstanceOf(Error);
  });

  test("bounds the total number of nested host-tool calls", async () => {
    let executed = 0;
    const prepared = await prepareCloudCodeTools([
      tool({
        execute: async () => {
          executed += 1;
          return executed;
        },
      }),
    ]);
    const factory: CloudCodeExecutorFactory = () => ({
      async execute(_code, providersOrFns) {
        const provider = Array.isArray(providersOrFns)
          ? providersOrFns[0]
          : undefined;
        const fn = provider?.fns["read-value"];
        if (!fn) return { result: undefined, error: "Missing tool" };
        try {
          for (let index = 0; index <= CLOUD_CODE_MAX_TOOL_CALLS; index += 1) {
            await fn({ key: String(index) });
          }
          return { result: "unexpected" };
        } catch (error) {
          return {
            result: undefined,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    });

    const result = await executeCloudCodeWithExecutorFactory(
      {
        loader,
        code: "async () => 'bounded'",
        tools: prepared,
        executionId: "run:total-limit",
      },
      factory,
    );

    expect(executed).toBe(CLOUD_CODE_MAX_TOOL_CALLS);
    expect(result).toMatchObject({
      ok: false,
      code: "resource_limit",
      error: expect.stringContaining("nested-call resource limit"),
    });
  });

  test("bounds concurrent nested host-tool calls", async () => {
    let executed = 0;
    const prepared = await prepareCloudCodeTools([
      tool({
        execute: async (_input, context) => {
          executed += 1;
          await new Promise<never>((_resolve, reject) => {
            context.signal.addEventListener(
              "abort",
              () => reject(new Error("bounded call canceled")),
              { once: true },
            );
          });
        },
      }),
    ]);
    const factory: CloudCodeExecutorFactory = () => ({
      async execute(_code, providersOrFns) {
        const provider = Array.isArray(providersOrFns)
          ? providersOrFns[0]
          : undefined;
        const fn = provider?.fns["read-value"];
        if (!fn) return { result: undefined, error: "Missing tool" };
        try {
          await Promise.all(
            Array.from(
              { length: CLOUD_CODE_MAX_CONCURRENT_TOOL_CALLS + 1 },
              (_, index) => fn({ key: String(index) }),
            ),
          );
          return { result: "unexpected" };
        } catch (error) {
          return {
            result: undefined,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    });

    const result = await executeCloudCodeWithExecutorFactory(
      {
        loader,
        code: "async () => 'bounded'",
        tools: prepared,
        executionId: "run:concurrency-limit",
      },
      factory,
    );

    expect(executed).toBe(CLOUD_CODE_MAX_CONCURRENT_TOOL_CALLS);
    expect(result).toMatchObject({
      ok: false,
      code: "resource_limit",
      error: expect.stringContaining("nested-call resource limit"),
    });
  });

  test("abort returns promptly, propagates to tools, and requests disposal", async () => {
    const controller = new AbortController();
    let hostSignal: AbortSignal | undefined;
    let disposeCalls = 0;
    const prepared = await prepareCloudCodeTools([
      tool({
        execute: async (_input, context) => {
          hostSignal = context.signal;
          await new Promise<never>((_resolve, reject) => {
            context.signal.addEventListener(
              "abort",
              () => reject(new Error("host tool aborted")),
              { once: true },
            );
          });
        },
      }),
    ]);
    const factory: CloudCodeExecutorFactory = () => {
      const executor = {
        ...callOnlyTool({ loader, timeout: 1_000, globalOutbound: null }),
        dispose() {
          disposeCalls += 1;
        },
      };
      return executor;
    };

    const resultPromise = executeCloudCodeWithExecutorFactory(
      {
        loader,
        code: "async () => codemode.read_value({ key: 'alpha' })",
        tools: prepared,
        signal: controller.signal,
        timeoutMs: 1_000,
      },
      factory,
    );
    await Promise.resolve();
    controller.abort();
    const result = await resultPromise;

    expect(result).toMatchObject({
      ok: false,
      code: "aborted",
      cleanup: "disposed",
    });
    expect(hostSignal?.aborted).toBe(true);
    expect(disposeCalls).toBe(1);
  });

  test("timeout ignores late settlement and reports unavailable package teardown", async () => {
    let settle: ((value: { result: unknown }) => void) | undefined;
    let factories = 0;
    const factory: CloudCodeExecutorFactory = () => {
      factories += 1;
      return {
        execute: async () =>
          new Promise((resolve) => {
            settle = resolve;
          }),
      };
    };

    const result = await executeCloudCodeWithExecutorFactory(
      {
        loader,
        code: "async () => 42",
        tools: await prepareCloudCodeTools([]),
        timeoutMs: 5,
      },
      factory,
    );
    expect(result).toEqual({
      ok: false,
      code: "executor_error",
      error: "Cloud code cancellation could not confirm sandbox termination.",
      cleanup: "executor_dispose_unavailable",
    });

    // The wrapper has already committed the timeout outcome. A late executor
    // result is observed for rejection safety but cannot change that outcome.
    settle?.({ result: "late" });
    await Promise.resolve();
    expect(result).toMatchObject({ code: "executor_error" });

    await executeCloudCodeWithExecutorFactory(
      {
        loader,
        code: "async () => 7",
        tools: await prepareCloudCodeTools([]),
        timeoutMs: 5,
      },
      () => {
        factories += 1;
        return { execute: async () => ({ result: 7 }) };
      },
    );
    expect(factories).toBe(2);
  });

  test("maps the package's own timeout into the bounded timeout result", async () => {
    const result = await executeCloudCodeWithExecutorFactory(
      {
        loader,
        code: "async () => new Promise(() => {})",
        tools: await prepareCloudCodeTools([]),
      },
      () => ({
        execute: async () => ({
          result: undefined,
          error: "Execution timed out",
        }),
      }),
    );

    expect(result).toMatchObject({ ok: false, code: "timeout" });
  });
});
