/**
 * Companion — the floating desktop Stella that sits on top of every window.
 *
 * Shared between the Electron main process (window geometry, IPC payloads)
 * and the companion renderer (layout constants). The main process owns the
 * BrowserWindow; the full shell renderer is the brain that publishes
 * `CompanionState` and executes sends, so the companion window itself stays a
 * thin view with no chat runtime of its own.
 */

/** Edge length of the animated mark, in CSS px. */
export const COMPANION_MARK_SIZE = 84;

/**
 * Size of the mark window. Wide enough for the mark, its glow, and the
 * running-agent badge that overhangs its corner.
 */
export const COMPANION_COMPACT_SIZE = { width: 128, height: 128 } as const;

/**
 * Size of the panel window that carries the arc, composer, and bubbles. It
 * sits behind the mark window at a fixed size and is click-through until it
 * has something to show, so nothing ever resizes on hover.
 */
export const COMPANION_FULL_SIZE = { width: 400, height: 560 } as const;

/** Inset from the bottom edge of the window to the bottom of the mark. */
export const COMPANION_MARK_BOTTOM_INSET = 14;
/** Horizontal inset from the anchored side edge to the mark (compact box). */
export const COMPANION_MARK_SIDE_INSET =
  (COMPANION_COMPACT_SIZE.width - COMPANION_MARK_SIZE) / 2;
/** Inset from the top edge to the mark when the box grows downward. */
export const COMPANION_MARK_TOP_INSET =
  COMPANION_COMPACT_SIZE.height -
  COMPANION_MARK_SIZE -
  COMPANION_MARK_BOTTOM_INSET;

/** Which of the two companion windows a renderer is. */
export type CompanionWindowKind = "mark" | "panel";

/** Screen-space anchor: the center-bottom of the mark. */
export type CompanionAnchor = { x: number; y: number };

export type CompanionEdgeH = "left" | "right";
export type CompanionEdgeV = "top" | "bottom";

/**
 * Sent by main to each companion renderer once it says hello, and again
 * whenever the anchor's side of the screen changes. The panel box hangs from
 * the compact box's edges that face the nearer screen borders, so the panel
 * positions its content relative to those two edges.
 */
export type CompanionLayout = {
  kind: CompanionWindowKind;
  width: number;
  height: number;
  edgeH: CompanionEdgeH;
  edgeV: CompanionEdgeV;
};

/** Panel → main: what the panel is doing. */
export type CompanionPanelStatus = {
  expanded: boolean;
  recording: boolean;
  transcribing: boolean;
  /** Panel has content (composer, bubbles, recording) that must stay visible. */
  wantsVisible: boolean;
};

/** Main → both renderers: the combined interaction state. */
export type CompanionActivity = {
  hovered: boolean;
  /** Panel is interactive (hovered or wanted). */
  panelActive: boolean;
  expanded: boolean;
  recording: boolean;
  transcribing: boolean;
};

export type CompanionWorkState =
  | "thinking"
  | "working"
  | "writing"
  | "searching"
  | "reading";

export type CompanionMessagePreview = {
  id: string;
  /** Plain text (markdown stripped), whitespace-collapsed. */
  text: string;
  /** Message timestamp (ms epoch). */
  at: number;
};

/**
 * Snapshot published by the full shell renderer whenever the pieces the
 * companion cares about change. Kept deliberately small — it is diffed and
 * shipped over IPC ~10×/s while a reply streams.
 */
export type CompanionState = {
  conversationId: string | null;
  latestUser: CompanionMessagePreview | null;
  latestAssistant: (CompanionMessagePreview & { streaming: boolean }) | null;
  isStreaming: boolean;
  workState: CompanionWorkState | null;
  runningAgentCount: number;
  readAloudPlaying: boolean;
};

export const EMPTY_COMPANION_STATE: CompanionState = {
  conversationId: null,
  latestUser: null,
  latestAssistant: null,
  isStreaming: false,
  workState: null,
  runningAgentCount: 0,
  readAloudPlaying: false,
};

export type CompanionSendRequest = { text: string };

export type CompanionDragMove = {
  /** Cursor position in screen px. */
  screenX: number;
  screenY: number;
};

export type CompanionVisibility = { visible: boolean };
