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

export const CONNECTOR_AVAILABILITY_REMINDER_CUSTOM_TYPE =
  "runtime.connector_availability_reminder";

const MAX_REMINDERS_PER_TURN = 2;

export const connectedReminderKey = (id: string) => `connector-connected:${id}`;
export const offerReminderKey = (id: string) => `connector-offer:${id}`;
export const MCP_HINT_REMINDER_KEY = "connector-mcp-hint";

const MCP_KEYWORD_RE = /\bmcp\b/iu;

export const MCP_HINT_REMINDER_TEXT =
  'The user mentioned MCP. Agents can register an MCP server through the node_repl connect client — await connect.addMcp({ id, transport: { url: "…" } }) for hosted servers or transport: { command, args } for stdio — and connect.remove(id) uninstalls one (connect.documentation() has details).';

export const buildConnectedReminderText = (
  entry: NativeConnectorCatalogEntry,
): string =>
  `${entry.name} is connected (integration id \`${entry.id}\`). Agents can use it directly for this request via the node_repl connect client (await connect.call("${entry.id}", …)) — no setup needed.`;

export const buildOfferReminderText = (
  entry: NativeConnectorCatalogEntry,
): string =>
  [
    `This request may involve ${entry.name}. Stella has a ${entry.name} connector, but it is not connected yet.`,
    `If using ${entry.name} would genuinely help, call the \`connector_status\` tool with connector "${entry.id}" (if it is not in your direct tool list, call it inside node_repl as tools.connector_status({ connector: "${entry.id}" })). That shows the user an inline connect card (the card is the consent — don't ask first) and returns the outcome: connected → delegate the task using it; declined → tell the user once they can connect it from Connections later, then proceed by other means (agents fall back to the browser).`,
    `If ${entry.name} isn't actually relevant, ignore this note.`,
  ].join(" ");

export const createConnectorAvailabilityReminderHook = (options: {

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

        if (!entry.connectable) continue;

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

      }
    }
    if (reminders.length === 0) return;

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
