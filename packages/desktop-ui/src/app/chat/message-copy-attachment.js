/**
 * True when a sent attachment should be copied to the clipboard as an image.
 * Mirrors the message row's image treatment: a `file`-kind attachment counts
 * only when its mime type is an image; screenshots (no `file` kind) and
 * image-mimed / `data:image/` attachments are images.
 *
 * @param {import("@stella/contracts/local-chat").Attachment} attachment
 */
const isImageCopyAttachment = (attachment) => {
  const mimeType = attachment.mimeType ?? "";
  if (attachment.kind === "file" && !mimeType.startsWith("image/")) return false;
  if (mimeType.startsWith("image/")) return true;
  if (typeof attachment.url === "string" && attachment.url.startsWith("data:image/"))
    return true;
  return attachment.kind !== "file" && !mimeType;
};

/**
 * Pick the single attachment the Copy action should place on the clipboard
 * for a sent user message, and shape it for `media.copyAttachment`. Prefers
 * the FIRST image attachment (the primary/leftmost chip); falls back to the
 * first attachment that carries a usable on-disk path or data/file URL.
 * Returns null when nothing is copyable.
 *
 * @param {ReadonlyArray<import("@stella/contracts/local-chat").Attachment> | undefined} attachments
 */
export const primaryCopyAttachment = (attachments) => {
  const usable = (attachments ?? []).filter(
    (attachment) =>
      attachment &&
      ((typeof attachment.url === "string" && attachment.url.length > 0) ||
        (typeof attachment.path === "string" && attachment.path.length > 0)),
  );
  if (usable.length === 0) return null;
  const chosen = usable.find(isImageCopyAttachment) ?? usable[0];
  return {
    ...(chosen.path ? { path: chosen.path } : {}),
    ...(chosen.url ? { url: chosen.url } : {}),
    ...(chosen.mimeType ? { mimeType: chosen.mimeType } : {}),
    ...(chosen.kind ? { kind: chosen.kind } : {}),
    ...(chosen.name ? { name: chosen.name } : {}),
  };
};
