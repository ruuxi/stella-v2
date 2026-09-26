import { useSyncExternalStore } from "react";
import type { AutomaticExecutionTarget } from "./execution-placement";
import type { StoredPhoneAccess } from "./phone-access";
import type {
  DesktopModelSnapshot,
  StellaCatalog,
} from "./desktop-model-prefs";
import type { ChatArtifact, MobileTask } from "../types";

/**
 * What the chat surface knows and the rest of the shell (sidebar, Files,
 * Settings) shows.
 *
 * The chat route owns the conversation thread and the paired-computer state,
 * but the surfaces that expose them are the `(main)` layout above it and the
 * sibling tab routes. The chat stays mounted under every tab, so a tiny
 * external store bridges them without threading props through the router:
 * the chat publishes, the others subscribe.
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

/** The paired computer and where turns run, for Settings' Computer section. */
export type ComputerControl = {
  /** Preferred paired computer; `null` while nothing is paired yet. */
  access: StoredPhoneAccess | null;
  pairedDesktops: StoredPhoneAccess[];
  platformLabel: string;
  statusLabel: string;
  statusAvailable: boolean | null;
  connecting: boolean;
  /** Show the inline "Wake up" affordance (computer asleep and not waking). */
  showWake: boolean;
  onWake: () => void;
  /** Bubble a freshly-paired computer up so the chat re-targets it. */
  onRepaired: (access: StoredPhoneAccess) => void;
  executionTarget: AutomaticExecutionTarget;
  onExecutionTargetChange: (target: AutomaticExecutionTarget) => void;
  /** The paired desktop's model, or `null` when its controls are hidden. */
  model: {
    label: string;
    catalog: StellaCatalog;
    onApplied: (snapshot: DesktopModelSnapshot) => void;
  } | null;
  composerModelPinned: boolean;
  onComposerModelPinnedChange: (next: boolean) => void;
};

/**
 * A route-owned replacement for the shell's top-left back control. A detail
 * route that stacks its own in-place view (an open workspace app on the Apps
 * route) publishes one so the single shell chevron unwinds that view first
 * instead of popping the route, and Android hardware back does the same.
 */
export type BackOverride = {
  /** Localized accessibility label for the chevron while the override holds. */
  label: string;
  onPress: () => void;
};

type ShellState = {
  activity: ActivityHubData | null;
  computer: ComputerControl | null;
  back: BackOverride | null;
};

const EMPTY_STATE: ShellState = {
  activity: null,
  computer: null,
  back: null,
};

let state: ShellState = EMPTY_STATE;
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

export function publishBackOverride(next: BackOverride | null): void {
  if (state.back === next) return;
  state = { ...state, back: next };
  emit();
}

const readBack = () => state.back;
export function useBackOverride(): BackOverride | null {
  return useSyncExternalStore(subscribe, readBack, readBack);
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
  state = EMPTY_STATE;
  listeners.clear();
  openRequestListeners.clear();
}
