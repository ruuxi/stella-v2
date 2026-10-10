import { shell, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { MeetingCaptureController } from "../services/meeting-capture-controller.js";
import { MeetingCaptureController as MeetingCaptureControllerCtor } from "../services/meeting-capture-controller.js";
import {
  IPC_MEETINGS_STATUS,
  IPC_MEETINGS_START,
  IPC_MEETINGS_PAUSE,
  IPC_MEETINGS_RESUME,
  IPC_MEETINGS_STOP,
  IPC_MEETINGS_OPEN_FOLDER,
} from "@stella/contracts/desktop/ipc-channels";
import { handleIpc } from "./typed-ipc.js";

export type MeetingCaptureHandlersOptions = {
  getStellaDataDir: () => string | null;
  getController: () => MeetingCaptureController | null;
  setController: (controller: MeetingCaptureController | null) => void;
  assertPrivilegedSender: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

const ensureController = (
  options: MeetingCaptureHandlersOptions,
): MeetingCaptureController | null => {
  const existing = options.getController();
  if (existing) return existing;
  const home = options.getStellaDataDir();
  if (!home) return null;
  const next = new MeetingCaptureControllerCtor(home);
  options.setController(next);
  return next;
};

export const registerMeetingCaptureHandlers = (
  options: MeetingCaptureHandlersOptions,
): void => {
  handleIpc(IPC_MEETINGS_STATUS, async (event) => {
    if (!options.assertPrivilegedSender(event, IPC_MEETINGS_STATUS)) {
      throw new Error("Blocked untrusted meetings:status request.");
    }
    const controller = ensureController(options);
    if (!controller) {
      return { available: false } as const;
    }
    return await controller.status();
  });

  handleIpc(
    IPC_MEETINGS_START,
    async (
      event,
      payload?: { sessionId?: string; segmentSeconds?: number },
    ) => {
      if (!options.assertPrivilegedSender(event, IPC_MEETINGS_START)) {
        throw new Error("Blocked untrusted meetings:start request.");
      }
      const controller = ensureController(options);
      if (!controller) {
        return { ok: false, reason: "no-stella-home" } as const;
      }
      return await controller.start({
        sessionId: payload?.sessionId,
        segmentSeconds: payload?.segmentSeconds,
      });
    },
  );

  handleIpc(IPC_MEETINGS_PAUSE, async (event) => {
    if (!options.assertPrivilegedSender(event, IPC_MEETINGS_PAUSE)) {
      throw new Error("Blocked untrusted meetings:pause request.");
    }
    const controller = ensureController(options);
    if (!controller) return { ok: false } as const;
    return { ok: await controller.pause() } as const;
  });

  handleIpc(IPC_MEETINGS_RESUME, async (event) => {
    if (!options.assertPrivilegedSender(event, IPC_MEETINGS_RESUME)) {
      throw new Error("Blocked untrusted meetings:resume request.");
    }
    const controller = ensureController(options);
    if (!controller) return { ok: false } as const;
    return { ok: await controller.resume() } as const;
  });

  handleIpc(IPC_MEETINGS_STOP, async (event) => {
    if (!options.assertPrivilegedSender(event, IPC_MEETINGS_STOP)) {
      throw new Error("Blocked untrusted meetings:stop request.");
    }
    const controller = ensureController(options);
    if (!controller) {
      return { ok: false, reason: "no-stella-home" } as const;
    }
    return await controller.stop();
  });

  handleIpc(
    IPC_MEETINGS_OPEN_FOLDER,
    async (event, payload?: { sessionId?: string }) => {
      if (!options.assertPrivilegedSender(event, IPC_MEETINGS_OPEN_FOLDER)) {
        throw new Error("Blocked untrusted meetings:openFolder request.");
      }
      const home = options.getStellaDataDir();
      if (!home) return { ok: false } as const;
      const dir = payload?.sessionId
        ? path.join(home, "meetings", payload.sessionId)
        : path.join(home, "meetings");
      try {
        await fs.mkdir(dir, { recursive: true });
      } catch {
        // best-effort
      }
      shell.openPath(dir);
      return { ok: true } as const;
    },
  );
};
