/**
 * `switch_destination` for Stella on Claude Code in the cloud (`runCliTurn`):
 * how she moves herself to one of the user's computers. pi's Stella has the
 * same tool in her own harness (`@stella/agent/stella/execution`); this one
 * keeps its shape and words, brain only.
 *
 * Only the brain moves here. Claude Code's Stella runs no work herself, so
 * there are no tools of hers to move: her agents take a `destination` of
 * their own. A move records the new host in the conversation's object
 * (`@stella/contracts/turn-plane/pi-brain`), which from then on places the
 * user's messages there, and her brief continues there once this turn ends.
 */

import type { TSchema } from "@sinclair/typebox";
import type { DeviceDestination } from "@stella/contracts/turn-plane/placement";
import { parseSpawnDestination } from "@stella/runtime/kernel/tools/defs/agent-orchestration-def.js";
import type { CloudCodeSourceAgentTool } from "./cloud-code-tool.js";

/** Why a listed device cannot take Stella now, in pi's words; undefined when it can. */
const deviceRefusal = async (
  device: DeviceDestination,
  name: string,
): Promise<string | undefined> => {
  // pi's offline line offers `whole_agent`, which this spawn_agent has not.
  if (!device.online) {
    return `${name} is offline, so you can't move there now. Tell the user, or use spawn_agent with that destination if the work can wait for it to come back.`;
  }
  const { deviceRefusal: piDeviceRefusal } = await import(
    "@stella/agent/stella/execution"
  );
  return piDeviceRefusal(device, name);
};

export type CloudSwitchDestinationToolOptions = Readonly<{
  /** The owner's connected devices, read fresh. */
  devices: () => Promise<readonly DeviceDestination[]>;
  /** The agents still working whose reports would wake Stella here: their descriptions. */
  workingAgents: () => Promise<string[]>;
  /** Stella moves to that computer; `brief` continues there once this turn ends. */
  move: (
    host: { deviceId: string; label?: string },
    brief: string,
    toolCallId: string,
  ) => Promise<void>;
}>;

export const createCloudSwitchDestinationTool = (
  options: CloudSwitchDestinationToolOptions,
): CloudCodeSourceAgentTool => ({
  name: "switch_destination",
  label: "Switch destination",
  workingText: "Switching destination",
  // A rerun records the same host again and keys the same brief.
  replay: "keyed",
  description:
    'Move yourself to one of the user\'s computers by device_id: that computer\'s Stella takes this conversation\'s turns from now on and carries on from the shared conversation with your brief once this turn ends. Use it when the user asks you to keep going on that computer, or when the work needs you there yourself rather than a background agent. Here only you move ("brain"): you run no tools of your own to move, and for separate work on a computer you pass its device_id as spawn_agent\'s destination instead.',
  parameters: {
    type: "object",
    properties: {
      destination: {
        type: "string",
        description:
          "A device_id from the connected devices list: the computer you move to.",
      },
      prompt: {
        type: "string",
        description:
          "Required: your brief to yourself, which you read there to carry on: what the user asked and what to do there. Self-contained; it is the first thing you read after the move.",
      },
      move: {
        type: "string",
        enum: ["brain"],
        description:
          'Only "brain" here: Stella herself moves, so that computer takes this conversation\'s turns from now on. Default "brain".',
      },
    },
    required: ["destination", "prompt"],
  } as unknown as TSchema,
  execute: async (toolCallId, params) => {
    const args = (params ?? {}) as {
      destination?: unknown;
      prompt?: unknown;
      move?: unknown;
    };
    if (args.move !== undefined && args.move !== "brain") {
      throw new Error(
        'Here only you move (move: "brain"). For work on a computer, pass its device_id as spawn_agent\'s destination.',
      );
    }
    const destination = parseSpawnDestination(args.destination);
    if (destination.kind === "here") {
      throw new Error(
        "destination is required: a device_id from the connected devices list.",
      );
    }
    if (destination.kind === "cloud") throw new Error("You already run in the cloud.");
    const brief = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!brief) {
      throw new Error(
        "Pass your brief as prompt: what you will do there, as you will read it there.",
      );
    }
    // Their reports would wake her here.
    const working = await options.workingAgents();
    if (working.length > 0) {
      throw new Error(
        `Your agents here are still working (${working.join("; ")}), and their reports come to you here. Move once they finish, or pause them first.`,
      );
    }
    const listed = await options.devices().catch(() => undefined);
    if (!listed) {
      throw new Error(
        "Couldn't read the connected devices list right now. Try again in a moment.",
      );
    }
    const device = listed.find((entry) => entry.deviceId === destination.deviceId);
    if (!device) {
      throw new Error(
        `No connected device has device_id ${destination.deviceId}. Use a device_id from the connected devices list.`,
      );
    }
    const label = device.label?.trim();
    const name = label || destination.deviceId;
    const refusal = await deviceRefusal(device, name);
    if (refusal) throw new Error(refusal);
    await options.move(
      { deviceId: destination.deviceId, ...(label ? { label } : {}) },
      brief,
      toolCallId,
    );
    return {
      content: [
        {
          type: "text",
          text: `You are moving to ${label ? `${label} [device ${destination.deviceId}]` : `device ${destination.deviceId}`}: from now on it takes this conversation's turns, and you carry on there with your brief once this turn ends, with the whole conversation. End this turn now with at most one short line to the user; start no more work here.`,
        },
      ],
      details: { move: "brain", destination: destination.deviceId, brief },
    };
  },
});
