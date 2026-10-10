import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { Attachment, MessageRecord } from "@stella/contracts/local-chat";
import {
  backendClient,
  readBackendAccountEpoch,
  subscribeBackendAccount,
} from "@/platform/backend/backend-client";

const DRIVE_ATTACHMENT_ID_PREFIX = "drive:";
const MAX_RESOLVED = 48;
const MAX_SENT = 32;
const MAX_CONCURRENT = 4;
const RETRY_MS = 30_000;

type Resolved =
  | { status: "pending" }
  | { status: "ready"; url: string; mimeType: string; name: string; size: number }
  | { status: "failed"; at: number };

const resolved = new Map<string, Resolved>();
const sentPreviews = new Map<string, Attachment[]>();
const listeners = new Set<() => void>();
const queue: string[] = [];
let active = 0;
let epoch = readBackendAccountEpoch();

type Snapshot = {
  resolved: ReadonlyMap<string, Resolved>;
  sent: ReadonlyMap<string, Attachment[]>;
};

let snapshot: Snapshot = { resolved: new Map(), sent: new Map() };

const notify = () => {
  snapshot = { resolved: new Map(resolved), sent: new Map(sentPreviews) };
  for (const listener of listeners) listener();
};

const forget = (entry: Resolved | undefined) => {
  if (entry?.status === "ready") URL.revokeObjectURL(entry.url);
};

const clearAll = () => {
  for (const entry of resolved.values()) forget(entry);
  resolved.clear();
  sentPreviews.clear();
  queue.length = 0;
  notify();
};

subscribeBackendAccount(() => {
  epoch = readBackendAccountEpoch();
  clearAll();
});

const remember = (path: string, entry: Resolved) => {
  resolved.delete(path);
  resolved.set(path, entry);
  while (resolved.size > MAX_RESOLVED) {
    const oldest = resolved.keys().next().value as string;
    forget(resolved.get(oldest));
    resolved.delete(oldest);
  }
};

const fetchPreview = async (path: string): Promise<Resolved> => {
  const file = await backendClient.call("drive.fileUrl", { path });
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`drive file ${response.status}`);
  const blob = await response.blob();
  const mimeType = file.contentType || blob.type || "application/octet-stream";
  const typed = blob.type === mimeType ? blob : new Blob([blob], { type: mimeType });
  return {
    status: "ready",
    url: URL.createObjectURL(typed),
    mimeType,
    name: file.name,
    size: file.sizeBytes,
  };
};

const pump = () => {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const path = queue.shift()!;
    const startedEpoch = epoch;
    active += 1;
    void fetchPreview(path)
      .catch((): Resolved => ({ status: "failed", at: Date.now() }))
      .then((entry) => {
        active -= 1;
        if (startedEpoch !== epoch) {
          forget(entry);
        } else {
          remember(path, entry);
          notify();
        }
        pump();
      });
  }
};

const request = (path: string) => {
  const current = resolved.get(path);
  if (current?.status === "ready" || current?.status === "pending") return;
  if (current?.status === "failed" && Date.now() - current.at < RETRY_MS) return;
  resolved.set(path, { status: "pending" });
  queue.push(path);
  pump();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const readSnapshot = () => snapshot;

export const driveAttachmentRef = (path: string): Attachment => ({
  id: `${DRIVE_ATTACHMENT_ID_PREFIX}${path}`,
  providerMeta: { drivePath: path },
});

const drivePathOf = (attachment: Attachment): string | null => {
  const meta = attachment.providerMeta as { drivePath?: unknown } | undefined;
  return typeof meta?.drivePath === "string" &&
    attachment.id === `${DRIVE_ATTACHMENT_ID_PREFIX}${meta.drivePath}`
    ? meta.drivePath
    : null;
};

export const rememberSentAttachmentPreviews = (
  userMessageId: string,
  attachments: readonly Attachment[],
) => {
  const shown = attachments.filter((attachment) => Boolean(attachment.url));
  if (!userMessageId || shown.length === 0) return;
  sentPreviews.delete(userMessageId);
  sentPreviews.set(userMessageId, [...shown]);
  while (sentPreviews.size > MAX_SENT) {
    sentPreviews.delete(sentPreviews.keys().next().value as string);
  }
  notify();
};

const attachmentsOf = (message: MessageRecord): Attachment[] | null => {
  if (message.type !== "user_message") return null;
  const attachments = (message.payload as { attachments?: unknown } | undefined)
    ?.attachments;
  if (!Array.isArray(attachments)) return null;
  return (attachments as Attachment[]).some((entry) => drivePathOf(entry))
    ? (attachments as Attachment[])
    : null;
};

const sentFor = (state: Snapshot, message: MessageRecord) => {
  const origin = (message.payload as { originUserMessageId?: unknown } | undefined)
    ?.originUserMessageId;
  return (
    state.sent.get(message._id) ??
    (typeof origin === "string" ? state.sent.get(origin) : undefined)
  );
};

const presentDrive = (state: Snapshot, attachment: Attachment): Attachment | null => {
  const path = drivePathOf(attachment);
  if (!path) return attachment;
  const entry = state.resolved.get(path);
  if (entry?.status === "ready") {
    return {
      id: attachment.id,
      url: entry.url,
      mimeType: entry.mimeType,
      name: entry.name,
      size: entry.size,
      ...(entry.mimeType.toLowerCase().startsWith("image/") ? {} : { kind: "file" }),
    };
  }
  if (entry?.status === "failed") return { id: attachment.id, kind: "file" };
  return null;
};

const presentAttachments = (
  state: Snapshot,
  message: MessageRecord,
  attachments: Attachment[],
) => {
  const sent = sentFor(state, message);
  if (sent) {
    return [...attachments.filter((entry) => !drivePathOf(entry)), ...sent];
  }
  return attachments.flatMap((entry) => {
    const shown = presentDrive(state, entry);
    return shown ? [shown] : [];
  });
};

const signatureOf = (attachments: readonly Attachment[]) =>
  attachments.map((entry) => `${entry.id ?? ""}\u001f${entry.url ?? ""}`).join("\u001e");

const presented = new WeakMap<MessageRecord, { signature: string; message: MessageRecord }>();

export const useDriveAttachmentPreviews = (
  messages: MessageRecord[],
): MessageRecord[] => {
  const state = useSyncExternalStore(subscribe, readSnapshot);

  const pathsKey = useMemo(() => {
    const paths = new Set<string>();
    for (const message of messages) {
      const attachments = attachmentsOf(message);
      if (!attachments) continue;
      if (sentFor(state, message)) continue;
      for (const attachment of attachments) {
        const path = drivePathOf(attachment);
        if (path) paths.add(path);
      }
    }
    return [...paths].sort().join("\n");
  }, [messages, state]);

  useEffect(() => {
    if (!pathsKey) return;
    for (const path of pathsKey.split("\n")) request(path);
  }, [pathsKey, state]);

  return useMemo(() => {
    if (!messages.some((message) => attachmentsOf(message))) return messages;
    return messages.map((message) => {
      const attachments = attachmentsOf(message);
      if (!attachments) return message;
      const shown = presentAttachments(state, message, attachments);
      const signature = signatureOf(shown);
      const cached = presented.get(message);
      if (cached && cached.signature === signature) return cached.message;
      const replaced: MessageRecord = {
        ...message,
        payload: { ...message.payload, attachments: shown },
      };
      presented.set(message, { signature, message: replaced });
      return replaced;
    });
  }, [messages, state]);
};
