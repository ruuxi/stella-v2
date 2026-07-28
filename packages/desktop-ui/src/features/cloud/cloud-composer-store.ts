/**
 * What is attached to the next turn.
 *
 * There is no destination setting: a turn runs where its subject lives. The
 * web/mobile interior has no local runtime, so its turns run in the cloud;
 * desktop chats with its local runtime and reaches cloud workspaces through
 * the spawn `workspace` argument, which the model picks from what the work is
 * about. Routing is a property of the request, never a mode the user holds.
 */
import { useSyncExternalStore } from "react";

export const isWebShell = (): boolean =>
  typeof window !== "undefined" &&
  !(window as { electronAPI?: unknown }).electronAPI;

export type CloudAttachment = {
  path: string;
  name: string;
  sizeBytes: number;
};

let attachments: readonly CloudAttachment[] = [];
const attachmentListeners = new Set<() => void>();

const emitAttachments = (next: readonly CloudAttachment[]): void => {
  attachments = next;
  for (const listener of attachmentListeners) listener();
};

export const cloudAttachmentsStore = {
  subscribe(listener: () => void): () => void {
    attachmentListeners.add(listener);
    return () => attachmentListeners.delete(listener);
  },
  getSnapshot(): readonly CloudAttachment[] {
    return attachments;
  },
  add(attachment: CloudAttachment): void {
    emitAttachments([
      ...attachments.filter((entry) => entry.path !== attachment.path),
      attachment,
    ]);
  },
  remove(path: string): void {
    emitAttachments(attachments.filter((entry) => entry.path !== path));
  },
  clear(): void {
    if (attachments.length) emitAttachments([]);
  },
};

const EMPTY_ATTACHMENTS: readonly CloudAttachment[] = [];

export const useCloudAttachments = (): readonly CloudAttachment[] =>
  useSyncExternalStore(
    cloudAttachmentsStore.subscribe,
    cloudAttachmentsStore.getSnapshot,
    () => EMPTY_ATTACHMENTS,
  );

/**
 * Attached drive files ride along as an addressable list in the prompt: the
 * cloud agent reaches them by drive path, so naming them is all it needs.
 */
export const withAttachmentPreamble = (
  prompt: string,
  files: readonly CloudAttachment[],
): string => {
  if (!files.length) return prompt;
  const lines = files.map((file) => `- ${file.path}`).join("\n");
  return `${prompt}\n\nAttached in my drive:\n${lines}`;
};
