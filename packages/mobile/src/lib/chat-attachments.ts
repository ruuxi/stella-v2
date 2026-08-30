/**
 * Composer attachments, from picked file to drive reference.
 *
 * A turn's attachment is a drive-relative path and nothing else. The bytes go
 * to the drive out of band, before the send, because the execution-placement
 * envelope is hash-fenced and size-bounded and a photo cannot ride it. Once
 * the bytes are on the drive both placements reach them through machinery that
 * already exists: a cloud turn hydrates the path through the drive sync, a
 * computer-placed turn resolves it through a signed drive GET.
 *
 * Uploading at pick time rather than at send time is what makes a failed
 * upload harmless. The composer still holds the draft and the chip when the
 * failure lands, so there is nothing to restore and nothing to lose.
 */
import type { ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { attachmentContentType } from "./image-attachments";

/**
 * One turn's attachment budget. The cloud attachment route signs at most this
 * many images per turn and the orchestrator asks for at most this many, so a
 * composer that accepted more would drop the surplus without saying so.
 */
export const CHAT_ATTACHMENT_MAX_COUNT = 4;

/** Where a phone's picks land in the drive. `uploads/` is the drive's own
 * convention for user-supplied files and ranks above agent output when a turn
 * hydrates. */
const CHAT_ATTACHMENT_DRIVE_PREFIX = "uploads";

const MAX_SEGMENT_LENGTH = 255;

export type ChatAttachmentKind = "image" | "file";

/** What the picker hands over: local bytes and what they claim to be. */
export type PickedAttachment = {
  id: string;
  uri: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  kind: ChatAttachmentKind;
};

/**
 * A chip's whole lifecycle. Modelled as a discriminated union so `drivePath`
 * cannot be read off an attachment that has not landed and `message` cannot be
 * read off one that has.
 */
export type ComposerAttachment = PickedAttachment &
  (
    | { status: "uploading" }
    | { status: "ready"; drivePath: string }
    | { status: "failed"; message: string }
  );

export type ReadyAttachment = PickedAttachment & {
  status: "ready";
  drivePath: string;
};

export const isAttachmentReady = (
  attachment: ComposerAttachment,
): attachment is ReadyAttachment => attachment.status === "ready";

/** Whether a send may proceed: nothing may still be in flight or broken. */
export const attachmentsSettled = (
  attachments: readonly ComposerAttachment[],
): attachments is readonly ReadyAttachment[] =>
  attachments.every(isAttachmentReady);

/**
 * Add picks up to the turn budget, reporting the overflow so the picker can
 * say how many it dropped instead of swallowing them.
 */
export const appendAttachments = <T>(
  current: readonly T[],
  incoming: readonly T[],
  limit = CHAT_ATTACHMENT_MAX_COUNT,
): { attachments: T[]; rejected: number } => {
  const combined = [...current, ...incoming];
  return {
    attachments: combined.slice(0, limit),
    rejected: Math.max(0, combined.length - limit),
  };
};

/**
 * Reduce a picked filename to one drive path segment. Path separators,
 * traversal and control characters are what `normalizeDrivePath` rejects
 * outright, so they are removed here rather than surfaced as a failed upload.
 */
export const driveFileNameFor = (name: string, kind: ChatAttachmentKind) => {
  const cleaned = name
    .replaceAll("\\", "/")
    .split("/")
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return kind === "image" ? "photo.jpg" : "file";
  }
  return cleaned.slice(-MAX_SEGMENT_LENGTH);
};

/**
 * Day-bucketed so a drive does not accumulate one flat directory, and
 * suffixed when a turn carries two files of the same name — the second upload
 * would otherwise land on the first one's path and the agent would read one
 * file twice.
 */
export const driveAttachmentPath = (args: {
  name: string;
  kind: ChatAttachmentKind;
  now: Date;
  taken: ReadonlySet<string>;
}): string => {
  const day = args.now.toISOString().slice(0, 10);
  const fileName = driveFileNameFor(args.name, args.kind);
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const extension = dot > 0 ? fileName.slice(dot) : "";
  for (let attempt = 1; ; attempt += 1) {
    const candidate = `${CHAT_ATTACHMENT_DRIVE_PREFIX}/${day}/${
      attempt === 1 ? fileName : `${stem}-${attempt}${extension}`
    }`;
    if (!args.taken.has(candidate)) return candidate;
  }
};

/**
 * Attached files ride along as an addressable list in the prompt, the same way
 * the desktop composer names them. A cloud turn's drive sync ranks paths the
 * prompt references above every other row, so naming them is both how the
 * agent learns they exist and how they get hydrated into the world at all.
 */
export const withAttachmentPreamble = (
  prompt: string,
  paths: readonly string[],
): string => {
  if (!paths.length) return prompt;
  const lines = paths.map((path) => `- ${path}`).join("\n");
  return `${prompt}\n\nAttached in my drive:\n${lines}`;
};

const prepareDriveUploadRef = makeFunctionReference<
  "action",
  { path: string; sizeBytes: number; contentType?: string },
  { path: string; uploadId: string; uploadUrl: string; contentType: string }
>("cloud_drive:prepareDriveUpload");

const finalizeDriveUploadRef = makeFunctionReference<
  "action",
  { path: string; uploadId: string; contentType?: string; source?: string },
  {
    path: string;
    name: string;
    sizeBytes: number;
    contentType: string;
    updatedAt: number;
  }
>("cloud_drive:finalizeDriveUpload");

export type AttachmentUploadDeps = {
  client: Pick<ConvexReactClient, "action">;
  /** Reads the picked file's bytes. Split out so tests never touch the disk. */
  readFile: (uri: string) => Promise<Uint8Array<ArrayBuffer>>;
  now?: () => Date;
};

/**
 * The drive's own two-step upload: claim a presigned PUT sized against the
 * plan quota, send the bytes straight to R2, then let the server write the row
 * from the size R2 actually reports. Nothing about the file is client-declared
 * once this returns — the path is the whole reference.
 */
export const uploadChatAttachment = async (
  attachment: PickedAttachment,
  taken: ReadonlySet<string>,
  deps: AttachmentUploadDeps,
): Promise<string> => {
  const path = driveAttachmentPath({
    name: attachment.name,
    kind: attachment.kind,
    now: deps.now?.() ?? new Date(),
    taken,
  });
  const bytes = await deps.readFile(attachment.uri);
  const contentType = attachmentContentType(bytes, attachment.mimeType);
  const prepared = await deps.client.action(prepareDriveUploadRef, {
    path,
    sizeBytes: bytes.byteLength,
    contentType,
  });
  const put = await fetch(prepared.uploadUrl, {
    method: "PUT",
    headers: { "content-type": prepared.contentType },
    body: new Blob([bytes], { type: prepared.contentType }),
  });
  if (!put.ok) {
    throw new Error(`Upload failed (${put.status}).`);
  }
  const finalized = await deps.client.action(finalizeDriveUploadRef, {
    path: prepared.path,
    uploadId: prepared.uploadId,
    contentType,
    source: "mobile-chat",
  });
  return finalized.path;
};
