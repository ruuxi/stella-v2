/**
 * Where a conversation's tools run, apart from where the conversation itself
 * runs. An agent's brain (its conversation, state and history) stays on the
 * host that holds it; its file and shell tools run in that conversation's
 * execution environment: a cloud container, or one of the owner's computers,
 * reached tool call by tool call. `switch_destination` moves the environment
 * and nothing else, so the agent carries on in the same turn with the same
 * context.
 *
 * For Stella herself the environment is where her own `Read` reads, and
 * where the agents she starts without a destination run their tools.
 *
 * Stella's brain can move too, in a conversation stored in the cloud:
 * `switch_destination` with `move: "brain"` hands the conversation's turns
 * to another host (the conversation's object in the cloud, or one of the
 * owner's computers), which carries on from the shared journal with her
 * brief (`@stella/contracts/turn-plane/pi-brain`).
 */
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { DeviceDestination } from "@stella/contracts/turn-plane/placement";
import { StellaAgentDoc } from "./agent-doc.ts";
import {
  describePlacement,
  parseSpawnDestination,
  placementOf,
  placementRecord,
  samePlacement,
  StellaPlacementDoc,
  type StellaPlacement,
} from "./placement.ts";

export const SWITCH_DESTINATION_TOOL_NAME = "switch_destination";

/** The tools a conversation's execution environment runs, as an agent reads them. */
export const ENVIRONMENT_TOOL_NAMES = "file and shell tools (Bash, Read, Write, Edit and the like)";

export type StellaExecutionHost = {
  /**
   * The chat is kept on this computer only, so its tools can run nowhere
   * else: every switch is refused.
   */
  localOnly?: boolean;
  /**
   * Whether `target` can run tools now, and what an agent is told about it
   * (a computer's name and home, from asking it); else why not, in words
   * the agent can act on. A host on a computer takes that computer, named
   * by its device id or "local", as `{ kind: "local" }`.
   */
  prepare(target: StellaPlacement, context: Context): Promise<{ placement: StellaPlacement } | { error: string }>;
  /** A conversation's tools moved: what its old environment held is let go (its container's work saved first). */
  moved?(conversationId: number, from: StellaPlacement, to: StellaPlacement, context: Context): Promise<void>;
  /**
   * Stella's brain moves to `target`: from now on that host takes the
   * conversation's turns, and `brief` continues there once this turn ends.
   * Answers where it went, named for her; absent, her brain stays on this host.
   */
  moveBrain?(target: StellaPlacement, brief: string, context: Context): Promise<{ moved: StellaPlacement } | { error: string }>;
};

/**
 * Why a listed device cannot run tools now, in the old `switch_destination`
 * words; undefined when it can.
 */
export const deviceRefusal = (device: DeviceDestination, name: string): string | undefined => {
  if (!device.online) {
    return `${name} is offline, so you can't move there now. Tell the user, or use spawn_agent with that destination and whole_agent if the work can wait for it to come back.`;
  }
  switch (device.remoteExecution) {
    case "enabled":
      break;
    case "asking":
      return `${name} is still waiting for the user to allow work from other devices on its screen. Ask the user to approve it there, then try again.`;
    case "declined":
      return `${name} has declined work from other devices. To change that, on ${name} the user opens Account › "Stella on your phone" and presses Enable next to that computer.`;
    default:
      return `${name} hasn't been enabled to accept work from other devices yet. To enable it, on ${name} the user opens Account › "Stella on your phone" and presses Enable next to that computer.`;
  }
  if (device.availability && device.availability.ready !== true) {
    return `${name} is online but not ready to take work yet. Try again in a moment.`;
  }
  return undefined;
};

/** The computer a placement names, as an agent reads it. */
const computerLine = (placement: Extract<StellaPlacement, { kind: "device" }>): string => {
  const about = [placement.platform, placement.hostname ? `host ${placement.hostname}` : ""].filter(Boolean).join(", ");
  return `${placement.label || placement.deviceId} [device_id: ${placement.deviceId}]${about ? ` (${about})` : ""}`;
};

/**
 * The prompt's execution destination for a conversation whose tools run on
 * one of the owner's computers.
 */
export const renderDeviceDestination = (
  placement: Extract<StellaPlacement, { kind: "device" }>,
  orchestrator: boolean,
): string =>
  [
    `Current execution destination: ${computerLine(placement)}.`,
    orchestrator
      ? "Your Read reads that computer's files, and agents you start without a destination run their tools there."
      : `Your ${ENVIRONMENT_TOOL_NAMES} run on that computer, not in a cloud container; your conversation, \`code\`, web and the rest stay where they are. What is said above about your cloud workspace (\`/workspace/world\`, the drive, delivering linked files) does not apply there: files you make on that computer stay on it.`,
    placement.home
      ? orchestrator
        ? `Its home is ${placement.home} (\`~\` there).`
        : `Its home is ${placement.home}: \`~\` there, and a shell command's working directory unless you pass one.`
      : "",
    'switch_destination with "cloud" moves them back.',
  ]
    .filter(Boolean)
    .join("\n");

/**
 * The prompt's execution destination for a conversation on a computer whose
 * tools run in a cloud container.
 */
export const renderCloudDestination = (orchestrator: boolean): string =>
  [
    "Current execution destination: Cloud.",
    orchestrator
      ? "Your Read reads a cloud container with the user's world, and agents you start without a destination run in the cloud."
      : `Your ${ENVIRONMENT_TOOL_NAMES} run in a cloud container with the user's world at /workspace/world as \`~\`, not on this computer; your conversation and everything else stay here.`,
    'switch_destination with "local" moves them back.',
  ].join("\n");

/** How an agent names where its tools started: "local" on a computer, "cloud" in the cloud. */
const homeName = (rootPlacement: StellaPlacement): string => (rootPlacement.kind === "local" ? "local" : "cloud");

const switchedText = (from: StellaPlacement, to: StellaPlacement, orchestrator: boolean, rootPlacement: StellaPlacement): string => {
  const left = describePlacement(from);
  const back = `switch_destination with "${homeName(rootPlacement)}" moves your tools back.`;
  if (to.kind === "device") {
    const what = orchestrator
      ? "Your Read now reads that computer's files, and agents you start without a destination run their tools there"
      : `From your next call, your ${ENVIRONMENT_TOOL_NAMES} run there`;
    return [
      `Your tools now run on ${computerLine(to)}. ${what}.`,
      to.home ? `Its home is ${to.home}: \`~\` there, and your shell's working directory unless you pass one.` : "",
      `This is a fresh environment: nothing from ${left} comes along. Its files and any shell you started there are not on this computer, and what you make here stays here unless you move it yourself.`,
      `Your conversation and everything else stay with you, so carry on in this turn. ${back}`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (to.kind === "local") {
    return [
      orchestrator
        ? "Your Read reads this computer's files again, and agents you start without a destination run here."
        : `From your next call, your ${ENVIRONMENT_TOOL_NAMES} run on this computer again.`,
      `Nothing from ${left} comes along: its files stay there, and any shell you started there is not here.`,
      "Your conversation and everything else stay with you, so carry on in this turn.",
    ].join("\n");
  }
  return [
    orchestrator
      ? "Your Read reads the cloud, and agents you start without a destination run there."
      : `From your next call, your ${ENVIRONMENT_TOOL_NAMES} run in a fresh cloud container, with the user's world at /workspace/world as \`~\`.`,
    `Nothing from ${left} comes along: its files stay on it, and any shell you started there is not here.`,
    "Your conversation and everything else stay with you, so carry on in this turn.",
    rootPlacement.kind === "cloud" ? "" : back,
  ]
    .filter(Boolean)
    .join("\n");
};

/** `switch_destination`, for a host whose conversations' tools can move. */
export const switchDestinationTool = (
  host: StellaExecutionHost,
  rootPlacement: StellaPlacement,
  /** The agents still working whose reports would wake Stella on this host: their descriptions. */
  workingAgents: (api: ToolExecutionApi, context: Context) => Promise<string[]>,
) =>
  defineTool({
    name: SWITCH_DESTINATION_TOOL_NAME,
    description:
      'Move where your tools run: "cloud", or one of the user\'s computers by device_id. Only the tools move, unless Stella passes move: "brain". Your conversation, what you know of this work and the agents you started stay with you, so you carry on in this same turn; the switch takes effect from your next tool call. The new place is a fresh environment: files and shells from where you were do not come along. Use it when the work needs that computer\'s files, programs or hardware, or to come back to where they started. For Stella it moves her Read and where her new agents run by default.',
    parameters: Type.Object({
      destination: Type.String({
        description:
          'Where your tools run from now on: "cloud", a device_id from the connected devices list, or "local" for the computer you run on.',
      }),
      prompt: Type.Optional(
        Type.String({
          description:
            'Optional: a line on what you will do there, shown with the switch. With move: "brain", required: your brief to yourself, which you read there to carry on.',
        }),
      ),
      move: Type.Optional(
        Type.Union([Type.Literal("tools"), Type.Literal("brain")], {
          description:
            'Stella only, in a chat stored in the cloud: "brain" moves Stella herself there, so that host takes this conversation\'s turns from now on and carries on from the shared conversation with your brief once this turn ends. Use it when the user asks you to keep going in the cloud (or on that computer) or when the work needs you there. Default "tools".',
        }),
      ),
    }),
    // Setting where tools run twice is setting it once.
    replay: "safe",
    execute: async (args, api, context) => {
      const local = /^(local|here|this computer)$/iu.test(args.destination.trim());
      const destination = parseSpawnDestination(args.destination);
      if (destination.kind === "here") throw new Error('destination is required: "cloud" or a device_id.');
      if (host.localOnly) throw new Error("This chat is stored only on this computer, so it can only run here.");
      if (local && rootPlacement.kind !== "local") throw new Error('You run in the cloud: pass "cloud" or a device_id.');
      const self = (await api.snapshot(StellaAgentDoc, api.conversationId, context)) ?? { agentType: "orchestrator" };
      const orchestrator = self.agentType === "orchestrator";
      if (args.move === "brain") {
        if (!orchestrator) throw new Error('Only Stella moves her brain. Leave out move: your tools move instead.');
        if (!host.moveBrain) throw new Error("Your brain can't move from here; move your tools instead.");
        const brief = args.prompt?.trim();
        if (!brief) throw new Error("Pass your brief as prompt: what you will do there, as you will read it there.");
        // Their reports would wake her here.
        const working = await workingAgents(api, context);
        if (working.length > 0) {
          throw new Error(
            `Your agents here are still working (${working.join("; ")}), and their reports come to you here. Move once they finish, or pause them first.`,
          );
        }
        const target: StellaPlacement = local
          ? { kind: "local" }
          : destination.kind === "cloud"
            ? { kind: "cloud" }
            : { kind: "device", deviceId: destination.deviceId };
        const moved = await host.moveBrain(target, brief, context);
        if ("error" in moved) throw new Error(moved.error);
        return {
          content: [
            {
              type: "text",
              text: `You are moving to ${describePlacement(moved.moved)}: from now on it takes this conversation's turns, and you carry on there with your brief once this turn ends, with the whole conversation. End this turn now with at most one short line to the user; start no more work here.`,
            },
          ],
          details: {
            move: "brain",
            destination: moved.moved.kind === "device" ? moved.moved.deviceId : moved.moved.kind,
            brief,
          } satisfies Record<string, string> as Record<string, string>,
        };
      }
      const current = placementOf(await api.snapshot(StellaPlacementDoc, api.conversationId, context)) ?? rootPlacement;
      const target: StellaPlacement = local
        ? { kind: "local" }
        : destination.kind === "cloud"
          ? { kind: "cloud" }
          : { kind: "device", deviceId: destination.deviceId };
      if (samePlacement(current, target)) {
        return { content: [{ type: "text", text: `Your tools already run on ${describePlacement(current)}. Carry on.` }] };
      }
      const prepared = await host.prepare(target, context);
      if ("error" in prepared) throw new Error(prepared.error);
      const to = prepared.placement;
      if (samePlacement(current, to)) {
        return { content: [{ type: "text", text: `Your tools already run on ${describePlacement(current)}. Carry on.` }] };
      }
      await api.commit(async (tx) => {
        const where = (await tx.doc(StellaPlacementDoc, api.conversationId)) as Record<string, unknown>;
        for (const key of Object.keys(where)) delete where[key];
        Object.assign(where, placementRecord(to));
      }, context);
      await host.moved?.(api.conversationId, current, to, context);
      const brief = args.prompt?.trim();
      return {
        content: [{ type: "text", text: switchedText(current, to, orchestrator, rootPlacement) }],
        details: {
          destination: to.kind === "device" ? to.deviceId : to.kind,
          ...(brief ? { brief } : {}),
        },
      };
    },
  });
