/**
 * Stella's resident context: the prompt sections that describe the user and
 * where this conversation runs (personality, memory, skills, devices,
 * destination, media access, language) as the conversation's first message
 * after the system prompt, never inside it.
 *
 * pi-durable already keeps these sections the cache-friendly way in the
 * transcript: a complete baseline at the head of each context window, and a
 * positional `pi.system` patch where one changed. But pi-ai sends a system
 * message in the middle of a conversation only to models flagged for it, and
 * merges every other one into the leading system prompt, so any change (a
 * device going offline, a memory write) would rewrite the top of the request
 * and miss the provider prompt cache for the whole conversation.
 *
 * `residentContextHook` reshapes each request instead: the resident sections
 * of every system message go out as a hidden user message at that same
 * position. The baseline lands right after the system prompt; a later change
 * lands where it happened (before the user message that started that turn)
 * and carries only what changed; compaction writes a
 * fresh baseline, which folds the changes in. The system prompt itself keeps
 * only Stella's static prompt, so it reads the same for every conversation.
 * The transcript is unchanged; this is a pure function of it, so every request
 * of a conversation renders the same bytes for the same history.
 */
import { GenerationTask, hook } from "@earendil-works/pi-durable";
import type { Message, SystemMessage, UserMessage } from "@earendil-works/pi-ai";
import { wrapSystemReminder } from "@stella/contracts/system-reminders";

/** The sections of `stellaPromptExtension` that are user and environment state, in prompt order. */
export const RESIDENT_SECTION_KEYS: ReadonlySet<string> = new Set([
  "personality",
  "core-memory",
  "memory-profile",
  "memory-index",
  "skills",
  "execution-devices",
  "execution-destination",
  "working-directory",
  "media-access",
  "response-language",
]);

const residentText = (sections: [string, string | null][], baseline: boolean): string => {
  const shown = sections.filter((entry): entry is [string, string] => entry[1] !== null).map(([, text]) => text);
  const removed = sections.filter(([, text]) => text === null).map(([key]) => key);
  const lines = [
    baseline
      ? "Context about the user and where this conversation runs. A later update replaces a part of it by name."
      : "This context changed. Each part below replaces the earlier part of the same name; the rest still holds.",
    ...shown,
    ...(removed.length > 0 ? [`No longer applies: ${removed.join(", ")}.`] : []),
  ];
  return wrapSystemReminder(lines.join("\n\n"));
};

/**
 * Move the resident sections of each system message into a user message at its
 * place: the baseline right after the system prompt, a change in front of the
 * user message that started its turn, so the user's own words stay last. A
 * system message left with nothing (no static section, text or tool change)
 * is dropped.
 */
export const withResidentContext = (messages: readonly Message[]): readonly Message[] => {
  let changed = false;
  let baselineSeen = false;
  const out: Message[] = [];
  const residentMessages = new Set<Message>();
  for (const message of messages) {
    if (message.role !== "system" || message.sections === undefined) {
      out.push(message);
      continue;
    }
    const entries = Object.entries(message.sections);
    const resident = entries.filter(([key]) => RESIDENT_SECTION_KEYS.has(key));
    if (resident.length === 0) {
      out.push(message);
      continue;
    }
    changed = true;
    const staticSections = entries.filter(([key]) => !RESIDENT_SECTION_KEYS.has(key));
    const { sections: _sections, ...rest } = message;
    const system: SystemMessage =
      staticSections.length > 0 ? { ...rest, sections: Object.fromEntries(staticSections) } : rest;
    if (
      system.sections !== undefined ||
      system.content.length > 0 ||
      (system.toolsAdded?.length ?? 0) > 0 ||
      (system.toolsRemoved?.length ?? 0) > 0
    ) {
      out.push(system);
    }
    // The first system message of a context is its complete baseline; later ones are patches.
    const user: UserMessage = {
      role: "user",
      content: residentText(resident, !baselineSeen),
      timestamp: message.timestamp,
    };
    let at = out.length;
    if (!baselineSeen) {
      // After a compaction the baseline is written behind the kept messages; it belongs at the head.
      at = 0;
      while (at < out.length && out[at]!.role === "system") at += 1;
    } else {
      while (at > 0 && out[at - 1]!.role === "user" && !residentMessages.has(out[at - 1]!)) at -= 1;
    }
    out.splice(at, 0, user);
    residentMessages.add(user);
    baselineSeen = true;
  }
  return changed ? out : messages;
};

export const residentContextHook = hook(GenerationTask, {
  beforeRequest: (request) => {
    const messages = withResidentContext(request.messages);
    return messages === request.messages ? undefined : { messages };
  },
});
