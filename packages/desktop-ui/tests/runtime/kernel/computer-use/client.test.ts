import { describe, expect, it, vi } from "vitest";

import {
  createSkyClient,
  type AuthorizeApp,
  type SkyAction,
} from "@stella/runtime/kernel/computer-use/client";
import type {
  ComputerUseAppState,
  ComputerUseAppPolicy,
  ComputerUseRequest,
  ComputerUseTarget,
} from "@stella/runtime/kernel/computer-use/contract";
import type { ComputerUseSession } from "@stella/runtime/kernel/computer-use/session";

const envelope = (request: ComputerUseRequest) => ({
  schemaVersion: request.schemaVersion,
  protocolVersion: request.protocolVersion,
  requestId: request.requestId,
  sessionId: request.sessionId,
});

const targetLabel = (target: ComputerUseTarget) =>
  target.type === "app"
    ? target.app
    : (target.app ?? `window-id:${target.windowId}`);

const policyFor = (target: ComputerUseTarget): ComputerUseAppPolicy => {
  const label = targetLabel(target);
  const normalized = label.toLocaleLowerCase();
  const isNotes = normalized === "notes" || normalized === "com.apple.notes";
  return {
    bundleIdentifier: isNotes ? "com.apple.Notes" : `test.${normalized}`,
    displayName: isNotes ? "Notes" : label,
    decision: "allowed",
    allowPersistentApproval: true,
  };
};

const createInjectedSession = (
  options: {
    policy?: (target: ComputerUseTarget) => ComputerUseAppPolicy;
    state?: (
      request: Extract<ComputerUseRequest, { type: "get_app_state" }>,
    ) => ComputerUseAppState;
    waitState?: (
      request: Extract<ComputerUseRequest, { type: "wait_for_change" }>,
    ) => ComputerUseAppState;
  } = {},
) => {
  const requests: ComputerUseRequest[] = [];
  const request = vi.fn(async (typedRequest: ComputerUseRequest) => {
    requests.push(typedRequest);
    switch (typedRequest.type) {
      case "list_apps":
        return { ...envelope(typedRequest), type: "list_apps", text: "Notes" };
      case "list_windows":
        return {
          ...envelope(typedRequest),
          type: "list_windows",
          text: "Notes [window-id=44]",
        };
      case "resolve_target":
        return {
          ...envelope(typedRequest),
          type: "target_policy",
          policy: (options.policy ?? policyFor)(typedRequest.selector),
        };
      case "get_app_state":
        return {
          ...envelope(typedRequest),
          type: "app_state",
          state:
            options.state?.(typedRequest) ??
            ({
              app: targetLabel(typedRequest.target),
              text: "<app_state>fresh ids</app_state>",
              screenshot: { type: "image", url: "file:///tmp/state.png" },
              semanticStateId: "state_test",
              visualStateId: "visual_test",
              resourceGeneration: 0,
            } as const),
        };
      case "wait_for_change":
        return {
          ...envelope(typedRequest),
          type: "wait_for_change",
          state:
            options.waitState?.(typedRequest) ??
            ({
              app: targetLabel(typedRequest.target),
              text: "<app_state>changed</app_state>",
              screenshot: null,
              semanticStateId: "state_changed",
              representation: "full",
              wait: {
                afterStateId: typedRequest.afterStateId,
                timeoutMs: typedRequest.timeoutMs,
                elapsedMs: 25,
                pollCount: 1,
                changeKinds: ["semantic"],
              },
            } as const),
        };
      case "action":
        return {
          ...envelope(typedRequest),
          type: "action",
          receipt: {
            type: "action",
            action: typedRequest.command.action.type,
            target: typedRequest.command.target,
            status: "accepted",
            deferred: true,
          },
        };
      case "batch":
        return {
          ...envelope(typedRequest),
          type: "batch",
          receipt: {
            type: "batch",
            receipts: typedRequest.commands.map((command) => ({
              type: "action" as const,
              action: command.action.type,
              target: command.target,
              status: "accepted" as const,
              deferred: true,
            })),
          },
        };
    }
  });
  return {
    requests,
    session: { request } satisfies ComputerUseSession,
  };
};

describe("typed Sky computer-use client", () => {
  it("submits one background batch request without a per-app consent prompt", async () => {
    const { requests, session } = createInjectedSession();
    const authorizeApp = vi.fn<AuthorizeApp>(async () => false);
    const sky = createSkyClient({
      sessionId: "general-task-agent-1",
      session,
      authorizeApp,
    });
    const actions: SkyAction[] = [
      {
        type: "click",
        app: "Notes",
        element_index: 12,
        mouse_button: "right",
        click_count: 2,
        state_id: "state_observed",
      },
      {
        type: "set_value",
        app: "Notes",
        element_index: 8,
        value: "hello world",
        state_id: "state_observed",
      },
      {
        type: "type_text",
        app: "Notes",
        text: "more text",
        state_id: "state_observed",
      },
    ];

    await expect(sky.batch(actions)).resolves.toHaveLength(3);

    expect(requests.map((request) => request.type)).toEqual([
      "resolve_target",
      "batch",
    ]);
    const batch = requests[1];
    expect(batch).toMatchObject({
      type: "batch",
      execution: "background",
      schemaVersion: 2,
      protocolVersion: "2.0",
      sessionId: "general-task-agent-1",
      commands: [
        {
          target: { type: "app", app: "Notes" },
          action: {
            type: "click_element",
            elementId: "12",
            mouseButton: "right",
            clickCount: 2,
          },
        },
        {
          action: {
            type: "set_value",
            elementId: "8",
            value: "hello world",
          },
        },
        { action: { type: "type_text", text: "more text" } },
      ],
    });
    expect(JSON.stringify(batch)).not.toMatch(
      /argv|--raise|foreground|defer-observation|stdout/i,
    );
    expect(authorizeApp).not.toHaveBeenCalled();
  });

  it("encodes every strict action variant without foreground controls", async () => {
    const { requests, session } = createInjectedSession();
    const sky = createSkyClient({
      sessionId: "session-1",
      session,
      authorizeApp: async () => true,
    });

    const observed = await sky.get_app_state({
      app: "Notes",
      screenshot_policy: "always",
    });

    await sky.click({
      app: "Notes",
      x: 10,
      y: 20,
      state_id: observed.state_id,
      observation_id: observed.observation_id,
    });
    await sky.drag({
      app: "Notes",
      path: [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
        { x: 5, y: 6 },
      ],
      state_id: observed.state_id,
      observation_id: observed.observation_id,
    });
    await sky.perform_secondary_action({
      app: "Notes",
      element_index: 7,
      action: "showMenu",
      state_id: observed.state_id,
    });
    await sky.press_key({
      app: "Notes",
      key: "ENTER",
      state_id: observed.state_id,
    });
    await sky.scroll({
      app: "Notes",
      element_index: 9,
      scroll_y: -500,
      pages: 2,
      state_id: observed.state_id,
    });
    await sky.select_text({
      app: "Notes",
      element_index: 4,
      text: "needle",
      prefix: "before",
      suffix: "after",
      selection_type: "cursor-after",
      state_id: observed.state_id,
    });

    const actionRequests = requests.filter(
      (request): request is Extract<ComputerUseRequest, { type: "action" }> =>
        request.type === "action",
    );
    expect(actionRequests.map((request) => request.command.action)).toEqual([
      {
        type: "click_point",
        point: { x: 10, y: 20 },
        mouseButton: "left",
        clickCount: 1,
      },
      { type: "drag", from: { x: 1, y: 2 }, to: { x: 5, y: 6 } },
      {
        type: "perform_secondary_action",
        elementId: "7",
        action: "showMenu",
      },
      { type: "press_key", key: "ENTER" },
      { type: "scroll", elementId: "9", direction: "up", pages: 2 },
      {
        type: "select_text",
        elementId: "4",
        text: "needle",
        prefix: "before",
        suffix: "after",
        selectionType: "cursor-after",
      },
    ]);
    for (const request of actionRequests) {
      expect(request.execution).toBe("background");
      expect(JSON.stringify(request.command.action)).not.toMatch(
        /raise|foreground|allowHid/i,
      );
    }
  });

  it("inspects Finder, Dock, unknown apps, and switches apps without Stella per-app prompts", async () => {
    const { requests, session } = createInjectedSession({
      policy: (target) => {
        const label = targetLabel(target);
        const normalized = label.toLocaleLowerCase();
        if (normalized === "finder" || normalized === "com.apple.finder") {
          return {
            bundleIdentifier: "com.apple.finder",
            displayName: "Finder",
            decision: "allowed",
            allowPersistentApproval: true,
            warningSubtitle: "Stella can view and interact with this app.",
          };
        }
        if (normalized === "dock" || normalized === "com.apple.dock") {
          return {
            bundleIdentifier: "com.apple.dock",
            displayName: "Dock",
            decision: "allowed",
            allowPersistentApproval: true,
            warningSubtitle: "Stella can view and interact with this app.",
          };
        }
        if (normalized === "explorer.exe") {
          return {
            bundleIdentifier: "explorer.exe",
            displayName: "File Explorer",
            decision: "allowed",
            allowPersistentApproval: true,
          };
        }
        return {
          bundleIdentifier: `pid:${normalized}`,
          displayName: label,
          decision: "allowed",
          allowPersistentApproval: false,
        };
      },
    });
    const authorizeApp = vi.fn<AuthorizeApp>(async () => false);
    const sky = createSkyClient({
      sessionId: "session-no-app-prompt",
      session,
      authorizeApp,
    });

    await expect(
      sky.get_app_state({ app: "Finder", screenshot_policy: "always" }),
    ).resolves.toMatchObject({ app: "Finder" });
    await expect(
      sky.click({ app: "Dock", element_index: 1, state_id: "state_observed" }),
    ).resolves.toMatchObject({ status: "accepted" });
    await expect(
      sky.get_app_state({ app: "Mystery App" }),
    ).resolves.toMatchObject({ app: "Mystery App" });
    await expect(
      sky.type_text({
        app: "explorer.exe",
        text: "docs",
        state_id: "state_observed",
      }),
    ).resolves.toMatchObject({ status: "accepted" });

    expect(
      requests.filter((request) => request.type === "resolve_target"),
    ).toHaveLength(4);
    expect(
      requests.filter(
        (request) =>
          request.type === "get_app_state" || request.type === "action",
      ),
    ).toHaveLength(4);
    expect(authorizeApp).not.toHaveBeenCalled();
  });

  it("does not invoke authorizeApp when switching between ordinary apps", async () => {
    const { requests, session } = createInjectedSession();
    const authorizeApp = vi.fn<AuthorizeApp>(async () => false);
    const sky = createSkyClient({
      sessionId: "session-policy",
      session,
      authorizeApp,
    });

    await sky.click({
      app: "Notes",
      element_index: 1,
      state_id: "state_observed",
    });
    await sky.get_app_state({ app: "com.apple.Notes" });
    await sky.type_text({
      app: "Calculator",
      text: "1+1",
      state_id: "state_observed",
    });

    expect(
      requests.filter((request) => request.type === "resolve_target"),
    ).toHaveLength(3);
    expect(authorizeApp).not.toHaveBeenCalled();
  });

  it("authorizes each distinct batch app by policy only, without a consent callback", async () => {
    const { requests, session } = createInjectedSession();
    const authorizeApp = vi.fn<AuthorizeApp>(async () => false);
    const sky = createSkyClient({
      sessionId: "session-batch-policy",
      session,
      authorizeApp,
    });

    await sky.batch([
      {
        type: "click",
        app: "Notes",
        element_index: 1,
        state_id: "state_observed",
      },
      {
        type: "set_value",
        app: "com.apple.Notes",
        element_index: 2,
        value: "x",
        state_id: "state_observed",
      },
      {
        type: "press_key",
        app: "Calculator",
        key: "ENTER",
        state_id: "state_observed",
      },
    ]);

    expect(
      requests.filter((request) => request.type === "resolve_target"),
    ).toHaveLength(3);
    expect(authorizeApp).not.toHaveBeenCalled();
    expect(requests.filter((request) => request.type === "batch")).toHaveLength(
      1,
    );
    expect(requests.at(-1)?.type).toBe("batch");
  });

  it("passes typed images through and delivers instructions once per canonical app", async () => {
    const { session } = createInjectedSession({
      state: (request) => ({
        app: targetLabel(request.target),
        text: "<app_state>fresh ids</app_state>",
        screenshot: {
          type: "image",
          url: "file:///tmp/state%20image.png",
        },
        instructions: "Use the app's Save button.",
      }),
    });
    const sky = createSkyClient({
      sessionId: "session-state",
      session,
      authorizeApp: async () => true,
    });

    const first = await sky.get_app_state({
      app: "Notes",
      screenshot_policy: "always",
      disable_diff: true,
    });
    const second = await sky.get_app_state({ app: "com.apple.Notes" });

    expect(first).toMatchObject({
      app: "Notes",
      screenshot: { url: "file:///tmp/state%20image.png" },
      text: expect.stringContaining("<app_specific_instructions>"),
      state_id: expect.stringMatching(/^state_[a-f0-9]{20}$/),
      observation_id: expect.stringMatching(/^observation_[a-f0-9]{20}$/),
      is_diff: false,
    });
    expect(first.text).toContain("Use the app's Save button.");
    expect(first.text).toContain("fresh ids");
    expect(second.text).toBe("<app_state>fresh ids</app_state>");
  });

  it("supports list operations and window selectors as typed requests", async () => {
    const { requests, session } = createInjectedSession();
    const sky = createSkyClient({ sessionId: "session-window", session });

    await expect(sky.list_apps()).resolves.toBe("Notes");
    await expect(sky.list_windows()).resolves.toBe("Notes [window-id=44]");
    await sky.click({
      app: "Notes",
      window_id: 44,
      element_index: 3,
      state_id: "state_observed",
    });

    expect(requests.map((request) => request.type)).toEqual([
      "list_apps",
      "list_windows",
      "resolve_target",
      "action",
    ]);
    expect(requests[2]).toMatchObject({
      type: "resolve_target",
      selector: { type: "window", app: "Notes", windowId: "44" },
    });
  });

  it("passes explicit state ids into actions", async () => {
    const { requests, session } = createInjectedSession();
    const sky = createSkyClient({ sessionId: "session-state-id", session });

    await sky.click({
      app: "Notes",
      element_index: 3,
      state_id: "state_observed",
    });

    expect(requests.find((request) => request.type === "action")).toMatchObject(
      {
        command: { observedStateId: "state_observed" },
      },
    );
  });

  it("binds coordinate actions to an immutable visual observation", async () => {
    let reads = 0;
    const { requests, session } = createInjectedSession({
      state: () => {
        reads += 1;
        return {
          app: "Notes",
          text: "same semantic state",
          screenshot: {
            type: "image",
            url: `file:///tmp/visual-${reads}.png`,
          },
          semanticStateId: "state_same",
          visualStateId: reads === 1 ? "visual_first" : "visual_second",
          resourceGeneration: 4,
        };
      },
    });
    const sky = createSkyClient({ sessionId: "session-visual", session });
    const first = await sky.get_app_state({
      app: "Notes",
      screenshot_policy: "always",
    });
    const second = await sky.get_app_state({
      app: "Notes",
      screenshot_policy: "always",
    });

    expect(first.state_id).toBe(second.state_id);
    expect(first.observation_id).not.toBe(second.observation_id);
    await sky.click({
      app: "Notes",
      x: 10,
      y: 20,
      state_id: first.state_id,
      observation_id: first.observation_id,
    });

    expect(requests.at(-1)).toMatchObject({
      type: "action",
      command: {
        observedObservationId: first.observation_id,
        observedStateId: "state_same",
        observedVisualStateId: "visual_first",
        observedResourceGeneration: 4,
      },
    });
    await expect(
      sky.click({
        app: "Notes",
        x: 10,
        y: 20,
        state_id: first.state_id,
      }),
    ).rejects.toThrow("immutable observation_id");
  });

  it("waits inside the runtime until app state changes", async () => {
    const { requests, session } = createInjectedSession({
      waitState: (request) =>
        ({
          app: "Notes",
          text: "changed",
          screenshot: null,
          semanticStateId: "state_after",
          representation: "full" as const,
          wait: {
            afterStateId: request.afterStateId,
            timeoutMs: request.timeoutMs,
            elapsedMs: 40,
            pollCount: 2,
            changeKinds: ["semantic"],
          },
        }) as const,
    });
    const sky = createSkyClient({ sessionId: "session-wait", session });

    await expect(
      sky.wait_for_change({
        app: "Notes",
        after_state_id: "state_before",
        timeout_ms: 2_000,
        screenshot_policy: "never",
      }),
    ).resolves.toMatchObject({
      state_id: "state_after",
      text: "changed",
      is_diff: false,
      provenance: {
        wait: {
          after_state_id: "state_before",
          timeout_ms: 2_000,
          elapsed_ms: 40,
          poll_count: 2,
          change_kinds: ["semantic"],
        },
      },
    });
    expect(requests.at(-1)).toMatchObject({
      type: "wait_for_change",
      afterStateId: "state_before",
      timeoutMs: 2_000,
      screenshotPolicy: "never",
    });
  });

  it("requires fresh state provenance for every action before dispatch", async () => {
    const { requests, session } = createInjectedSession();
    const sky = createSkyClient({ sessionId: "session-freshness", session });
    const missingStateActions = [
      () => sky.click({ app: "Notes", element_index: 1 }),
      () =>
        sky.perform_secondary_action({
          app: "Notes",
          element_index: 1,
          action: "Show Menu",
        }),
      () => sky.scroll({ app: "Notes", element_index: 1, direction: "down" }),
      () => sky.select_text({ app: "Notes", element_index: 1, text: "needle" }),
      () => sky.set_value({ app: "Notes", element_index: 1, value: "value" }),
      () => sky.press_key({ app: "Notes", key: "ENTER" }),
      () => sky.type_text({ app: "Notes", text: "text" }),
      () => sky.click({ app: "Notes", x: 10, y: 20 }),
      () =>
        sky.drag({
          app: "Notes",
          from_x: 1,
          from_y: 2,
          to_x: 3,
          to_y: 4,
        }),
    ];

    for (const action of missingStateActions) {
      await expect(action()).rejects.toThrow(
        "requires state_id from a fresh get_app_state result",
      );
    }
    await expect(
      sky.batch([
        {
          type: "click",
          app: "Notes",
          element_index: 1,
          state_id: "state_observed",
        },
        { type: "set_value", app: "Notes", element_index: 2, value: "x" },
      ]),
    ).rejects.toThrow(
      "set_value requires state_id from a fresh get_app_state result",
    );

    expect(requests.some((request) => request.type === "action")).toBe(false);
    expect(requests.some((request) => request.type === "batch")).toBe(false);
  });

  it("rejects forbidden, denied, and ambiguous operations before dispatch", async () => {
    const { requests, session } = createInjectedSession({
      policy: (target) => ({
        ...policyFor(target),
        decision:
          targetLabel(target) === "Keychain Access" ? "forbidden" : "denied",
      }),
    });
    const sky = createSkyClient({ sessionId: "session-denied", session });

    await expect(
      sky.press_key({ app: "Keychain Access", key: "ENTER" }),
    ).rejects.toThrow("forbidden by computer-use policy");
    await expect(sky.click({ app: "Notes", element_index: 1 })).rejects.toThrow(
      "denied by computer-use policy",
    );
    await expect(
      sky.click({ app: "Notes", element_index: 1, x: 1, y: 2 }),
    ).rejects.toThrow("either element_index or x/y");
    await expect(
      sky.drag({ app: "Notes", path: [{ x: 1, y: 2 }] }),
    ).rejects.toThrow("at least two points");

    expect(
      requests.filter((request) => request.type === "action"),
    ).toHaveLength(0);
  });

  it("still blocks forbidden and denied apps even if authorizeApp would approve", async () => {
    const { requests, session } = createInjectedSession({
      policy: (target) => ({
        ...policyFor(target),
        decision:
          targetLabel(target) === "Keychain Access" ? "forbidden" : "denied",
      }),
    });
    const authorizeApp = vi.fn<AuthorizeApp>(async () => true);
    const sky = createSkyClient({
      sessionId: "session-hard-policy",
      session,
      authorizeApp,
    });

    await expect(
      sky.press_key({ app: "Keychain Access", key: "ENTER" }),
    ).rejects.toThrow("forbidden by computer-use policy");
    await expect(sky.click({ app: "Notes", element_index: 1 })).rejects.toThrow(
      "denied by computer-use policy",
    );
    expect(authorizeApp).not.toHaveBeenCalled();
    expect(
      requests.filter((request) => request.type === "action"),
    ).toHaveLength(0);
  });
});
