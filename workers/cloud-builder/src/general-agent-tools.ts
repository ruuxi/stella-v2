/**
 * The cloud general agent's tool capability manifest, and the pinned catalog
 * the resident `BuildSession` loop hands to `Agent`.
 *
 * One closed table decides where every tool in the general-agent catalog runs.
 * A tool name the table does not classify fails closed rather than defaulting
 * to a placement, because a wrong default is either a silent capability grant
 * (do-local) or a silent container boot (container). The catalog is assembled
 * from the same metadata-only descriptor modules the container tool host
 * composes its executable definitions from, so both placements advertise
 * byte-identical tools; `general-agent-catalog-parity.test.ts` in
 * `packages/executor-cloud` pins that against the real `createToolHost`.
 *
 * This module never imports `createToolHost` and never reaches a Node builtin
 * workerd lacks. `general-agent-resident-bundle.test.ts` walks the import
 * graph and fails on a violation.
 */

import type { TSchema } from "@sinclair/typebox";
import type {
  AgentTool,
  AgentToolResult,
} from "@stella/runtime/kernel/agent-core/types.js";
import {
  AGENT_ORCHESTRATION_TOOL_DESCRIPTORS,
  AGENT_ORCHESTRATION_TOOL_NAMES,
} from "@stella/runtime/kernel/tools/defs/agent-orchestration-def.js";
import {
  APPLY_PATCH_TOOL_DESCRIPTION,
  APPLY_PATCH_TOOL_NAME,
  APPLY_PATCH_TOOL_PARAMETERS,
} from "@stella/runtime/kernel/tools/defs/apply-patch-def.js";
import {
  CODE_TOOL_DESCRIPTION,
  CODE_TOOL_NAME,
  CODE_TOOL_PARAMETERS,
} from "@stella/runtime/kernel/tools/defs/code-def.js";
import {
  EXEC_COMMAND_TOOL_DESCRIPTION,
  EXEC_COMMAND_TOOL_NAME,
  EXEC_COMMAND_TOOL_PARAMETERS,
} from "@stella/runtime/kernel/tools/defs/exec-command-def.js";
import {
  READ_TOOL_DESCRIPTION,
  READ_TOOL_NAME,
  READ_TOOL_PARAMETERS,
} from "@stella/runtime/kernel/tools/defs/read-def.js";
import {
  WRITE_STDIN_TOOL_DESCRIPTION,
  WRITE_STDIN_TOOL_NAME,
  WRITE_STDIN_TOOL_PARAMETERS,
} from "@stella/runtime/kernel/tools/defs/write-stdin-def.js";
import {
  WEB_TOOL_DESCRIPTION,
  WEB_TOOL_NAME,
  WEB_TOOL_PARAMETERS,
} from "@stella/runtime/kernel/tools/defs/web-def.js";

/**
 * Where a general-agent tool's work happens.
 *
 * `container` needs a real process or the world filesystem, so the first such
 * call attaches the Cloudflare Sandbox. `do_local` runs against worker-side
 * capabilities the DO already holds. `js_sandbox` runs in a fresh Dynamic
 * Worker isolate the DO loads on demand: no container, no cold start, no
 * per-turn compute reservation.
 */
export type GeneralAgentToolCompute = "container" | "do_local" | "js_sandbox";

export const PUBLISH_STELLA_INTERIOR_TOOL_NAME = "publish_stella_interior";

/** The legacy image-read name. It has no runtime definition and no descriptor,
 * so it never reaches the model, but a replayed historical transcript can
 * still name it and must route rather than look unknown. */
export const LEGACY_VIEW_IMAGE_TOOL_NAME = "view_image";

/**
 * `code` runs in the JS sandbox, exactly as the cloud orchestrator's `code`
 * does: the same Dynamic Worker executor, the same read-only nested-tool
 * rules, and no browser facility. The resident agent therefore never boots a
 * container just to evaluate JavaScript; a turn that needs a process or the
 * world filesystem still attaches on its first container tool. Until this
 * classification, `code` sat in `container` yet was never bridged to the
 * daemon, so every cloud background agent that reached for code mode got the
 * "no workspace attached" refusal and nothing else.
 */
const GENERAL_AGENT_TOOL_COMPUTE = {
  [EXEC_COMMAND_TOOL_NAME]: "container",
  [WRITE_STDIN_TOOL_NAME]: "container",
  [READ_TOOL_NAME]: "container",
  [APPLY_PATCH_TOOL_NAME]: "container",
  [LEGACY_VIEW_IMAGE_TOOL_NAME]: "container",
  [CODE_TOOL_NAME]: "js_sandbox",
  [WEB_TOOL_NAME]: "do_local",
  spawn_agent: "do_local",
  send_input: "do_local",
  pause_agent: "do_local",
  agent_status: "do_local",
  [PUBLISH_STELLA_INTERIOR_TOOL_NAME]: "do_local",
} as const satisfies Record<string, GeneralAgentToolCompute>;

export type GeneralAgentToolName = keyof typeof GENERAL_AGENT_TOOL_COMPUTE;

export const GENERAL_AGENT_TOOL_NAMES = Object.keys(
  GENERAL_AGENT_TOOL_COMPUTE,
) as readonly GeneralAgentToolName[];

export class UnknownGeneralAgentToolError extends Error {
  constructor(readonly toolName: string) {
    super(`${toolName} is not a general-agent tool.`);
    this.name = "UnknownGeneralAgentToolError";
  }
}

/**
 * The only way to ask where a tool runs. Unknown names throw: a general-agent
 * turn has a fixed catalog, so an unclassified name is a programming error or
 * a hallucinated call, and both must stop before either picks a placement.
 */
export const computeForTool = (toolName: string): GeneralAgentToolCompute => {
  const compute = (
    GENERAL_AGENT_TOOL_COMPUTE as Record<
      string,
      GeneralAgentToolCompute | undefined
    >
  )[toolName];
  if (!compute) throw new UnknownGeneralAgentToolError(toolName);
  return compute;
};

export const generalAgentToolNamesFor = (
  compute: GeneralAgentToolCompute,
): readonly GeneralAgentToolName[] =>
  GENERAL_AGENT_TOOL_NAMES.filter((name) => computeForTool(name) === compute);

export type GeneralAgentToolDescriptor = Readonly<{
  name: string;
  label: string;
  workingText?: string;
  description: string;
  parameters: Record<string, unknown>;
}>;

/**
 * The one pinned tool with no tool-host handler behind it. The container path
 * answers it by posting a turn-broker command; the resident path records the
 * request in the DO directly.
 */
const PUBLISH_STELLA_INTERIOR_DESCRIPTOR: GeneralAgentToolDescriptor = {
  name: PUBLISH_STELLA_INTERIOR_TOOL_NAME,
  label: "Publish interior build",
  workingText: "Requesting the interior build",
  description:
    "Ask Stella to run the immutable production build of this Stella interior workspace after this turn finishes, and record the result as a candidate the user can select in Settings. Call it once, only when your source changes are complete and you would stand behind them. It publishes nothing on its own: the user chooses whether to switch to the candidate.",
  parameters: {
    type: "object",
    properties: {
      note: {
        type: "string",
        maxLength: 512,
        description:
          "Optional one-line summary of what changed, for the build record.",
      },
    },
    additionalProperties: false,
  },
};

/**
 * Every model-visible entry, in the order the container executor emits it.
 * `label` mirrors what that path produces: none of the tool-host definitions
 * carries a label, so the executor falls back to the tool name.
 */
export const GENERAL_AGENT_TOOL_DESCRIPTORS: readonly GeneralAgentToolDescriptor[] =
  [
    {
      name: EXEC_COMMAND_TOOL_NAME,
      label: EXEC_COMMAND_TOOL_NAME,
      description: EXEC_COMMAND_TOOL_DESCRIPTION,
      parameters: EXEC_COMMAND_TOOL_PARAMETERS,
    },
    {
      name: WRITE_STDIN_TOOL_NAME,
      label: WRITE_STDIN_TOOL_NAME,
      description: WRITE_STDIN_TOOL_DESCRIPTION,
      parameters: WRITE_STDIN_TOOL_PARAMETERS,
    },
    {
      name: APPLY_PATCH_TOOL_NAME,
      label: APPLY_PATCH_TOOL_NAME,
      description: APPLY_PATCH_TOOL_DESCRIPTION,
      parameters: APPLY_PATCH_TOOL_PARAMETERS,
    },
    {
      name: WEB_TOOL_NAME,
      label: WEB_TOOL_NAME,
      description: WEB_TOOL_DESCRIPTION,
      parameters: WEB_TOOL_PARAMETERS,
    },
    {
      name: READ_TOOL_NAME,
      label: READ_TOOL_NAME,
      description: READ_TOOL_DESCRIPTION,
      parameters: READ_TOOL_PARAMETERS,
    },
    {
      name: CODE_TOOL_NAME,
      label: CODE_TOOL_NAME,
      description: CODE_TOOL_DESCRIPTION,
      parameters: CODE_TOOL_PARAMETERS,
    },
    ...AGENT_ORCHESTRATION_TOOL_DESCRIPTORS.map((descriptor) => ({
      ...descriptor,
      label: descriptor.name,
    })),
    PUBLISH_STELLA_INTERIOR_DESCRIPTOR,
  ];

export const descriptorForTool = (
  toolName: string,
): GeneralAgentToolDescriptor => {
  const descriptor = GENERAL_AGENT_TOOL_DESCRIPTORS.find(
    (candidate) => candidate.name === toolName,
  );
  if (!descriptor) throw new UnknownGeneralAgentToolError(toolName);
  return descriptor;
};

export const NO_WORKSPACE_ATTACHED_MESSAGE =
  "This turn has no workspace attached yet";

export const NO_JS_SANDBOX_MESSAGE =
  "The cloud code runtime is not available for this turn";

/**
 * With no ladder supplied, a container tool returns a model-visible tool error
 * rather than throwing: a throw fails the turn, while an error result lets the
 * model answer from the conversation or tell the user why it cannot.
 */
const refusalStub = (
  descriptor: GeneralAgentToolDescriptor,
  reason: string = NO_WORKSPACE_ATTACHED_MESSAGE,
): AgentTool => ({
  name: descriptor.name,
  label: descriptor.label,
  ...(descriptor.workingText ? { workingText: descriptor.workingText } : {}),
  description: descriptor.description,
  parameters: descriptor.parameters as unknown as TSchema,
  execute: async (): Promise<AgentToolResult<unknown>> => ({
    content: [
      {
        type: "text",
        text: `${reason}, so ${descriptor.name} cannot run. Answer from the conversation, or tell the user this needs a workspace.`,
      },
    ],
    details: null,
    isError: true,
  }),
});

/**
 * What a container tool needs to actually run: the ladder that attaches the
 * sandbox on the first such call and bridges every later one to its daemon.
 */
export type GeneralAgentComputeBridge = Readonly<{
  execute(call: {
    toolCallId: string;
    toolName: string;
    params: Record<string, unknown>;
  }): Promise<{
    outcome:
      | Readonly<{ kind: "ok"; text: string }>
      | Readonly<{ kind: "error"; message: string }>;
    details: unknown;
  }>;
}>;

/**
 * The tools the ladder can serve. A container tool outside this set keeps the
 * refusal stub even when a ladder is supplied, because the daemon has no
 * handler for it and a bridged call would fail with a protocol error the model
 * cannot act on. `code` is not a container tool at all; it is placed in the
 * JS sandbox and supplied by the caller.
 */
const BRIDGED_TOOL_NAMES: ReadonlySet<string> = new Set([
  EXEC_COMMAND_TOOL_NAME,
  WRITE_STDIN_TOOL_NAME,
  READ_TOOL_NAME,
  APPLY_PATCH_TOOL_NAME,
]);

const bridgedTool = (
  descriptor: GeneralAgentToolDescriptor,
  compute: GeneralAgentComputeBridge,
): AgentTool => ({
  name: descriptor.name,
  label: descriptor.label,
  ...(descriptor.workingText ? { workingText: descriptor.workingText } : {}),
  description: descriptor.description,
  parameters: descriptor.parameters as unknown as TSchema,
  execute: async (toolCallId, params): Promise<AgentToolResult<unknown>> => {
    const result = await compute.execute({
      toolCallId,
      toolName: descriptor.name,
      params: (params ?? {}) as Record<string, unknown>,
    });
    if (result.outcome.kind === "error") {
      return {
        content: [{ type: "text", text: result.outcome.message }],
        details: result.details ?? null,
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: result.outcome.text || "(no output)" }],
      details: result.details ?? null,
    };
  },
});

/**
 * The resident catalog: one entry per descriptor, in descriptor order. The
 * caller supplies the do-local tools it executes itself and, when the DO can
 * load Dynamic Workers, the JS-sandbox tools. A container tool the ladder can
 * serve is bridged to it; every other container tool keeps the refusal stub,
 * and a JS-sandbox tool without an implementation refuses with its own
 * reason, so no tool leaves the model's list merely because its execution
 * path is not wired on this deployment.
 */
export const createResidentGeneralAgentTools = (
  doLocal: ReadonlyMap<string, AgentTool>,
  compute?: GeneralAgentComputeBridge,
  jsSandbox?: ReadonlyMap<string, AgentTool>,
  options: Readonly<{ agentDepth?: number }> = {},
): readonly AgentTool[] =>
  GENERAL_AGENT_TOOL_DESCRIPTORS.filter(
    (descriptor) =>
      (options.agentDepth ?? 0) < 2 ||
      !AGENT_ORCHESTRATION_TOOL_NAMES.includes(descriptor.name),
  ).map((descriptor) => {
    const placement = computeForTool(descriptor.name);
    if (placement === "container") {
      return compute && BRIDGED_TOOL_NAMES.has(descriptor.name)
        ? bridgedTool(descriptor, compute)
        : refusalStub(descriptor);
    }
    if (placement === "js_sandbox") {
      return (
        jsSandbox?.get(descriptor.name) ??
        refusalStub(descriptor, NO_JS_SANDBOX_MESSAGE)
      );
    }
    const tool = doLocal.get(descriptor.name);
    if (!tool) {
      throw new Error(
        `The resident catalog is missing its ${descriptor.name} implementation.`,
      );
    }
    return tool;
  });
