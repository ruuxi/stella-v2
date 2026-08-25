import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import type { MapRouteArtifact } from "@stella/contracts/map-artifact";
import { NodeReplKernelRegistry } from "@stella/runtime/kernel/computer-use/kernel";
import type { BrowserSessionClient } from "@stella/runtime/kernel/browser-use/client";
import {
  buildCatalogSection,
  searchToolCatalog,
  type DemotedToolCatalogEntry,
} from "@stella/runtime/kernel/tools/code-catalog";
import { createNodeReplTool } from "@stella/runtime/kernel/tools/defs/node-repl";
import type { ToolContext } from "@stella/runtime/kernel/tools/types";

const context: ToolContext = {
  conversationId: "conversation-1",
  deviceId: "device-1",
  requestId: "request-1",
  agentId: "agent-1",
  agentType: AGENT_IDS.GENERAL,
  stellaAppDir: "/workspace",
  allowedToolNames: [
    "node_repl",
    "multi_tool_use_parallel",
    "fake_tool",
  ],
};

describe("node_repl tool", () => {
  it("falls back to home when its inherited cwd points at app.asar", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "stella-node-repl-cwd-"));
    const appAsar = path.join(dir, "app.asar");
    await writeFile(appAsar, "packaged archive", "utf-8");
    const registry = new NodeReplKernelRegistry({
      sessionFactory: () => ({ request: async () => ({}) }),
    });
    try {
      await expect(
        registry.evaluate("nodeRepl.write(nodeRepl.cwd)", {
          ...context,
          agentId: "agent-file-cwd",
          stellaAppDir: appAsar,
        }),
      ).resolves.toBe(os.homedir());
    } finally {
      await registry.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is available to working Orchestrator and General agents and retains state across tool calls", async () => {
    const registry = new NodeReplKernelRegistry({
      sessionFactory: () => ({
        request: async () => {
          throw new Error(
            "Unexpected Computer Use request in REPL persistence test.",
          );
        },
      }),
    });
    const tool = createNodeReplTool({ registry });
    try {
      expect(tool.agentTypes).toEqual([
        AGENT_IDS.ORCHESTRATOR,
        AGENT_IDS.GENERAL,
      ]);
      expect(tool.description).toContain("bindings persist");
      expect(tool.description).toContain("fresh element IDs");
      await expect(
        tool.execute({ code: "const value = 9" }, context),
      ).resolves.toEqual({
        result: "",
      });
      await expect(
        tool.execute({ code: "value * 2" }, context),
      ).resolves.toEqual({
        result: "18",
      });
    } finally {
      registry.dispose();
    }
  });

  it("exposes allowed tools as an immutable API and runs independent calls concurrently", async () => {
    let activeCalls = 0;
    let maxActiveCalls = 0;
    const registry = new NodeReplKernelRegistry({
      sessionFactory: () => ({ request: async () => ({}) }),
      executeTool: async (_name, args) => {
        activeCalls += 1;
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeCalls -= 1;
        return { result: args.id };
      },
    });
    const tool = createNodeReplTool({ registry });
    try {
      await expect(
        tool.execute(
          {
            code: `({
              names: Object.keys(tools),
              values: await Promise.all([
                tools.fake_tool({id: 1}),
                tools.fake_tool({id: 2})
              ])
            })`,
          },
          context,
        ),
      ).resolves.toMatchObject({
        result: expect.stringContaining("values: [ 1, 2 ]"),
      });
      // `tools` is now a Proxy with a mutable backing map (refreshed each
      // evaluate), so Object.isFrozen can no longer be true — immutability
      // from REPL code is enforced by refusing traps instead. Sloppy-mode
      // assignments fail silently, so probe values rather than throws.
      const output = await registry.evaluate(
        [
          "tools.injected = () => 'nope';",
          "delete tools.fake_tool;",
          "({",
          "  injected: typeof tools.injected,",
          "  stillCallable: typeof tools.fake_tool,",
          "  frozenFn: Object.isFrozen(tools.fake_tool),",
          "  names: Object.keys(tools),",
          "})",
        ].join("\n"),
        context,
      );
      expect(output).toContain("injected: 'undefined'");
      expect(output).toContain("stillCallable: 'function'");
      expect(output).toContain("frozenFn: true");
      expect(output).toContain("fake_tool");
      expect(output).toContain("$search");
      expect(output).not.toContain("multi_tool_use_parallel");
      expect(output).not.toContain("node_repl");
      expect(maxActiveCalls).toBe(2);

      // Narrowing allowedToolNames removes the entry from the refreshed
      // tools object itself, so the call fails in the REPL before it can
      // even reach the kernel's allowlist gate.
      await expect(
        registry.evaluate("await tools.fake_tool({id: 3})", {
          ...context,
          allowedToolNames: ["node_repl"],
        }),
      ).rejects.toThrow("tools.fake_tool is not a function");
    } finally {
      await registry.dispose();
    }
  });

  it("discovers and invokes all six built-in demoted tools through the bounded proxy", async () => {
    const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
    const demotedCatalog: DemotedToolCatalogEntry[] = [
      ["schedule_add", "Create a scheduled trigger."],
      ["schedule_list", "List scheduled triggers."],
      ["schedule_update", "Update a scheduled trigger."],
      ["schedule_remove", "Remove a scheduled trigger."],
      ["ScriptDraft", "Author and dry-run a watch script."],
      ["connector_status", "Check a connector and request consent."],
    ].map(([name, description]) => ({
      name: name!,
      description,
      parameters: {
        type: "object",
        properties: { probe: { type: "string" } },
      },
      demoted: { searchTerms: [description!] },
    }));
    const registry = new NodeReplKernelRegistry({
      sessionFactory: () => ({ request: async () => ({}) }),
      executeTool: async (name, args) => {
        executed.push({ name, args });
        return { result: `ran ${name}` };
      },
      searchTools: (query, toolContext) => {
        expect(toolContext.conversationId).toBe("conversation-1");
        return searchToolCatalog(demotedCatalog, query);
      },
    });
    const tool = createNodeReplTool({ registry });
    try {
      const demotedContext = {
        ...context,
        allowedToolNames: [
          "node_repl",
          ...demotedCatalog.map((entry) => entry.name),
        ],
      };
      await expect(
        tool.execute(
          {
            code: [
              `const names = ${JSON.stringify(demotedCatalog.map((entry) => entry.name))};`,
              "const matches = await Promise.all(names.map(async (name) => (await tools.$search({ query: name }))[0]));",
              "const outcomes = await Promise.all(names.map((name) => tools[name]({ probe: name })));",
              "({ matches, outcomes })",
            ].join("\n"),
            timeout_ms: 5_000,
          },
          demotedContext,
        ),
      ).resolves.toMatchObject({
        result: expect.stringContaining(
          "tools.connector_status(input: { probe?: string }): Promise<unknown>",
        ),
      });
      expect(executed.map((entry) => entry.name).sort()).toEqual(
        demotedCatalog.map((entry) => entry.name).sort(),
      );
      for (const entry of executed) {
        expect(entry.args).toEqual({ probe: entry.name });
      }
    } finally {
      await registry.dispose();
    }
  });

  it("invokes deferred map and lifts its exact artifact onto the outer result", async () => {
    const map: MapRouteArtifact = {
      kind: "map-route",
      version: 1,
      title: "Coffee",
      markers: [
        {
          id: "p1",
          name: "Blue Bottle Coffee",
          lat: 37.7961,
          lng: -122.3939,
        },
      ],
    };
    const registry = new NodeReplKernelRegistry({
      sessionFactory: () => ({ request: async () => ({}) }),
      executeTool: async (name, args) => {
        expect(name).toBe("map");
        expect(args).toEqual({ places: ["Blue Bottle Coffee"] });
        return {
          result: "Pinned place: Blue Bottle Coffee.",
          details: { map },
        };
      },
    });
    const tool = createNodeReplTool({ registry });
    try {
      await expect(
        tool.execute(
          {
            code: 'await tools.map({ places: ["Blue Bottle Coffee"] })',
          },
          { ...context, allowedToolNames: ["node_repl", "map"] },
        ),
      ).resolves.toEqual({
        result: "'Pinned place: Blue Bottle Coffee.'",
        details: { map },
      });
    } finally {
      await registry.dispose();
    }
  });

  it("searches the full live catalog when the embedded catalog is partial", async () => {
    const liveCatalog: DemotedToolCatalogEntry[] = Array.from(
      { length: 40 },
      (_, index) => ({
        name: `alpha_verbose_${String(index).padStart(2, "0")}`,
        description: `Verbose catalog entry ${index} ${"x".repeat(100)}`,
        parameters: { type: "object" },
        demoted: { searchTerms: [`alpha ${index}`] },
      }),
    );
    liveCatalog.push({
      name: "alpha_zz_hidden_route_planner",
      description: `Plan a far-horizon route beyond the embedded prefix. ${"y".repeat(400)}`,
      parameters: {
        type: "object",
        properties: { destination: { type: "string" } },
        required: ["destination"],
      },
      demoted: { searchTerms: ["far horizon", "hidden route"] },
    });
    const embedded = buildCatalogSection(liveCatalog, 80);
    expect(embedded).toContain("PARTIAL");
    expect(embedded).not.toContain("alpha_zz_hidden_route_planner");

    const registry = new NodeReplKernelRegistry({
      sessionFactory: () => ({ request: async () => ({}) }),
      executeTool: async () => ({ result: "unused" }),
      searchTools: (query) => searchToolCatalog(liveCatalog, query),
    });
    try {
      const result = await registry.evaluate(
        "await tools.$search({ query: 'far horizon route' })",
        {
          ...context,
          allowedToolNames: [
            "node_repl",
            ...liveCatalog.map((entry) => entry.name),
          ],
        },
      );
      expect(result).toContain("alpha_zz_hidden_route_planner");
      expect(result).toContain(
        "tools.alpha_zz_hidden_route_planner(input: { destination: string }): Promise<unknown>",
      );
      expect(result).toContain("beyond the embedded prefix");
    } finally {
      await registry.dispose();
    }
  });

  it("drains unawaited nested tools before returning and preserves tracking", async () => {
    let releaseNested!: () => void;
    let markNestedStarted!: () => void;
    const nestedStarted = new Promise<void>((resolve) => {
      markNestedStarted = resolve;
    });
    const nestedGate = new Promise<void>((resolve) => {
      releaseNested = resolve;
    });
    const onUpdate = vi.fn();
    const registry = new NodeReplKernelRegistry({
      sessionFactory: () => ({ request: async () => ({}) }),
      executeTool: async (_name, _args, _context, _signal, update) => {
        update?.({ result: "nested update" });
        markNestedStarted();
        await nestedGate;
        return {
          result: "edited",
          fileChanges: [
            { path: "/workspace/app.ts", kind: { type: "update" } },
          ],
          producedFiles: [
            { path: "/workspace/report.pdf", kind: { type: "add" } },
          ],
        };
      },
    });
    const tool = createNodeReplTool({ registry });
    try {
      let completed = false;
      const evaluation = tool
        .execute({ code: `tools.fake_tool({}); "cell complete"` }, context, {
          onUpdate,
        })
        .then((result) => {
          completed = true;
          return result;
        });

      await nestedStarted;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(completed).toBe(false);
      expect(onUpdate).toHaveBeenCalledWith({
        result: "nested update",
      });

      releaseNested();
      await expect(evaluation).resolves.toEqual({
        result: "'cell complete'",
        fileChanges: [{ path: "/workspace/app.ts", kind: { type: "update" } }],
        producedFiles: [
          { path: "/workspace/report.pdf", kind: { type: "add" } },
        ],
      });
    } finally {
      await registry.dispose();
    }
  });

  it("fails the cell when an unawaited nested tool fails", async () => {
    const registry = new NodeReplKernelRegistry({
      sessionFactory: () => ({ request: async () => ({}) }),
      executeTool: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error("nested tool failed");
      },
    });
    try {
      await expect(
        registry.evaluate(`tools.fake_tool({}); "premature success"`, context),
      ).rejects.toThrow("nested tool failed");
    } finally {
      await registry.dispose();
    }
  });

  it("does not fail the cell when a nested tool failure is caught", async () => {
    const registry = new NodeReplKernelRegistry({
      sessionFactory: () => ({ request: async () => ({}) }),
      executeTool: async () => {
        throw new Error("handled nested failure");
      },
    });
    try {
      await expect(
        registry.evaluate(
          `tools.fake_tool({}).catch(() => {}); "recovered"`,
          context,
        ),
      ).resolves.toBe("'recovered'");
    } finally {
      await registry.dispose();
    }
  });

  it("aborts nested tools when the node_repl evaluation is cancelled", async () => {
    let nestedSignal: AbortSignal | undefined;
    let markNestedStarted!: () => void;
    const nestedStarted = new Promise<void>((resolve) => {
      markNestedStarted = resolve;
    });
    const registry = new NodeReplKernelRegistry({
      sessionFactory: () => ({ request: async () => ({}) }),
      executeTool: async (_name, _args, _context, signal) => {
        nestedSignal = signal;
        markNestedStarted();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          );
        });
        return { result: "unreachable" };
      },
    });
    try {
      const controller = new AbortController();
      const evaluation = registry.evaluate(
        `tools.fake_tool({}); "must remain pending"`,
        context,
        { signal: controller.signal },
      );
      await nestedStarted;
      controller.abort(new Error("cancel nested tools"));
      await expect(
        evaluation,
      ).rejects.toThrow("cancel nested tools");
      expect(nestedSignal?.aborted).toBe(true);
    } finally {
      await registry.dispose();
    }
  });

  it("fails in bounded time with a diagnosis when an unawaited nested tool never settles, keeping the kernel alive", async () => {
    const registry = new NodeReplKernelRegistry({
      sessionFactory: () => ({ request: async () => ({}) }),
      // Never settles: simulates a nested call wedged on a dead transport.
      executeTool: () => new Promise(() => {}),
      toolDrainTimeoutMs: 250,
    });
    try {
      const startedAt = Date.now();
      await expect(
        registry.evaluate(
          `var probe = 41; tools.fake_tool({}); "cell done"`,
          context,
        ),
      ).rejects.toThrow(
        /never settled within 250ms: tools\.fake_tool/,
      );
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      // The drain timeout must not kill the kernel: REPL state survives.
      await expect(registry.evaluate(`probe + 1`, context)).resolves.toBe(
        "42",
      );
    } finally {
      await registry.dispose();
    }
  });

  it("rejects with the eval timeout instead of hanging when an awaited browser call and its dispose never settle", async () => {
    const registry = new NodeReplKernelRegistry({
      sessionFactory: () => ({ request: async () => ({}) }),
      // Wedged bridge: commands and teardown never settle (observed with a
      // hung Brave extension bridge on 2026-07-12).
      browserSessionFactory: () =>
        ({
          command: () => new Promise(() => {}),
          chain: () => new Promise(() => {}),
          dispose: () => new Promise(() => {}),
        }) as never,
      evalTimeoutMs: 300,
      disposeTimeoutMs: 200,
    });
    try {
      const startedAt = Date.now();
      await expect(
        registry.evaluate(`await browser.tabs.list()`, context),
      ).rejects.toThrow("Node REPL timed out after 300ms.");
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      // The wedged kernel was dropped; a follow-up evaluate gets a fresh
      // kernel instead of queueing behind the dead one.
      await expect(
        registry.evaluate(`1 + 1`, context, { timeoutMs: 2_000 }),
      ).resolves.toBe("2");
    } finally {
      await registry.dispose();
    }
  });

  it("hoists nested tool file tracking onto the node_repl result", async () => {
    const registry = new NodeReplKernelRegistry({
      sessionFactory: () => ({ request: async () => ({}) }),
      executeTool: async () => ({
        result: "edited",
        fileChanges: [{ path: "/workspace/app.ts", kind: { type: "update" } }],
        producedFiles: [{ path: "/workspace/report.pdf", kind: { type: "add" } }],
      }),
    });
    const tool = createNodeReplTool({ registry });
    try {
      await expect(
        tool.execute({ code: `await tools.fake_tool({})` }, context),
      ).resolves.toEqual({
        result: "'edited'",
        fileChanges: [
          { path: "/workspace/app.ts", kind: { type: "update" } },
        ],
        producedFiles: [
          { path: "/workspace/report.pdf", kind: { type: "add" } },
        ],
      });
    } finally {
      await registry.dispose();
    }
  });

  it("returns automatic browser screenshots only in UI response metadata", async () => {
    const jpeg = Buffer.from("ui-only-node-repl-screenshot");
    const command = vi.fn(async (action: string) => {
      const data =
        action === "tab_list"
          ? {
              tabs: [
                { tabId: 9, active: true, url: "https://example.test/save" },
              ],
              activeTabId: 9,
            }
          : action === "screenshot"
            ? { base64: jpeg.toString("base64"), format: "jpeg" }
            : { ok: true };
      return {
        sessionId: "general-task-agent-1",
        bridgeSessionId: "stella-app-bridge",
        requestId: `request-${command.mock.calls.length}`,
        action,
        params: {},
        result: { id: "response", success: true as const, data },
        attempts: 1,
        durationMs: 1,
      };
    });
    const registry = new NodeReplKernelRegistry({
      sessionFactory: () => ({ request: async () => ({}) }),
      browserSessionFactory: () =>
        ({
          command,
          chain: vi.fn(),
          dispose: vi.fn(async () => undefined),
        }) as unknown as BrowserSessionClient,
    });
    const tool = createNodeReplTool({ registry });
    try {
      const result = await tool.execute(
        {
          code: "await browser.tabs.get(9).playwright.locator('#save').click(); 'done'",
        },
        context,
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toContain("'done'");
      expect(result.result).not.toContain("data:image/jpeg");
      expect(result.result).not.toContain("[stella-attach-image]");
      expect(result.details).toEqual({
        _meta: {
          "stella/browserUse": true,
          "stella/toolSurface": {
            kind: "browserUse",
            backend: "iab",
            browserId: "general-task-agent-1",
            openTabIds: ["9"],
            sessionEnded: false,
            screenshot: {
              tabId: "9",
              url: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
              pageUrl: "https://example.test",
            },
          },
          browser_use: { url: "https://example.test/save" },
        },
      });
    } finally {
      await registry.dispose();
    }
  });
});
