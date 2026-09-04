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
 * Window size while nothing but the mark is showing. Wide enough for the
 * mark, its glow, and the running-agent badge that overhangs its corner.
 */
export const COMPANION_COMPACT_SIZE = { width: 128, height: 128 } as const;

/**
 * Window size when the companion is hovered, expanded (composer open), or
 * showing message bubbles. The mark stays anchored at the same screen point;
 * everything else stacks upward from it.
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

export type CompanionLayoutMode = "compact" | "full";

/** Screen-space anchor: the center-bottom of the mark. */
export type CompanionAnchor = { x: number; y: number };

export type CompanionEdgeH = "left" | "right";
export type CompanionEdgeV = "top" | "bottom";

/**
 * How the window grows around the mark. The full box always keeps one
 * horizontal and one vertical edge of the compact box fixed (the edges nearer
 * the screen border), so the mark — positioned in CSS relative to those two
 * edges — never moves on screen while the window resizes, regardless of when
 * this message lands relative to the resize.
 */
export type CompanionLayout = {
  mode: CompanionLayoutMode;
  width: number;
  height: number;
  edgeH: CompanionEdgeH;
  edgeV: CompanionEdgeV;
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
