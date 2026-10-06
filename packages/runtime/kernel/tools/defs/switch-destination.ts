import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import {
  DEVICES_PATH,
  type DeviceDestination,
} from "@stella/contracts/turn-plane/placement";
import type { ToolDefinition } from "../types.js";
import { parseSpawnDestination } from "./agent-orchestration-def.js";

export const SWITCH_DESTINATION_TOOL_NAME = "switch_destination";

export type ExecutionDestinationSwitchTarget =
  | { mode: "automatic" }
  | { mode: "cloud" }
  | { mode: "device"; deviceId: string };

export type ExecutionDestinationSwitchRequest = {
  conversationId: string;
  runId?: string;
  target: ExecutionDestinationSwitchTarget;
  prompt?: string;
};

export type ExecutionDestinationSwitcher = (
  request: ExecutionDestinationSwitchRequest,
) => Promise<{ ok: true } | { ok: false; error: string }>;

export const SWITCH_DESTINATION_TOOL_DESCRIPTOR = {
  name: SWITCH_DESTINATION_TOOL_NAME,
  description:
    "Move yourself to another execution destination: the same switch the user flips in the app, so the chat's destination picker changes too. Your own tools (code, Read, and the rest) then run there. Use it when the user wants you, not a background agent, working on another computer or in the cloud. The move takes effect when this turn ends: you continue there with `prompt` as your brief, so end this turn right after calling it.",
  parameters: {
    type: "object",
    properties: {
      destination: {
        type: "string",
        description:
          'Where to move: "cloud", or a device_id from the connected devices list. This device\'s own id switches the chat back to running here.',
      },
      prompt: {
        type: "string",
        description:
          "Your brief to yourself for the turn that continues at the destination: what the user asked and what to do there. Self-contained; it is the first thing you read after the move. Required unless the destination is where you already are.",
      },
    },
    required: ["destination"],
  },
} as const;

const DEVICE_LIST_TIMEOUT_MS = 5_000;

const loadDevices = async (
  auth: { baseUrl: string; authToken: string },
): Promise<DeviceDestination[] | null> => {
  try {
    const response = await fetch(
      `${auth.baseUrl.replace(/\/+$/, "")}${DEVICES_PATH}`,
      {
        headers: { Authorization: `Bearer ${auth.authToken}` },
        signal: AbortSignal.timeout(DEVICE_LIST_TIMEOUT_MS),
      },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { devices?: unknown };
    return Array.isArray(body.devices)
      ? (body.devices as DeviceDestination[])
      : null;
  } catch {
    return null;
  }
};

const deviceRefusal = (device: DeviceDestination, name: string): string | null => {
  if (!device.online) {
    return `${name} is offline, so you can't move there now. Tell the user, or use spawn_agent with that destination if the work can wait for it to come back.`;
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
  return null;
};

export const createSwitchDestinationTool = (options: {
  getCloudBackendAuth?: () => { baseUrl: string; authToken: string } | null;
  switchExecutionDestination?: ExecutionDestinationSwitcher;
}): ToolDefinition => ({
  ...SWITCH_DESTINATION_TOOL_DESCRIPTOR,
  label: "Switch destination",
  workingText: "Switching destination",
  replay: "unsafe",
  agentTypes: [AGENT_IDS.ORCHESTRATOR],
  execute: async (args, context) => {
    const destination = parseSpawnDestination(args.destination);
    if (destination.kind === "here") {
      return { error: 'destination is required: "cloud" or a device_id.' };
    }
    if (context.conversationId.startsWith("local_") || context.storageMode === "local") {
      return {
        error: "This chat is stored only on this computer, so it can only run here.",
      };
    }
    const switcher = options.switchExecutionDestination;
    if (!switcher) {
      return {
        error: "This runtime can't change the chat's destination. Use spawn_agent with a destination instead.",
      };
    }
    if (destination.kind === "device" && destination.deviceId === context.deviceId) {
      const result = await switcher({
        conversationId: context.conversationId,
        ...(context.runId ? { runId: context.runId } : {}),
        target: { mode: "automatic" },
      });
      if (!result.ok) return { error: result.error };
      return {
        result:
          "You are already running on this computer. The chat's destination is now set to this computer, so later turns run here too. Carry on.",
      };
    }
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!prompt) {
      return {
        error: "prompt is required: write the brief you will continue from at the destination.",
      };
    }
    const auth = options.getCloudBackendAuth?.() ?? null;
    if (!auth) {
      return {
        error: "Moving to the cloud or another computer needs this computer to be signed in to Stella.",
      };
    }
    let name = "Stella's cloud";
    if (destination.kind === "device") {
      const devices = await loadDevices(auth);
      if (!devices) {
        return {
          error: "Couldn't read the connected devices list right now. Try again in a moment.",
        };
      }
      const device = devices.find((entry) => entry.deviceId === destination.deviceId);
      if (!device) {
        return {
          error: `No connected device has device_id ${destination.deviceId}. Use a device_id from the connected devices list, or "cloud".`,
        };
      }
      name = device.label?.trim() || destination.deviceId;
      const refusal = deviceRefusal(device, name);
      if (refusal) return { error: refusal };
    }
    const result = await switcher({
      conversationId: context.conversationId,
      ...(context.runId ? { runId: context.runId } : {}),
      target:
        destination.kind === "cloud"
          ? { mode: "cloud" }
          : { mode: "device", deviceId: destination.deviceId },
      prompt,
    });
    if (!result.ok) return { error: result.error };
    return {
      result: `Switched this chat to ${name}; the app's destination picker shows it now. You continue there from your brief as soon as this turn ends, and later turns run there too. End this turn now with one short line telling the user you're moving to ${name}. Do no more work here.`,
    };
  },
});
