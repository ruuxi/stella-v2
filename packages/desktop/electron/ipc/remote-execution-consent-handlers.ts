/**
 * This computer's answer to its own "accept work from your other devices?"
 * prompt.
 *
 * The question arrives from the owner gate on the runtime's presence socket
 * and is broadcast to the windows as `IPC_EXECUTION_REMOTE_REQUEST` (see the
 * host runner's `notifyRemoteExecutionRequest`). Nothing waits on the answer,
 * so this is an ordinary invoke rather than a held request: the dispatch that
 * asked was already refused with a retryable code, and agent work retries
 * while the prompt is up.
 */

import type { IpcMainInvokeEvent } from "electron";
import { IPC_EXECUTION_ANSWER_REMOTE_REQUEST } from "@stella/contracts/desktop/ipc-channels";
import { handleIpc } from "./typed-ipc.js";

type RemoteExecutionConsentOptions = {
  getStellaHostRunner: () => {
    answerRemoteExecutionRequest: (params: {
      allow: boolean;
    }) => Promise<{ allow: boolean }>;
  } | null;
  assertPrivilegedSender: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

export const registerRemoteExecutionConsentHandlers = (
  options: RemoteExecutionConsentOptions,
): void => {
  handleIpc(
    IPC_EXECUTION_ANSWER_REMOTE_REQUEST,
    async (event, payload: unknown) => {
      if (
        !options.assertPrivilegedSender(
          event,
          IPC_EXECUTION_ANSWER_REMOTE_REQUEST,
        )
      ) {
        throw new Error("Blocked untrusted request.");
      }
      const allow = Boolean(
        payload &&
          typeof payload === "object" &&
          (payload as { allow?: unknown }).allow === true,
      );
      const runner = options.getStellaHostRunner();
      if (!runner) {
        throw new Error("Stella's runtime is not running on this computer.");
      }
      // Declining is as load-bearing as allowing: it is a recorded answer, and
      // losing it would leave the device looking merely un-asked and get it
      // prompted again by the next attempt.
      return await runner.answerRemoteExecutionRequest({ allow });
    },
  );
};
