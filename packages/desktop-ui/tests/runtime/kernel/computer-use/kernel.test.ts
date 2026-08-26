import { describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile, rm } from "node:fs/promises";
import {
  createExternalNodeReplTransport,
  isBunNodeReplRuntime,
  nodeReplChildUsesElectronRuntime,
  NodeReplKernelRegistry,
  type ComputerUseSessionFactory,
  type ComputerUseSessionFactoryOptions,
} from "@stella/runtime/kernel/computer-use/kernel";
import { BrowserSessionCommandError } from "@stella/runtime/kernel/browser-use/client";
import type {
  BrowserSessionClient,
  BrowserSessionOptions,
} from "@stella/runtime/kernel/browser-use/client";
import type {
  ComputerUseRequest,
  ComputerUseResponse,
} from "@stella/runtime/kernel/computer-use/contract";
import type {
  ComputerUseSession,
  ComputerUseSessionRequestOptions,
} from "@stella/runtime/kernel/computer-use/session";
import type { ToolContext } from "@stella/runtime/kernel/tools/types";

const TEST_WORKSPACE_ROOT = process.cwd();

const context = (agentId: string): ToolContext => ({
  conversationId: "conversation-1",
  deviceId: "device-1",
  requestId: "request-1",
  runId: "run-1",
  agentId,
  agentType: "general",
  stellaAppDir: TEST_WORKSPACE_ROOT,
  toolWorkspaceRoot: TEST_WORKSPACE_ROOT,
  storageMode: "local",
});

const rootContext = (runId: string): ToolContext => ({
  conversationId: "conversation-1",
  deviceId: "device-1",
  requestId: `request-${runId}`,
  runId,
  agentType: "orchestrator",
  stellaAppDir: TEST_WORKSPACE_ROOT,
  toolWorkspaceRoot: TEST_WORKSPACE_ROOT,
  storageMode: "local",
});

const responseFor = (request: ComputerUseRequest): ComputerUseResponse => {
  const envelope = {
    schemaVersion: request.schemaVersion,
    protocolVersion: request.protocolVersion,
    requestId: request.requestId,
    sessionId: request.sessionId,
  };
  switch (request.type) {
    case "list_apps":
      return { ...envelope, type: "list_apps", text: "Notes" };
    case "list_windows":
      return { ...envelope, type: "list_windows", text: "Notes: Main" };
    case "resolve_target":
      return {
        ...envelope,
        type: "target_policy",
        policy: {
          bundleIdentifier: "com.apple.Notes",
          displayName: "Notes",
          decision: "allowed",
          allowPersistentApproval: true,
        },
      };
    case "get_app_state":
      return {
        ...envelope,
        type: "app_state",
        state: {
          app: "Notes",
          text: "<app_state>fresh ids</app_state>",
          screenshot: null,
        },
      };
    case "action":
      return {
        ...envelope,
        type: "action",
        receipt: {
          type: "action",
          action: request.command.action.type,
          target: request.command.target,
          status: "completed",
          deferred: false,
        },
      };
    case "batch":
      return {
        ...envelope,
        type: "batch",
        receipt: {
          type: "batch",
          receipts: request.commands.map((command) => ({
            type: "action",
            action: command.action.type,
            target: command.target,
            status: "completed",
            deferred: false,
          })),
        },
      };
  }
};

const defaultSessionFactory: ComputerUseSessionFactory = () => ({
  request: async (request) => responseFor(request),
});

const createRegistry = (idleTimeoutMs = 60_000) =>
  new NodeReplKernelRegistry({
    sessionFactory: defaultSessionFactory,
    idleTimeoutMs,
  });

describe("persistent Node REPL kernels", () => {
  it("recognizes Bun so production kernels use the external Node transport", () => {
    expect(
      isBunNodeReplRuntime({
        ...process.versions,
        bun: "1.4.0",
      }),
    ).toBe(true);
    expect(isBunNodeReplRuntime({ ...process.versions })).toBe(false);
  });

  it("runs the host Electron executable as Node for Bun child kernels", () => {
    expect(
      nodeReplChildUsesElectronRuntime({
        STELLA_HOST_EXECUTABLE_PATH: "/Applications/Stella.app/Electron",
      }),
    ).toBe(true);
    expect(
      nodeReplChildUsesElectronRuntime({
        STELLA_NODE_BIN: "/opt/homebrew/bin/node",
        STELLA_HOST_EXECUTABLE_PATH: "/Applications/Stella.app/Electron",
      }),
    ).toBe(false);
    expect(
      nodeReplChildUsesElectronRuntime({
        STELLA_NODE_BIN: "/Applications/Stella.app/Electron",
        STELLA_NODE_IS_ELECTRON: "1",
      }),
    ).toBe(true);
  });

  it("forwards a child stdin EPIPE through the transport without an unhandled stream error", async () => {
    const pipeError = Object.assign(new Error("write EPIPE"), {
      code: "EPIPE",
    });
    const stdin = Object.assign(new EventEmitter(), {
      end: vi.fn(() => {
        stdin.emit("error", pipeError);
      }),
    });
    const child = Object.assign(new EventEmitter(), {
      stdin,
      connected: true,
      channel: { ref: vi.fn(), unref: vi.fn() },
      exitCode: null,
      signalCode: null,
      send: vi.fn(),
      ref: vi.fn(),
      unref: vi.fn(),
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    const spawnProcess = vi.fn(
      () => child,
    ) as unknown as typeof import("node:child_process").spawn;

    const transport = createExternalNodeReplTransport(
      "worker source",
      {} as Parameters<typeof createExternalNodeReplTransport>[1],
      {
        env: { STELLA_NODE_BIN: process.execPath },
        spawnProcess,
      },
    );
    const observedError = new Promise<Error>((resolve) => {
      transport.on("error", resolve);
    });

    await expect(observedError).resolves.toBe(pipeError);
    expect(stdin.end).toHaveBeenCalledWith("worker source");
  });

  it("supports top-level await and preserves lexical bindings", async () => {
    const registry = createRegistry();
    try {
      await expect(
        registry.evaluate(
          [
            "const answer = await Promise.resolve(41)",
            "// Multiline input must remain one REPL evaluation.",
            "answer",
          ].join("\n"),
          context("agent-a"),
        ),
      ).resolves.toBe("41");
      await expect(
        registry.evaluate("answer + 1", context("agent-a")),
      ).resolves.toBe("42");
    } finally {
      registry.dispose();
    }
  });

  it("strictly isolates kernels by the Stella computer session identity", async () => {
    const registry = createRegistry();
    try {
      await registry.evaluate(
        "const ownerSecret = 'alpha'",
        context("agent-a"),
      );
      await expect(
        registry.evaluate("ownerSecret", context("agent-b")),
      ).rejects.toThrow("ownerSecret is not defined");
      await expect(
        registry.evaluate("ownerSecret", context("agent-a")),
      ).resolves.toBe("'alpha'");
    } finally {
      registry.dispose();
    }
  });

  it("reuses conversation-scoped browser ownership across root run kernels", async () => {
    const browserOptions: BrowserSessionOptions[] = [];
    const registry = new NodeReplKernelRegistry({
      sessionFactory: defaultSessionFactory,
      idleTimeoutMs: 60_000,
      browserSessionFactory: (options) => {
        browserOptions.push(options);
        return {
          command: vi.fn(),
          chain: vi.fn(),
          dispose: vi.fn(async () => undefined),
        } as unknown as BrowserSessionClient;
      },
    });

    try {
      await expect(registry.evaluate("1", rootContext("run-1"))).resolves.toBe(
        "1",
      );
      await expect(registry.evaluate("2", rootContext("run-2"))).resolves.toBe(
        "2",
      );

      expect(browserOptions).toHaveLength(2);
      expect(browserOptions.map(({ sessionId }) => sessionId)).toEqual([
        "orchestrator-conversation-conversation-1",
        "orchestrator-conversation-conversation-1",
      ]);
    } finally {
      await registry.dispose();
    }
  });

  it("routes browser.use through the session client and persists the selected backend in the worker", async () => {
    const selectBackend = vi.fn(async (backend: "in-app" | "external") => ({
      backend,
    }));
    const registry = new NodeReplKernelRegistry({
      sessionFactory: defaultSessionFactory,
      idleTimeoutMs: 60_000,
      browserSessionFactory: () =>
        ({
          command: vi.fn(),
          chain: vi.fn(),
          selectBackend,
          dispose: vi.fn(async () => undefined),
        }) as unknown as BrowserSessionClient,
    });

    try {
      await expect(
        registry.evaluate(
          'await browser.use("external"); browser.backend',
          context("external-browser-owner"),
        ),
      ).resolves.toBe("'external'");
      await expect(
        registry.evaluate("browser.backend", context("external-browser-owner")),
      ).resolves.toBe("'external'");
      expect(selectBackend).toHaveBeenCalledOnce();
      expect(selectBackend).toHaveBeenCalledWith("external");
    } finally {
      await registry.dispose();
    }
  });

  it("serializes evaluations within one kernel", async () => {
    const registry = createRegistry();
    try {
      const first = registry.evaluate(
        "const order = []; await new Promise((resolve) => setTimeout(resolve, 20)); order.push('first')",
        context("agent-a"),
      );
      const second = registry.evaluate(
        "order.push('second'); order",
        context("agent-a"),
      );
      await first;
      await expect(second).resolves.toBe("[ 'first', 'second' ]");
    } finally {
      registry.dispose();
    }
  });

  it("serializes concurrent sky calls and keeps a batch atomic", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const requests: ComputerUseRequest[] = [];
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const request = vi.fn(async (typedRequest: ComputerUseRequest) => {
      requests.push(typedRequest);
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      try {
        if (requests.length === 1) await firstGate;
        return responseFor(typedRequest);
      } finally {
        activeRequests -= 1;
      }
    });
    const registry = new NodeReplKernelRegistry({
      sessionFactory: () => ({ request }),
      idleTimeoutMs: 60_000,
    });
    try {
      const pending = registry.evaluate(
        [
          "await Promise.all([",
          "  sky.batch([",
          "    { type: 'click', app: 'Notes', element_index: 1, state_id: 'known-notes-state' },",
          "    { type: 'set_value', app: 'Notes', element_index: 2, value: 'done', state_id: 'known-notes-state' },",
          "  ]),",
          "  sky.press_key({ app: 'Notes', key: 'ENTER', state_id: 'known-notes-state' }),",
          "])",
        ].join("\n"),
        context("agent-serialized"),
      );

      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      releaseFirst();
      await pending;

      expect(maxActiveRequests).toBe(1);
      expect(requests.map(({ type }) => type)).toEqual([
        "resolve_target",
        "batch",
        "resolve_target",
        "action",
      ]);
      const batches = requests.filter(
        (candidate) => candidate.type === "batch",
      );
      expect(batches).toHaveLength(1);
      expect(batches[0]?.commands).toHaveLength(2);
    } finally {
      releaseFirst();
      registry.dispose();
    }
  });

  it("exposes one persistent browser client with reusable tabs and locators", async () => {
    const command = vi.fn(
      async (action: string, params: Record<string, unknown> = {}) => {
        const data =
          action === "tab_new"
            ? { tabId: 101, index: 0, total: 1 }
            : action === "title"
              ? { title: "Saved profile" }
              : { action, params };
        return {
          sessionId: "agent-browser",
          bridgeSessionId: "stella-app-bridge",
          requestId: `request-${command.mock.calls.length}`,
          action,
          params,
          result: { id: "response", success: true as const, data },
          attempts: 1,
          durationMs: 1,
        };
      },
    );
    const dispose = vi.fn(async () => undefined);
    const beginTurn = vi.fn();
    const endTurn = vi.fn(async () => undefined);
    const browserClient = {
      command,
      chain: vi.fn(),
      beginTurn,
      endTurn,
      dispose,
    } as unknown as BrowserSessionClient;
    const browserOptions: BrowserSessionOptions[] = [];
    const registry = new NodeReplKernelRegistry({
      sessionFactory: defaultSessionFactory,
      browserBinPath: "/runtime/stella-browser.js",
      idleTimeoutMs: 60_000,
      browserSessionFactory: (options) => {
        browserOptions.push(options);
        return browserClient;
      },
    });

    try {
      await expect(
        registry.evaluate(
          [
            "const tab = await browser.tabs.new('https://example.com/profile')",
            "const nameInput = tab.playwright.getByLabel('Name')",
            "await nameInput.fill('Rahul')",
            "await tab.playwright.getByRole('button', { name: 'Save' }).click()",
            "tab.id",
          ].join("; "),
          context("agent-browser"),
        ),
      ).resolves.toContain("101\n[browser-receipt] calls=3 mutated=true");
      await expect(
        registry.evaluate("await tab.title()", context("agent-browser")),
      ).resolves.toContain(
        "'Saved profile'\n[browser-receipt] calls=1 mutated=false last=title",
      );

      expect(browserOptions).toHaveLength(1);
      expect(browserOptions[0]).toMatchObject({
        binaryPath: "/runtime/stella-browser.js",
        cwd: TEST_WORKSPACE_ROOT,
        sessionId: "general-task-agent-browser",
        ownerLeaseId: expect.any(String),
        ownerLeaseIssuedAt: expect.any(Number),
      });
      expect(command.mock.calls.map(([action]) => action)).toEqual([
        "tab_new",
        "fill",
        "click",
        "tab_list",
        "title",
      ]);
      expect(command.mock.calls[1]?.[1]).toMatchObject({
        tabId: 101,
        selector: expect.stringContaining("aria="),
        value: "Rahul",
      });
      expect(command.mock.calls[2]?.[1]).toMatchObject({
        tabId: 101,
        selector: expect.stringContaining("aria="),
      });
      expect(beginTurn).toHaveBeenCalledWith("run-1");
      await registry.endBrowserTurn("run-1", "close-tabs");
      expect(endTurn).toHaveBeenCalledOnce();
      expect(endTurn).toHaveBeenCalledWith("run-1", "close-tabs");
    } finally {
      await registry.dispose();
    }
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps the browser session alive after a recoverable REPL syntax error", async () => {
    const command = vi.fn(async (action: string) => ({
      sessionId: "syntax-owner",
      bridgeSessionId: "bridge",
      requestId: `request-${command.mock.calls.length}`,
      action,
      params: {},
      result: {
        id: "response",
        success: true as const,
        data:
          action === "tab_new"
            ? { tabId: 91, index: 0, total: 1 }
            : {
                tabs: [{ tabId: 91, url: "about:blank", active: true }],
                activeTabId: 91,
              },
      },
      attempts: 1,
      durationMs: 1,
    }));
    const dispose = vi.fn(async () => undefined);
    const registry = new NodeReplKernelRegistry({
      sessionFactory: defaultSessionFactory,
      idleTimeoutMs: 60_000,
      browserSessionFactory: () =>
        ({
          command,
          chain: vi.fn(),
          dispose,
        }) as unknown as BrowserSessionClient,
    });

    try {
      await registry.evaluate(
        "const syntaxTabs = [await browser.tabs.new()]",
        context("syntax-owner"),
      );
      await expect(
        registry.evaluate("const syntaxTabs = []", context("syntax-owner")),
      ).rejects.toThrow("Identifier 'syntaxTabs' has already been declared");
      await expect(
        registry.evaluate(
          "(await browser.tabs.list()).map(tab => tab.id)",
          context("syntax-owner"),
        ),
      ).resolves.toContain("91");
      expect(dispose).not.toHaveBeenCalled();
    } finally {
      await registry.dispose();
    }
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps the same REPL bindings after BrowserSessionCommandError", async () => {
    const browserSessionFactory = vi.fn(() => {
      const command = vi.fn(async (action: string) => {
        if (action === "title") {
          throw new BrowserSessionCommandError(
            "command_failed",
            "Element is covered by another element",
            { requestId: "browser-request-1", action },
          );
        }
        return {
          sessionId: "recoverable-browser-owner",
          bridgeSessionId: "bridge",
          requestId: "browser-request-2",
          action,
          params: {},
          result: { id: "response", success: true as const, data: {} },
          attempts: 1,
          durationMs: 1,
        };
      });
      return {
        command,
        chain: vi.fn(),
        dispose: vi.fn(async () => undefined),
      } as unknown as BrowserSessionClient;
    });
    const registry = new NodeReplKernelRegistry({
      sessionFactory: defaultSessionFactory,
      idleTimeoutMs: 60_000,
      browserSessionFactory,
    });

    try {
      await expect(
        registry.evaluate(
          "const bindingBeforeBrowserFailure = 73",
          context("recoverable-browser-owner"),
        ),
      ).resolves.toBe("");
      await expect(
        registry.evaluate(
          "await browser.tabs.get(7).title()",
          context("recoverable-browser-owner"),
        ),
      ).rejects.toThrow("Element is covered by another element");
      await expect(
        registry.evaluate(
          "bindingBeforeBrowserFailure",
          context("recoverable-browser-owner"),
        ),
      ).resolves.toBe("73");
      expect(browserSessionFactory).toHaveBeenCalledOnce();
      const browserClient = browserSessionFactory.mock.results[0]?.value;
      expect(browserClient?.dispose).not.toHaveBeenCalled();
    } finally {
      await registry.dispose();
    }
  });

  it("offers extension connection once and retries the direct browser call", async () => {
    const command = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "Extension not connected. Install the Stella Browser Bridge extension and connect it.",
        ),
      )
      .mockResolvedValueOnce({
        sessionId: "agent-connect",
        bridgeSessionId: "stella-app-bridge",
        requestId: "request-2",
        action: "tab_list",
        params: {},
        result: {
          id: "response-2",
          success: true,
          data: { tabs: [], activeTabId: null },
        },
        attempts: 1,
        durationMs: 1,
      });
    const requestBrowserExtensionConnect = vi.fn(async () => ({
      ok: true as const,
      status: "connected" as const,
    }));
    const registry = new NodeReplKernelRegistry({
      sessionFactory: defaultSessionFactory,
      idleTimeoutMs: 60_000,
      requestBrowserExtensionConnect,
      browserSessionFactory: () =>
        ({
          command,
          chain: vi.fn(),
          dispose: vi.fn(async () => undefined),
        }) as unknown as BrowserSessionClient,
    });

    try {
      await expect(
        registry.evaluate(
          "await browser.tabs.list()",
          context("agent-connect"),
        ),
      ).resolves.toContain("[browser-receipt]");
      expect(command).toHaveBeenCalledTimes(2);
      expect(requestBrowserExtensionConnect).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "conversation-1",
          agentId: "agent-connect",
          command: "stella-browser node_repl",
        }),
        expect.any(AbortSignal),
      );
    } finally {
      await registry.dispose();
    }
  });

  it("captures one UI-only screenshot after the last successful visual action", async () => {
    const jpeg = Buffer.from("browser-presentation-image");
    const command = vi.fn(async (action: string) => {
      const data =
        action === "tab_list"
          ? {
              tabs: [
                {
                  tabId: 44,
                  title: "Receipt",
                  url: "https://user:password@example.test/account?token=secret#section",
                  active: true,
                },
              ],
              activeTabId: 44,
            }
          : action === "screenshot"
            ? { base64: jpeg.toString("base64"), format: "jpeg" }
            : { ok: true };
      return {
        sessionId: "agent-receipt",
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
      sessionFactory: defaultSessionFactory,
      idleTimeoutMs: 60_000,
      browserSessionFactory: () =>
        ({
          command,
          chain: vi.fn(),
          dispose: vi.fn(async () => undefined),
        }) as unknown as BrowserSessionClient,
    });
    try {
      const onResponseMeta = vi.fn();
      const output = await registry.evaluate(
        [
          "const receiptTab = browser.tabs.get(44)",
          "await receiptTab.playwright.getByRole('button', { name: 'Save' }).click()",
          "await receiptTab.playwright.getByLabel('Name').fill('Rahul')",
          "'done'",
        ].join("; "),
        context("agent-receipt"),
        { onResponseMeta },
      );
      expect(output).toContain(
        "[browser-receipt] calls=2 mutated=true tabs=1 activeTabId=44 last=fill",
      );
      expect(output).not.toContain("[stella-attach-image]");
      expect(command.mock.calls.map(([action]) => action)).toEqual([
        "click",
        "fill",
        "tab_list",
        "screenshot",
      ]);
      expect(command).toHaveBeenLastCalledWith(
        "screenshot",
        { tabId: 44, format: "jpeg" },
        { signal: expect.any(AbortSignal) },
      );
      expect(onResponseMeta).toHaveBeenCalledTimes(1);
      expect(onResponseMeta).toHaveBeenCalledWith({
        "stella/browserUse": true,
        "stella/toolSurface": {
          kind: "browserUse",
          backend: "iab",
          browserId: "general-task-agent-receipt",
          openTabIds: ["44"],
          sessionEnded: false,
          screenshot: {
            tabId: "44",
            url: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
            pageUrl: "https://example.test",
          },
        },
        browser_use: { url: "https://example.test/account" },
      });
    } finally {
      await registry.dispose();
    }
  });

  it("uses a bound handle's backend for post-cell tab state and preview metadata", async () => {
    const jpeg = Buffer.from("bound-backend-presentation");
    const command = vi.fn(async (action: string) => {
      const data =
        action === "tab_list"
          ? {
              tabs: [
                {
                  tabId: 44,
                  url: "https://example.test/in-app",
                  active: true,
                },
              ],
              activeTabId: 44,
            }
          : action === "screenshot"
            ? { base64: jpeg.toString("base64"), format: "jpeg" }
            : { ok: true };
      return {
        sessionId: "agent-bound-preview",
        bridgeSessionId: "stella-app-bridge",
        requestId: `request-${command.mock.calls.length}`,
        action,
        params: {},
        result: { id: "response", success: true as const, data },
        attempts: 1,
        durationMs: 1,
      };
    });
    const chain = vi.fn(async () => ({
      sessionId: "agent-bound-preview",
      bridgeSessionId: "stella-app-bridge",
      requestId: "request-chain",
      action: "chain",
      params: {},
      result: {
        id: "response-chain",
        success: true as const,
        data: {
          results: [
            { step: 0, action: "evaluate", success: true, data: true },
            {
              step: 1,
              action: "click",
              success: true,
              data: { clicked: true },
            },
          ],
          completed: 2,
          total: 2,
          totalDurationMs: 1,
        },
      },
      attempts: 1,
      durationMs: 1,
    }));
    const selectBackend = vi.fn(async (backend: "in-app" | "external") => ({
      backend,
    }));
    const registry = new NodeReplKernelRegistry({
      sessionFactory: defaultSessionFactory,
      idleTimeoutMs: 60_000,
      browserSessionFactory: () =>
        ({
          command,
          chain,
          selectBackend,
          dispose: vi.fn(async () => undefined),
        }) as unknown as BrowserSessionClient,
    });
    try {
      const onResponseMeta = vi.fn();
      await registry.evaluate(
        [
          "var boundTab = browser.tabs.get(44)",
          "await browser.use('external')",
          "await boundTab.playwright.locator('.row').filter({hasText: 'Save'}).click()",
        ].join("; "),
        context("agent-bound-preview"),
        { onResponseMeta },
      );

      expect(selectBackend).toHaveBeenCalledWith("external");
      expect(selectBackend).toHaveBeenCalledTimes(1);
      expect(chain).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ action: "evaluate" }),
          expect.objectContaining({ action: "click" }),
        ]),
        expect.objectContaining({
          __stellaBrowserBackend: "in-app",
          abortOnError: false,
          waitForSelector: false,
        }),
      );
      expect(command.mock.calls.map(([action]) => action)).toEqual([
        "evaluate",
        "tab_list",
        "screenshot",
      ]);
      for (const index of [0, 1, 2]) {
        expect(command.mock.calls[index]?.[1]).toMatchObject({
          __stellaBrowserBackend: "in-app",
        });
      }
      expect(onResponseMeta).toHaveBeenCalledWith(
        expect.objectContaining({
          "stella/toolSurface": expect.objectContaining({
            backend: "iab",
            screenshot: expect.objectContaining({ tabId: "44" }),
          }),
        }),
      );
    } finally {
      await registry.dispose();
    }
  });

  it("captures the newly active tab after a successful tab close", async () => {
    const jpeg = Buffer.from("post-close-active-tab");
    const command = vi.fn(async (action: string) => {
      const data =
        action === "tab_list"
          ? {
              tabs: [
                { tabId: 55, active: true, url: "https://example.test/next" },
              ],
              activeTabId: 55,
            }
          : action === "screenshot"
            ? { base64: jpeg.toString("base64"), format: "jpeg" }
            : { ok: true };
      return {
        sessionId: "agent-close-presentation",
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
      sessionFactory: defaultSessionFactory,
      idleTimeoutMs: 60_000,
      browserSessionFactory: () =>
        ({
          command,
          chain: vi.fn(),
          dispose: vi.fn(async () => undefined),
        }) as unknown as BrowserSessionClient,
    });
    try {
      const onResponseMeta = vi.fn();
      await registry.evaluate(
        "await browser.tabs.get(44).close()",
        context("agent-close-presentation"),
        { onResponseMeta },
      );

      expect(command.mock.calls.map(([action]) => action)).toEqual([
        "tab_close",
        "tab_list",
        "screenshot",
      ]);
      expect(command).toHaveBeenLastCalledWith(
        "screenshot",
        { tabId: 55, format: "jpeg" },
        { signal: expect.any(AbortSignal) },
      );
      expect(onResponseMeta.mock.calls[0]?.[0]).toMatchObject({
        "stella/toolSurface": {
          openTabIds: ["55"],
          screenshot: {
            tabId: "55",
            url: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
          },
        },
      });
    } finally {
      await registry.dispose();
    }
  });

  it("does not fall back to another tab when a visual action target vanishes", async () => {
    const command = vi.fn(async (action: string) => {
      const data =
        action === "tab_list"
          ? {
              tabs: [
                { tabId: 55, active: true, url: "https://example.test/next" },
              ],
              activeTabId: 55,
            }
          : { ok: true };
      return {
        sessionId: "agent-vanished-presentation",
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
      sessionFactory: defaultSessionFactory,
      idleTimeoutMs: 60_000,
      browserSessionFactory: () =>
        ({
          command,
          chain: vi.fn(),
          dispose: vi.fn(async () => undefined),
        }) as unknown as BrowserSessionClient,
    });
    try {
      const onResponseMeta = vi.fn();
      await registry.evaluate(
        "await browser.tabs.get(44).playwright.locator('#save').click()",
        context("agent-vanished-presentation"),
        { onResponseMeta },
      );

      expect(command.mock.calls.map(([action]) => action)).toEqual([
        "click",
        "tab_list",
      ]);
      expect(onResponseMeta).toHaveBeenCalledWith({
        "stella/browserUse": true,
        "stella/toolSurface": {
          kind: "browserUse",
          backend: "iab",
          browserId: "general-task-agent-vanished-presentation",
          openTabIds: ["55"],
          sessionEnded: false,
        },
      });
    } finally {
      await registry.dispose();
    }
  });

  it("does not capture or attach a screenshot when a browser action fails", async () => {
    const command = vi.fn(async (action: string) => {
      if (action === "click") throw new Error("Element is covered");
      return {
        sessionId: "agent-browser-failure",
        bridgeSessionId: "stella-app-bridge",
        requestId: `request-${command.mock.calls.length}`,
        action,
        params: {},
        result: { id: "response", success: true as const, data: {} },
        attempts: 1,
        durationMs: 1,
      };
    });
    const registry = new NodeReplKernelRegistry({
      sessionFactory: defaultSessionFactory,
      idleTimeoutMs: 60_000,
      browserSessionFactory: () =>
        ({
          command,
          chain: vi.fn(),
          dispose: vi.fn(async () => undefined),
        }) as unknown as BrowserSessionClient,
    });
    try {
      const onResponseMeta = vi.fn();
      const error = await registry
        .evaluate(
          "await browser.tabs.get(44).playwright.locator('#save').click()",
          context("agent-browser-failure"),
          { onResponseMeta },
        )
        .catch((cause: unknown) => cause as Error);
      expect(error.message).toContain("Element is covered");
      expect(error.message).not.toContain("[stella-attach-image]");
      expect(command.mock.calls.map(([action]) => action)).toEqual([
        "click",
        "evaluate",
      ]);
      expect(onResponseMeta).not.toHaveBeenCalled();
    } finally {
      await registry.dispose();
    }
  });

  it("captures after the last successful visual action when a later command fails", async () => {
    const jpeg = Buffer.from("successful-action-before-failure");
    const command = vi.fn(async (action: string) => {
      if (action === "click") throw new Error("Later click failed");
      const data =
        action === "tab_list"
          ? {
              tabs: [
                { tabId: 44, active: true, url: "https://example.test/form" },
              ],
              activeTabId: 44,
            }
          : action === "screenshot"
            ? { base64: jpeg.toString("base64"), format: "jpeg" }
            : { ok: true };
      return {
        sessionId: "agent-visual-before-failure",
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
      sessionFactory: defaultSessionFactory,
      idleTimeoutMs: 60_000,
      browserSessionFactory: () =>
        ({
          command,
          chain: vi.fn(),
          dispose: vi.fn(async () => undefined),
        }) as unknown as BrowserSessionClient,
    });
    try {
      const onResponseMeta = vi.fn();
      const error = await registry
        .evaluate(
          [
            "const tab = browser.tabs.get(44)",
            "await tab.playwright.locator('#name').fill('Rahul')",
            "await tab.playwright.locator('#save').click()",
          ].join("; "),
          context("agent-visual-before-failure"),
          { onResponseMeta },
        )
        .catch((cause: unknown) => cause as Error);

      expect(error.message).toContain("Later click failed");
      expect(error.message).not.toContain("[stella-attach-image]");
      expect(command.mock.calls.map(([action]) => action)).toEqual([
        "fill",
        "click",
        "evaluate",
        "tab_list",
        "screenshot",
      ]);
      expect(onResponseMeta).toHaveBeenCalledTimes(1);
      expect(onResponseMeta.mock.calls[0]?.[0]).toMatchObject({
        "stella/toolSurface": {
          screenshot: {
            tabId: "44",
            url: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
          },
        },
      });
    } finally {
      await registry.dispose();
    }
  });

  it("lets finalized browser lifecycle metadata supersede a visual screenshot", async () => {
    const command = vi.fn(async (action: string) => ({
      sessionId: "agent-finalize-browser",
      bridgeSessionId: "stella-app-bridge",
      requestId: `request-${command.mock.calls.length}`,
      action,
      params: {},
      result: { id: "response", success: true as const, data: { ok: true } },
      attempts: 1,
      durationMs: 1,
    }));
    const registry = new NodeReplKernelRegistry({
      sessionFactory: defaultSessionFactory,
      idleTimeoutMs: 60_000,
      browserSessionFactory: () =>
        ({
          command,
          chain: vi.fn(),
          dispose: vi.fn(async () => undefined),
        }) as unknown as BrowserSessionClient,
    });
    try {
      const onResponseMeta = vi.fn();
      const output = await registry.evaluate(
        [
          "const tab = browser.tabs.get(44)",
          "await tab.playwright.locator('#save').click()",
          "await browser.tabs.finalize()",
        ].join("; "),
        context("agent-finalize-browser"),
        { onResponseMeta },
      );

      expect(output).toContain(
        "[browser-receipt] calls=2 mutated=true last=finalize_tabs",
      );
      expect(command.mock.calls.map(([action]) => action)).toEqual([
        "click",
        "finalize_tabs",
      ]);
      expect(onResponseMeta).toHaveBeenCalledWith({
        "stella/browserUse": true,
        "stella/toolSurface": {
          kind: "browserUse",
          backend: "iab",
          browserId: "general-task-agent-finalize-browser",
          openTabIds: [],
          sessionEnded: true,
        },
      });
    } finally {
      await registry.dispose();
    }
  });

  it("still attaches screenshots explicitly requested by the caller", async () => {
    const jpeg = Buffer.from("explicit-browser-image");
    const command = vi.fn(async (action: string) => ({
      sessionId: "agent-explicit-screenshot",
      bridgeSessionId: "stella-app-bridge",
      requestId: "request-explicit-screenshot",
      action,
      params: {},
      result: {
        id: "response",
        success: true as const,
        data: { base64: jpeg.toString("base64"), format: "jpeg" },
      },
      attempts: 1,
      durationMs: 1,
    }));
    const registry = new NodeReplKernelRegistry({
      sessionFactory: defaultSessionFactory,
      idleTimeoutMs: 60_000,
      browserSessionFactory: () =>
        ({
          command,
          chain: vi.fn(),
          dispose: vi.fn(async () => undefined),
        }) as unknown as BrowserSessionClient,
    });
    try {
      const onResponseMeta = vi.fn();
      const output = await registry.evaluate(
        "await browser.tabs.get(44).screenshot({ format: 'jpeg' })",
        context("agent-explicit-screenshot"),
        { onResponseMeta },
      );
      expect(output).toContain("[stella-attach-image]");
      expect(command.mock.calls.map(([action]) => action)).toEqual([
        "screenshot",
      ]);
      expect(onResponseMeta).not.toHaveBeenCalled();
    } finally {
      await registry.dispose();
    }
  });

  it("does not auto-attach screenshots for page evaluation or network work", async () => {
    const command = vi.fn(async (action: string) => ({
      sessionId: "agent-nonvisual-browser",
      bridgeSessionId: "stella-app-bridge",
      requestId: `request-${command.mock.calls.length}`,
      action,
      params: {},
      result: {
        id: "response",
        success: true as const,
        data:
          action === "evaluate"
            ? { result: 42 }
            : action === "requests"
              ? { requests: [] }
              : { ok: true },
      },
      attempts: 1,
      durationMs: 1,
    }));
    const registry = new NodeReplKernelRegistry({
      sessionFactory: defaultSessionFactory,
      idleTimeoutMs: 60_000,
      browserSessionFactory: () =>
        ({
          command,
          chain: vi.fn(),
          dispose: vi.fn(async () => undefined),
        }) as unknown as BrowserSessionClient,
    });

    try {
      const onResponseMeta = vi.fn();
      const output = await registry.evaluate(
        [
          "const nonvisualTab = browser.tabs.get(44)",
          "await nonvisualTab.playwright.evaluate(() => 42)",
          "await nonvisualTab.network.requests()",
          "'done'",
        ].join("; "),
        context("agent-nonvisual-browser"),
        { onResponseMeta },
      );
      expect(output).not.toContain("[stella-attach-image]");
      expect(command.mock.calls.map(([action]) => action)).toEqual([
        "evaluate",
        "requests",
        "tab_list",
      ]);
      expect(command).not.toHaveBeenCalledWith(
        "screenshot",
        expect.anything(),
        expect.anything(),
      );
      expect(onResponseMeta).not.toHaveBeenCalled();
    } finally {
      await registry.dispose();
    }
  });

  it("does not capture for successful actions outside the visual allowlist", async () => {
    const command = vi.fn(async (action: string) => ({
      sessionId: "agent-nonvisual-actions",
      bridgeSessionId: "stella-app-bridge",
      requestId: `request-${command.mock.calls.length}`,
      action,
      params: {},
      result: {
        id: "response",
        success: true as const,
        data:
          action === "tab_list"
            ? {
                tabs: [
                  {
                    tabId: 44,
                    active: true,
                    url: "https://example.test",
                  },
                ],
                activeTabId: 44,
              }
            : { ok: true },
      },
      attempts: 1,
      durationMs: 1,
    }));
    const registry = new NodeReplKernelRegistry({
      sessionFactory: defaultSessionFactory,
      idleTimeoutMs: 60_000,
      browserSessionFactory: () =>
        ({
          command,
          chain: vi.fn(),
          dispose: vi.fn(async () => undefined),
        }) as unknown as BrowserSessionClient,
    });

    try {
      const onResponseMeta = vi.fn();
      const output = await registry.evaluate(
        [
          "const tab = browser.tabs.get(44)",
          "await tab.playwright.locator('#save').hover()",
          "await tab.playwright.locator('#save').focus()",
          "await tab.playwright.locator('#save').scrollIntoViewIfNeeded()",
          "'done'",
        ].join("; "),
        context("agent-nonvisual-actions"),
        { onResponseMeta },
      );

      expect(output).not.toContain("[stella-attach-image]");
      expect(command.mock.calls.map(([action]) => action)).toEqual([
        "hover",
        "focus",
        "scrollintoview",
        "tab_list",
      ]);
      expect(onResponseMeta).not.toHaveBeenCalled();
    } finally {
      await registry.dispose();
    }
  });

  it("aborts an in-flight sky call without starting queued calls", async () => {
    const controller = new AbortController();
    const request = vi.fn(
      async (
        _request: ComputerUseRequest,
        options?: ComputerUseSessionRequestOptions,
      ): Promise<unknown> =>
        await new Promise((_resolve, reject) => {
          const onAbort = () =>
            reject(
              options?.signal?.reason instanceof Error
                ? options.signal.reason
                : new Error("aborted"),
            );
          options?.signal?.addEventListener("abort", onAbort, { once: true });
          if (options?.signal?.aborted) onAbort();
        }),
    );
    const registry = new NodeReplKernelRegistry({
      sessionFactory: () => ({ request }),
      idleTimeoutMs: 60_000,
    });
    try {
      const pending = registry.evaluate(
        "await Promise.all([sky.click({ app: 'Notes', element_index: 1, state_id: 'known-state' }), sky.click({ app: 'Notes', element_index: 2, state_id: 'known-state' })])",
        context("agent-cancelled"),
        { signal: controller.signal },
      );
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      controller.abort(new Error("cancel concurrent sky calls"));
      await expect(pending).rejects.toThrow("cancel concurrent sky calls");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      registry.dispose();
    }
  });

  it("exposes frozen metadata and emits file URL screenshots as Stella markers", async () => {
    const registry = createRegistry();
    try {
      const output = await registry.evaluate(
        [
          "nodeRepl.write(nodeRepl.cwd)",
          "nodeRepl.write(nodeRepl.homeDir === nodeRepl.home, nodeRepl.tmpDir === nodeRepl.tmp)",
          "nodeRepl.write(Object.isFrozen(sky))",
          "nodeRepl.write(JSON.stringify(nodeRepl.status()))",
          "nodeRepl.write(nodeRepl.help('bindings'))",
          "nodeRepl.write(nodeRepl.emitImage({ attached: true, path: '/tmp/already.png' }))",
          "await nodeRepl.emitImage('file:///tmp/screen%20shot.png')",
        ].join("; "),
        context("agent-a"),
      );
      expect(output).toContain(TEST_WORKSPACE_ROOT);
      expect(output).toContain("true true");
      expect(output).toContain('"generation":1');
      expect(output).toContain("Use var for names you may redeclare");
      expect(output).toContain("{ type: 'image'");
      expect(output).toContain("attached: true");
      expect(output.match(/\[stella-attach-image\]/g)).toHaveLength(1);
      expect(output).toContain(
        `[stella-attach-image] path=${JSON.stringify("/tmp/screen shot.png")}`,
      );
    } finally {
      registry.dispose();
    }
  });

  it("keeps text, image, and audio output typed until the compatibility boundary", async () => {
    const registry = createRegistry();
    try {
      const result = await registry.evaluateDetailed(
        [
          "nodeRepl.write('hello')",
          "nodeRepl.emitImage('/tmp/image.png', { mimeType: 'image/png', detail: 'original' })",
          "nodeRepl.emitAudio('/tmp/audio.mp3', { mimeType: 'audio/mpeg' })",
          "'done'",
        ].join("; "),
        context("agent-typed-content"),
      );
      expect(result.content).toEqual([
        { type: "text", text: "hello" },
        {
          type: "image",
          path: "/tmp/image.png",
          mimeType: "image/png",
          detail: "original",
        },
        { type: "audio", path: "/tmp/audio.mp3", mimeType: "audio/mpeg" },
        { type: "text", text: "'done'" },
      ]);
      expect(result.output).toContain(
        '[stella-attach-image] inline=image/png detail=original path="/tmp/image.png"',
      );
      expect(result.output).toContain(
        '[node-repl-audio] mime=audio/mpeg path="/tmp/audio.mp3"',
      );
    } finally {
      await registry.dispose();
    }
  });

  it("resets explicitly with generation metadata and discards bindings", async () => {
    const registry = createRegistry();
    try {
      const reset = await registry.evaluate(
        "var beforeReset = 42; nodeRepl.reset()",
        context("agent-reset"),
      );
      expect(reset).toContain("previousGeneration: 1");
      expect(reset).toContain("nextGeneration: 2");
      expect(reset).toContain("bindingsDiscarded: true");

      const status = await registry.evaluate(
        "nodeRepl.status()",
        context("agent-reset"),
      );
      expect(status).toContain("generation: 2");
      await expect(
        registry.evaluate("beforeReset", context("agent-reset")),
      ).rejects.toThrow("beforeReset is not defined");
    } finally {
      await registry.dispose();
    }
  });

  it("commits an explicit reset when the same evaluation later throws", async () => {
    const registry = createRegistry();
    try {
      const failed = await registry.startCell(
        "var discardedAfterResetError = 42; nodeRepl.reset(); throw new Error('failure after reset')",
        context("agent-reset-error"),
        { yieldTimeMs: 2_000 },
      );
      expect(failed).toMatchObject({
        status: "failed",
        generation: 1,
        error: expect.stringContaining("failure after reset"),
        reset: {
          reason: "explicit",
          previousGeneration: 1,
          nextGeneration: 2,
          bindingsDiscarded: true,
        },
      });
      await expect(
        registry.evaluate("nodeRepl.status()", context("agent-reset-error")),
      ).resolves.toContain("generation: 2");
      await expect(
        registry.evaluate(
          "typeof discardedAfterResetError",
          context("agent-reset-error"),
        ),
      ).resolves.toBe("'undefined'");
    } finally {
      await registry.dispose();
    }
  });

  it("transfers reset-closing browser screenshots before kernel cleanup", async () => {
    const png = Buffer.from("kernel-owned-browser-screenshot");
    const command = vi.fn(async (action: string) => ({
      sessionId: "agent-screenshot-reset",
      bridgeSessionId: "stella-app-bridge",
      requestId: `request-${command.mock.calls.length}`,
      action,
      params: {},
      result: {
        id: "response",
        success: true as const,
        data: { base64: png.toString("base64"), format: "png" },
      },
      attempts: 1,
      durationMs: 1,
    }));
    const registry = new NodeReplKernelRegistry({
      sessionFactory: defaultSessionFactory,
      idleTimeoutMs: 60_000,
      browserSessionFactory: () =>
        ({
          command,
          chain: vi.fn(),
          dispose: vi.fn(async () => undefined),
        }) as unknown as BrowserSessionClient,
    });
    let screenshotPath: string | undefined;
    try {
      const result = await registry.evaluateDetailed(
        "await browser.tabs.get(44).screenshot({ format: 'png' }); nodeRepl.reset()",
        context("agent-screenshot-reset"),
      );
      const image = result.content.find((item) => item.type === "image");
      expect(image).toMatchObject({
        type: "image",
        mimeType: "image/png",
        deleteAfterAttach: true,
      });
      if (!image || image.type !== "image") {
        throw new Error("Expected a typed browser screenshot.");
      }
      screenshotPath = image.path;

      // Starting the next generation guarantees the reset-closing kernel has
      // handed off the result. Its temp cleanup must no longer own this file.
      await expect(
        registry.evaluate(
          "nodeRepl.status()",
          context("agent-screenshot-reset"),
        ),
      ).resolves.toContain("generation: 2");
      await expect(readFile(screenshotPath)).resolves.toEqual(png);
    } finally {
      await registry.dispose();
      if (screenshotPath) await rm(screenshotPath, { force: true });
    }
  });

  it("times out async evaluations, drops the kernel, and cleans up idle kernels", async () => {
    const registry = createRegistry(15);
    try {
      await expect(
        registry.evaluate("await new Promise(() => {})", context("agent-a"), {
          timeoutMs: 10,
        }),
      ).rejects.toThrow(
        /timed out.*reason=timeout generation=1 previousGeneration=1 nextGeneration=2 bindingsDiscarded=true/,
      );
      await registry.evaluate("const afterTimeout = 1", context("agent-a"));
      await new Promise((resolve) => setTimeout(resolve, 30));
      await expect(
        registry.evaluate("afterTimeout", context("agent-a")),
      ).rejects.toThrow("afterTimeout is not defined");
    } finally {
      registry.dispose();
    }
  });

  it("forcibly terminates a synchronous infinite loop without blocking other kernels", async () => {
    const registry = createRegistry();
    try {
      const startedAt = Date.now();
      await expect(
        registry.evaluate("while (true) {}", context("agent-a"), {
          timeoutMs: 50,
        }),
      ).rejects.toThrow("timed out");
      expect(Date.now() - startedAt).toBeLessThan(2_000);

      await expect(
        registry.evaluate("6 * 7", context("agent-b"), { timeoutMs: 1_000 }),
      ).resolves.toBe("42");
      await expect(
        registry.evaluate("typeof answer", context("agent-a"), {
          timeoutMs: 1_000,
        }),
      ).resolves.toBe("'undefined'");
    } finally {
      registry.dispose();
    }
  });

  it("drops a crashed worker and recreates its session kernel", async () => {
    const registry = createRegistry();
    try {
      await expect(
        registry.evaluate(
          "setImmediate(() => { throw new Error('intentional worker crash') }); await new Promise(() => {})",
          context("agent-a"),
          { timeoutMs: 1_000 },
        ),
      ).rejects.toThrow("intentional worker crash");
      await expect(
        registry.evaluate("40 + 2", context("agent-a"), {
          timeoutMs: 1_000,
        }),
      ).resolves.toBe("42");
    } finally {
      registry.dispose();
    }
  });

  it("routes the frozen sky client through one persistent typed session", async () => {
    const requests: ComputerUseRequest[] = [];
    const factoryOptions: ComputerUseSessionFactoryOptions[] = [];
    const sessionFactory = vi.fn(
      (options: ComputerUseSessionFactoryOptions): ComputerUseSession => {
        factoryOptions.push(options);
        return {
          request: async (request) => {
            requests.push(request);
            if (request.type === "get_app_state") {
              const response = responseFor(request);
              if (response.type !== "app_state") return response;
              return {
                ...response,
                state: {
                  ...response.state,
                  instructions: "Use Save.",
                  screenshot: {
                    type: "image" as const,
                    url: "file:///tmp/state%20image.png",
                  },
                },
              };
            }
            return responseFor(request);
          },
        };
      },
    );
    const authorizeApp = vi.fn(async () => false);
    const registry = new NodeReplKernelRegistry({
      sessionFactory,
      authorizeApp,
      idleTimeoutMs: 60_000,
    });
    try {
      const output = await registry.evaluate(
        [
          "const apps = await sky.list_apps()",
          "const firstState = await sky.get_app_state({ app: 'Notes' })",
          "const secondState = await sky.get_app_state({ app: 'Notes' })",
          "await sky.batch([{ type: 'click', app: 'Notes', element_index: 4, state_id: firstState.state_id }])",
          "nodeRepl.write(Object.isFrozen(sky), apps, firstState.screenshot.url)",
          "[firstState.text.includes('app_specific_instructions'), secondState.text.includes('app_specific_instructions')]",
        ].join("; "),
        context("agent-a"),
      );

      expect(output).toContain("true Notes file:///tmp/state%20image.png");
      expect(output).toContain("[ true, false ]");
      expect(requests.map(({ type }) => type)).toEqual([
        "list_apps",
        "resolve_target",
        "get_app_state",
        "resolve_target",
        "get_app_state",
        "resolve_target",
        "batch",
      ]);
      const batches = requests.filter((request) => request.type === "batch");
      expect(batches).toHaveLength(1);
      expect(batches[0]?.commands).toHaveLength(1);
      expect(authorizeApp).not.toHaveBeenCalled();
      expect(sessionFactory).toHaveBeenCalledTimes(1);
      expect(factoryOptions[0]).toMatchObject({
        sessionId: expect.stringContaining("agent-a"),
        cwd: TEST_WORKSPACE_ROOT,
        timeoutMs: 30_000,
        getSignal: expect.any(Function),
      });

      await expect(
        registry.evaluate("await sky.list_apps()", context("agent-a")),
      ).resolves.toBe("'Notes'");
      expect(sessionFactory).toHaveBeenCalledTimes(1);
    } finally {
      await registry.dispose();
    }
  });

  it("fails clearly when no typed session factory is configured", async () => {
    const registry = new NodeReplKernelRegistry();
    await expect(
      registry.evaluate("1", context("agent-no-session")),
    ).rejects.toThrow("requires a typed ComputerUseSession factory");
  });

  it("aborts an evaluation and drops its kernel", async () => {
    const registry = createRegistry();
    const controller = new AbortController();
    try {
      const pending = registry.evaluate(
        "const beforeAbort = true; await new Promise(() => {})",
        context("agent-a"),
        { signal: controller.signal },
      );
      controller.abort(new Error("cancelled by test"));
      await expect(pending).rejects.toThrow("cancelled by test");
      await expect(
        registry.evaluate("typeof beforeAbort", context("agent-a")),
      ).resolves.toBe("'undefined'");
    } finally {
      registry.dispose();
    }
  });

  it("keeps fs/path imports but blocks direct process spawning", async () => {
    const registry = createRegistry();
    try {
      await expect(
        registry.evaluate(
          "const pathModule = await import('node:path'); pathModule.basename('/a/b')",
          context("agent-a"),
        ),
      ).resolves.toBe("'b'");
      await expect(
        registry.evaluate(
          "await import('node:child_process')",
          context("agent-a"),
        ),
      ).rejects.toThrow("Direct process spawning is blocked");
    } finally {
      registry.dispose();
    }
  });

  it("blocks computed builtin imports and createRequire process bypasses", async () => {
    const registry = createRegistry();
    try {
      await expect(
        registry.evaluate(
          "const child = await import('node:' + 'child_process'); child.spawn('echo', ['unsafe'])",
          context("agent-a"),
        ),
      ).rejects.toThrow("Direct process access is blocked");
      await expect(
        registry.evaluate(
          "const threads = await import('node:' + 'worker_threads'); new threads.Worker('0', { eval: true })",
          context("agent-a"),
        ),
      ).rejects.toThrow("Direct process access is blocked");
      await expect(
        registry.evaluate(
          "const proc = await import('node:' + 'process'); proc.default.getBuiltinModule('child_process')",
          context("agent-a"),
        ),
      ).rejects.toThrow("Direct process access is blocked");
      await expect(
        registry.evaluate(
          [
            "const moduleBuiltin = await import('node:' + 'module')",
            "const computedRequire = moduleBuiltin.createRequire(nodeRepl.cwd + '/node-repl.cjs')",
            "computedRequire('node:' + 'child_process').execFile('echo', ['unsafe'])",
          ].join("; "),
          context("agent-a"),
        ),
      ).rejects.toThrow("Direct process access is blocked");
    } finally {
      registry.dispose();
    }
  });

  it("uses distinct long-lived evaluation, session, and idle defaults", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const factoryOptions: ComputerUseSessionFactoryOptions[] = [];
    const registry = new NodeReplKernelRegistry({
      sessionFactory: (options) => {
        factoryOptions.push(options);
        return defaultSessionFactory(options);
      },
    });
    try {
      await registry.evaluate(
        "await sky.list_apps()",
        context("agent-default-budgets"),
      );
      expect(factoryOptions[0]?.timeoutMs).toBe(30_000);
      expect(
        timeoutSpy.mock.calls.some(([, delay]) => delay === 11 * 60_000),
      ).toBe(true);
      expect(
        timeoutSpy.mock.calls.some(([, delay]) => delay === 4 * 60 * 60_000),
      ).toBe(true);
    } finally {
      registry.dispose();
      timeoutSpy.mockRestore();
    }
  });

  it("disposes each kernel session exactly once across closure paths", async () => {
    const explicitCleanup = vi.fn();
    const explicit = new NodeReplKernelRegistry({
      sessionFactory: defaultSessionFactory,
      disposeSession: explicitCleanup,
      idleTimeoutMs: 60_000,
    });
    await explicit.evaluate("1", context("agent-explicit"));
    explicit.dispose();
    explicit.dispose();
    expect(explicitCleanup).toHaveBeenCalledTimes(1);
    expect(explicitCleanup).toHaveBeenCalledWith(
      expect.stringContaining("agent-explicit"),
    );

    const idleCleanup = vi.fn();
    const idle = new NodeReplKernelRegistry({
      sessionFactory: defaultSessionFactory,
      disposeSession: idleCleanup,
      idleTimeoutMs: 10,
    });
    await idle.evaluate("1", context("agent-idle"));
    await vi.waitFor(() => expect(idleCleanup).toHaveBeenCalledTimes(1));
    idle.dispose();
    expect(idleCleanup).toHaveBeenCalledTimes(1);

    const timeoutCleanup = vi.fn();
    const timeout = new NodeReplKernelRegistry({
      sessionFactory: defaultSessionFactory,
      disposeSession: timeoutCleanup,
      idleTimeoutMs: 60_000,
    });
    await expect(
      timeout.evaluate("while (true) {}", context("agent-timeout"), {
        timeoutMs: 20,
      }),
    ).rejects.toThrow("timed out");
    expect(timeoutCleanup).toHaveBeenCalledTimes(1);
    timeout.dispose();
    expect(timeoutCleanup).toHaveBeenCalledTimes(1);

    const failureCleanup = vi.fn();
    const failure = new NodeReplKernelRegistry({
      sessionFactory: defaultSessionFactory,
      disposeSession: failureCleanup,
      idleTimeoutMs: 60_000,
    });
    await expect(
      failure.evaluate(
        "setImmediate(() => { throw new Error('cleanup crash') }); await new Promise(() => {})",
        context("agent-failure"),
      ),
    ).rejects.toThrow("cleanup crash");
    expect(failureCleanup).toHaveBeenCalledTimes(1);
    failure.dispose();
    expect(failureCleanup).toHaveBeenCalledTimes(1);
  });

  it("surfaces thrown non-Error values without waiting for timeout", async () => {
    const registry = createRegistry();
    try {
      await expect(
        registry.evaluate("throw 'plain failure'", context("agent-a")),
      ).rejects.toThrow("plain failure");
    } finally {
      registry.dispose();
    }
  });

  it("round-trips tools.$search through the host searchTools handler", async () => {
    const queries: Array<{ query: string; limit?: number }> = [];
    const registry = new NodeReplKernelRegistry({
      sessionFactory: defaultSessionFactory,
      idleTimeoutMs: 60_000,
      searchTools: (query, _context, limit) => {
        queries.push({ query, ...(limit !== undefined ? { limit } : {}) });
        return [
          {
            name: "example_send_message",
            signature:
              "tools.example_send_message(input: { parts: Array<unknown> }): Promise<unknown>",
            description: "Send an example connector message.",
          },
        ];
      },
    });
    try {
      const output = await registry.evaluate(
        "await tools.$search({ query: 'send an example', limit: 3 })",
        context("agent-search"),
      );
      expect(output).toContain("example_send_message");
      expect(output).toContain("tools.example_send_message(input:");
      expect(queries).toEqual([{ query: "send an example", limit: 3 }]);

      // Empty queries fail loudly instead of returning an ambiguous [].
      await expect(
        registry.evaluate(
          "await tools.$search({ query: '   ' })",
          context("agent-search"),
        ),
      ).rejects.toThrow("non-empty");
    } finally {
      await registry.dispose();
    }
  });

  it("round-trips tools.$describe(name) through its dedicated host handler", async () => {
    const calls: Array<{ name: string; cursor?: number }> = [];
    const registry = new NodeReplKernelRegistry({
      sessionFactory: defaultSessionFactory,
      idleTimeoutMs: 60_000,
      describeTool: (name, _context, cursor) => {
        calls.push({ name, ...(cursor !== undefined ? { cursor } : {}) });
        if (name !== "example_send_message") {
          throw new Error(`Tool "${name}" is unknown or unauthorized.`);
        }
        return {
          name,
          description: "Full untruncated description.",
          inputSchema: {
            type: "object",
            required: ["message"],
            properties: { message: { type: "string", minLength: 1 } },
          },
        };
      },
    });
    try {
      const output = await registry.evaluate(
        "await tools.$describe('example_send_message')",
        context("agent-describe"),
      );
      expect(output).toContain("Full untruncated description");
      expect(output).toContain("minLength: 1");
      expect(calls).toEqual([{ name: "example_send_message" }]);

      await expect(
        registry.evaluate(
          "await tools.$describe('not_authorized')",
          context("agent-describe"),
        ),
      ).rejects.toThrow("unknown or unauthorized");
    } finally {
      await registry.dispose();
    }
  });

  it("fails tools.$search clearly when no searchTools handler is configured", async () => {
    const registry = createRegistry();
    try {
      await expect(
        registry.evaluate(
          "await tools.$search({ query: 'anything' })",
          context("agent-search-none"),
        ),
      ).rejects.toThrow("tools.$search is not available in this session.");
    } finally {
      registry.dispose();
    }
  });

  it("refreshes the worker tools object from allowedToolNames on every evaluate", async () => {
    const registry = new NodeReplKernelRegistry({
      sessionFactory: defaultSessionFactory,
      idleTimeoutMs: 60_000,
      executeTool: async (name) => ({ result: `ran ${name}` }),
    });
    const contextWithTools = (allowedToolNames: string[]): ToolContext => ({
      ...context("agent-refresh"),
      allowedToolNames,
    });
    try {
      const first = await registry.evaluate(
        "Object.keys(tools).sort()",
        contextWithTools(["node_repl", "alpha_tool"]),
      );
      expect(first).toContain("alpha_tool");
      expect(first).not.toContain("beta_tool");

      // Same kernel, next turn: a tool added mid-session appears and a
      // removed one disappears — the construction-time list is not frozen.
      const second = await registry.evaluate(
        "Object.keys(tools).sort()",
        contextWithTools(["node_repl", "beta_tool"]),
      );
      expect(second).toContain("beta_tool");
      expect(second).not.toContain("alpha_tool");
      expect(second).toContain("$search");
      expect(second).toContain("$describe");
      await expect(
        registry.evaluate(
          "await tools.beta_tool({})",
          contextWithTools(["node_repl", "beta_tool"]),
        ),
      ).resolves.toBe("'ran beta_tool'");

      // Object.keys accuracy and identity stability across refreshes.
      const third = await registry.evaluate(
        [
          "const before = tools.beta_tool;",
          "({ same: before === tools.beta_tool, hasIn: 'beta_tool' in tools })",
        ].join("\n"),
        contextWithTools(["node_repl", "beta_tool"]),
      );
      expect(third).toContain("same: true");
      expect(third).toContain("hasIn: true");
    } finally {
      await registry.dispose();
    }
  });

  it("keeps the tools Proxy immutable and never exposes $-shadowing entries", async () => {
    const registry = new NodeReplKernelRegistry({
      sessionFactory: defaultSessionFactory,
      idleTimeoutMs: 60_000,
      executeTool: async (name) => ({ result: name }),
      searchTools: () => [],
    });
    try {
      const output = await registry
        .evaluate(
          [
            "tools.$search2 = 1",
            "Object.defineProperty(tools, 'evil', { value: 1 })",
          ].join("\n"),
          {
            ...context("agent-proxy"),
            // A hostile "$evil" entry in allowedToolNames must be filtered.
            allowedToolNames: ["node_repl", "$evil", "real_tool"],
          },
        )
        .catch((error: Error) => error.message);
      // defineProperty on a refusing trap throws TypeError in the REPL.
      expect(String(output)).toContain("evil");

      const keys = await registry.evaluate(
        "({ keys: Object.keys(tools), shadow: typeof tools.$evil, freezeFails: (() => { try { Object.freeze(tools); return false; } catch { return true; } })() })",
        {
          ...context("agent-proxy"),
          allowedToolNames: ["node_repl", "$evil", "real_tool"],
        },
      );
      expect(keys).toContain("real_tool");
      expect(keys).toContain("'$search'");
      expect(keys).toContain("'$describe'");
      expect(keys).not.toContain("$evil");
      expect(keys).toContain("shadow: 'undefined'");
      // Object.freeze(tools) THROWS by design: the Proxy target must stay
      // extensible for the per-evaluate key refresh (JS invariants forbid a
      // non-extensible target from reporting keys it doesn't own), so the
      // preventExtensions trap refuses and freeze fails loudly rather than
      // letting user code lock the target and break the refresh. The
      // node_repl description warns the model never to freeze `tools`.
      expect(keys).toContain("freezeFails: true");
    } finally {
      await registry.dispose();
    }
  });
});
