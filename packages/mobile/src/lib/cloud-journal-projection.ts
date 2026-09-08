import { lifecycleWakeTask, projectMobileLifecycle, resolvedMobileReplyRefs } from "./mobile-reply-context";
import { cloudFileArtifact } from "./cloud-file-payload";
import type { ChatArtifact, ChatMessage, MobileDisplayPayload } from "../types";
import { splitReplyRefs, toReplyPreview, type ReplyRef } from "@stella/contracts/reply-refs";
import { isMapRouteArtifact } from "@stella/contracts/map-artifact";
import type { ToolStep } from "./tool-activity";
import {
  hasToolCalls,
  messageText,
  type JournalMessageRecord,
  type JournalRecord,
} from "./cloud-conversation-protocol";
import type { LiveTurn } from "./cloud-conversation-store";
import { withAttachmentPreamble } from "./chat-attachments";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

// Placement allocates a dispatch id, but preserves this caller identity in
// the committed prompt. The journal can arrive before the admission response.
const projectedMessageId = (record: JournalMessageRecord): string => {
  const origin = record.role === "user" ? record.payload.originUserMessageId : undefined;
  return (typeof origin === "string" && origin.trim()) ||
    record.clientMsgId || `cloud:${record.turnId}:message:${record.seq}`;
};

const timestampOf = (record: JournalMessageRecord): number =>
  typeof record.payload.timestamp === "number" &&
  Number.isFinite(record.payload.timestamp)
    ? record.payload.timestamp
    : record.createdAtMs;

const userAttachmentPresentation = (payload: Record<string, unknown>) => {
  const raw = asRecord(payload.providerContext)?.attachments;
  const attachmentPaths = Array.isArray(raw)
    ? [...new Set(raw.filter((path): path is string => typeof path === "string" && path.length > 0 && path.length <= 400))]
    : [];
  const text = messageText(payload);
  // This is the exact transport suffix generated for these structured paths,
  // not a search for prose that happens to mention attachments or storage.
  const suffix = attachmentPaths.length ? withAttachmentPreamble("", attachmentPaths) : "";
  return {
    text: suffix && text.endsWith(suffix) ? text.slice(0, -suffix.length) : text,
    ...(attachmentPaths.length ? {
      attachmentPaths,
      attachmentPreviews: attachmentPaths.map(path => ({ path, name: path.split("/").at(-1) ?? path })),
    } : {}),
  };
};

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

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
      )
    : [];

/**
 * One inline image card per `image_gen` call the orchestrator made in this
 * assistant row — the cloud twin of the desktop bridge's tool-start /
 * tool-end artifacts. A call without a result yet renders as generating;
 * a settled call carries the drive paths the cloud tool saved the image to.
 */
const generatedImageArtifacts = (args: {
  record: JournalMessageRecord;
  conversationId: string;
  toolResults: ReadonlyMap<
    string,
    { error: boolean; payload: Record<string, unknown> }
  >;
  terminal: Extract<JournalRecord, { kind: "turn" }> | undefined;
  createdAt: number;
}): ChatArtifact[] => {
  const artifacts: ChatArtifact[] = [];
  for (const call of toolCalls(args.record)) {
    if (call.name !== "image_gen") continue;
    const result = args.toolResults.get(call.id);
    const details = asRecord(result?.payload.details);
    const drivePaths = stringList(details?.drivePaths);
    const status = typeof details?.status === "string" ? details.status : "";
    const generationState: "running" | "completed" | "failed" | "canceled" =
      result
        ? !result.error && drivePaths.length > 0
          ? "completed"
          : status === "canceled"
            ? "canceled"
            : "failed"
        : args.terminal
          ? args.terminal.phase === "canceled"
            ? "canceled"
            : "failed"
          : "running";
    const prompt =
      (typeof details?.prompt === "string" && details.prompt) ||
      call.args?.prompt;
    const aspectRatio =
      (typeof details?.aspectRatio === "string" && details.aspectRatio) ||
      call.args?.aspectRatio;
    artifacts.push({
      id: `cloud:${args.record.turnId}:image:${call.id}`,
      conversationId: args.conversationId,
      payload: {
        kind: "media",
        asset: { kind: "image", filePaths: drivePaths },
        createdAt: args.createdAt,
        presentation: "inline-image",
        toolCallId: call.id,
        generationState,
        ...(drivePaths.length ? { driveBacked: true } : {}),
        ...(prompt ? { prompt } : {}),
        ...(aspectRatio ? { aspectRatio } : {}),
        ...(typeof details?.capability === "string"
          ? { capability: details.capability }
          : {}),
      },
    });
  }
  return artifacts;
};

/** Keep a runaway turn from stacking maps down the timeline. */
const MAX_MAP_CARDS_PER_TURN = 3;

/**
 * One inline map card per resolved `map` call in this assistant row — the
 * cloud twin of the desktop bridge's `map-route` artifact. A map resolved
 * inside `code` rides that call's lifted `maps`, exactly as on desktop.
 */
const mapRouteArtifacts = (args: {
  record: JournalMessageRecord;
  conversationId: string;
  toolResults: ReadonlyMap<
    string,
    { error: boolean; payload: Record<string, unknown> }
  >;
  createdAt: number;
}): ChatArtifact[] => {
  const artifacts: ChatArtifact[] = [];
  for (const call of toolCalls(args.record)) {
    if (call.name !== "map" && call.name !== "code") continue;
    const result = args.toolResults.get(call.id);
    if (!result || result.error) continue;
    const details = asRecord(result.payload.details);
    const candidates = Array.isArray(details?.maps)
      ? details.maps
      : [details?.map];
    candidates.forEach((candidate, index) => {
      if (artifacts.length >= MAX_MAP_CARDS_PER_TURN) return;
      if (!isMapRouteArtifact(candidate)) return;
      artifacts.push({
        id: `cloud:${args.record.turnId}:map:${call.id}:${index}`,
        conversationId: args.conversationId,
        payload: {
          kind: "map-route",
          version: 1,
          ...(candidate.title ? { title: candidate.title } : {}),
          markers: candidate.markers,
          ...(candidate.route ? { route: candidate.route } : {}),
        },
      });
    });
  }
  return artifacts;
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
 *
 * Committed records are the only source of assistant text. A turn in flight
 * contributes nothing to the transcript — the working indicator stands in for
 * it until the reply's row commits whole.
 */
export const projectCloudConversationMessages = (args: {
  conversationId?: string;
  records: readonly JournalRecord[];
  hasOlder?: boolean;
}): ChatMessage[] => {
  const records = completeWindow(args.records, args.hasOlder === true);
  const recordsBySeq = new Map(args.records.map(record => [record.seq, record]));
  const byTurn = new Map<string, JournalRecord[]>();
  for (const record of records) {
    const turn = byTurn.get(record.turnId);
    if (turn) turn.push(record);
    else byTurn.set(record.turnId, [record]);
  }

  const messages: ChatMessage[] = [];
  for (const [turnId, turn] of byTurn) {
    let userMessageId = `cloud:${turnId}:user`;
    let terminal: Extract<JournalRecord, { kind: "turn" }> | undefined;
    const toolResults = new Map<
      string,
      { error: boolean; payload: Record<string, unknown> }
    >();
    for (const record of turn) {
      if (record.kind === "turn" && record.phase !== "started") {
        terminal = record;
      }
      if (record.kind === "message" && record.role === "toolResult") {
        const id =
          typeof record.payload.toolCallId === "string"
            ? record.payload.toolCallId
            : "";
        if (id) {
          toolResults.set(id, {
            error: record.payload.isError === true,
            payload: record.payload,
          });
        }
      }
    }

    for (const record of turn) {
      if (record.kind !== "message") continue;
      const createdAt = timestampOf(record);
      if (record.role === "user") {
        userMessageId = projectedMessageId(record);
        if (record.hidden) continue;
        messages.push({
          id: userMessageId,
          canonicalId: `cloud:${turnId}:message:${record.seq}`,
          role: "user",
          ...userAttachmentPresentation(record.payload),
          createdAt,
          canonicalCreatedAt: record.createdAtMs,
          sequence: record.seq,
        });
        continue;
      }
      if (record.role !== "assistant" || record.hidden) continue;
      const spawnedThreadIds: string[] = [];
      const spawnedDescriptions: string[] = [];
      const tools: ToolStep[] = toolCalls(record).flatMap((call) => {
        const result = toolResults.get(call.id);
        if (!result) return [];
        if (call.name === "spawn_agent" || call.name === "send_input") {
          const details = result.payload.details;
          const threadId = details && typeof details === "object" && "thread_id" in details ? details.thread_id : undefined;
          const argThreadId = call.args && "thread_id" in call.args ? call.args.thread_id : undefined;
          for (const candidate of [threadId, argThreadId]) {
            if (typeof candidate === "string" && candidate && !spawnedThreadIds.includes(candidate)) spawnedThreadIds.push(candidate);
          }
          const description = call.name === "spawn_agent" && call.args && "description" in call.args ? call.args.description : undefined;
          if (typeof description === "string" && description.trim() && !spawnedDescriptions.includes(description.trim())) spawnedDescriptions.push(description.trim());
        }
        return [
          {
            id: call.id,
            toolName: call.name,
            status: result.error ? "error" : "completed",
            ...(call.args ? { args: call.args } : {}),
          },
        ];
      });
      // The trailing `refs` fence is model-facing (see `reply-refs`); it
      // never renders. Preserve its relationships for contextual navigation.
      const split = splitReplyRefs(messageText(record.payload));
      const value = split.text;
      const rawReplyRefs: ReplyRef[] = split.refs.flatMap((ref): ReplyRef[] => {
        if (ref.kind === "agent") return [{ ...ref, title: "" }];
        const target = recordsBySeq.get(ref.sequence);
        if (!target || target.kind !== "message" || target.hidden || (target.role !== "user" && target.role !== "assistant")) return [];
        return [{ kind: "message", sequence: ref.sequence,
          id: projectedMessageId(target),
          role: target.role, preview: toReplyPreview(splitReplyRefs(messageText(target.payload)).text) }];
      });
      const storedRefs = resolvedMobileReplyRefs(record.payload);
      const replyRefs = storedRefs.length ? storedRefs : rawReplyRefs;
      if (!replyRefs.length) {
        const wake = turn.find(r => r.kind === "message" && r.role === "user" && r.hidden);
        const task = wake?.kind === "message" ? lifecycleWakeTask(messageText(wake.payload)) : null;
        if (task) replyRefs.push({ kind: "agent", threadId: task.threadId, title: task.description ?? "" });
      }
      const artifacts = [
        ...mapRouteArtifacts({
          record,
          conversationId: args.conversationId ?? "",
          toolResults,
          createdAt,
        }),
        ...generatedImageArtifacts({
          record,
          conversationId: args.conversationId ?? "",
          toolResults,
          terminal,
          createdAt,
        }),
      ];
      if (!value && !tools.length && !artifacts.length) continue;
      messages.push({
        id: `cloud:${turnId}:message:${record.seq}`,
        requestId: userMessageId,
        role: "assistant",
        text: value,
        ...(replyRefs.length ? { replyRefs } : {}),
        createdAt,
        canonicalCreatedAt: record.createdAtMs,
        sequence: record.seq,
        ...(tools.length ? { toolSteps: tools } : {}),
        ...(spawnedThreadIds.length ? { spawnedThreadIds } : {}),
        ...(spawnedDescriptions.length ? { spawnedDescriptions } : {}),
        ...(artifacts.length ? { artifacts } : {}),
      });
    }

    // Files the turn itself produced (an orchestrator-direct `html`,
    // `image_gen`, …) ride the turn's last reply. Files a spawned task
    // produced are reported under the same turn id but belong to the task's
    // completion card, which `projectMobileLifecycle` places on the reply
    // that relays the result — desktop parity.
    const turnSpawnedAgent = turn.some(
      (record) =>
        record.kind === "card" &&
        record.card.type === "agent-lifecycle" &&
        record.card.event.type === "agent-started",
    );
    const files = turnSpawnedAgent
      ? []
      : turn.flatMap((record) =>
          record.kind === "card" && record.card.type === "files"
            ? record.card.files
            : [],
        );
    if (files.length) {
      const createdAt = turn.at(-1)?.createdAtMs ?? 0;
      const artifacts: ChatArtifact[] = files.map((file) =>
        cloudFileArtifact(file, args.conversationId ?? "", createdAt),
      );
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

  return projectMobileLifecycle(messages, args.records, args.conversationId ?? "");
};

export const activeCloudTurnId = (
  records: readonly JournalRecord[],
  live: LiveTurn | null,
): string | null => {
  const phases = new Map<string, string>();
  for (const record of records) {
    if (record.kind === "turn") phases.set(record.turnId, record.phase);
  }
  // Durable terminal evidence wins over an older ephemeral snapshot. The
  // terminal record and live-clear frame can arrive in separate renders.
  if (live && (!phases.has(live.turnId) || phases.get(live.turnId) === "started")) {
    return live.turnId;
  }
  for (const [turnId, phase] of [...phases].reverse()) {
    if (phase === "started") return turnId;
  }
  return null;
};

/** What the journal can prove about a running turn for the working indicator. */
export type CloudTurnActivity = {
  /**
   * True once this turn committed an assistant reply that is not on its way
   * into another tool. Assistant text lands whole, so this flips exactly once
   * per answer and lets the indicator step aside rather than fade over a reply
   * the user is already reading.
   */
  answerLanded: boolean;
  /** True once any tool ran this turn. Gates the pre-tool think label. */
  hasToolActivity: boolean;
};

export { journalWorkingActivity as cloudTurnActivity } from "@stella/contracts/journal-working-activity";

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
  const localById = new Map(args.local.map(message => [message.id, message]));
  const canonical = args.canonical.map(message => {
    const local = localById.get(message.id);
    if (message.role !== "user" || local?.role !== "user") return message;
    // Identity is already canonical here. Keep the picked preview while the
    // authenticated canonical attachment URL resolves, including after ACK.
    return {
      ...message,
      ...(message.attachmentPaths?.length ? {
        attachmentPreviews: message.attachmentPaths.map(path =>
          local.attachmentPreviews?.find(preview => preview.path === path)
          ?? message.attachmentPreviews?.find(preview => preview.path === path)
          ?? { path, name: path.split("/").at(-1) ?? path }),
      } : {}),
      ...(!message.thumbnailUris?.length && local.thumbnailUris?.length
        ? { thumbnailUris: local.thumbnailUris, hasImage: true } : {}),
      ...(!message.documentNames?.length && local.documentNames?.length
        ? { documentNames: local.documentNames } : {}),
      ...(!message.quotedText && local.quotedText ? { quotedText: local.quotedText } : {}),
    };
  });
  // Failed admissions have no journal row. Appending them after the entire
  // journal makes an old offline notice follow every later successful reply.
  // Merge by time while preserving the journal's authoritative relative order.
  const timestamp = (message: ChatMessage) => message.createdAt ?? Infinity;
  const pending = [...optimistic].sort((a, b) => timestamp(a) - timestamp(b));
  const merged: ChatMessage[] = [];
  const seenCanonical = new Set<string>();
  let index = 0;
  for (const message of canonical) {
    while (index < pending.length) {
      const next = pending[index]!;
      if (timestamp(next) > timestamp(message)) break;
      // A phone clock can precede the server clock. Never put an optimistic
      // assistant segment above the canonical user message it answers.
      if (next.requestId && canonicalIds.has(next.requestId) &&
          !seenCanonical.has(next.requestId)) break;
      merged.push(next);
      index += 1;
    }
    merged.push(message);
    seenCanonical.add(message.id);
  }
  merged.push(...pending.slice(index));
  return merged;
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
