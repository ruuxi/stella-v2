import type { ChatArtifact, ChatMessage, MobileDisplayPayload } from "../types";
import type { ToolStep } from "./tool-activity";
import {
  messageText,
  type JournalMessageRecord,
  type JournalRecord,
} from "./cloud-conversation-protocol";
import type { LiveStream } from "./cloud-conversation-store";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const timestampOf = (record: JournalMessageRecord): number =>
  typeof record.payload.timestamp === "number" &&
  Number.isFinite(record.payload.timestamp)
    ? record.payload.timestamp
    : record.createdAtMs;

const toolCalls = (
  record: JournalMessageRecord,
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
    return [
      { id, name, ...(args && Object.keys(args).length ? { args } : {}) },
    ];
  });
};

const completeWindow = (
  records: readonly JournalRecord[],
  hasOlder: boolean,
): JournalRecord[] => {
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
  records: readonly JournalRecord[];
  live: LiveStream | null;
  hasOlder?: boolean;
}): ChatMessage[] => {
  const records = completeWindow(args.records, args.hasOlder === true);
  const byTurn = new Map<string, JournalRecord[]>();
  for (const record of records) {
    const turn = byTurn.get(record.turnId);
    if (turn) turn.push(record);
    else byTurn.set(record.turnId, [record]);
  }

  const messages: ChatMessage[] = [];
  const userIdsByTurn = new Map<string, string>();
  for (const [turnId, turn] of byTurn) {
    let userMessageId = `cloud:${turnId}:user`;
    let terminal: Extract<JournalRecord, { kind: "turn" }> | undefined;
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
        userIdsByTurn.set(turnId, userMessageId);
        if (record.hidden) continue;
        messages.push({
          id: userMessageId,
          canonicalId: `cloud:${turnId}:message:${record.seq}`,
          role: "user",
          text: messageText(record.payload),
          createdAt,
          canonicalCreatedAt: record.createdAtMs,
          sequence: record.seq,
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
      const value = messageText(record.payload);
      if (!value && !tools.length) continue;
      messages.push({
        id: `cloud:${turnId}:message:${record.seq}`,
        requestId: userMessageId,
        role: "assistant",
        text: value,
        createdAt,
        canonicalCreatedAt: record.createdAtMs,
        sequence: record.seq,
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
          sequence: turn.at(-1)?.seq,
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
          messageText(record.payload) === terminal!.notice,
      )
    ) {
      messages.push({
        id: `cloud:${turnId}:notice:${terminal.seq}`,
        requestId: userMessageId,
        role: "assistant",
        text: terminal.notice,
        createdAt: terminal.createdAtMs,
        canonicalCreatedAt: terminal.createdAtMs,
        sequence: terminal.seq,
        ...(terminal.phase === "canceled" ? { stopped: true } : {}),
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
        userIdsByTurn.get(args.live.turnId) ?? `cloud:${args.live.turnId}:user`;
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
  records: readonly JournalRecord[],
  live: LiveStream | null,
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

/** Server placement dispatch echoed by the canonical prompt for one turn. */
export const canonicalCloudDispatchIdForTurn = (
  records: readonly JournalRecord[],
  turnId: string | null,
): string | null => {
  if (!turnId) return null;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    if (
      record.turnId === turnId &&
      record.kind === "message" &&
      record.role === "user" &&
      record.clientMsgId
    ) {
      return record.clientMsgId;
    }
  }
  return null;
};

/** Canonical dispatch ids echoed by journal user rows. */
export const canonicalCloudDispatchIds = (
  records: readonly JournalRecord[],
): ReadonlySet<string> =>
  new Set(
    records.flatMap((record) =>
      record.kind === "message" && record.role === "user" && record.clientMsgId
        ? [record.clientMsgId]
        : [],
    ),
  );

/**
 * Adds only the current device's unresolved optimistic rows to the canonical
 * projection. Historical SQLite rows are never consulted as transcript
 * authority. A binding maps the local bubble id to the server dispatch id,
 * because the DO echoes the latter as clientMsgId.
 */
export const mergeCanonicalCloudMessages = (args: {
  canonical: readonly ChatMessage[];
  local: readonly ChatMessage[];
  dispatchBindings: ReadonlyMap<string, string | null>;
  acknowledgedDispatchIds: ReadonlySet<string>;
}): ChatMessage[] => {
  const canonicalIds = new Set(args.canonical.map((message) => message.id));
  const canonicalAssistantOwners = new Set(
    args.canonical.flatMap((message) =>
      message.role === "assistant" && message.requestId
        ? [message.requestId]
        : [],
    ),
  );
  const pendingLocalIds = new Set(
    [...args.dispatchBindings].flatMap(([localId, dispatchId]) =>
      dispatchId && args.acknowledgedDispatchIds.has(dispatchId)
        ? []
        : [localId],
    ),
  );
  const trackedLocalIds = new Set(args.dispatchBindings.keys());
  const optimistic = args.local.filter((message) => {
    if (canonicalIds.has(message.id)) return false;
    if (message.role === "user") return pendingLocalIds.has(message.id);
    const owner = message.requestId;
    return Boolean(
      owner &&
        trackedLocalIds.has(owner) &&
        !canonicalAssistantOwners.has(owner),
    );
  });
  return [...args.canonical, ...optimistic];
};

/**
 * Rebinds the server's placement dispatch id to the mobile optimistic bubble
 * id once admission is known. Canonical identity remains available in
 * canonicalId, while React/UI identity stays stable across the handoff.
 */
export const rebindCanonicalCloudMessages = (
  canonical: readonly ChatMessage[],
  dispatchBindings: ReadonlyMap<string, string | null>,
): ChatMessage[] => {
  const localByDispatch = new Map<string, string>();
  for (const [localId, dispatchId] of dispatchBindings) {
    if (dispatchId) localByDispatch.set(dispatchId, localId);
  }
  return canonical.map((message) => {
    const localId = localByDispatch.get(message.id);
    const localRequestId = message.requestId
      ? localByDispatch.get(message.requestId)
      : undefined;
    if (!localId && !localRequestId) return message;
    return {
      ...message,
      ...(localId
        ? {
            id: localId,
            canonicalId: message.canonicalId ?? message.id,
          }
        : {}),
      ...(localRequestId ? { requestId: localRequestId } : {}),
    };
  });
};
