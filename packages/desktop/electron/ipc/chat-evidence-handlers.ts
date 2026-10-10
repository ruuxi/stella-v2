import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { IPC_CHAT_EVIDENCE_CARDS } from "@stella/contracts/desktop/ipc-channels";
import type { EvidenceCardSet } from "@stella/contracts/chat-evidence";
import { createChatEvidenceService } from "../services/chat-evidence-service.js";
import { handleIpc } from "./typed-ipc.js";

const REQUEST_PATH_CAP = 40;

export const registerChatEvidenceHandlers = (options: {
  getStellaDataDir: () => string | null;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
}) => {
  const service = createChatEvidenceService({
    getStellaDataDir: options.getStellaDataDir,
  });

  handleIpc(
    IPC_CHAT_EVIDENCE_CARDS,
    async (
      event,
      payload?: { filePaths?: unknown },
    ): Promise<EvidenceCardSet> => {
      if (!options.assertPrivilegedSender(event, IPC_CHAT_EVIDENCE_CARDS)) {
        throw new Error("Blocked untrusted chat evidence request.");
      }
      const requested = Array.isArray(payload?.filePaths)
        ? payload.filePaths
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter((value) => value.length > 0)
            .slice(0, REQUEST_PATH_CAP)
        : [];
      if (requested.length === 0) return { cards: [], overflowCount: 0 };
      return await service.buildCardSet(requested);
    },
  );

  return service;
};
