const buildLocalScreenshotAttachments = (chatContext) => (chatContext?.regionScreenshots ?? []).map((screenshot) => {
    // Path-backed attachments ship only the path + preview; the runtime
    // worker reads and resizes the original from disk. The worker sniffs
    // the mime type from the file bytes.
    if (screenshot.filePath) {
        return {
            url: screenshot.filePath,
            previewUrl: screenshot.previewUrl ?? screenshot.dataUrl,
        };
    }
    const match = screenshot.dataUrl.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,/);
    return {
        url: screenshot.dataUrl,
        mimeType: match ? match[1] : 'image/png',
        ...(screenshot.previewUrl ? { previewUrl: screenshot.previewUrl } : {}),
    };
});
const buildLocalFileAttachments = (chatContext) =>
// Name/size/kind/path ride along so the sent-message row can render a
// real file chip (and open the original); the runtime worker only
// reads `url` + `mimeType`.
(chatContext?.files ?? []).map((file) => ({
    url: file.dataUrl,
    mimeType: file.mimeType,
    name: file.name,
    size: file.size,
    kind: 'file',
    ...(file.path ? { path: file.path } : {}),
}));
/** Builds all local attachments (screenshots + files) from chat context. */
export const buildAllLocalAttachments = (chatContext) => [
    ...buildLocalScreenshotAttachments(chatContext),
    ...buildLocalFileAttachments(chatContext),
];
/**
 * Display copies (optimistic rows, stored chat events) swap the full
 * resolution data URL for the attach-time preview when one exists. The
 * model path keeps `url` untouched.
 */
export const toDisplayAttachments = (attachments) => attachments.map(({ previewUrl, ...attachment }) => ({
    ...attachment,
    ...(previewUrl ? { url: previewUrl } : {}),
}));
