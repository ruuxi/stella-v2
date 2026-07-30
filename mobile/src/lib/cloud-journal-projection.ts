import type { ChatArtifact, ChatMessage, MobileDisplayPayload } from "../types";
import type { ToolStep } from "./tool-activity";
import {
  cloudJournalMessageText,
  type CloudJournalMessageRecord,
  type CloudJournalRecord,
} from "./cloud-conversation-protocol";
import type {
  CloudConversationLiveState,
  CloudPendingPrompt,
} from "./cloud-conversation-store";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const timestampOf = (record: CloudJournalMessageRecord): number =>
  typeof record.payload.timestamp === "number" &&
  Number.isFinite(record.payload.timestamp)
    ? record.payload.timestamp
    : record.createdAtMs;

const toolCalls = (
  record: CloudJournalMessageRecord,
): { id: string; name: string; args?: Record<string, string> }[] => {
  if (!Array.isArray(record.payload.content)) return [];
  return record.payload.content.flatMap((value, index) => {
    const block = asRecord(value);
    if (!block || block.type !== "toolCall") return [];
    const name = typeof block.name === "string" ? block.name : "tool";
    const id =
      typeof block.id === "string" && block.id
        ? block.id
        : `cloud:${record.turnId}:tool:${record.seq}:${index}`;
    const rawArgs = asRecord(block.arguments);
    const args = rawArgs
      ? Object.fromEntries(
          Object.entries(rawArgs).flatMap(([key, raw]) =>
            typeof raw === "string" ? [[key, raw]] : [],
          ),
        )
      : undefined;
    return [{ id, name, ...(args && Object.keys(args).length ? { args } : {}) }];
  });
};

const completeWindow = (
  records: readonly CloudJournalRecord[],
  hasOlder: boolean,
): CloudJournalRecord[] => {
  if (!hasOlder || records.length === 0) return [...records];
  const firstTurn = records[0]!.turnId;
  const leading = records.filter((record) => record.turnId === firstTurn);
  const hasPrompt = leading.some(
    (record) => record.kind === "message" && record.role === "user",
  );
  return hasPrompt
    ? [...records]
    : records.filter((record) => record.turnId !== firstTurn);
};

/**
 * Projects the DO journal into the existing native timeline shape.
 * Canonical sequence order is retained; no local transcript is consulted.
 */
export const projectCloudConversationMessages = (args: {
  conversationId?: string;
  records: readonly CloudJournalRecord[];
  pending: readonly CloudPendingPrompt[];
  live: CloudConversationLiveState | null;
  hasOlder?: boolean;
}): ChatMessage[] => {
  const records = completeWindow(args.records, args.hasOlder === true);
  const byTurn = new Map<string, CloudJournalRecord[]>();
  for (const record of records) {
    const turn = byTurn.get(record.turnId);
    if (turn) turn.push(record);
    else byTurn.set(record.turnId, [record]);
  }

  const messages: ChatMessage[] = [];
  const canonicalClientIds = new Set<string>();
  for (const [turnId, turn] of byTurn) {
    let userMessageId = `cloud:${turnId}:user`;
    let terminal:
      | Extract<CloudJournalRecord, { kind: "turn" }>
      | undefined;
    const toolResults = new Map<string, { error: boolean }>();
    for (const record of turn) {
      if (record.kind === "turn" && record.phase !== "started") {
        terminal = record;
      }
      if (record.kind === "message" && record.role === "toolResult") {
        const id =
          typeof record.payload.toolCallId === "string"
            ? record.payload.toolCallId
            : "";
        if (id) toolResults.set(id, { error: record.payload.isError === true });
      }
    }

    for (const record of turn) {
      if (record.kind !== "message") continue;
      const createdAt = timestampOf(record);
      if (record.role === "user") {
        userMessageId =
          record.clientMsgId ?? `cloud:${turnId}:message:${record.seq}`;
        if (record.clientMsgId) canonicalClientIds.add(record.clientMsgId);
        if (record.hidden) continue;
        messages.push({
          id: userMessageId,
          canonicalId: `cloud:${turnId}:message:${record.seq}`,
          role: "user",
          text: cloudJournalMessageText(record.payload),
          createdAt,
          canonicalCreatedAt: record.createdAtMs,
        });
        continue;
      }
      if (record.role !== "assistant" || record.hidden) continue;
      const tools: ToolStep[] = toolCalls(record).flatMap((call) => {
        const result = toolResults.get(call.id);
        if (!result) return [];
        return [
          {
            id: call.id,
            toolName: call.name,
            status: result.error ? "error" : "completed",
            ...(call.args ? { args: call.args } : {}),
          },
        ];
      });
      const value = cloudJournalMessageText(record.payload);
      if (!value && !tools.length) continue;
      messages.push({
        id: `cloud:${turnId}:message:${record.seq}`,
        requestId: userMessageId,
        role: "assistant",
        text: value,
        createdAt,
        canonicalCreatedAt: record.createdAtMs,
        ...(tools.length ? { toolSteps: tools } : {}),
      });
    }

    const files = turn.flatMap((record) =>
      record.kind === "card" && record.card.type === "files"
        ? record.card.files
        : [],
    );
    if (files.length) {
      const artifacts: ChatArtifact[] = files.map((file, index) => {
        const path = file.path;
        const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
        let payload: MobileDisplayPayload;
        if (extension === "pdf") {
          payload = { kind: "pdf", filePath: path, title: file.name };
        } else if (extension === "md" || extension === "markdown") {
          payload = {
            kind: "markdown",
            filePath: path,
            title: file.name,
            createdAt: turn.at(-1)?.createdAtMs,
          };
        } else if (
          ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "tsv"].includes(
            extension,
          )
        ) {
          const artifactKind =
            extension === "csv" || extension === "tsv"
              ? "delimited-table"
              : extension.startsWith("xls")
                ? "office-spreadsheet"
                : extension.startsWith("ppt")
                  ? "office-slides"
                  : "office-document";
          payload = {
            kind: "file-artifact",
            filePath: path,
            artifactKind,
            title: file.name,
            createdAt: turn.at(-1)?.createdAtMs,
          };
        } else {
          payload = {
            kind: "media",
            asset: { kind: "download", filePath: path, label: file.name },
            createdAt: turn.at(-1)?.createdAtMs ?? 0,
          };
        }
        return {
          id: `cloud:${turnId}:file:${index}:${path}`,
          conversationId: args.conversationId ?? "",
          payload,
        };
      });
      const lastAssistantIndex = messages.findLastIndex(
        (message) =>
          message.role === "assistant" && message.requestId === userMessageId,
      );
      if (lastAssistantIndex >= 0) {
        const assistant = messages[lastAssistantIndex]!;
        messages[lastAssistantIndex] = {
          ...assistant,
          artifacts: [...(assistant.artifacts ?? []), ...artifacts],
        };
      } else {
        messages.push({
          id: `cloud:${turnId}:files`,
          requestId: userMessageId,
          role: "assistant",
          text: "",
          artifacts,
          createdAt: turn.at(-1)?.createdAtMs,
        });
      }
    }

    if (
      terminal &&
      terminal.phase !== "completed" &&
      terminal.notice &&
      !turn.some(
        (record) =>
          record.kind === "message" &&
          record.role === "assistant" &&
          cloudJournalMessageText(record.payload) === terminal!.notice,
      )
    ) {
      messages.push({
        id: `cloud:${turnId}:notice:${terminal.seq}`,
        requestId: userMessageId,
        role: "assistant",
        text: terminal.notice,
        createdAt: terminal.createdAtMs,
        canonicalCreatedAt: terminal.createdAtMs,
        ...(terminal.phase === "canceled" ? { stopped: true } : {}),
      });
    }
  }

  for (const entry of args.pending) {
    if (canonicalClientIds.has(entry.clientMsgId)) continue;
    messages.push({
      id: entry.clientMsgId,
      role: "user",
      text: entry.text,
      createdAt: entry.createdAtMs,
    });
    if (entry.error) {
      messages.push({
        id: `${entry.clientMsgId}:error`,
        requestId: entry.clientMsgId,
        clientMsgId: entry.clientMsgId,
        role: "assistant",
        text: entry.error,
        createdAt: entry.createdAtMs + 1,
        sendError: true,
      });
    }
  }

  if (args.live?.text) {
    const hasCommittedLive = messages.some(
      (message) =>
        message.role === "assistant" &&
        message.id.startsWith(`cloud:${args.live!.turnId}:message:`),
    );
    if (!hasCommittedLive) {
      const owner =
        [...messages]
          .reverse()
          .find(
            (message) =>
              message.role === "user" &&
              (message.id.startsWith(`cloud:${args.live!.turnId}:`) ||
                args.pending.some(
                  (pending) =>
                    pending.turnId === args.live!.turnId &&
                    pending.clientMsgId === message.id,
                )),
          )?.id ?? `cloud:${args.live.turnId}:user`;
      messages.push({
        id: `cloud:${args.live.turnId}:live:${args.live.streamId}`,
        requestId: owner,
        role: "assistant",
        text: args.live.text,
        createdAt: Date.now(),
      });
    }
  }
  return messages;
};

export const activeCloudTurnId = (
  records: readonly CloudJournalRecord[],
  live: CloudConversationLiveState | null,
): string | null => {
  if (live) return live.turnId;
  const phases = new Map<string, string>();
  for (const record of records) {
    if (record.kind === "turn") phases.set(record.turnId, record.phase);
  }
  for (const [turnId, phase] of [...phases].reverse()) {
    if (phase === "started") return turnId;
  }
  return null;
};
