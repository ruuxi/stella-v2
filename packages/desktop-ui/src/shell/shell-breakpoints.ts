/**
 * Width thresholds at which the shell changes presentation.
 *
 * One threshold is left. The auto-hide width for the standalone activity
 * surface went with that surface — activity now lives in the top bar, which
 * costs no width at any size.
 */

import { useSyncExternalStore } from "react";

const SHELL_DISPLAY_PANEL_TAKEOVER_WIDTH = 720;

export type ShellBreakpointState = {
  displayPanelTakeover: boolean;
};

export const getShellBreakpointState = (
  width: number,
): ShellBreakpointState => ({
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
): boolean => left.displayPanelTakeover === right.displayPanelTakeover;

/**
 * RootChrome owns the ResizeObserver because it measures the actual shell,
 * not the browser viewport. The tiny store lets composer chrome consume that
 * same resolved state without installing a second observer or duplicating the
 * breakpoint constants.
 */
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
