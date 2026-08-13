/**
 * Rebuild composer state from a *sent* user message so the desktop Fork /
 * Rewind actions can drop that message back into a composer, ready to edit
 * and re-send.
 *
 * Fidelity note: a sent user row only persists the flattened `attachments`
 * (file + image) that the send path produced from the live `ChatContext`.
 * Files round-trip faithfully (name / size / mimeType / on-disk path all
 * survive). Image/screenshot attachments come back as `regionScreenshots`
 * carrying the stored (preview-resolution) data URL, with width/height
 * unknown — enough to render the chip and re-send. Richer live-only context
 * that was never persisted onto the message (window capture + AX tree, app
 * selections, pasted-text bodies, activity anchors) can't be reconstructed
 * here and is intentionally dropped; the text always carries over.
 */

/**
 * @param {ReadonlyArray<import("@stella/contracts/local-chat").Attachment> | undefined} attachments
 * @returns {import("@/shared/types/electron").ChatContext | null}
 */
export const composerContextFromSentAttachments = (attachments) => {
  const files = [];
  const regionScreenshots = [];
  for (const attachment of attachments ?? []) {
    const url = attachment?.url;
    if (typeof url !== "string" || url.length === 0) continue;
    if (attachment.kind === "file") {
      files.push({
        name: attachment.name ?? "file",
        size: typeof attachment.size === "number" ? attachment.size : 0,
        mimeType: attachment.mimeType ?? "application/octet-stream",
        dataUrl: url,
        ...(attachment.path ? { path: attachment.path } : {}),
      });
    } else {
      regionScreenshots.push({
        dataUrl: url,
        width: 0,
        height: 0,
        previewUrl: url,
      });
    }
  }
  if (files.length === 0 && regionScreenshots.length === 0) return null;
  return {
    window: null,
    browserUrl: null,
    regionScreenshots,
    ...(files.length > 0 ? { files } : {}),
  };
};

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

/**
 * The composer payload restored from a sent user row: the message text plus
 * the reconstructed attachment/context state (or null when the row carried
 * no re-hydratable attachments).
 *
 * @param {import("@/features/chat/conversation-row-types").UserRowViewModel} row
 */
export const composerDraftFromUserRow = (row) => ({
  message: row.text ?? "",
  chatContext: composerContextFromSentAttachments(row.attachments),
});
