import { sha256Hex } from "./hash.js";

const OWNER_ID_MAX_CHARS = 512;

export type OwnerTransferRequest = {
  fromOwnerId: string;
  toOwnerId: string;
};

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
  if (
    !fromOwnerId ||
    !toOwnerId ||
    fromOwnerId === toOwnerId ||
    fromOwnerId.length > OWNER_ID_MAX_CHARS ||
    toOwnerId.length > OWNER_ID_MAX_CHARS
  ) {
    return null;
  }
  return { fromOwnerId, toOwnerId };
};

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
