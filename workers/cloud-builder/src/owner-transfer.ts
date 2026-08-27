import { sha256BytesHex, sha256Hex } from "./hash.js";
import {
  parseOwnerTransferControl,
  type OwnerTransferControl,
} from "./owner-transfer-coordinator.js";

const OWNER_ID_MAX_CHARS = 512;

export type OwnerTransferRequest = OwnerTransferControl & {
  fromOwnerId: string;
  toOwnerId: string;
};

const ARCHIVE_SOURCE_MARKER = "stellaOwnerTransferSource";
const ARCHIVE_SOURCE_ETAG_MARKER = "stellaOwnerTransferSourceEtag";
const ARCHIVE_SOURCE_DIGEST_MARKER = "stellaOwnerTransferSourceDigest";
const ARCHIVE_DESTINATION_DIGEST_MARKER =
  "stellaOwnerTransferDestinationDigest";

export type ArchiveOwnerTransferProof = {
  sourceMarker: string;
  sourceEtagMarker: string;
  sourceDigest: string;
  destinationDigest: string;
  customMetadata: Record<string, string>;
};

export class OwnerTransferArchiveConflictError extends Error {
  constructor(readonly objectRef: string) {
    super(
      `The conversation archive destination contains unrelated data (ref ${objectRef}).`,
    );
    this.name = "OwnerTransferArchiveConflictError";
  }
}

/**
 * `turn` is intentionally retained after completion so alarms and crash
 * recovery can redeliver a terminal event. Only a non-terminal snapshot
 * represents active work that must fence an ownership transfer.
 */
export const retainedTurnBlocksOwnerTransfer = (
  turnPresent: boolean,
  terminal: boolean | undefined,
): boolean => turnPresent && terminal !== true;

export const parseOwnerTransferRequest = (
  value: unknown,
): OwnerTransferRequest | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const fromOwnerId =
    typeof candidate.fromOwnerId === "string"
      ? candidate.fromOwnerId.trim()
      : "";
  const toOwnerId =
    typeof candidate.toOwnerId === "string" ? candidate.toOwnerId.trim() : "";
  const control = parseOwnerTransferControl(candidate);
  if (
    !control ||
    !fromOwnerId ||
    !toOwnerId ||
    fromOwnerId === toOwnerId ||
    fromOwnerId.length > OWNER_ID_MAX_CHARS ||
    toOwnerId.length > OWNER_ID_MAX_CHARS
  ) {
    return null;
  }
  return { ...control, fromOwnerId, toOwnerId };
};

export const archiveOwnerTransferProof = async (args: {
  sourceKey: string;
  sourceEtag: string;
  sourceBody: Uint8Array<ArrayBufferLike>;
  destinationBody: Uint8Array<ArrayBufferLike>;
}): Promise<ArchiveOwnerTransferProof> => {
  const [sourceKeyHash, sourceEtagMarker, sourceDigest, destinationDigest] =
    await Promise.all([
      sha256Hex(args.sourceKey),
      sha256Hex(args.sourceEtag),
      sha256BytesHex(args.sourceBody),
      sha256BytesHex(args.destinationBody),
    ]);
  const sourceMarker = await sha256Hex(
    `conversation-owner-transfer-v1\0${sourceKeyHash}\0${sourceEtagMarker}\0${sourceDigest}`,
  );
  return {
    sourceMarker,
    sourceEtagMarker,
    sourceDigest,
    destinationDigest,
    customMetadata: {
      [ARCHIVE_SOURCE_MARKER]: sourceMarker,
      [ARCHIVE_SOURCE_ETAG_MARKER]: sourceEtagMarker,
      [ARCHIVE_SOURCE_DIGEST_MARKER]: sourceDigest,
      [ARCHIVE_DESTINATION_DIGEST_MARKER]: destinationDigest,
    },
  };
};

export const archiveOwnerTransferMetadataMatches = (
  customMetadata: Record<string, string> | undefined,
  proof: ArchiveOwnerTransferProof,
): boolean =>
  customMetadata?.[ARCHIVE_SOURCE_MARKER] === proof.sourceMarker &&
  customMetadata?.[ARCHIVE_SOURCE_ETAG_MARKER] === proof.sourceEtagMarker &&
  customMetadata?.[ARCHIVE_SOURCE_DIGEST_MARKER] === proof.sourceDigest &&
  customMetadata?.[ARCHIVE_DESTINATION_DIGEST_MARKER] ===
    proof.destinationDigest;

export const conversationArchivePrefix = async (
  ownerId: string,
  conversationId: string,
): Promise<string> =>
  `conversations/${await sha256Hex(ownerId)}/${conversationId}`;

export const transferArchiveKey = (
  key: string,
  fromPrefix: string,
  toPrefix: string,
): string | null =>
  key.startsWith(`${fromPrefix}/`)
    ? `${toPrefix}${key.slice(fromPrefix.length)}`
    : null;

const gzip = async (text: string): Promise<ArrayBuffer> =>
  await new Response(
    new Blob([text]).stream().pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();

export const rewriteSegmentOwnership = async (
  compressed: ArrayBuffer,
  toOwnerId: string,
  fromPrefix: string,
  toPrefix: string,
): Promise<ArrayBuffer> => {
  const text = await new Response(
    new Blob([compressed])
      .stream()
      .pipeThrough(new DecompressionStream("gzip")),
  ).text();
  const lines = text.split("\n");
  if (!lines[0]) throw new Error("Archived segment header is missing.");
  const header = JSON.parse(lines[0]) as Record<string, unknown>;
  header.ownerId = toOwnerId;
  lines[0] = JSON.stringify(header);
  for (let index = 1; index < lines.length; index += 1) {
    if (!lines[index]) continue;
    const row = JSON.parse(lines[index]!) as Record<string, unknown>;
    if (
      typeof row.spill_key === "string" &&
      row.spill_key.startsWith(`${fromPrefix}/`)
    ) {
      row.spill_key = `${toPrefix}${row.spill_key.slice(fromPrefix.length)}`;
      lines[index] = JSON.stringify(row);
    }
  }
  return await gzip(lines.join("\n"));
};
