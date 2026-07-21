import type {
  ExtensionRuntime,
  HookDefinition,
  NativeConnectorCatalogEntry,
} from "../types.js";

/**
 * Connector-availability reminder (stella-runtime).
 *
 * Deterministic, LLM-free: every visible orchestrator user message is
 * keyword-matched against the connector catalog index (catalog-derived
 * names + a loose synonym layer — "mail" → gmail/outlook, "calendar" →
 * google calendar, …). On a hit, a hidden `<system-reminder>` is
 * attached to that user message:
 *
 *  - connected  → notes it's connected via stella-connect; nothing else
 *    to do, the orchestrator proceeds/delegates with that knowledge.
 *  - not connected → tells the orchestrator it can expose the deferred
 *    `connector_status` tool (via `tool_search`) and call it for this
 *    connector if relevant — that call shows the inline connect card.
 *
 * Each variant is deduped through the generic once-per-active-context-
 * window gate: while a copy of the same reminder sits in the current
 * model-facing window, it is not injected again; a compaction
 * checkpoint resets eligibility. A persisted user decline suppresses
 * the not-connected variant entirely, regardless of window resets (the
 * connected variant may still show — that's just useful info).
 */

export const CONNECTOR_AVAILABILITY_REMINDER_CUSTOM_TYPE =
  "runtime.connector_availability_reminder";

const MAX_REMINDERS_PER_TURN = 2;

export const connectedReminderKey = (id: string) => `connector-connected:${id}`;
export const offerReminderKey = (id: string) => `connector-offer:${id}`;

export const buildConnectedReminderText = (
  entry: NativeConnectorCatalogEntry,
): string =>
  `${entry.name} is connected via stella-connect (integration id \`${entry.id}\`). Agents can use it directly for this request — no setup needed.`;

export const buildOfferReminderText = (
  entry: NativeConnectorCatalogEntry,
): string =>
  [
    `This request may involve ${entry.name}. Stella has a ${entry.name} connector, but it is not connected yet.`,
    `If using ${entry.name} would genuinely help, run tool_search with query "connector status" to expose the \`connector_status\` tool, then call it with connector "${entry.id}". That shows the user an inline connect card (the card is the consent — don't ask first) and returns the outcome: connected → delegate the task using it; declined → tell the user once they can connect it from the Store later, then proceed by other means (agents fall back to the browser).`,
    `If ${entry.name} isn't actually relevant, ignore this note.`,
  ].join(" ");

export const createConnectorAvailabilityReminderHook = (options: {
  runtime: ExtensionRuntime;
}): HookDefinition => ({
  event: "before_user_message",
  async handler(payload) {
    if (payload.agentType !== "orchestrator") return;
    if (payload.isUserTurn === false) return;
    const prompt = payload.userPrompt?.trim();
    if (!prompt) return;
    const threadKey = payload.threadKey ?? payload.conversationId;
    if (!threadKey) return;

    let matches: NativeConnectorCatalogEntry[];
    try {
      matches = await options.runtime.connectors.match(prompt);
    } catch {
      return;
    }
    if (matches.length === 0) return;

    const reminders: Array<{ key: string; text: string }> = [];
    for (const entry of matches) {
      if (reminders.length >= MAX_REMINDERS_PER_TURN) break;
      try {
        const state =
          await options.runtime.connectors.getConnectionState(entry);
        if (state.connected) {
          const key = connectedReminderKey(entry.id);
          if (
            await options.runtime.connectors.isReminderShown(threadKey, key)
          ) {
            continue;
          }
          reminders.push({ key, text: buildConnectedReminderText(entry) });
          continue;
        }
        // Only connectable entries can be offered through the card.
        if (!entry.connectable) continue;
        // Decline persistence wins over window resets: once the user
        // declined the connect card, the offer reminder stays suppressed.
        const declined = await options.runtime.connectors.getDecline(entry.id);
        if (declined) continue;
        const key = offerReminderKey(entry.id);
        if (await options.runtime.connectors.isReminderShown(threadKey, key)) {
          continue;
        }
        reminders.push({ key, text: buildOfferReminderText(entry) });
      } catch {
        // Per-entry state lookups are best-effort; skip on failure.
      }
    }
    if (reminders.length === 0) return;

    // Record before returning: the prepends are handed to the prompt
    // build unconditionally from here on.
    for (const reminder of reminders) {
      await options.runtime.connectors
        .recordReminderShown(threadKey, reminder.key)
        .catch(() => undefined);
    }

    return {
      prependMessages: reminders.map(({ text }) => ({
        text: options.runtime.wrapSystemReminder(text),
        uiVisibility: "hidden" as const,
        messageType: "message" as const,
        customType: CONNECTOR_AVAILABILITY_REMINDER_CUSTOM_TYPE,
      })),
    };
  },
});
