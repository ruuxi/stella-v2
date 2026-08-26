import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { MOBILE_BRIDGE_FEATURES } from "../services/mobile-bridge/capabilities.js";
import { selectedCloudConversationId } from "../cloud-conversation-mode.js";
import { assertPrivilegedRequest } from "./privileged-ipc.js";

const DEVELOPER_RESOURCE_PREVIEWS_KEY = "stella-developer-resource-previews";
const CLOUD_CONVERSATION_WAIT_MS = 5_000;
const CLOUD_CONVERSATION_POLL_MS = 25;

export const IPC_MOBILE_HELLO = "mobile:hello" as const;

type ConversationWaitOptions = {
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
};

type MobileHelloHandlersOptions = {
  /** Active conversation id from renderer UI state (may be empty pre-boot). */
  getActiveConversationId: () => string | null | undefined;
  /** Renderer localStorage mirror (ui-state KV snapshot). */
  getUiStateSnapshot: () => Record<string, string>;
  assertPrivilegedSender: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
  /** Test seam for the short renderer/cloud-selection startup race. */
  conversationWait?: ConversationWaitOptions;
};

export type MobileHelloPayload = {
  expectedConversationId?: string | null;
  sinceCursor?: string | null;
  maxMessages?: number;
  negotiateOnly?: boolean;
};

export const waitForSelectedCloudConversation = async (
  getActiveConversationId: () => string | null | undefined,
  options: ConversationWaitOptions = {},
): Promise<string> => {
  const timeoutMs = Math.max(
    0,
    options.timeoutMs ?? CLOUD_CONVERSATION_WAIT_MS,
  );
  const pollMs = Math.max(1, options.pollMs ?? CLOUD_CONVERSATION_POLL_MS);
  const sleep =
    options.sleep ??
    ((delayMs: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      }));
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const conversationId = selectedCloudConversationId(
      getActiveConversationId(),
    );
    if (conversationId) return conversationId;
    if (Date.now() >= deadline) {
      throw new Error(
        "The cloud conversation is still loading. Try connecting again.",
      );
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
};

export const runMobileHello = async (
  options: Pick<
    MobileHelloHandlersOptions,
    "getActiveConversationId" | "getUiStateSnapshot" | "conversationWait"
  >,
  payload?: MobileHelloPayload,
) => {
  const conversationId = await waitForSelectedCloudConversation(
    options.getActiveConversationId,
    options.conversationWait,
  );

  const developerArtifactsEnabled =
    options.getUiStateSnapshot()[DEVELOPER_RESOURCE_PREVIEWS_KEY] === "true";
  const expected = payload?.expectedConversationId?.trim() || null;
  const conversationChanged = Boolean(expected && expected !== conversationId);
  const sinceCursor = conversationChanged
    ? null
    : (payload?.sinceCursor ?? null);
  if (payload?.negotiateOnly !== true) {
    throw new Error(
      "Mobile transcript history is cloud-owned and must be loaded from the cloud conversation API.",
    );
  }

  return {
    conversationId,
    conversationChanged,
    developerArtifactsEnabled,
    features: [...MOBILE_BRIDGE_FEATURES],
    historyAuthority: "cloud" as const,
    historyAvailableFromDesktopBridge: false as const,
    messages: [],
    cursor: sinceCursor,
  };
};

/**
 * One-RTT connect endpoint for the mobile bridge. Folds what used to take
 * four serialized round-trips from the phone — `/bridge/bootstrap` (developer
 * artifacts flag) and `ui:getState` (cloud-selected conversation id) into a
 * single negotiation invoke. Canonical transcript history is deliberately not
 * returned here: the phone reads the cloud conversation directly, while this
 * desktop bridge remains available for local operational activity and files.
 *
 * Additive: phones that predate it keep the multi-RTT path; phones that call
 * it against an older desktop get "Unknown IPC channel"/"Disallowed IPC
 * channel" and fall back.
 */
export const registerMobileHelloHandlers = (
  options: MobileHelloHandlersOptions,
) => {
  ipcMain.handle(
    IPC_MOBILE_HELLO,
    async (event, payload?: MobileHelloPayload) => {
      assertPrivilegedRequest(options, event, IPC_MOBILE_HELLO);
      return runMobileHello(options, payload);
    },
  );
};
