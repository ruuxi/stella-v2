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

const isImageCopyAttachment = (attachment) => {
  const mimeType = attachment.mimeType ?? "";
  if (attachment.kind === "file" && !mimeType.startsWith("image/")) return false;
  if (mimeType.startsWith("image/")) return true;
  if (typeof attachment.url === "string" && attachment.url.startsWith("data:image/"))
    return true;
  return attachment.kind !== "file" && !mimeType;
};

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

export const composerDraftFromUserRow = (row) => ({
  message: row.text ?? "",
  chatContext: composerContextFromSentAttachments(row.attachments),
});
