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
 */
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
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

/** The tools a conversation's execution environment runs. */
export const ENVIRONMENT_TOOL_NAMES = "Bash, write_stdin, Read, Write, Edit, Grep and apply_patch";

export type StellaExecutionHost = {
  /**
   * The chat is kept on this computer only, so its tools can run nowhere
   * else: every switch is refused.
   */
  localOnly?: boolean;
  /**
   * Whether `target` can run tools now, and what an agent is told about it
   * (a computer's name and home, from asking it); else why not, in words
   * the agent can act on.
   */
  prepare(target: StellaPlacement, context: Context): Promise<{ placement: StellaPlacement } | { error: string }>;
  /** A conversation's tools moved: what its old environment held is let go (its container's work saved first). */
  moved?(conversationId: number, from: StellaPlacement, to: StellaPlacement, context: Context): Promise<void>;
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
    placement.home ? `Its home is ${placement.home}: \`~\` there, and a shell command's working directory unless you pass one.` : "",
    'switch_destination with "cloud" moves them back.',
  ]
    .filter(Boolean)
    .join("\n");

const switchedText = (from: StellaPlacement, to: StellaPlacement, orchestrator: boolean): string => {
  const left = describePlacement(from);
  if (to.kind === "device") {
    const what = orchestrator
      ? "Your Read now reads that computer's files, and agents you start without a destination run their tools there"
      : `From your next call, your ${ENVIRONMENT_TOOL_NAMES} run there`;
    return [
      `Your tools now run on ${computerLine(to)}. ${what}.`,
      to.home ? `Its home is ${to.home}: \`~\` there, and your shell's working directory unless you pass one.` : "",
      `This is a fresh environment: nothing from ${left} comes along. Its files and any shell you started there are not on this computer, and what you make here stays here unless you move it yourself.`,
      'Your conversation and everything else stay with you, so carry on in this turn. switch_destination with "cloud" moves your tools back.',
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    orchestrator
      ? "Your Read reads the cloud again, and agents you start without a destination run there."
      : `From your next call, your ${ENVIRONMENT_TOOL_NAMES} run in a fresh cloud container again, with the user's world at /workspace/world as \`~\`.`,
    `Nothing from ${left} comes along: its files stay on it, and any shell you started there is not here.`,
    "Your conversation and everything else stay with you, so carry on in this turn.",
  ].join("\n");
};

/** `switch_destination`, for a host whose conversations' tools can move. */
export const switchDestinationTool = (host: StellaExecutionHost, rootPlacement: StellaPlacement) =>
  defineTool({
    name: SWITCH_DESTINATION_TOOL_NAME,
    description:
      'Move where your tools run: "cloud", or one of the user\'s computers by device_id. Only the tools move. Your conversation, what you know of this work and the agents you started stay with you, so you carry on in this same turn; the switch takes effect from your next tool call. The new place is a fresh environment: files and shells from where you were do not come along. Use it when the work needs that computer\'s files, programs or hardware, or to come back to the cloud. For Stella it moves her Read and where her new agents run by default.',
    parameters: Type.Object({
      destination: Type.String({
        description: 'Where your tools run from now on: "cloud", or a device_id from the connected devices list.',
      }),
      prompt: Type.Optional(
        Type.String({
          description: "Optional: a line on what you will do there, shown with the switch.",
        }),
      ),
    }),
    // Setting where tools run twice is setting it once.
    replay: "safe",
    execute: async (args, api, context) => {
      const destination = parseSpawnDestination(args.destination);
      if (destination.kind === "here") throw new Error('destination is required: "cloud" or a device_id.');
      if (host.localOnly) throw new Error("This chat is stored only on this computer, so it can only run here.");
      const self = (await api.snapshot(StellaAgentDoc, api.conversationId, context)) ?? { agentType: "orchestrator" };
      const orchestrator = self.agentType === "orchestrator";
      const current = placementOf(await api.snapshot(StellaPlacementDoc, api.conversationId, context)) ?? rootPlacement;
      const target: StellaPlacement =
        destination.kind === "cloud" ? { kind: "cloud" } : { kind: "device", deviceId: destination.deviceId };
      if (samePlacement(current, target)) {
        return { content: [{ type: "text", text: `Your tools already run on ${describePlacement(current)}. Carry on.` }] };
      }
      const prepared = await host.prepare(target, context);
      if ("error" in prepared) throw new Error(prepared.error);
      const to = prepared.placement;
      await api.commit(async (tx) => {
        const where = (await tx.doc(StellaPlacementDoc, api.conversationId)) as Record<string, unknown>;
        for (const key of Object.keys(where)) delete where[key];
        Object.assign(where, placementRecord(to));
      }, context);
      await host.moved?.(api.conversationId, current, to, context);
      const brief = args.prompt?.trim();
      return {
        content: [{ type: "text", text: switchedText(current, to, orchestrator) }],
        details: {
          destination: to.kind === "device" ? to.deviceId : "cloud",
          ...(brief ? { brief } : {}),
        },
      };
    },
  });
