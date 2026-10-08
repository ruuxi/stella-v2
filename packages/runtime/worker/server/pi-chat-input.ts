/**
 * A desktop composer send as pi-durable user input. The model gets what the
 * agent loops gave it: the typed text, the chat context and attachment
 * notices, and the images sized for it. Everything but the typed text is
 * marked hidden, and the first part carries what the message shows (image
 * previews, files, context chips), so the timeline renders the message as the
 * user sent it.
 */
import type {
  RuntimeAttachmentRef,
  RuntimeChatPayload,
} from "@stella/contracts/protocol";
import type { PiUserDisplay, PiUserPart } from "@stella/contracts/pi-chat";
import type { PreparedChatInput } from "./chat-input.js";

const DATA_URL = /^data:([^;,]+);base64,(.+)$/s;

const imagePart = (url: string): PiUserPart | null => {
  const match = DATA_URL.exec(url.trim());
  return match
    ? { type: "image", mimeType: match[1]!, data: match[2]!, stella: { hidden: true } }
    : null;
};

/** The notice the agent loops add for attachments saved on this computer. */
const attachmentNotice = (
  attachments: readonly RuntimeAttachmentRef[],
): string | undefined => {
  const lines = attachments.flatMap((attachment) => {
    if (!attachment.sourcePath) return [];
    if (attachment.kind === "file") {
      return [
        `The user attached a file: ${JSON.stringify(attachment.name || "attachment")} (${attachment.mimeType || "application/octet-stream"}). The file is available locally at ${JSON.stringify(attachment.sourcePath)}. Use Read or delegate to an agent to inspect it. Pass this absolute path to any agent that needs its contents.`,
      ];
    }
    if (attachment.kind === "image") {
      return [
        `The user attached an image: ${JSON.stringify(attachment.name || "image")} (${attachment.mimeType || "image/png"}). It is already attached to this message, and the same bytes are saved locally at ${JSON.stringify(attachment.sourcePath)}. Use Read with that path to look at it again, and pass this absolute path to any agent that needs to see it.`,
      ];
    }
    return [];
  });
  return lines.length > 0 ? lines.join("\n") : undefined;
};

/** What the user's message shows: previews of what they attached, and its context chips. */
const displayOf = (
  payload: RuntimeChatPayload,
  prepared: PreparedChatInput,
): PiUserDisplay | undefined => {
  const attachments = (payload.attachments ?? []).flatMap(
    (attachment): NonNullable<PiUserDisplay["attachments"]> => {
      const image =
        attachment.kind === "image" ||
        (attachment.mimeType ?? "").startsWith("image/");
      const preview = attachment.previewUrl ?? (image ? attachment.url : undefined);
      return [
        {
          kind: image ? "image" : "file",
          ...(attachment.name ? { name: attachment.name } : {}),
          ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
          ...(typeof attachment.size === "number" ? { size: attachment.size } : {}),
          ...(preview ? { url: preview } : {}),
          ...(attachment.path ? { path: attachment.path } : {}),
        },
      ];
    },
  );
  const context = {
    ...prepared.journalDisplayContext,
    ...(prepared.windowContextLabel ? { windowLabel: prepared.windowContextLabel } : {}),
    ...(prepared.browserUrl ? { browserUrl: prepared.browserUrl } : {}),
  };
  const display: PiUserDisplay = {
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(Object.keys(context).length > 0 ? { context } : {}),
  };
  return Object.keys(display).length > 0 ? display : undefined;
};

export const piUserContent = (
  payload: RuntimeChatPayload,
  prepared: PreparedChatInput,
): PiUserPart[] => {
  const parts: PiUserPart[] = [];
  if (prepared.visibleUserPrompt.trim()) {
    parts.push({ type: "text", text: prepared.visibleUserPrompt });
  }
  for (const message of prepared.runPromptMessages) {
    if (message.text.trim()) parts.push({ type: "text", text: message.text, stella: { hidden: true } });
  }
  const notice = attachmentNotice([
    ...prepared.modelImageAttachments,
    ...prepared.modelFileAttachments,
  ]);
  if (notice) parts.push({ type: "text", text: notice, stella: { hidden: true } });
  for (const attachment of prepared.modelImageAttachments) {
    const part = imagePart(attachment.url);
    if (part) parts.push(part);
  }
  if (prepared.modelWindowScreenshotAttachment) {
    const part = imagePart(prepared.modelWindowScreenshotAttachment.url);
    if (part) parts.push(part);
  }
  if (parts.length === 0) parts.push({ type: "text", text: "(empty message)", stella: { hidden: true } });
  const display = displayOf(payload, prepared);
  if (display) {
    const [first] = parts;
    parts[0] = { ...first!, stella: { ...(first as { stella?: object }).stella, display } } as PiUserPart;
  }
  return parts;
};
