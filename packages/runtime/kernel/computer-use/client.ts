import { createHash, randomUUID } from "node:crypto";

import {
  COMPUTER_USE_PROTOCOL_VERSION,
  COMPUTER_USE_SCHEMA_VERSION,
  type ComputerUseAction,
  type ComputerUseActionCommand,
  type ComputerUseAppState,
  type ComputerUseAppPolicy,
  type ComputerUseAppSelector,
  type ComputerUseRequest,
  type ComputerUseTarget,
} from "./contract.js";
import {
  createCliDiagnosticsComputerUseSession,
  type CliDiagnosticsComputerUseSessionOptions,
} from "./cli-diagnostics-session.js";
import {
  executeComputerUseRequest,
  type ComputerUseSession,
} from "./session.js";

type CommonAction = {
  app?: string;
  window_id?: string | number;
  state_id?: string;
  observation_id?: string;
};

export type SkyAction =
  | ({ type: "click" } & ClickArgs)
  | ({ type: "drag" } & DragArgs)
  | ({ type: "perform_secondary_action" } & SecondaryActionArgs)
  | ({ type: "press_key" } & PressKeyArgs)
  | ({ type: "scroll" } & ScrollArgs)
  | ({ type: "select_text" } & SelectTextArgs)
  | ({ type: "set_value" } & SetValueArgs)
  | ({ type: "type_text" } & TypeTextArgs);

export type ClickArgs = CommonAction & {
  element_index?: string | number;
  x?: number;
  y?: number;
  mouse_button?: "left" | "right" | "middle";
  click_count?: number;
};

export type DragArgs = CommonAction & {
  path?: Array<{ x: number; y: number }>;
  from_x?: number;
  from_y?: number;
  to_x?: number;
  to_y?: number;
};

export type SecondaryActionArgs = CommonAction & {
  element_index: string | number;
  action: string;
};

export type PressKeyArgs = CommonAction & { key: string };

export type ScrollArgs = CommonAction & {
  element_index: string | number;
  direction?: "up" | "down" | "left" | "right";
  pages?: number;
  scroll_x?: number;
  scroll_y?: number;
};

export type SelectTextArgs = CommonAction & {
  element_index: string | number;
  text: string;
  prefix?: string;
  suffix?: string;
  selection_type?: "text" | "cursor-before" | "cursor-after";
};

export type SetValueArgs = CommonAction & {
  element_index: string | number;
  value: string;
};

export type TypeTextArgs = CommonAction & { text: string };

export type GetAppStateArgs = CommonAction & {
  screenshot_policy?: "auto" | "always" | "never";
  disable_diff?: boolean;
  disableDiff?: boolean;
};

export type WaitForChangeArgs = GetAppStateArgs & {
  after_state_id: string;
  after_visual_state_id?: string;
  timeout_ms?: number;
};

export type AppStateProvenance = {
  request_id: string;
  resource_generation?: number;
  wait?: {
    after_state_id: string;
    after_visual_state_id?: string;
    timeout_ms: number;
    elapsed_ms: number;
    poll_count: number;
    change_kinds: Array<"semantic" | "visual" | "resource">;
  };
};

export type AppState = {
  app: string;
  screenshot: { url: string } | null;
  text: string;
  state_id: string;
  observation_id: string;
  visual_state_id?: string;
  base_state_id?: string;
  base_visual_state_id?: string;
  resource_generation?: number;
  is_diff: boolean;
  provenance: AppStateProvenance;
};

export type AuthorizeAppContext = Readonly<{
  selector: ComputerUseAppSelector;
  signal?: AbortSignal;
}>;

export type AuthorizeApp = (
  policy: ComputerUseAppPolicy,
  context: AuthorizeAppContext,
) => boolean | Promise<boolean>;

export type SkyClient = Readonly<{
  list_apps: () => Promise<string>;
  list_windows: () => Promise<string>;
  get_app_state: (args: GetAppStateArgs) => Promise<AppState>;
  wait_for_change: (args: WaitForChangeArgs) => Promise<AppState>;
  click: (args: ClickArgs) => Promise<unknown>;
  drag: (args: DragArgs) => Promise<unknown>;
  perform_secondary_action: (args: SecondaryActionArgs) => Promise<unknown>;
  press_key: (args: PressKeyArgs) => Promise<unknown>;
  scroll: (args: ScrollArgs) => Promise<unknown>;
  select_text: (args: SelectTextArgs) => Promise<unknown>;
  set_value: (args: SetValueArgs) => Promise<unknown>;
  type_text: (args: TypeTextArgs) => Promise<unknown>;
  batch: (actions: SkyAction[]) => Promise<unknown[]>;
}>;

type CreateSkyClientCommonOptions = Readonly<{
  sessionId: string;
  signal?: AbortSignal;
  getSignal?: () => AbortSignal | undefined;
  authorizeApp?: AuthorizeApp;
}>;

export type CreateSkyClientWithSessionOptions = CreateSkyClientCommonOptions &
  Readonly<{
    session: ComputerUseSession;
  }>;

export type CreateSkyClientDiagnosticsOptions = CreateSkyClientCommonOptions &
  Omit<CliDiagnosticsComputerUseSessionOptions, "signal" | "getSignal">;

export type CreateSkyClientOptions = CreateSkyClientWithSessionOptions;

const requireString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required.`);
  }
  return value;
};

const requireFinite = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
  }
  return value;
};

const requirePositiveInteger = (value: unknown, name: string): number => {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return Number(value);
};

const elementId = (value: unknown): string => {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    String(value).trim() === ""
  ) {
    throw new Error("element_index is required.");
  }
  return String(value);
};

const targetFrom = (args: CommonAction): ComputerUseTarget => {
  const app =
    args.app === undefined ? undefined : requireString(args.app, "app");
  if (args.window_id !== undefined) {
    const windowId = String(args.window_id).trim();
    if (!windowId) throw new Error("window_id must not be empty.");
    return { type: "window", windowId, ...(app ? { app } : {}) };
  }
  if (!app) throw new Error("app or window_id is required.");
  return { type: "app", app };
};

const directionFromScroll = (args: ScrollArgs) => {
  if (args.direction) return args.direction;
  const x = args.scroll_x ?? 0;
  const y = args.scroll_y ?? 0;
  if (x === 0 && y === 0) return "down";
  return Math.abs(y) >= Math.abs(x)
    ? y < 0
      ? "up"
      : "down"
    : x < 0
      ? "left"
      : "right";
};

const clickAction = (args: ClickArgs): ComputerUseAction => {
  const hasElement = args.element_index !== undefined;
  const hasCoordinates = args.x !== undefined || args.y !== undefined;
  if (hasElement && hasCoordinates) {
    throw new Error("click must use either element_index or x/y, not both.");
  }
  const mouseButton = args.mouse_button ?? "left";
  const clickCount = requirePositiveInteger(
    args.click_count ?? 1,
    "click_count",
  );
  if (hasElement) {
    return {
      type: "click_element",
      elementId: elementId(args.element_index),
      mouseButton,
      clickCount,
    };
  }
  return {
    type: "click_point",
    point: {
      x: requireFinite(args.x, "x"),
      y: requireFinite(args.y, "y"),
    },
    mouseButton,
    clickCount,
  };
};

const dragAction = (args: DragArgs): ComputerUseAction => {
  if (args.path !== undefined) {
    if (
      args.from_x !== undefined ||
      args.from_y !== undefined ||
      args.to_x !== undefined ||
      args.to_y !== undefined
    ) {
      throw new Error(
        "drag must use either path or from/to coordinates, not both.",
      );
    }
    if (!Array.isArray(args.path) || args.path.length < 2) {
      throw new Error("path must contain at least two points.");
    }
    const first = args.path[0]!;
    const last = args.path[args.path.length - 1]!;
    return {
      type: "drag",
      from: {
        x: requireFinite(first.x, "path[0].x"),
        y: requireFinite(first.y, "path[0].y"),
      },
      to: {
        x: requireFinite(last.x, `path[${args.path.length - 1}].x`),
        y: requireFinite(last.y, `path[${args.path.length - 1}].y`),
      },
    };
  }
  return {
    type: "drag",
    from: {
      x: requireFinite(args.from_x, "from_x"),
      y: requireFinite(args.from_y, "from_y"),
    },
    to: {
      x: requireFinite(args.to_x, "to_x"),
      y: requireFinite(args.to_y, "to_y"),
    },
  };
};

const actionCommand = (entry: SkyAction): ComputerUseActionCommand => {
  if (!entry || typeof entry !== "object") {
    throw new Error("Each batch action must be an object.");
  }
  const target = targetFrom(entry);
  const observedState = (command: ComputerUseActionCommand) => ({
    ...command,
    ...(entry.observation_id === undefined
      ? {}
      : {
          observedObservationId: requireString(
            entry.observation_id,
            "observation_id",
          ),
        }),
    ...(entry.state_id === undefined
      ? {}
      : { observedStateId: requireString(entry.state_id, "state_id") }),
  });
  switch (entry.type) {
    case "click":
      return observedState({ target, action: clickAction(entry) });
    case "drag":
      return observedState({ target, action: dragAction(entry) });
    case "perform_secondary_action":
      return observedState({
        target,
        action: {
          type: "perform_secondary_action",
          elementId: elementId(entry.element_index),
          action: requireString(entry.action, "action"),
        },
      });
    case "press_key":
      return observedState({
        target,
        action: { type: "press_key", key: requireString(entry.key, "key") },
      });
    case "scroll":
      return observedState({
        target,
        action: {
          type: "scroll",
          elementId: elementId(entry.element_index),
          direction: directionFromScroll(entry),
          pages: requirePositiveInteger(entry.pages ?? 1, "pages"),
        },
      });
    case "select_text":
      return observedState({
        target,
        action: {
          type: "select_text",
          elementId: elementId(entry.element_index),
          text: requireString(entry.text, "text"),
          ...(entry.prefix === undefined ? {} : { prefix: entry.prefix }),
          ...(entry.suffix === undefined ? {} : { suffix: entry.suffix }),
          ...(entry.selection_type === undefined
            ? {}
            : { selectionType: entry.selection_type }),
        },
      });
    case "set_value":
      return observedState({
        target,
        action: {
          type: "set_value",
          elementId: elementId(entry.element_index),
          value: String(entry.value ?? ""),
        },
      });
    case "type_text":
      return observedState({
        target,
        action: {
          type: "type_text",
          text: requireString(entry.text, "text"),
        },
      });
    default:
      throw new Error(
        `Unsupported batch action: ${String((entry as { type?: unknown }).type)}`,
      );
  }
};

const singleAction = <TArgs extends CommonAction>(
  type: SkyAction["type"],
  args: TArgs,
) => actionCommand({ type, ...args } as SkyAction);

const instructionText = (instructions: string, text: string) =>
  [
    "<app_specific_instructions>",
    instructions,
    "</app_specific_instructions>",
    text,
  ]
    .filter(Boolean)
    .join("\n");

export const createSkyClient = (options: CreateSkyClientOptions): SkyClient => {
  const sessionId = requireString(options.sessionId, "sessionId");
  const session = options.session;
  const deliveredInstructions = new Set<string>();
  type StateProvenance = {
    semanticStateId: string;
    visualStateId?: string;
    resourceGeneration?: number;
  };
  const stateProvenance = new Map<string, StateProvenance | null>();
  const observationProvenance = new Map<string, StateProvenance>();
  const signal = () => options.getSignal?.() ?? options.signal;
  const envelope = () => ({
    schemaVersion: COMPUTER_USE_SCHEMA_VERSION,
    protocolVersion: COMPUTER_USE_PROTOCOL_VERSION,
    requestId: randomUUID(),
    sessionId,
  });
  const execute = async <TRequest extends ComputerUseRequest>(
    request: TRequest,
  ) =>
    await executeComputerUseRequest(session, request, {
      signal: signal(),
    });

  const resolveTarget = async (
    selector: ComputerUseAppSelector,
  ): Promise<ComputerUseAppPolicy> => {
    const response = await execute({
      ...envelope(),
      type: "resolve_target",
      selector,
    });
    return response.policy;
  };

  const authorizePolicy = async (policy: ComputerUseAppPolicy) => {
    if (policy.decision === "forbidden") {
      throw new Error(
        `${policy.displayName} is forbidden by computer-use policy.`,
      );
    }
    if (policy.decision === "denied") {
      throw new Error(
        `${policy.displayName} is denied by computer-use policy.`,
      );
    }
  };

  const authorizeTarget = async (target: ComputerUseTarget) => {
    const policy = await resolveTarget(target);
    await authorizePolicy(policy);
    return policy;
  };

  const commandWithProvenance = (
    command: ComputerUseActionCommand,
  ): ComputerUseActionCommand => {
    const stateId = command.observedStateId;
    const observationId = command.observedObservationId;
    const exactProvenance = observationId
      ? observationProvenance.get(observationId)
      : undefined;
    if (observationId && !exactProvenance) {
      throw new Error(
        "observation_id is unknown or no longer available. Use the observation_id returned with the current app state.",
      );
    }
    if (
      stateId &&
      exactProvenance &&
      exactProvenance.semanticStateId !== stateId
    ) {
      throw new Error(
        "state_id and observation_id refer to different app-state observations.",
      );
    }
    const provenance =
      exactProvenance ?? (stateId ? stateProvenance.get(stateId) : undefined);
    const needsVisualState =
      command.action.type === "click_point" || command.action.type === "drag";
    if (
      needsVisualState &&
      (!observationId || !exactProvenance?.visualStateId)
    ) {
      throw new Error(
        'Screenshot-coordinate actions require the immutable observation_id from get_app_state with screenshot_policy: "always".',
      );
    }
    return {
      ...command,
      ...(exactProvenance
        ? { observedStateId: exactProvenance.semanticStateId }
        : {}),
      ...(needsVisualState && provenance?.visualStateId
        ? { observedVisualStateId: provenance.visualStateId }
        : {}),
      ...(provenance?.resourceGeneration !== undefined
        ? { observedResourceGeneration: provenance.resourceGeneration }
        : {}),
    };
  };

  const requireFreshInput = (command: ComputerUseActionCommand) => {
    if (!command.observedStateId) {
      throw new Error(
        `${command.action.type} requires state_id from a fresh get_app_state result.`,
      );
    }
  };

  const runAction = async (rawCommand: ComputerUseActionCommand) => {
    await authorizeTarget(rawCommand.target);
    requireFreshInput(rawCommand);
    const command = commandWithProvenance(rawCommand);
    const response = await execute({
      ...envelope(),
      type: "action",
      execution: "background",
      command,
    });
    return response.receipt;
  };

  const mapAppState = (
    response: { requestId: string; state: ComputerUseAppState },
    policy: ComputerUseAppPolicy,
  ): AppState => {
    const instructionKey = policy.bundleIdentifier.toLocaleLowerCase();
    const instructions = response.state.instructions?.trim();
    const shouldDeliverInstructions =
      Boolean(instructions) && !deliveredInstructions.has(instructionKey);
    if (shouldDeliverInstructions) deliveredInstructions.add(instructionKey);
    const stateId =
      response.state.semanticStateId ??
      response.state.stateId ??
      `state_${createHash("sha256")
        .update(`${response.state.app}\n${response.state.text}`)
        .digest("hex")
        .slice(0, 20)}`;
    const provenance: StateProvenance = {
      semanticStateId: stateId,
      ...(response.state.visualStateId
        ? { visualStateId: response.state.visualStateId }
        : {}),
      ...(response.state.resourceGeneration !== undefined
        ? { resourceGeneration: response.state.resourceGeneration }
        : {}),
    };
    const observationId = `observation_${createHash("sha256")
      .update(
        `${stateId}\n${provenance.visualStateId ?? "-"}\n${provenance.resourceGeneration ?? "-"}`,
      )
      .digest("hex")
      .slice(0, 20)}`;
    observationProvenance.set(observationId, provenance);
    const existing = stateProvenance.get(stateId);
    if (existing === undefined) {
      stateProvenance.set(stateId, provenance);
    } else if (
      existing !== null &&
      (existing.visualStateId !== provenance.visualStateId ||
        existing.resourceGeneration !== provenance.resourceGeneration)
    ) {
      stateProvenance.set(stateId, null);
    }
    return {
      app: response.state.app,
      screenshot: response.state.screenshot
        ? { url: response.state.screenshot.url }
        : null,
      text:
        shouldDeliverInstructions && instructions
          ? instructionText(instructions, response.state.text)
          : response.state.text,
      state_id: stateId,
      observation_id: observationId,
      ...(response.state.visualStateId
        ? { visual_state_id: response.state.visualStateId }
        : {}),
      ...(response.state.baseStateId
        ? { base_state_id: response.state.baseStateId }
        : {}),
      ...(response.state.baseVisualStateId
        ? { base_visual_state_id: response.state.baseVisualStateId }
        : {}),
      ...(response.state.resourceGeneration !== undefined
        ? { resource_generation: response.state.resourceGeneration }
        : {}),
      is_diff:
        response.state.representation === "diff" ||
        response.state.text.includes("<app_state_diff"),
      provenance: {
        request_id: response.requestId,
        ...(response.state.resourceGeneration !== undefined
          ? { resource_generation: response.state.resourceGeneration }
          : {}),
        ...(response.state.wait
          ? {
              wait: {
                after_state_id: response.state.wait.afterStateId,
                ...(response.state.wait.afterVisualStateId
                  ? {
                      after_visual_state_id:
                        response.state.wait.afterVisualStateId,
                    }
                  : {}),
                timeout_ms: response.state.wait.timeoutMs,
                elapsed_ms: response.state.wait.elapsedMs,
                poll_count: response.state.wait.pollCount,
                change_kinds: [...response.state.wait.changeKinds],
              },
            }
          : {}),
      },
    };
  };

  const getAppState = async (args: GetAppStateArgs): Promise<AppState> => {
    const target = targetFrom(args);
    const policy = await authorizeTarget(target);
    const response = await execute({
      ...envelope(),
      type: "get_app_state",
      target,
      screenshotPolicy: args.screenshot_policy ?? "auto",
      disableDiff: args.disable_diff === true || args.disableDiff === true,
    });
    return mapAppState(response, policy);
  };

  const methods: SkyClient = {
    list_apps: async () => {
      const response = await execute({ ...envelope(), type: "list_apps" });
      return response.text;
    },
    list_windows: async () => {
      const response = await execute({ ...envelope(), type: "list_windows" });
      return response.text;
    },
    get_app_state: getAppState,
    wait_for_change: async (args: WaitForChangeArgs): Promise<AppState> => {
      const afterStateId = requireString(args.after_state_id, "after_state_id");
      const timeoutMs = requirePositiveInteger(
        args.timeout_ms ?? 10_000,
        "timeout_ms",
      );
      if (timeoutMs > 120_000) {
        throw new Error("timeout_ms must not exceed 120000.");
      }
      const target = targetFrom(args);
      const policy = await authorizeTarget(target);
      const known = stateProvenance.get(afterStateId);
      const afterVisualStateId =
        args.after_visual_state_id ?? known?.visualStateId;
      const response = await execute({
        ...envelope(),
        type: "wait_for_change",
        target,
        afterStateId,
        ...(afterVisualStateId ? { afterVisualStateId } : {}),
        timeoutMs,
        screenshotPolicy: args.screenshot_policy ?? "auto",
        disableDiff: args.disable_diff === true || args.disableDiff === true,
      });
      return mapAppState(response, policy);
    },
    click: async (args) => await runAction(singleAction("click", args)),
    drag: async (args) => await runAction(singleAction("drag", args)),
    perform_secondary_action: async (args) =>
      await runAction(singleAction("perform_secondary_action", args)),
    press_key: async (args) => await runAction(singleAction("press_key", args)),
    scroll: async (args) => await runAction(singleAction("scroll", args)),
    select_text: async (args) =>
      await runAction(singleAction("select_text", args)),
    set_value: async (args) => await runAction(singleAction("set_value", args)),
    type_text: async (args) => await runAction(singleAction("type_text", args)),
    batch: async (actions) => {
      if (!Array.isArray(actions)) throw new Error("actions must be an array.");
      const rawCommands = actions.map(actionCommand);
      const policiesBySelector = new Map<string, ComputerUseAppPolicy>();
      const authorizationByBundle = new Map<string, ComputerUseAppPolicy>();
      for (const command of rawCommands) {
        const selectorKey = JSON.stringify(command.target);
        let policy = policiesBySelector.get(selectorKey);
        if (!policy) {
          policy = await resolveTarget(command.target);
          policiesBySelector.set(selectorKey, policy);
        }
        const bundleKey = policy.bundleIdentifier.toLocaleLowerCase();
        if (!authorizationByBundle.has(bundleKey)) {
          authorizationByBundle.set(bundleKey, policy);
        }
      }
      for (const policy of authorizationByBundle.values()) {
        await authorizePolicy(policy);
      }
      rawCommands.forEach(requireFreshInput);
      const commands = rawCommands.map(commandWithProvenance);
      const response = await execute({
        ...envelope(),
        type: "batch",
        execution: "background",
        commands,
      });
      return [...response.receipt.receipts];
    },
  };

  return Object.freeze(methods);
};

export const createSkyClientForCliDiagnostics = (
  options: CreateSkyClientDiagnosticsOptions,
): SkyClient =>
  createSkyClient({
    sessionId: options.sessionId,
    session: createCliDiagnosticsComputerUseSession({
      cliPath: options.cliPath,
      cwd: options.cwd,
      runner: options.runner,
      env: options.env,
      signal: options.signal,
      getSignal: options.getSignal,
      commandTimeoutMs: options.commandTimeoutMs,
      maxOutputBytes: options.maxOutputBytes,
    }),
    signal: options.signal,
    getSignal: options.getSignal,
    authorizeApp: options.authorizeApp,
  });
