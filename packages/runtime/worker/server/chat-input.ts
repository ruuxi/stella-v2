/**
 * What a desktop chat send gives the model, prepared off the UI thread:
 * composer images validated, sized to the target provider and spilled to
 * disk when over budget; file attachments materialized as local files; the
 * chat context (window, selection, browser, pasted text) as hidden prompt
 * messages; the window screenshot. Both runtimes start from it: the agent
 * loops (`agent-runs.ts`) and the pi-durable chat (`pi-chats.ts`).
 */
import type {
  RuntimeChatPayload,
  RuntimePromptMessage,
} from "@stella/contracts/protocol";
import type { ImageCapTarget } from "../../kernel/shared/image-caps.js";
import {
  approximateDataUrlBytes,
  attachPersistedImagePaths,
  buildSpilledAttachmentNotice,
  dataUrlBase64Length,
  INLINE_IMAGE_ATTACHMENT_BUDGET_BYTES,
  MAX_INLINE_IMAGE_BASE64_BYTES,
  spillImageAttachmentsToDisk,
  type SpilledImageAttachment,
} from "../chat-attachment-spill.js";
import {
  materializeFileAttachments,
  materializeImageAttachments,
} from "./attachments.js";

export const prepareChatInput = async (
  payload: RuntimeChatPayload,
  options: {
    stellaDataDirPath: string;
    /** The provider/model the turn will run on, so images fit its limits. */
    resolveImageTarget: () => Promise<ImageCapTarget | undefined>;
  },
) => {
  // Resolve the provider/model this turn will run on so composer images
  // are sized to that provider's real limits (best-effort; falls back to
  // the safe conservative profile when no route resolves).
  let composerImageTarget: ImageCapTarget | undefined;
  try {
    composerImageTarget = await options.resolveImageTarget();
  } catch {
    composerImageTarget = undefined;
  }
  const materializedImageAttachments = await materializeImageAttachments(
    payload.attachments,
    composerImageTarget,
  );
  const modelFileAttachments = await materializeFileAttachments({
    attachments: payload.attachments,
    stellaDataDirPath: options.stellaDataDirPath,
    conversationId: payload.conversationId,
  });
  let modelImageAttachments = materializedImageAttachments.map(
    ({ attachment }) => attachment,
  );
  let persistedImageAttachments: SpilledImageAttachment[] = [];
  if (modelImageAttachments.length > 0) {
    persistedImageAttachments = await spillImageAttachmentsToDisk({
      stellaDataDirPath: options.stellaDataDirPath,
      conversationId: payload.conversationId,
      attachments: modelImageAttachments,
    });
    modelImageAttachments = attachPersistedImagePaths(
      modelImageAttachments,
      persistedImageAttachments,
    );
  }
  const totalInlineImageBytes = modelImageAttachments.reduce(
    (total, attachment) => total + approximateDataUrlBytes(attachment.url),
    0,
  );
  let spilledImageAttachments: SpilledImageAttachment[] = [];
  const hasOverCapInlineImage = modelImageAttachments.some(
    (attachment) =>
      dataUrlBase64Length(attachment.url) > MAX_INLINE_IMAGE_BASE64_BYTES,
  );
  if (
    totalInlineImageBytes > INLINE_IMAGE_ATTACHMENT_BUDGET_BYTES ||
    hasOverCapInlineImage
  ) {
    spilledImageAttachments = persistedImageAttachments;
    modelImageAttachments = [];
  }
  const { buildChatPromptMessages } = await import("../../kernel/chat-prompt-context.js");
  const {
    visibleUserPrompt,
    windowContextLabel,
    browserUrl,
    appSelectionLabel,
    appSelectionLabels,
    activityLabel,
    quotedText,
    pastedTexts,
    promptMessages,
    windowScreenshotAttachment,
  } = buildChatPromptMessages({
    userPrompt: payload.userPrompt,
    selectedText:
      payload.selectedText ?? payload.chatContext?.selectedText ?? null,
    chatContext: payload.chatContext ?? null,
    explicitImageAttachmentCount: modelImageAttachments.length,
  });
  const journalDisplayContext = {
    ...(appSelectionLabel ? { appSelectionLabel } : {}),
    ...(appSelectionLabels?.length ? { appSelectionLabels } : {}),
    ...(activityLabel ? { activityLabel } : {}),
    ...(quotedText ? { quotedText } : {}),
    ...(pastedTexts?.length ? { pastedTexts } : {}),
  };
  const userMessageMetadata =
    Object.keys(journalDisplayContext).length > 0
      ? { context: journalDisplayContext }
      : undefined;
  let modelWindowScreenshotAttachment = windowScreenshotAttachment;
  if (modelWindowScreenshotAttachment) {
    const persistedWindowScreenshot = await spillImageAttachmentsToDisk({
      stellaDataDirPath: options.stellaDataDirPath,
      conversationId: payload.conversationId,
      attachments: [modelWindowScreenshotAttachment],
    });
    [modelWindowScreenshotAttachment] = attachPersistedImagePaths(
      [modelWindowScreenshotAttachment],
      persistedWindowScreenshot,
    );
  }
  const runPromptMessages: RuntimePromptMessage[] = [
    ...(promptMessages ?? []),
    ...(spilledImageAttachments.length > 0
      ? [
          {
            text: buildSpilledAttachmentNotice(spilledImageAttachments),
            uiVisibility: "hidden" as const,
            messageType: "message" as const,
            customType: "runtime.chat_context",
          },
        ]
      : []),
  ];
  const mergedAttachments = [
    ...modelImageAttachments,
    ...modelFileAttachments,
    ...(modelWindowScreenshotAttachment
      ? [modelWindowScreenshotAttachment]
      : []),
  ];
  return {
    visibleUserPrompt,
    windowContextLabel,
    browserUrl,
    appSelectionLabel,
    activityLabel,
    journalDisplayContext,
    userMessageMetadata,
    windowScreenshotAttachment,
    modelImageAttachments,
    modelFileAttachments,
    modelWindowScreenshotAttachment,
    spilledImageAttachments,
    totalInlineImageBytes,
    runPromptMessages,
    mergedAttachments,
  };
};

export type PreparedChatInput = Awaited<ReturnType<typeof prepareChatInput>>;
