/**
 * Global open/close state for the feedback dialog.
 *
 * A store (rather than local trigger state) because feedback is opened from
 * two places: the footer trigger in the Home section, and the periodic
 * auto-prompt in `ShellTopBarAccount`. The dialog itself is hosted by
 * `SidebarUtilityControls`, which stays mounted for the life of the panel.
 */
import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export const feedbackDialog = {
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

export const useFeedbackDialogOpen = () =>
  useSyncExternalStore(
    subscribe,
    () => open,
    () => false,
  );
