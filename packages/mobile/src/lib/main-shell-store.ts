import { useSyncExternalStore } from "react";
import type { NativeMenuItem } from "../components/NativeMenu.types";
import type { StoredPhoneAccess } from "./phone-access";
import type { DesktopConnection } from "./top-bar-status";
import type { ChatArtifact, MobileTask } from "../types";

/**
 * What the chat surface knows and the shell chrome (top bar, sidebar) shows.
 *
 * The chat route owns the conversation thread and the paired-computer state,
 * but the buttons that expose them live in the `(main)` layout above it. A
 * tiny external store bridges the two without threading props through the
 * router: the chat publishes, the chrome subscribes.
 */
export type ActivityHubData = {
  /** Background tasks in the conversation (running + settled). */
  tasks: MobileTask[];
  /** Artifacts in the conversation, newest first. */
  artifacts: ChatArtifact[];
  /** Exact desktop-style agent/thread ownership for nested files. */
  artifactsByTaskId: ReadonlyMap<string, ChatArtifact[]>;
  /** Direct orchestrator artifacts owned by the main conversation thread. */
  conversationArtifacts: ChatArtifact[];
  /** Desktop pairing used to load artifact contents for the viewer. */
  access: StoredPhoneAccess | null;
};

export type ComputerControl = {
  /** `null` while nothing is paired yet: the button then starts pairing. */
  connection: DesktopConnection | null;
  /** Localized accessibility label for the current state. */
  label: string;
  onPress: () => void;
};

export type HistoryControl = {
  disabled: boolean;
  onPress: () => void;
  items: NativeMenuItem[];
};

type ShellState = {
  activity: ActivityHubData | null;
  computer: ComputerControl | null;
  history: HistoryControl | null;
};

let state: ShellState = { activity: null, computer: null, history: null };
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function publishActivityHub(next: ActivityHubData | null): void {
  if (state.activity === next) return;
  state = { ...state, activity: next };
  emit();
}

export function publishComputerControl(next: ComputerControl | null): void {
  if (state.computer === next) return;
  state = { ...state, computer: next };
  emit();
}

export function publishHistoryControl(next: HistoryControl | null): void {
  if (state.history === next) return;
  state = { ...state, history: next };
  emit();
}

const readHistory = () => state.history;
export function useHistoryControl(): HistoryControl | null {
  return useSyncExternalStore(subscribe, readHistory, readHistory);
}

const readActivity = () => state.activity;
const readComputer = () => state.computer;

export function useActivityHub(): ActivityHubData | null {
  return useSyncExternalStore(subscribe, readActivity, readActivity);
}

export function useComputerControl(): ComputerControl | null {
  return useSyncExternalStore(subscribe, readComputer, readComputer);
}

/** Current snapshot, for tests and non-React callers. */
export function readMainShellState(): ShellState {
  return state;
}

// ---------------------------------------------------------------------------
// Sidebar open requests: the running-tasks pill in the chat asks the layout to
// reveal the sidebar, where the activity now lives.

const openRequestListeners = new Set<() => void>();

export function requestOpenSidebar(): void {
  for (const listener of openRequestListeners) listener();
}

export function subscribeSidebarOpenRequests(listener: () => void): () => void {
  openRequestListeners.add(listener);
  return () => {
    openRequestListeners.delete(listener);
  };
}

/** Test hook: drop every subscriber and published value. */
export function resetMainShellStore(): void {
  state = { activity: null, computer: null, history: null };
  listeners.clear();
  openRequestListeners.clear();
}
