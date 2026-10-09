/**
 * Where a desktop conversation's tools run, apart from the conversation: the
 * brain (Stella's or an agent's conversation, its state and history) stays
 * in this computer's harness, and its file and shell tools run on this
 * computer, on another of the owner's computers, or in a cloud container.
 *
 *   another computer: this computer --HTTP--> owner gate --presence socket--> computer
 *   cloud:            this computer --HTTP--> conversation object --> its container
 *
 * Both ends serve the same file and shell tools a cloud agent's container
 * does (`@stella/contracts/turn-plane/device-tools`), so a call leaves here
 * in their shape: pi's own tools translate their arguments, and Stella's
 * Read goes as it is. Only a conversation stored in the cloud can move its
 * tools; one kept on this computer refuses every switch.
 *
 * In a conversation stored in the cloud Stella can move her brain as well
 * (`switch_destination` with `move: "brain"`): the conversation's object
 * records the new host (`@stella/contracts/turn-plane/pi-brain`), and once
 * her turn here ends her brief continues there as a placed chat.
 */
import { createHash } from "node:crypto";
import type { Context, JsonValue } from "@earendil-works/chord";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { defineExtension, type Extension, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import type { DeviceDestination } from "@stella/contracts/turn-plane/placement";
import type { PiBrainHost, PiBrainRecord } from "@stella/contracts/turn-plane/pi-brain";
import type {
  DeviceToolCall,
  DeviceToolName,
  DeviceToolOutcome,
  DeviceToolResult,
} from "@stella/contracts/turn-plane/device-tools";
import { StellaAgentDoc } from "../stella/agent-doc.ts";
import { STELLA_CODING_EXTENSION } from "../stella/coding.ts";
import { deviceRefusal, type StellaExecutionHost } from "../stella/execution.ts";
import { placementOf, StellaPlacementDoc, type StellaPlacement } from "../stella/placement.ts";

/** How long a cloud container is kept for a conversation that stopped calling it. */
const CLOUD_IDLE_MS = 10 * 60_000;
/** The longest a shell command waits for its end on the other side before handing back a session. */
const SHELL_WAIT_MS = 600_000;

/** One file or shell call for a conversation's tools elsewhere. */
export type RemoteToolCall = {
  /** The pi conversation whose tools these are, in this computer's harness. */
  piConversationId: number;
  /** The agent's thread; absent for Stella herself. */
  threadId?: string;
  callId: string;
  toolName: DeviceToolName;
  params: Record<string, unknown>;
};

/** How this computer reaches the owner's other computers and the cloud, for one conversation stored in the cloud. */
export type DesktopExecutionRemote = {
  /** The owner's computers, as the owner gate lists them. */
  devices(): Promise<DeviceDestination[]>;
  /** One call on a computer, relayed by the owner gate; `signal` withdraws it there too. */
  deviceTool(deviceId: string, requestId: string, call: DeviceToolCall, signal?: AbortSignal): Promise<DeviceToolOutcome>;
  /** One call in the conversation's cloud container for `scope`, which comes up on the first. */
  cloudTool(
    call: { scope: string; threadId: string; callId: string; toolName: DeviceToolName; params: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<DeviceToolResult>;
  /** Save the container's work into the world and let it go. */
  releaseCloud(scope: string): Promise<void>;
};

/** Where a conversation stored in the cloud has its brain, as its object records it. */
export type DesktopBrain = {
  read(): Promise<PiBrainRecord | null>;
  set(host: PiBrainHost): Promise<PiBrainRecord>;
  /** Carry on at `host` with Stella's brief, as a chat placed there. */
  handOff(host: PiBrainHost, brief: string): Promise<void>;
};

export type ToolResultContent = (TextContent | ImageContent)[];

const result = (outcome: DeviceToolResult): { content: ToolResultContent; isError?: true } => ({
  content: [
    { type: "text", text: outcome.text || "(no output)" },
    ...(outcome.images ?? []).map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
  ],
  ...(outcome.isError ? { isError: true as const } : {}),
});

const failure = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true as const });

/**
 * pi's file and shell tools, as the other side's tools take them: the
 * same work under the container's argument names. A shell command waits as
 * long as the other side lets one wait.
 */
const remoteCall = (toolName: string, args: Record<string, unknown>): { toolName: DeviceToolName; params: Record<string, unknown> } => {
  switch (toolName) {
    case "Bash": {
      const seconds = typeof args.timeout === "number" && args.timeout > 0 ? args.timeout : undefined;
      return {
        toolName: "Bash",
        params: { cmd: args.command, timeout_ms: Math.min(SHELL_WAIT_MS, seconds ? seconds * 1000 : SHELL_WAIT_MS) },
      };
    }
    case "Read":
      return {
        toolName: "Read",
        params: {
          file_path: args.path,
          ...(typeof args.offset === "number" ? { offset: args.offset } : {}),
          ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
        },
      };
    case "Write":
      return { toolName: "Write", params: { file_path: args.path, content: args.content } };
    case "Edit": {
      const edits = Array.isArray(args.edits) ? (args.edits as Array<{ oldText?: unknown; newText?: unknown }>) : [];
      return {
        toolName: "Edit",
        params: { file_path: args.path, edits: edits.map((edit) => ({ old_string: edit.oldText, new_string: edit.newText })) },
      };
    }
    default:
      throw new Error(`${toolName} does not run away from this computer.`);
  }
};

/**
 * The agents' `stella-coding` on this computer: pi's own tools, which run
 * here through the ExecutionEnv, and wherever else the conversation's tools
 * were moved through `run`.
 */
export const desktopCoding = (
  run: (placement: Exclude<StellaPlacement, { kind: "local" }>, call: RemoteToolCall, context: Context) => Promise<{ content: ToolResultContent; isError?: true }>,
): Extension =>
  defineExtension({
    name: STELLA_CODING_EXTENSION,
    tools: [
      { ...createBashTool(), name: "Bash" },
      { ...createReadTool(), name: "Read" },
      { ...createWriteTool(), name: "Write" },
      { ...createEditTool(), name: "Edit" },
    ].map(
      (tool): ToolRegistration => ({
        ...tool,
        async execute(args: unknown, api: ToolExecutionApi<JsonValue>, context: Context) {
          const placement = placementOf(await api.snapshot(StellaPlacementDoc, api.conversationId, context));
          if (!placement || placement.kind === "local") return await tool.execute(args as never, api as never, context);
          const role = await api.snapshot(StellaAgentDoc, api.conversationId, context);
          const { toolName, params } = remoteCall(tool.name, (args ?? {}) as Record<string, unknown>);
          return await run(
            placement,
            {
              piConversationId: api.conversationId,
              ...(role?.threadId ? { threadId: role.threadId } : {}),
              callId: api.callId,
              toolName,
              params,
            },
            context,
          );
        },
      }),
    ),
  });

/**
 * One conversation's execution host on this computer: where its tools can
 * move (`switch_destination`, `spawn_agent` with a device), and how a call
 * reaches them there.
 */
export function desktopExecution(options: {
  /** The Stella conversation. */
  conversationId: string;
  /** This computer: naming it moves tools back here. */
  deviceId?: string;
  /** Kept on this computer only: every switch is refused. */
  localOnly: boolean;
  remote?: DesktopExecutionRemote;
  /** Where the conversation's brain runs, for a conversation stored in the cloud. */
  brain?: DesktopBrain;
  /** Settles once Stella's turn here has ended, so her brief continues after it. */
  turnEnded?(): Promise<void>;
  /** The record the conversation's object took for a move. */
  brainMoved?(record: PiBrainRecord): void;
  report(error: unknown): void;
}) {
  const { conversationId, remote } = options;
  /** Containers this conversation holds, by scope, each let go when it sits idle. */
  const idle = new Map<string, ReturnType<typeof setTimeout>>();
  const scopeOf = (piConversationId: number) => `${options.deviceId ?? "desktop"}:${piConversationId}`;

  const release = async (scope: string) => {
    const timer = idle.get(scope);
    if (timer) clearTimeout(timer);
    idle.delete(scope);
    await remote?.releaseCloud(scope);
  };

  const touch = (scope: string) => {
    const previous = idle.get(scope);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      if (idle.get(scope) !== timer) return;
      void release(scope).catch((error: unknown) => options.report(error));
    }, CLOUD_IDLE_MS);
    timer.unref?.();
    idle.set(scope, timer);
  };

  /** One call where the conversation's tools run now. */
  const run = async (
    placement: Exclude<StellaPlacement, { kind: "local" }>,
    call: RemoteToolCall,
    context: Context,
  ): Promise<{ content: ToolResultContent; isError?: true }> => {
    if (!remote) return failure("Sign in to Stella to run tools away from this computer.");
    const signal = context.abortSignal;
    if (placement.kind === "cloud") {
      const scope = scopeOf(call.piConversationId);
      touch(scope);
      try {
        return result(
          await remote.cloudTool(
            {
              scope,
              threadId: call.threadId ?? "stella",
              callId: call.callId,
              toolName: call.toolName,
              params: call.params,
            },
            signal,
          ),
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        return failure(
          `The cloud workspace did not run it: ${error instanceof Error ? error.message : String(error)} Try again, or switch_destination back to this computer.`,
        );
      } finally {
        touch(scope);
      }
    }
    const name = placement.label || placement.deviceId;
    // The same call is the same request on every attempt, so a rerun joins it there.
    const requestId = `pt:${createHash("sha256").update(`${conversationId}:${call.piConversationId}:${call.callId}`).digest("hex")}`;
    let outcome: DeviceToolOutcome;
    try {
      outcome = await remote.deviceTool(
        placement.deviceId,
        requestId,
        {
          kind: "tool",
          toolName: call.toolName,
          params: call.params,
          callId: call.callId,
          conversationId,
          ...(call.threadId ? { threadId: call.threadId } : {}),
        },
        signal,
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      outcome = { ok: false, code: "failed", message: error instanceof Error ? error.message : String(error) };
    }
    if (!outcome.ok) {
      const unreachable = outcome.code === "device_offline" || outcome.code === "not_ready" || outcome.code === "not_enabled";
      return failure(
        `${outcome.message.replace(/^That computer/u, name)}${
          unreachable
            ? ` Your tools are set to run on ${name}. Tell the user, wait for it, or switch_destination back to this computer and carry on here.`
            : ""
        }`,
      );
    }
    if (!("result" in outcome)) return failure(`${name} sent no result.`);
    return result(outcome.result);
  };

  const host: StellaExecutionHost = {
    localOnly: options.localOnly,
    prepare: async (target) => {
      if (target.kind === "local" || (target.kind === "device" && target.deviceId === options.deviceId)) {
        return { placement: { kind: "local" } };
      }
      if (!remote) return { error: "Sign in to Stella to run tools away from this computer." };
      if (target.kind === "cloud") return { placement: { kind: "cloud" } };
      const listed = await remote.devices().catch(() => undefined);
      if (!listed) return { error: "Couldn't read the connected devices list right now. Try again in a moment." };
      const device = listed.find((entry) => entry.deviceId === target.deviceId);
      if (!device) {
        return {
          error: `No connected device has device_id ${target.deviceId}. Use a device_id from the connected devices list, "cloud", or "local" for this computer.`,
        };
      }
      const name = device.label?.trim() || target.deviceId;
      const refusal = deviceRefusal(device, name);
      if (refusal) return { error: refusal };
      const described = await remote
        .deviceTool(target.deviceId, `describe:${crypto.randomUUID()}`, { kind: "describe" })
        .catch((error: unknown) => ({ ok: false as const, code: "failed" as const, message: error instanceof Error ? error.message : String(error) }));
      if (!described.ok) return { error: `${name} could not take tool calls: ${described.message.replace(/^That computer/u, "it")}` };
      if (!("description" in described)) return { error: `${name} did not describe itself.` };
      const { home, hostname, platform } = described.description;
      return {
        placement: {
          kind: "device",
          deviceId: target.deviceId,
          label: name,
          home,
          ...(hostname ? { hostname } : {}),
          ...(platform ? { platform } : {}),
        },
      };
    },
    // Leaving the cloud saves the container's work into the world, then lets it go.
    moved: async (piConversationId, from) => {
      if (from.kind === "cloud") await release(scopeOf(piConversationId)).catch((error: unknown) => options.report(error));
    },
    ...(options.brain && !options.localOnly
      ? {
          moveBrain: async (target, brief, context) => {
            const brain = options.brain!;
            if (target.kind === "local" || (target.kind === "device" && target.deviceId === options.deviceId)) {
              return { error: "You already run on this computer." };
            }
            // A computer must be able to take work now, as for its tools.
            const prepared = await host.prepare(target, context);
            if ("error" in prepared) return prepared;
            const placement = prepared.placement;
            const next: PiBrainHost =
              placement.kind === "device"
                ? { host: "device", deviceId: placement.deviceId, ...(placement.label ? { label: placement.label } : {}) }
                : { host: "cloud" };
            const record = await brain.set(next);
            options.brainMoved?.(record);
            void (async () => {
              await options.turnEnded?.();
              await brain.handOff(next, brief);
            })().catch((error: unknown) => options.report(error));
            return { moved: placement };
          },
        }
      : {}),
  };

  return {
    host,
    run,
    /** Let every container this conversation holds go. */
    async close(): Promise<void> {
      await Promise.all([...idle.keys()].map((scope) => release(scope).catch(() => undefined)));
    },
  };
}

export type DesktopExecution = ReturnType<typeof desktopExecution>;
