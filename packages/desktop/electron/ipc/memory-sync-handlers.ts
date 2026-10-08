import {
  IPC_MEMORY_SYNC_ERASE_LOCAL,
  IPC_MEMORY_SYNC_GET_STATUS,
  IPC_MEMORY_SYNC_NOW,
} from "@stella/contracts/desktop/ipc-channels";
import type { MemorySyncService } from "../services/memory-sync/memory-sync-service.js";
import {
  registerPrivilegedHandle,
  type PrivilegedIpcOptions,
} from "./privileged-ipc.js";

/** The renderer shows the memory sync and asks for a pass; main does the work. */
export const registerMemorySyncHandlers = (
  options: PrivilegedIpcOptions & { service: MemorySyncService },
): void => {
  registerPrivilegedHandle(options, IPC_MEMORY_SYNC_GET_STATUS, () =>
    options.service.getStatus(),
  );
  registerPrivilegedHandle(options, IPC_MEMORY_SYNC_NOW, () =>
    options.service.syncNow(),
  );
  registerPrivilegedHandle(options, IPC_MEMORY_SYNC_ERASE_LOCAL, () =>
    options.service.eraseLocal(),
  );
};
