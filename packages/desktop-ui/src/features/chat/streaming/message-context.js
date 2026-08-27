const buildLocalScreenshotAttachments = (chatContext) => (chatContext?.regionScreenshots ?? []).map((screenshot) => {

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

(chatContext?.files ?? []).map((file) => ({
    url: file.dataUrl,
    mimeType: file.mimeType,
    name: file.name,
    size: file.size,
    kind: 'file',
    ...(file.path ? { path: file.path } : {}),
}));

export const buildAllLocalAttachments = (chatContext) => [
    ...buildLocalScreenshotAttachments(chatContext),
    ...buildLocalFileAttachments(chatContext),
];

export const toDisplayAttachments = (attachments) => attachments.map(({ previewUrl, ...attachment }) => ({
    ...attachment,
    ...(previewUrl ? { url: previewUrl } : {}),
}));
