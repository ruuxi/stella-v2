/**
 * Global open/close state for the Settings dialog.
 *
 * A store because Settings is opened from several places — the gear button
 * in either top bar and the "Open settings" toast CTA — while the dialog
 * itself is hosted once in the root chrome (`SettingsDialogHost`), so two
 * mounted gear buttons never produce two dialogs.
 */
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
