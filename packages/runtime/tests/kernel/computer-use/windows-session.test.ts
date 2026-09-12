import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  COMPUTER_USE_PROTOCOL_VERSION,
  COMPUTER_USE_SCHEMA_VERSION,
  type ComputerUseAction,
  type ComputerUseRequest,
} from "@stella/runtime/kernel/computer-use/contract";
import { executeComputerUseRequest } from "@stella/runtime/kernel/computer-use/session";
import {
  createWindowsComputerUseSession,
  type WindowsComputerHelperRequest,
} from "@stella/runtime/kernel/computer-use/windows-session";
import { runWithComputerExecutionContext } from "@stella/runtime/kernel/computer-use/execution-context";
import type {
  WinHelperRequest,
  WinSnapshot,
} from "@stella/runtime/kernel/cli/stella-computer-windows";

const envelope = (requestId: string, sessionId = "windows-session") => ({
  schemaVersion: COMPUTER_USE_SCHEMA_VERSION,
  protocolVersion: COMPUTER_USE_PROTOCOL_VERSION,
  requestId,
  sessionId,
});

const snapshot = (overrides: Partial<WinSnapshot> = {}): WinSnapshot => ({
  app: {
    name: "Spotify.exe",
    bundleIdentifier: "Spotify.exe",
    pid: 321,
  },
  windowId: 654,
  windowTitle: "Spotify",
  windowBounds: { x: 10, y: 20, width: 900, height: 700 },
  screenshotPngBase64: Buffer.from("png-bytes").toString("base64"),
  screenshot: { widthPx: 900, heightPx: 700 },
  treeLines: ['[12] textbox "Search"', '[19] button "Play"'],
  elements: [
    { index: 12, name: "Search", controlType: "Edit" },
    { index: 19, name: "Play", controlType: "Button" },
  ],
  appInstructions: "Prefer the Search textbox for exact queries.",
  revision: 7,
  materializedRevision: 7,
  ...overrides,
});

const withStateRoot = async <T>(operation: () => Promise<T>) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "stella-windows-session-"));
  try {
    const result = await runWithComputerExecutionContext(
      { env: { ...process.env, STELLA_DATA_DIR: root } },
      operation,
    );
    return { value: result.value, root };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
};

describe("Windows production ComputerUseSession", () => {
  it("keeps hidden target resolution out of the model-delivered diff baseline", async () => {
    let reads = 0;
    const requestHelper: WindowsComputerHelperRequest = vi.fn(
      async (_sessionId, operation) => {
        if (operation.tool !== "get_app_state") {
          throw new Error(`Unexpected helper operation: ${operation.tool}`);
        }
        reads += 1;
        const label = reads === 1 ? "Old" : reads === 2 ? "Hidden" : "New";
        return {
          ok: true,
          snapshot: snapshot({
            treeLines: [`[12] textbox "${label}"`],
            elements: [{ index: 12, name: label, controlType: "Edit" }],
          }),
        };
      },
    );
    const session = createWindowsComputerUseSession({ requestHelper });
    const { value, root } = await withStateRoot(async () => {
      const first = await executeComputerUseRequest(session, {
        ...envelope("first"),
        type: "get_app_state",
        target: { type: "app", app: "spotify" },
        screenshotPolicy: "never",
        disableDiff: false,
      });
      await executeComputerUseRequest(session, {
        ...envelope("hidden-resolve"),
        type: "resolve_target",
        selector: { type: "app", app: "spotify" },
      });
      const second = await executeComputerUseRequest(session, {
        ...envelope("second"),
        type: "get_app_state",
        target: { type: "app", app: "spotify" },
        screenshotPolicy: "never",
        disableDiff: false,
      });
      return { first, second };
    });

    expect(value.first.state.representation).toBe("full");
    expect(value.second.state).toMatchObject({
      representation: "diff",
      baseStateId: value.first.state.semanticStateId,
    });
    expect(value.second.state.text).toContain('- [12] textbox "Old"');
    expect(value.second.state.text).toContain('+ [12] textbox "New"');
    expect(value.second.state.text).not.toContain("Hidden");
    rmSync(root, { recursive: true, force: true });
  });

  it("maps list, canonical target policy, and state directly to typed helper requests", async () => {
    const calls: Parameters<WindowsComputerHelperRequest>[1][] = [];
    const requestHelper: WindowsComputerHelperRequest = vi.fn(
      async (_sessionId, operation) => {
        calls.push(operation);
        if (operation.tool === "list_apps") {
          return { ok: true, text: "Spotify.exe\nBrave.exe" };
        }
        if (operation.tool === "list_windows") {
          return {
            ok: true,
            windows: [
              {
                pid: 321,
                windowId: 654,
                app: "Spotify.exe",
                title: "Spotify",
              },
            ],
          };
        }
        return { ok: true, snapshot: snapshot() };
      },
    );
    const session = createWindowsComputerUseSession({ requestHelper });
    const { value, root } = await withStateRoot(async () => {
      const apps = await executeComputerUseRequest(session, {
        ...envelope("apps"),
        type: "list_apps",
      });
      const windows = await executeComputerUseRequest(session, {
        ...envelope("windows"),
        type: "list_windows",
      });
      const policy = await executeComputerUseRequest(session, {
        ...envelope("policy"),
        type: "resolve_target",
        selector: { type: "app", app: "spotify" },
      });
      const state = await executeComputerUseRequest(session, {
        ...envelope("state"),
        type: "get_app_state",
        target: { type: "window", app: "spotify", windowId: "654" },
        screenshotPolicy: "auto",
        disableDiff: false,
      });
      return { apps, windows, policy, state };
    });

    expect(value.apps.text).toBe("Spotify.exe\nBrave.exe");
    expect(value.windows.text).toContain("target=hwnd:654");
    expect(value.policy.policy).toEqual({
      bundleIdentifier: "Spotify.exe",
      displayName: "Spotify.exe",
      decision: "allowed",
      allowPersistentApproval: true,
    });
    expect(value.state.state).toMatchObject({
      app: "Spotify.exe",
      text: expect.stringContaining('[12] textbox "Search"'),
      instructions: "Prefer the Search textbox for exact queries.",
      screenshot: {
        type: "image",
        mimeType: "image/png",
        width: 900,
        height: 700,
      },
    });
    expect(value.state.state.screenshot?.url).toMatch(/^file:/);
    expect(
      existsSync(
        path.join(
          root,
          "stella-computer",
          "sessions",
          "windows-session",
          "windows-targets",
          "window-654",
          "last-screenshot.png",
        ),
      ),
    ).toBe(true);
    expect(calls).toEqual([
      { tool: "list_apps" },
      { tool: "list_windows" },
      {
        tool: "get_app_state",
        app: "spotify",
        windowId: undefined,
        screenshot_policy: "never",
      },
      {
        tool: "get_app_state",
        app: "spotify",
        windowId: 654,
        screenshot_policy: "auto",
      },
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  it.each<{
    name: string;
    action: ComputerUseAction;
    expected: Partial<WinHelperRequest>;
  }>([
    {
      name: "element click",
      action: {
        type: "click_element",
        elementId: "19",
        mouseButton: "left",
        clickCount: 2,
      },
      expected: {
        tool: "click",
        element: { index: 19, name: "Play", controlType: "Button" },
        mouse_button: "left",
        click_count: 2,
      },
    },
    {
      name: "semantic text selection",
      action: {
        type: "select_text",
        elementId: "12",
        text: "exact",
        prefix: "before",
        suffix: "after",
        selectionType: "cursor-after",
      },
      expected: {
        tool: "select_text",
        text: "exact",
        prefix: "before",
        suffix: "after",
        selection: "cursor-after",
      },
    },
    {
      name: "background typing",
      action: { type: "type_text", text: "temporary query" },
      expected: { tool: "type_text", text: "temporary query" },
    },
    {
      name: "screenshot drag",
      action: {
        type: "drag",
        from: { x: 11, y: 22 },
        to: { x: 33, y: 44 },
      },
      expected: {
        tool: "drag",
        from_x: 11,
        from_y: 22,
        to_x: 33,
        to_y: 44,
        screenshot_width: 900,
        screenshot_height: 700,
      },
    },
  ])(
    "maps $name without argv/stdout translation",
    async ({ action, expected }) => {
      const operations: Parameters<WindowsComputerHelperRequest>[1][] = [];
      const requestHelper: WindowsComputerHelperRequest = vi.fn(
        async (_sessionId, operation) => {
          operations.push(operation);
          if (operation.tool === "get_app_state") {
            return { ok: true, snapshot: snapshot() };
          }
          return {
            ok: true,
            deferred: true,
            revision: 8,
            receipt: {
              route: "uia.test",
              dispatch: "background",
              background_safe: true,
            },
          };
        },
      );
      const session = createWindowsComputerUseSession({ requestHelper });
      const { value, root } = await withStateRoot(async () => {
        const observed = await executeComputerUseRequest(session, {
          ...envelope("observe"),
          type: "get_app_state",
          target: { type: "app", app: "spotify" },
          screenshotPolicy: "never",
          disableDiff: false,
        });
        return await executeComputerUseRequest(session, {
          ...envelope("action"),
          type: "action",
          execution: "background",
          command: {
            target: { type: "app", app: "spotify" },
            action,
            observedStateId: observed.state.semanticStateId!,
          },
        });
      });

      expect(operations[2]).toMatchObject({
        tool: "atomic_action",
        precondition: {
          state_id: expect.any(String),
          target_pid: 321,
          window_id: 654,
          revision: 7,
          materialized_revision: 7,
        },
        command: {
          ...expected,
          app: "spotify",
          windowId: 654,
          dispatch: "background",
          defer_observation: true,
          screenshot_policy: "auto",
        },
      });
      expect(value.receipt).toMatchObject({
        action: action.type,
        status: "accepted",
        deferred: true,
        details: {
          revision: 8,
          deferred: true,
        },
      });
      rmSync(root, { recursive: true, force: true });
    },
  );

  it("sends a typed batch as exactly one helper request and maps every native result", async () => {
    const operations: Parameters<WindowsComputerHelperRequest>[1][] = [];
    let active = 0;
    let maxActive = 0;
    const requestHelper: WindowsComputerHelperRequest = vi.fn(
      async (_sessionId, operation) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        operations.push(operation);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        if (operation.tool === "get_app_state") {
          return { ok: true, snapshot: snapshot() };
        }
        if ("commands" in operation) {
          return {
            ok: true,
            completed: operation.commands.length,
            results: operation.commands.map((_command, index) => ({
              index,
              ok: true,
              result: {
                ok: true,
                deferred: true,
                revision: index + 10,
              },
            })),
          };
        }
        return { ok: true, deferred: true, revision: operations.length };
      },
    );
    const session = createWindowsComputerUseSession({ requestHelper });
    const { value, root } = await withStateRoot(async () => {
      const observed = await executeComputerUseRequest(session, {
        ...envelope("observe"),
        type: "get_app_state",
        target: { type: "app", app: "spotify" },
        screenshotPolicy: "never",
        disableDiff: false,
      });
      const request: ComputerUseRequest = {
        ...envelope("batch"),
        type: "batch",
        execution: "background",
        commands: [
          {
            target: { type: "app", app: "spotify" },
            action: { type: "press_key", key: "CTRL+L" },
            observedStateId: observed.state.semanticStateId!,
          },
          {
            target: { type: "app", app: "spotify" },
            action: { type: "type_text", text: "query" },
            observedStateId: observed.state.semanticStateId!,
          },
        ],
      };
      return await executeComputerUseRequest(session, request);
    });

    expect(value.receipt.receipts).toHaveLength(2);
    expect(operations).toHaveLength(4);
    expect(operations[3]).toMatchObject({
      tool: "atomic_batch",
      commands: [
        {
          precondition: {
            target_pid: 321,
            window_id: 654,
            revision: 7,
            materialized_revision: 7,
          },
          command: {
            tool: "press_key",
            key: "CTRL+L",
            dispatch: "background",
            defer_observation: true,
          },
        },
        {
          precondition: {
            target_pid: 321,
            window_id: 654,
            revision: 7,
            materialized_revision: 7,
          },
          command: {
            tool: "type_text",
            text: "query",
            dispatch: "background",
            defer_observation: true,
          },
        },
      ],
    });
    expect(value.receipt.receipts).toMatchObject([
      { action: "press_key", details: { revision: 10 } },
      { action: "type_text", details: { revision: 11 } },
    ]);
    expect(maxActive).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  it("invalidates the observation after a partially executed native batch", async () => {
    const requestHelper: WindowsComputerHelperRequest = vi.fn(
      async (_sessionId, operation) => {
        if (operation.tool === "get_app_state") {
          return { ok: true, snapshot: snapshot() };
        }
        return {
          ok: false,
          completed: 1,
          error: "strict background dispatch failed",
          results: [
            {
              index: 0,
              ok: true,
              result: { ok: true, deferred: true, revision: 10 },
            },
            {
              index: 1,
              ok: false,
              error: "strict background dispatch failed",
            },
          ],
        };
      },
    );
    const session = createWindowsComputerUseSession({ requestHelper });
    const { root } = await withStateRoot(async () => {
      const observed = await executeComputerUseRequest(session, {
        ...envelope("observe-failed-batch"),
        type: "get_app_state",
        target: { type: "app", app: "spotify" },
        screenshotPolicy: "never",
        disableDiff: false,
      });
      await expect(
        executeComputerUseRequest(session, {
          ...envelope("failed-batch"),
          type: "batch",
          execution: "background",
          commands: [
            {
              target: { type: "app", app: "spotify" },
              action: { type: "press_key", key: "CTRL+L" },
              observedStateId: observed.state.semanticStateId!,
            },
            {
              target: { type: "app", app: "spotify" },
              action: { type: "type_text", text: "query" },
              observedStateId: observed.state.semanticStateId!,
            },
          ],
        }),
      ).rejects.toMatchObject({
        code: "windows_session_failed",
        message: "strict background dispatch failed",
      });
      await expect(
        executeComputerUseRequest(session, {
          ...envelope("retry-after-failed-batch"),
          type: "action",
          execution: "background",
          command: {
            target: { type: "app", app: "spotify" },
            action: { type: "type_text", text: "must not dispatch" },
            observedStateId: observed.state.semanticStateId!,
          },
        }),
      ).rejects.toMatchObject({
        code: "stale_observation",
      });
    });

    expect(requestHelper).toHaveBeenCalledTimes(4);
    rmSync(root, { recursive: true, force: true });
  });

  it("maps a native dispatch-boundary revision mismatch to stale_observation", async () => {
    const requestHelper: WindowsComputerHelperRequest = vi.fn(
      async (_sessionId, operation) =>
        operation.tool === "get_app_state"
          ? { ok: true, snapshot: snapshot() }
          : {
              ok: false,
              code: "stale_observation",
              error: "Observed Windows app state changed before dispatch.",
              observed_state_id:
                operation.tool === "atomic_action" &&
                "precondition" in operation
                  ? operation.precondition.state_id
                  : undefined,
              current_revision: 8,
            },
    );
    const session = createWindowsComputerUseSession({ requestHelper });
    const { root } = await withStateRoot(async () => {
      const observed = await executeComputerUseRequest(session, {
        ...envelope("observe-native-stale"),
        type: "get_app_state",
        target: { type: "app", app: "spotify" },
        screenshotPolicy: "never",
        disableDiff: false,
      });
      await expect(
        executeComputerUseRequest(session, {
          ...envelope("native-stale-action"),
          type: "action",
          execution: "background",
          command: {
            target: { type: "app", app: "spotify" },
            action: { type: "type_text", text: "must not land" },
            observedStateId: observed.state.semanticStateId!,
          },
        }),
      ).rejects.toMatchObject({
        code: "stale_observation",
        message: expect.stringContaining("native_revision_8"),
      });
    });

    expect(requestHelper).toHaveBeenCalledTimes(3);
    rmSync(root, { recursive: true, force: true });
  });

  it("arbitrates the same target across independently created Windows sessions", async () => {
    let activeMutations = 0;
    let maxActiveMutations = 0;
    let atomicCalls = 0;
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let announceFirst!: () => void;
    const firstAnnounced = new Promise<void>((resolve) => {
      announceFirst = resolve;
    });
    const requestHelper: WindowsComputerHelperRequest = vi.fn(
      async (_sessionId, operation) => {
        if (operation.tool === "get_app_state") {
          return { ok: true, snapshot: snapshot() };
        }
        if (operation.tool !== "atomic_action") {
          throw new Error(`Unexpected helper operation: ${operation.tool}`);
        }
        atomicCalls += 1;
        activeMutations += 1;
        maxActiveMutations = Math.max(maxActiveMutations, activeMutations);
        announceFirst();
        await firstEntered;
        activeMutations -= 1;
        return { ok: true, deferred: true, revision: 8 };
      },
    );
    const sessionA = createWindowsComputerUseSession({ requestHelper });
    const sessionB = createWindowsComputerUseSession({ requestHelper });
    const targetApp = `process-wide-${Date.now()}-${Math.random()}`;
    const { root } = await withStateRoot(async () => {
      const observedA = await executeComputerUseRequest(sessionA, {
        ...envelope("observe-a", "windows-a"),
        type: "get_app_state",
        target: { type: "app", app: targetApp },
        screenshotPolicy: "never",
        disableDiff: false,
      });
      const observedB = await executeComputerUseRequest(sessionB, {
        ...envelope("observe-b", "windows-b"),
        type: "get_app_state",
        target: { type: "app", app: targetApp },
        screenshotPolicy: "never",
        disableDiff: false,
      });
      const first = executeComputerUseRequest(sessionA, {
        ...envelope("action-a", "windows-a"),
        type: "action",
        execution: "background",
        command: {
          target: { type: "app", app: targetApp },
          action: { type: "type_text", text: "first" },
          observedStateId: observedA.state.semanticStateId!,
        },
      });
      await firstAnnounced;
      const second = executeComputerUseRequest(sessionB, {
        ...envelope("action-b", "windows-b"),
        type: "action",
        execution: "background",
        command: {
          target: { type: "app", app: targetApp },
          action: { type: "type_text", text: "second" },
          observedStateId: observedB.state.semanticStateId!,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(atomicCalls).toBe(1);
      releaseFirst();
      await first;
      await expect(second).rejects.toMatchObject({
        code: "stale_observation",
      });
    });

    expect(atomicCalls).toBe(1);
    expect(maxActiveMutations).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  it("returns typed errors for unresolved targets and missing observed state", async () => {
    const requestHelper: WindowsComputerHelperRequest = vi.fn(async () => ({
      ok: false,
      error: "No matching process",
    }));
    const session = createWindowsComputerUseSession({ requestHelper });

    await expect(
      executeComputerUseRequest(session, {
        ...envelope("missing-policy"),
        type: "resolve_target",
        selector: { type: "app", app: "missing" },
      }),
    ).rejects.toMatchObject({
      code: "windows_target_resolution_failed",
      message: "No matching process",
    });
    await expect(
      executeComputerUseRequest(session, {
        ...envelope("missing-state"),
        type: "action",
        execution: "background",
        command: {
          target: { type: "app", app: "missing" },
          action: { type: "type_text", text: "no-op" },
        },
      }),
    ).rejects.toThrow(
      "ComputerUseRequest.command.observedStateId must be a non-empty string",
    );
  });

  it("lets Sky inspect and switch ordinary Windows apps without a per-app consent prompt", async () => {
    const requestHelper: WindowsComputerHelperRequest = vi.fn(
      async (_sessionId, operation) => {
        if (operation.tool === "list_apps") {
          return { ok: true, text: "Spotify.exe\nexplorer.exe" };
        }
        if (operation.app === "explorer.exe") {
          return {
            ok: true,
            snapshot: snapshot({
              app: {
                name: "explorer.exe",
                bundleIdentifier: "explorer.exe",
                pid: 99,
              },
              windowId: 1,
              windowTitle: "File Explorer",
            }),
          };
        }
        return { ok: true, snapshot: snapshot() };
      },
    );
    const session = createWindowsComputerUseSession({ requestHelper });
    const authorizeApp = vi.fn(async () => false);
    const { createSkyClient } =
      await import("@stella/runtime/kernel/computer-use/client");
    const { value, root } = await withStateRoot(async () => {
      const sky = createSkyClient({
        sessionId: "windows-session",
        session,
        authorizeApp,
      });
      const state = await sky.get_app_state({ app: "Spotify.exe" });
      const explorerState = await sky.get_app_state({ app: "explorer.exe" });
      await sky.click({
        app: "explorer.exe",
        element_index: 12,
        state_id: explorerState.state_id,
      });
      return state;
    });

    expect(value.app).toBe("Spotify.exe");
    expect(authorizeApp).not.toHaveBeenCalled();
    rmSync(root, { recursive: true, force: true });
  });
});
