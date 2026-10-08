/**
 * The frozen provider context of a resident thread, shared by every host
 * (the desktop runtime and the cloud orchestrator).
 *
 * At a boundary (thread start, compaction, a memory toggle) the system
 * prompt and each tool's description + schema freeze. Between boundaries the
 * provider keeps receiving exactly those bytes so the prompt cache keeps
 * hitting, and drift is told to the model as appended hidden messages:
 *
 *   - a system prompt section that changed is re-sent on its own, once;
 *   - tool drift is announced once per distinct change, and calls to a tool
 *     that went away fail with a clear message.
 *
 * Resident blocks (personality, memory, skills, execution context) are not
 * part of this; they live in `resident-context.js`.
 *
 * Pure and serializable: the desktop keeps the state in memory, the cloud
 * persists it with the conversation.
 */

import type { RuntimePromptMessage } from "@stella/contracts/protocol";
import { wrapSystemReminder } from "@stella/contracts/system-reminders";
import { CONTEXT_DELTA_CUSTOM_TYPE_PREFIX } from "./resident-context.js";

/** One named part of a system prompt. */
export type SystemPromptSection = { id: string; text: string };

export const renderSystemPrompt = (
  sections: readonly SystemPromptSection[],
): string => sections.map((section) => section.text).join("\n\n");

type ToolDescriptor = {
  name: string;
  description: string;
  parameters: unknown;
};

export type FrozenTool = {
  name: string;
  description: string;
  parameters: unknown;
  parametersJson: string;
};

export type FrozenContext = {
  /** The system prompt bytes the provider receives until the next boundary. */
  systemPrompt: string;
  /** Each section as the model last saw it: frozen, or since re-sent. */
  sections: SystemPromptSection[];
  tools: FrozenTool[];
  /** The last announced tool drift, so one change is announced once. */
  toolDriftSignature: string | null;
};

const schemaJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
};

export const freezeContext = (
  sections: readonly SystemPromptSection[],
  tools: readonly ToolDescriptor[],
): FrozenContext => ({
  systemPrompt: renderSystemPrompt(sections),
  sections: sections.map(({ id, text }) => ({ id, text })),
  tools: tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: structuredClone(tool.parameters),
    parametersJson: schemaJson(tool.parameters),
  })),
  toolDriftSignature: null,
});

const deltaMessage = (kind: string, text: string): RuntimePromptMessage => ({
  text,
  uiVisibility: "hidden",
  messageType: "message",
  customType: `${CONTEXT_DELTA_CUSTOM_TYPE_PREFIX}${kind}`,
});

const sectionUpdate = (
  announced: readonly SystemPromptSection[],
  sections: readonly SystemPromptSection[],
): string | undefined => {
  const previous = new Map(announced.map((section) => [section.id, section.text]));
  const live = new Set(sections.map((section) => section.id));
  const changed = sections.filter(
    (section) => previous.get(section.id) !== section.text,
  );
  const removed = announced.filter((section) => !live.has(section.id));
  if (changed.length === 0 && removed.length === 0) return undefined;
  return wrapSystemReminder(
    [
      "Part of your system prompt changed. Each section below replaces the earlier version of the same section; the rest of your instructions still apply.",
      ...changed.map(
        (section) => `<section name="${section.id}">\n${section.text}\n</section>`,
      ),
      ...removed.map(
        (section) =>
          `<section name="${section.id}" removed="true">No longer applies: ${section.text.split("\n", 1)[0]}</section>`,
      ),
    ].join("\n"),
  );
};

export type ToolDrift = {
  added: string[];
  removed: string[];
  changed: string[];
};

/**
 * Carry a frozen context into a new turn: the same frozen bytes, plus the
 * hidden messages that tell the model what drifted since it last heard.
 */
export const advanceFrozenContext = (
  frozen: FrozenContext,
  sections: readonly SystemPromptSection[],
  tools: readonly ToolDescriptor[],
): { frozen: FrozenContext; deltas: RuntimePromptMessage[]; drift: ToolDrift } => {
  const deltas: RuntimePromptMessage[] = [];
  let next = frozen;
  const update = sectionUpdate(frozen.sections, sections);
  if (update) {
    deltas.push(deltaMessage("system", update));
    next = { ...next, sections: sections.map(({ id, text }) => ({ id, text })) };
  }

  const frozenByName = new Map(frozen.tools.map((tool) => [tool.name, tool]));
  const liveNames = new Set(tools.map((tool) => tool.name));
  const drift: ToolDrift = {
    added: tools.filter((tool) => !frozenByName.has(tool.name)).map((tool) => tool.name),
    removed: frozen.tools.filter((tool) => !liveNames.has(tool.name)).map((tool) => tool.name),
    changed: tools
      .filter((tool) => {
        const snapshot = frozenByName.get(tool.name);
        return (
          snapshot !== undefined &&
          (tool.description !== snapshot.description ||
            schemaJson(tool.parameters) !== snapshot.parametersJson)
        );
      })
      .map((tool) => tool.name),
  };
  const drifted =
    drift.added.length + drift.removed.length + drift.changed.length > 0;
  if (drifted) {
    const signature = schemaJson(
      tools.map((tool) => [tool.name, tool.description, schemaJson(tool.parameters)]),
    );
    if (frozen.toolDriftSignature !== signature) {
      next = { ...next, toolDriftSignature: signature };
      deltas.push(
        deltaMessage(
          "tools",
          wrapSystemReminder(
            `Available tools changed mid-conversation.${drift.added.length > 0 ? ` Added: ${drift.added.join(", ")}.` : ""}${drift.removed.length > 0 ? ` Removed (calls now fail): ${drift.removed.join(", ")}.` : ""}${drift.changed.length > 0 ? ` Changed: ${drift.changed.join(", ")}.` : ""} Your visible tool schemas are a thread-start snapshot and refresh at the next context compaction; current callable names and compact signatures are discoverable inside code via await tools.$search({ query: "<capability>" }), and one selected live schema is available via await tools.$describe(name).`,
          ),
        ),
      );
    }
  } else if (frozen.toolDriftSignature !== null) {
    next = { ...next, toolDriftSignature: null };
    deltas.push(
      deltaMessage(
        "tools",
        wrapSystemReminder(
          "The available tools now match the visible tool definitions again.",
        ),
      ),
    );
  }
  return { frozen: next, deltas, drift };
};

const UNAVAILABLE_TOOL_TEXT =
  "This tool is no longer available. Use another available tool.";

/**
 * The tools the provider sees: the frozen descriptors, each bound to this
 * turn's live implementation, or to a stub that fails when it went away.
 */
export const frozenProviderTools = <
  T extends ToolDescriptor & { label?: string; execute: unknown },
>(
  frozen: FrozenContext,
  liveTools: readonly T[],
  unavailable: (snapshot: FrozenTool, text: string) => T,
): T[] => {
  const live = new Map(liveTools.map((tool) => [tool.name, tool]));
  return frozen.tools.map((snapshot) => {
    const tool = live.get(snapshot.name);
    return tool
      ? { ...tool, description: snapshot.description, parameters: snapshot.parameters }
      : unavailable(snapshot, UNAVAILABLE_TOOL_TEXT);
  });
};
