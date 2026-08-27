import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";

type HandleHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown | Promise<unknown>;

type OnHandler = (event: IpcMainEvent, ...args: unknown[]) => void;

const handleHandlers = new Map<string, HandleHandler>();

const onHandlers = new Map<string, OnHandler[]>();

export const startCapturingHandlers = () => {
  const originalHandle = ipcMain.handle.bind(ipcMain);
  const originalOn = ipcMain.on.bind(ipcMain);

  ipcMain.handle = ((channel: string, listener: HandleHandler) => {
    handleHandlers.set(channel, listener);
    return originalHandle(channel, listener);
  }) as typeof ipcMain.handle;

  ipcMain.on = ((channel: string, listener: OnHandler) => {
    const existing = onHandlers.get(channel);
    if (existing) {
      existing.push(listener);
    } else {
      onHandlers.set(channel, [listener]);
    }
    return originalOn(channel, listener);
  }) as typeof ipcMain.on;

  return () => {
    ipcMain.handle = originalHandle;
    ipcMain.on = originalOn;
  };
};

export const getHandler = (channel: string): HandleHandler | undefined =>
  handleHandlers.get(channel);

export const getOnHandlers = (channel: string): OnHandler[] | undefined =>
  onHandlers.get(channel);
