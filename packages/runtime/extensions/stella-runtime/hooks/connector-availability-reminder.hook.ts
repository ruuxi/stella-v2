import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import { getConnectorDecline } from "../../../kernel/connectors/connect-preferences.js";
import { getNativeConnectorConnectionState } from "../../../kernel/connectors/connection-status.js";
import {
  getConnectorKeywordIndex,
  matchConnectorsInMessage,
} from "../../../kernel/connectors/keyword-index.js";
import type { NativeConnectorCatalogEntry } from "../../../kernel/connectors/native-integrations.js";
import type { HookDefinition } from "../../../kernel/extensions/types.js";
import { wrapSystemReminder } from "@stella/contracts/message-timestamp";
import {
  isReminderShownInActiveWindow,
  recordReminderShown,
  type ReminderWindowStore,
} from "../../../kernel/runner/reminder-window-gate.js";

/**
 * Connector-availability reminder (stella-runtime).
 *
 * Deterministic, LLM-free: every visible orchestrator user message is
 * keyword-matched against the connector catalog index (catalog-derived
 * names + a loose synonym layer — "mail" → gmail/outlook, "calendar" →
 * google calendar, …). On a hit, a hidden `<system-reminder>` is
 * attached to that user message. Matches are capability hints, not
 * confirmed intent or instructions to use a connector:
 *
 *  - connected  → notes it's connected (agents use the code
 *    `connect` client); nothing else
 *    to do, the orchestrator proceeds/delegates with that knowledge.
 *  - not connected → tells the orchestrator it can call the
 *    `connector_status` tool for this connector if relevant (directly, or
 *    as `tools.connector_status({...})` inside code when the tool is
 *    demoted out of the direct list) — that call shows the inline connect
 *    card.
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
export const MCP_HINT_REMINDER_KEY = "connector-mcp-hint";

/**
 * "mcp" / "mcp server(s)" in the user message: not a catalog entry, but the
 * connect client can register one — surface that in one sentence.
 */
const MCP_KEYWORD_RE = /\bmcp\b/iu;

export const MCP_HINT_REMINDER_TEXT =
  'Keyword hint: MCP was mentioned, possibly incidentally. If the user wants to manage an MCP connection, agents can use connect.addMcp(…) or connect.remove(id) through the code connect client; connect.documentation() has details.';

export const buildConnectedReminderText = (
  entry: NativeConnectorCatalogEntry,
): string =>
  `Keyword hint: ${entry.name} may be relevant. It is connected (integration id \`${entry.id}\`). If it fits the user's intent, agents can use it via the code connect client (await connect.call("${entry.id}", …)). The keyword match alone does not imply it should be used.`;

export const buildOfferReminderText = (
  entry: NativeConnectorCatalogEntry,
): string =>
  [
    `Keyword hint: ${entry.name} may be relevant. Its connector is not connected.`,
    `If it fits the user's intent and would help, \`connector_status\` can show an inline connect card (connector: "${entry.id}"; also available inside code as tools.connector_status({ connector: "${entry.id}" })).`,
    `The keyword match alone does not imply a connection is needed.`,
  ].join(" ");

export const createConnectorAvailabilityReminderHook = (options: {
  /** `~/.stella` — where connector state and the catalog cache live. */
  stellaDataDir: string;
  store: ReminderWindowStore;
}): HookDefinition<"before_user_message"> => ({
  event: "before_user_message",
  async handler(payload) {
    if (payload.agentType !== AGENT_IDS.ORCHESTRATOR) return;
    if (payload.isUserTurn === false) return;
    const prompt = payload.userPrompt?.trim();
    if (!prompt) return;
    const threadKey = payload.threadKey ?? payload.conversationId;
    if (!threadKey) return;

    let matches: NativeConnectorCatalogEntry[];
    try {
      const index = await getConnectorKeywordIndex(options.stellaDataDir);
      matches = matchConnectorsInMessage(index, prompt);
    } catch {
      matches = [];
    }

    const reminders: Array<{ key: string; text: string }> = [];
    if (MCP_KEYWORD_RE.test(prompt)) {
      const shown = await isReminderShownInActiveWindow({
        stellaDataDir: options.stellaDataDir,
        store: options.store,
        threadKey,
        key: MCP_HINT_REMINDER_KEY,
      }).catch(() => true);
      if (!shown) {
        reminders.push({
          key: MCP_HINT_REMINDER_KEY,
          text: MCP_HINT_REMINDER_TEXT,
        });
      }
    }
    if (matches.length === 0 && reminders.length === 0) return;

    for (const entry of matches) {
      if (reminders.length >= MAX_REMINDERS_PER_TURN) break;
      try {
        const state = await getNativeConnectorConnectionState(
          options.stellaDataDir,
          entry,
        );
        if (state.connected) {
          const key = connectedReminderKey(entry.id);
          if (
            await isReminderShownInActiveWindow({
              stellaDataDir: options.stellaDataDir,
              store: options.store,
              threadKey,
              key,
            })
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
        const declined = await getConnectorDecline(
          options.stellaDataDir,
          entry.id,
        );
        if (declined) continue;
        const key = offerReminderKey(entry.id);
        if (
          await isReminderShownInActiveWindow({
            stellaDataDir: options.stellaDataDir,
            store: options.store,
            threadKey,
            key,
          })
        ) {
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
      await recordReminderShown({
        stellaDataDir: options.stellaDataDir,
        threadKey,
        key: reminder.key,
      }).catch(() => undefined);
    }

    return {
      prependMessages: reminders.map(({ text }) => ({
        text: wrapSystemReminder(text),
        uiVisibility: "hidden" as const,
        messageType: "message" as const,
        customType: CONNECTOR_AVAILABILITY_REMINDER_CUSTOM_TYPE,
      })),
    };
  },
});
