import { useSyncExternalStore } from "react";

const SHELL_WORKSPACE_STRIP_AUTO_HIDE_WIDTH = 1120;
const SHELL_DISPLAY_PANEL_TAKEOVER_WIDTH = 720;

export type ShellBreakpointState = {
  hideWorkspaceStrip: boolean;
  displayPanelTakeover: boolean;
};

export const getShellBreakpointState = (
  width: number,
): ShellBreakpointState => ({
  hideWorkspaceStrip:
    width > 0 && width <= SHELL_WORKSPACE_STRIP_AUTO_HIDE_WIDTH,
  displayPanelTakeover:
    width > 0 && width <= SHELL_DISPLAY_PANEL_TAKEOVER_WIDTH,
});

let snapshot = getShellBreakpointState(
  typeof window === "undefined" ? 0 : window.innerWidth,
);
const listeners = new Set<() => void>();

const sameBreakpointState = (
  left: ShellBreakpointState,
  right: ShellBreakpointState,
): boolean =>
  left.hideWorkspaceStrip === right.hideWorkspaceStrip &&
  left.displayPanelTakeover === right.displayPanelTakeover;

export const shellBreakpointStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): ShellBreakpointState {
    return snapshot;
  },
  setWidth(width: number): void {
    const next = getShellBreakpointState(Math.round(width));
    if (sameBreakpointState(snapshot, next)) return;
    snapshot = next;
    for (const listener of listeners) listener();
  },
};

export const useShellBreakpointState = (): ShellBreakpointState =>
  useSyncExternalStore(
    shellBreakpointStore.subscribe,
    shellBreakpointStore.getSnapshot,
    shellBreakpointStore.getSnapshot,
  );
