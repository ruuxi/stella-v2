/**
 * Model usage of the conversations that run on pi-durable, as the usage
 * dashboard lists it: one record per model call. Each conversation's SQLite
 * file keeps every call's usage on its assistant entry, so this reads the
 * files directly (read-only, beside the open harnesses) instead of opening
 * every conversation.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { PiChatUsageRequest } from "@stella/contracts/pi-chat";
import type { LocalModelUsagePage, LocalModelUsageRecord } from "@stella/contracts/local-chat";
import { openSqliteConnection } from "../../kernel/storage/database.js";

const DEFAULT_LIMIT = 10_000;
const MAX_LIMIT = 50_000;
const LABEL_CHARS = 80;

type Usage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
};

/** An assistant entry's call, in the order `CALL_FIELDS` reads it. */
type CallFields = [
  kind: unknown,
  timestamp: unknown,
  provider: unknown,
  api: unknown,
  model: unknown,
  responseModel: unknown,
  usage: Usage | null,
  stopReason: unknown,
  errorMessage: unknown,
];
const CALL_FIELDS = [
  "$.kind",
  "$.model[0].timestamp",
  "$.model[0].provider",
  "$.model[0].api",
  "$.model[0].model",
  "$.model[0].responseModel",
  "$.model[0].usage",
  "$.model[0].stopReason",
  "$.model[0].errorMessage",
]
  .map((field) => `'${field}'`)
  .join(", ");

const str = (value: unknown): string => (typeof value === "string" ? value : "");

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** A message's first text, as a label. */
const labelOf = (content: string | null): string => {
  if (!content) return "";
  let text = "";
  try {
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed === "string") text = parsed;
    else if (Array.isArray(parsed)) {
      const part = parsed.find((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "text");
      text = typeof part?.text === "string" ? part.text : "";
    }
  } catch {
    text = content;
  }
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > LABEL_CHARS ? `${line.slice(0, LABEL_CHARS - 1)}…` : line;
};

const readConversation = (
  file: string,
  conversationId: string,
  args: PiChatUsageRequest,
): LocalModelUsageRecord[] => {
  const db = openSqliteConnection(file);
  try {
    db.exec("PRAGMA query_only = 1; PRAGMA busy_timeout = 2000;");
    // Conversations by their owner: the root is the orchestrator, the rest its agents.
    const owners = new Map<number, number | null>();
    for (const row of db.prepare("SELECT id, owner_conversation_id AS owner FROM conversations").all() as Array<{
      id: number;
      owner: number | null;
    }>) {
      owners.set(row.id, row.owner);
    }
    const depthOf = (id: number): number => {
      let depth = 0;
      for (let owner = owners.get(id); owner != null && depth < 16; owner = owners.get(owner)) depth += 1;
      return depth;
    };
    // Each conversation's first prompt names it: the root's first message, an agent's brief.
    const labels = new Map<number, string>();
    for (const row of db
      .prepare(
        `SELECT conversation_id AS conversation, json_extract(record, '$.model[0].content') AS content
         FROM entries WHERE id IN (
           SELECT MIN(id) FROM entries WHERE json_extract(record, '$.kind') = 'pi.user' GROUP BY conversation_id
         )`,
      )
      .all() as Array<{ conversation: number; content: string | null }>) {
      labels.set(row.conversation, labelOf(row.content));
    }
    const root = [...owners].find(([, owner]) => owner == null)?.[0];
    const title = (root !== undefined ? labels.get(root) : undefined) || conversationId;
    // One parse per entry: the string match skips everything but assistant entries.
    const rows = db
      .prepare(
        `SELECT id, conversation_id AS conversation, json_extract(record, ${CALL_FIELDS}) AS fields
         FROM entries WHERE instr(record, '"pi.assistant"') > 0`,
      )
      .all() as Array<{ id: number; conversation: number; fields: string }>;
    const fromMs = args.fromMs ?? 0;
    const toMs = args.toMs ?? Number.MAX_SAFE_INTEGER;
    const records: LocalModelUsageRecord[] = [];
    for (const row of rows) {
      let fields: CallFields;
      try {
        fields = JSON.parse(row.fields) as CallFields;
      } catch {
        continue;
      }
      const [kind, at, provider, api, model, responseModel, usage, stopReason, errorMessage] = fields;
      const timestamp = num(at);
      if (kind !== "pi.assistant" || !usage || timestamp < fromMs || timestamp > toMs) continue;
      const call = { id: row.id, conversation: row.conversation };
      const threadId = `pi:${conversationId}:${call.conversation}`;
      if (args.threadId && args.threadId !== threadId) continue;
      const depth = depthOf(call.conversation);
      const owner = owners.get(call.conversation);
      const isRoot = depth === 0;
      const agentLabel = labels.get(call.conversation) ?? "";
      records.push({
        id: `pi:${conversationId}:${call.id}`,
        timestamp,
        conversationId,
        conversationTitle: title,
        threadId,
        threadName: isRoot ? "Stella" : agentLabel,
        agentType: isRoot ? "orchestrator" : "general",
        ...(isRoot ? {} : { agentDescription: agentLabel }),
        agentDepth: depth,
        ...(owner != null ? { parentAgentId: `pi:${conversationId}:${owner}` } : {}),
        provider: str(provider),
        api: str(api),
        model: str(model),
        ...(str(responseModel) ? { responseModel: str(responseModel) } : {}),
        inputTokens: num(usage.input),
        cacheReadTokens: num(usage.cacheRead),
        cacheWriteTokens: num(usage.cacheWrite),
        outputTokens: num(usage.output),
        reasoningTokens: num(usage.reasoning),
        totalTokens: num(usage.totalTokens),
        inputCostUsd: num(usage.cost?.input),
        cacheReadCostUsd: num(usage.cost?.cacheRead),
        cacheWriteCostUsd: num(usage.cost?.cacheWrite),
        outputCostUsd: num(usage.cost?.output),
        totalCostUsd: num(usage.cost?.total),
        stopReason: str(stopReason),
        ...(str(errorMessage) ? { errorMessage: str(errorMessage) } : {}),
      });
    }
    return records;
  } finally {
    db.close();
  }
};

export const piModelUsage = async (dataDir: string, args: PiChatUsageRequest): Promise<LocalModelUsagePage> => {
  const directory = path.join(dataDir, "agent");
  const files = (await readdir(directory).catch(() => [] as string[])).filter((name) => name.endsWith(".sqlite"));
  const limit = Math.max(1, Math.min(Math.floor(args.limit ?? DEFAULT_LIMIT), MAX_LIMIT));
  const records: LocalModelUsageRecord[] = [];
  for (const name of files) {
    const conversationId = name.slice(0, -".sqlite".length);
    if (args.conversationId && args.conversationId !== conversationId) continue;
    try {
      records.push(...readConversation(path.join(directory, name), conversationId, args));
    } catch (error) {
      console.warn(`[pi-usage] ${name} could not be read.`, error);
    }
  }
  records.sort((a, b) => b.timestamp - a.timestamp);
  return { records: records.slice(0, limit), truncated: records.length > limit };
};
