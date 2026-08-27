import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export const settingsDialog = {
  open() {
    if (open) return;
    open = true;
    emit();
  },
  close() {
    if (!open) return;
    open = false;
    emit();
  },
  setOpen(next: boolean) {
    if (next) this.open();
    else this.close();
  },
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useSettingsDialogOpen = () =>
  useSyncExternalStore(
    subscribe,
    () => open,
    () => false,
  );
