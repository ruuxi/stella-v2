import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  computeSnapshotDiff,
  formatStateDiffBlock,
  shouldUseDiffOnly,
  type StateDiff,
  type StateDiffTarget,
} from "../../cli/stella-computer-state-diff.js";
import {
  writeComputerStderr,
  writeComputerStdout,
} from "../execution-context.js";
import { formatScreenshotMarker as formatAttachImageMarker } from "../session-fs.js";

// Rendering of desktop_automation payloads: the accessibility tree and
// <app_state> block, the state ids derived from them, and the CLI's
// human-readable output for snapshots, actions, app/window lists and errors.

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Screenshot = {
  mimeType: string;
  data: string;
  path?: string | null;
  widthPx?: number | null;
  heightPx?: number | null;
  byteCount?: number | null;
  captureMethod?: string | null;
  exactWindowMatch?: boolean | null;
  occludedRectFallback?: boolean | null;
  treeRevision?: number | null;
  reliableFinalFrame?: boolean | null;
};

export type SnapshotNode = {
  index?: number | null;
  ref?: string | null;
  role: string;
  subrole?: string | null;
  title?: string | null;
  description?: string | null;
  value?: string | null;
  valueType?: string | null;
  settable?: boolean | null;
  details?: string | null;
  help?: string | null;
  identifier?: string | null;
  url?: string | null;
  enabled?: boolean | null;
  focused?: boolean | null;
  selected?: boolean | null;
  expanded?: boolean | null;
  placeholder?: string | null;
  frame?: Rect | null;
  actions: string[];
  children: SnapshotNode[];
};

type OverlayEntry = {
  frame?: Rect | null;
};

export type SnapshotDocument = {
  ok: boolean;
  appName: string;
  bundleId?: string | null;
  pid: number;
  windowTitle?: string | null;
  windowFrame?: Rect | null;
  windowId?: number | null;
  nodeCount: number;
  refCount: number;
  refs?: Record<string, OverlayEntry> | null;
  indices?: Record<string, OverlayEntry> | null;
  warnings: string[];
  screenshotPath?: string | null;
  screenshot?: Screenshot | null;
  appInstructions?: string | null;
  selectedText?: string | null;
  focusedSummary?: string | null;
  nodes: SnapshotNode[];
  capturedAt?: string | null;
  maxDepth?: number | null;
  maxNodes?: number | null;
  allWindows?: boolean | null;
  revision?: number | null;
  materializedRevision?: number | null;
  cacheHit?: boolean | null;
  pendingActionCount?: number | null;
  screenshotPolicy?: string | null;
  settle?: AutomationSettle | null;
};

export type ActionPayload = {
  ok: boolean;
  action: string;
  ref?: string | null;
  message: string;
  matchedRef?: string | null;
  usedAction?: string | null;
  warnings: string[];
  screenshotPath?: string | null;
  screenshot?: Screenshot | null;
  appInstructions?: string | null;
  snapshotText?: string | null;
  settle?: AutomationSettle | null;
  receipt?: {
    id: string;
    baselineRevision: number;
    invalidatedRevision: number;
    deferred: boolean;
  } | null;
  revision?: number | null;
  deferred?: boolean | null;
  stateUpdated?: boolean | null;
};

export type AutomationSettle = {
  observed: boolean;
  quietMs: number;
  waitedMs: number;
  eventCount: number;
  timedOut: boolean;
  reason?: string | null;
  lastEventAt?: string | null;
  baselineRevision?: number | null;
  finalRevision?: number | null;
  pendingActionCount?: number | null;
  dirtyElementCount?: number | null;
  dirtyScopes?: string[] | null;
};

export type ListedAppPayload = {
  name: string;
  bundleId?: string | null;
  pid: number;
  activationPolicy: string;
  isRunning?: boolean | null;
  isActive: boolean;
  // Spotlight-tracked usage data populated by the desktop_automation
  // daemon. Either or both can be null when the bundle isn't indexed
  // (sandboxed apps without read perms, network-mounted bundles, etc.).
  lastUsedDate?: string | null;
  useCount?: number | null;
};

export type ListAppsPayload = {
  ok: boolean;
  apps: ListedAppPayload[];
  warnings: string[];
};

export type ListWindowsPayload = {
  ok: boolean;
  windows: Array<{
    appName: string;
    bundleId?: string | null;
    pid: number;
    windowId: number;
    title?: string | null;
    frame: Rect;
    isActive: boolean;
  }>;
  warnings: string[];
};

export type ErrorPayload = {
  ok: boolean;
  error: string;
  warnings?: string[];
  screenshotPath?: string | null;
  screenshot?: Screenshot | null;
};

const truncate = (value: string | null | undefined, limit = 80) => {
  if (!value) {
    return "";
  }
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
};

const ACTIONS_TO_HIDE = new Set([
  "AXPress",
  "AXShowMenu",
  "AXScrollToVisible",
  "AXIncrement",
  "AXDecrement",
  "AXRaise",
  // AppKit table/outline rows expose Show Default UI / Show Alternate UI
  // alongside the user-meaningful AX actions. They flip an internal styling
  // pair and are not actuatable affordances; surface only the real actions
  // (e.g. swipe-to-Read on Mail message rows).
  "AXShowDefaultUI",
  "AXShowAlternateUI",
]);

const ROLES_WITH_VISIBLE_SETTABLE_STATE = new Set([
  "AXCell",
  "AXCheckBox",
  "AXComboBox",
  "AXGenericElement",
  "AXGroup",
  "AXPopUpButton",
  "AXRadioButton",
  "AXSearchField",
  "AXSecureTextField",
  "AXSlider",
  "AXSplitGroup",
  "AXSplitter",
  "AXSwitch",
  "AXTextArea",
  "AXTextField",
  "AXUnknown",
  "AXWebArea",
]);

// Subrole-aware names for buttons so the model can tell window controls apart
// instead of seeing a row of identical "button" entries.
// Mirrors the role labels used by macOS desktop-automation renderers.
const BUTTON_SUBROLE_LABELS: Record<string, string> = {
  AXCloseButton: "close button",
  AXMinimizeButton: "minimize button",
  AXZoomButton: "full screen button",
  AXFullScreenButton: "full screen button",
  AXToolbarButton: "toolbar button",
  AXSortButton: "sort button",
  AXIncrementor: "incrementor button",
  AXDecrementor: "decrementor button",
};

const formatUrlLike = (value: string) => value.replace(/^https?:\/\//, "");

const escapeMarkdownLinkText = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");

const humanActionName = (action: string) => {
  const trimmed = action.startsWith("AX") ? action.slice(2) : action;
  return trimmed.replace(/([a-z])([A-Z])/g, "$1 $2");
};

const humanRole = (node: Pick<SnapshotNode, "role" | "subrole">): string => {
  switch (node.role) {
    case "AXWindow":
      return node.subrole === "AXStandardWindow" ? "standard window" : "window";
    case "AXWebArea":
      return "HTML content";
    case "AXGroup":
    case "AXGenericElement":
    case "AXUnknown":
    case "AXSplitGroup":
      return "container";
    case "AXStaticText":
      return "text";
    case "AXCheckBox":
      return node.subrole === "AXSwitch" ? "switch" : "checkbox";
    case "AXList":
      return "list box";
    case "AXButton":
      return (node.subrole && BUTTON_SUBROLE_LABELS[node.subrole]) || "button";
    default: {
      const trimmed = node.role.startsWith("AX")
        ? node.role.slice(2)
        : node.role;
      return trimmed.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    }
  }
};

const secondaryActions = (actions: string[]) =>
  actions
    .filter((action) => !ACTIONS_TO_HIDE.has(action))
    .map((action) => humanActionName(action));

const displayValue = (node: SnapshotNode) => {
  if (!node.value) return null;
  if (node.subrole === "AXSwitch" && inferredValueType(node) === "boolean") {
    if (node.value === "1") return "on";
    if (node.value === "0") return "off";
  }
  return node.value;
};

const shouldSurfaceSettable = (node: SnapshotNode) =>
  !!node.settable &&
  (ROLES_WITH_VISIBLE_SETTABLE_STATE.has(node.role) ||
    node.subrole === "AXSwitch" ||
    !!node.value);

const inferredValueType = (node: SnapshotNode) => {
  if (node.role === "AXSlider") return "float";
  if (node.subrole === "AXSwitch") return "boolean";
  if (node.valueType && node.valueType !== "error") return node.valueType;
  if (!shouldSurfaceSettable(node)) return null;
  return "string";
};

const choosePrimaryLabel = (node: SnapshotNode) => {
  if (node.title) return node.title;
  if (node.role === "AXStaticText" && node.value) return node.value;
  if (
    (node.role === "AXButton" ||
      node.role === "AXComboBox" ||
      node.role === "AXMenuItem" ||
      node.role === "AXRow" ||
      node.role === "AXWindow" ||
      node.role === "AXGroup" ||
      node.role === "AXGenericElement" ||
      node.role === "AXHeading" ||
      node.role === "AXList" ||
      // Brave/Chrome/Safari toolbar dropdowns (Brave Shields, Wallet, VPN,
      // Extensions, profile picker, address-bar lock icon) and AppKit
      // window-resize splitters all carry their human-readable label on
      // AXDescription. Without surfacing it, browser/window chrome reads
      // as a row of unnamed `(settable, string)` placeholders.
      node.role === "AXPopUpButton" ||
      node.role === "AXMenuButton" ||
      node.role === "AXSplitter" ||
      node.role === "AXWebArea") &&
    node.description
  ) {
    return node.description;
  }
  // AppKit outline rows leave their description on a child AXCell. When the
  // row has exactly one AXCell child whose description is the only label
  // available, present that description as the row's own primary label so
  // sidebars (Mail mailboxes, Finder source list, Notes accounts, etc.)
  // surface readable names like "Inbox" / "Junk" instead of bare "row".
  if (
    node.role === "AXRow" &&
    node.children.length === 1 &&
    node.children[0]?.role === "AXCell" &&
    node.children[0].description
  ) {
    return node.children[0].description;
  }
  if (!node.title && !node.description && node.value) return node.value;
  return null;
};

const primaryLabelForLine = (
  node: SnapshotNode,
  primaryLabel: string | null,
) => {
  if (node.role !== "AXLink" || !node.url || !primaryLabel) {
    return primaryLabel;
  }
  if (primaryLabel === node.url) {
    return primaryLabel;
  }
  return `[${escapeMarkdownLinkText(primaryLabel)}](${node.url})`;
};

const annotationSegment = (node: SnapshotNode) => {
  const flags: string[] = [];
  if (node.enabled === false) flags.push("disabled");
  if (node.selected) flags.push("selected");
  // AppKit's outline/table cells inherit the parent table's focus bit, so
  // every cell in a focused table reports `focused=true`. That tells the
  // model nothing useful about which element actually has keyboard focus.
  // Suppress the flag for cells; meaningful focus on a cell's text field
  // child still surfaces normally.
  if (node.focused && node.role !== "AXCell") flags.push("focused");
  // Outline rows + disclosure groups expose AXExpanded so the model can
  // tell whether sidebars/sections (Mail Favorites/Smart Mailboxes,
  // Finder source list, Notes accounts) are open or collapsed before
  // deciding whether to actuate the disclosure triangle.
  if (node.expanded === true) flags.push("expanded");
  else if (node.expanded === false) flags.push("collapsed");
  if (shouldSurfaceSettable(node)) {
    flags.push("settable");
    const valueType = inferredValueType(node);
    if (valueType) flags.push(valueType);
  }
  return flags.length > 0 ? ` (${flags.join(", ")})` : "";
};

// Internal AppKit selector identifiers (e.g. `_NS:355`, `_recentItemRequested:`)
// are pure noise to the agent: not stable across builds, never useful for
// targeting (the numeric ID already addresses the element). Hide them.
const isInternalAppKitIdentifier = (identifier: string) =>
  /^_[A-Za-z0-9_]+:?$/.test(identifier);

// Cancel/Pick are present on every menu/menu-item via the AX API. They're
// universal noise — surfacing them on every menu line would balloon the
// snapshot without giving the agent any new affordance.
const filterMenuActions = (actions: string[], role: string) =>
  role === "AXMenuItem" || role === "AXMenuBarItem" || role === "AXMenu"
    ? actions.filter((action) => action !== "AXCancel" && action !== "AXPick")
    : actions;

// Container roles that may be skipped from the rendered tree when the node
// adds no information of its own. Their children re-attach at the parent's
// depth so the model sees one tight tree instead of a deep stack of empty
// `container` lines (e.g. web-area wrapper chains).
const COLLAPSIBLE_CONTAINER_ROLES = new Set([
  "AXGroup",
  "AXGenericElement",
  "AXUnknown",
  "AXSplitGroup",
]);

export const formatNodeLines = (node: SnapshotNode, depth = 0): string[] => {
  const indent = "\t".repeat(depth);
  const id =
    typeof node.index === "number" && Number.isFinite(node.index)
      ? String(node.index)
      : (node.ref ?? "_");

  // Menu bar items are globally positioned app chrome, not the target window
  // content. Hiding them prevents the agent from opening menus while trying
  // to act on visible app UI.
  if (node.role === "AXMenuBarItem") {
    return [];
  }

  const role = humanRole(node);
  const rawPrimaryLabel = choosePrimaryLabel(node);
  const primaryLabel = primaryLabelForLine(node, rawPrimaryLabel);
  const extras: string[] = [];

  if (
    node.description &&
    node.description !== rawPrimaryLabel &&
    node.description !== primaryLabel &&
    (node.role === "AXLink" ||
      node.role === "AXCheckBox" ||
      node.subrole === "AXSwitch" ||
      // Browser/Mail/Notes address-bar style fields name themselves on
      // AXDescription ("Address and search bar", "Search field", "To:",
      // "Subject:"). The value attribute carries the typed text, so
      // surface description as a separate prefix rather than collapsing
      // it into the primary label.
      node.role === "AXTextField" ||
      node.role === "AXSearchField" ||
      node.role === "AXSecureTextField" ||
      node.role === "AXTextArea")
  ) {
    extras.push(`Description: ${truncate(node.description, 120)}`);
  }

  const renderedValue = displayValue(node);
  if (
    renderedValue &&
    renderedValue !== rawPrimaryLabel &&
    renderedValue !== primaryLabel
  ) {
    extras.push(`Value: ${truncate(renderedValue, 120)}`);
  }

  if (
    node.details &&
    node.details !== primaryLabel &&
    node.details !== renderedValue
  ) {
    extras.push(`Details: ${truncate(node.details, 120)}`);
  }

  if (node.help && node.help !== primaryLabel) {
    extras.push(`Help: ${truncate(node.help, 120)}`);
  }

  if (
    node.identifier &&
    node.identifier !== rawPrimaryLabel &&
    node.identifier !== primaryLabel &&
    node.identifier !== node.description &&
    node.identifier !== node.value &&
    !isInternalAppKitIdentifier(node.identifier)
  ) {
    extras.push(`ID: ${truncate(node.identifier, 120)}`);
  }

  if (node.url) {
    const renderedUrl = truncate(formatUrlLike(node.url), 100);
    if (node.role === "AXLink" && primaryLabel !== rawPrimaryLabel) {
      // The markdown link already carries the destination.
    } else if (node.role === "AXLink" && !renderedValue) {
      extras.push(`Value: ${renderedUrl}`);
    } else {
      extras.push(`URL: ${renderedUrl}`);
    }
  }

  // Placeholder text for empty input fields (Brave's "Search Google or
  // type a URL", Spotlight's "Spotlight Search", Mail's "To:" hint).
  // Only meaningful for text-bearing roles, and only when the field
  // doesn't already carry a typed value to display.
  if (
    node.placeholder &&
    node.placeholder !== rawPrimaryLabel &&
    node.placeholder !== primaryLabel &&
    node.placeholder !== node.description &&
    node.placeholder !== renderedValue &&
    (node.role === "AXTextField" ||
      node.role === "AXSearchField" ||
      node.role === "AXSecureTextField" ||
      node.role === "AXTextArea" ||
      node.role === "AXComboBox")
  ) {
    extras.push(`Placeholder: ${truncate(node.placeholder, 120)}`);
  }

  const actions = secondaryActions(
    filterMenuActions(node.actions ?? [], node.role),
  );
  if (actions.length > 0) {
    extras.push(`Secondary Actions: ${actions.join(", ")}`);
  }

  const annotation = annotationSegment(node);

  // Collapse / skip empty container nodes. Spotify alone emits ~140 such
  // anonymous `container` lines per snapshot — they're pure DOM
  // structural scaffolding from the web view, with no label, no extras,
  // and no flag annotation worth surfacing. The model gets nothing from
  // them. Two cases:
  //
  //   (a) Empty container with no children → drop entirely. Emitting
  //       `\t\t\t\t\t<id> container` is just noise.
  //   (b) Empty container with exactly one child → fold the wrapper:
  //       render the child at the parent's depth. Most macOS
  //       web-wrapped apps (Spotify, Slack, Discord, Notion, Cursor,
  //       VS Code) produce 5–10 nested AXGroup/AXSplitGroup wrappers
  //       around the actual UI. This rule subsumes the previous
  //       same-role chain-collapse and applies even when the single
  //       child is a meaningful node (button/text/link).
  //
  // "Empty" requires no primary label, no extras (description / value /
  // url / placeholder / etc.), and no annotation flags (no
  // disabled/focused/selected/expanded/settable). Containers that
  // expose `settable` are still part of the actionable tree; we never
  // collapse those.
  const isEmptyCollapsibleContainer =
    COLLAPSIBLE_CONTAINER_ROLES.has(node.role) &&
    !primaryLabel &&
    extras.length === 0 &&
    annotation === "";
  if (isEmptyCollapsibleContainer) {
    if (node.children.length === 0) {
      return [];
    }
    if (node.children.length === 1) {
      return formatNodeLines(node.children[0]!, depth);
    }
  }

  let line = `${indent}${id} ${role}${annotation}`;
  if (primaryLabel) {
    line += ` ${truncate(primaryLabel, 120)}`;
    if (extras.length > 0) {
      line += `, ${extras.join(", ")}`;
    }
  } else if (extras.length > 0) {
    // When there's no primary label, extras hang directly off the role with a
    // single space, no comma. The extras among themselves are still ", "-joined.
    line += ` ${extras.join(", ")}`;
  }
  // Skip rendering the lone AXCell child of an AXRow when its description
  // was already folded up into the row's primary label (see
  // `choosePrimaryLabel`). Otherwise sidebars duplicate every label as a
  // child cell line right under the row.
  const childrenToRender =
    node.role === "AXRow" &&
    node.children.length === 1 &&
    node.children[0]?.role === "AXCell" &&
    primaryLabel === node.children[0].description
      ? []
      : node.children;
  return [
    line,
    ...childrenToRender.flatMap((child) => formatNodeLines(child, depth + 1)),
  ];
};

const findFocusedElement = (
  nodes: SnapshotNode[],
): { index: number | string; role: string } | null => {
  for (const node of nodes) {
    if (node.focused) {
      return {
        index:
          typeof node.index === "number" && Number.isFinite(node.index)
            ? node.index
            : (node.ref ?? "_"),
        role: humanRole(node),
      };
    }
    const nested = findFocusedElement(node.children);
    if (nested) return nested;
  }
  return null;
};

const printWarnings = (warnings: string[] | undefined) => {
  for (const warning of warnings ?? []) {
    writeComputerStdout(`[warning] ${warning}\n`);
  }
};

const formatScreenshotMarker = (
  screenshot?: Screenshot | null,
  fallbackPath?: string | null,
) =>
  formatAttachImageMarker({
    path: screenshot?.path ?? fallbackPath ?? null,
    widthPx: screenshot?.widthPx,
    heightPx: screenshot?.heightPx,
    byteCount: screenshot?.byteCount,
    inline: Boolean(screenshot?.data),
  });

const formatAppInstructions = (instructions?: string | null) => {
  if (!instructions) return "";
  const trimmed = instructions.trim();
  if (!trimmed) return "";
  return `<app_specific_instructions>\n${trimmed}\n</app_specific_instructions>\n`;
};

const formatBundleSpecificStateNote = (snapshot: SnapshotDocument) => {
  if (snapshot.bundleId !== "com.spotify.client") {
    return "";
  }
  return (
    "Note: In order to be usable, Spotify app links must be rewritten as regular links " +
    "(e.g. use open.spotify.com instead of xpui.app.spotify.com). Only use Spotify links " +
    "that are written verbatim in the UI above. Note that IDs are only valid with their " +
    'associated type (e.g. you cannot change an "album" URL to a "track" URL).'
  );
};

/** Stable, capture-independent state used for freshness and diffs. */
const appSemanticStateLines = (snapshot: SnapshotDocument) => {
  const lines: string[] = ["<app_state>"];
  lines.push(
    snapshot.bundleId
      ? `App=${snapshot.bundleId} (pid ${snapshot.pid})`
      : `App=${snapshot.appName} (pid ${snapshot.pid})`,
  );
  if (snapshot.windowTitle) {
    lines.push(`Window: "${snapshot.windowTitle}", App: ${snapshot.appName}.`);
  }
  if (snapshot.windowFrame) {
    const frame = snapshot.windowFrame;
    lines.push(
      `Window frame: x=${frame.x}, y=${frame.y}, width=${frame.width}, height=${frame.height}.`,
    );
  }
  for (const node of snapshot.nodes) {
    lines.push(...formatNodeLines(node));
  }
  if (snapshot.selectedText) {
    lines.push("", `Selected text: [${snapshot.selectedText}]`);
  } else if (snapshot.focusedSummary) {
    lines.push("", `The focused UI element is ${snapshot.focusedSummary}.`);
  } else {
    const focused = findFocusedElement(snapshot.nodes);
    if (focused) {
      lines.push(
        "",
        `The focused UI element is ${focused.index} ${focused.role}.`,
      );
    }
  }
  const bundleNote = formatBundleSpecificStateNote(snapshot);
  if (bundleNote) lines.push("", bundleNote);
  lines.push("</app_state>");
  return lines;
};

export const appStateLines = (snapshot: SnapshotDocument) => {
  const semanticLines = appSemanticStateLines(snapshot);
  const headerLineCount =
    2 + (snapshot.windowTitle ? 1 : 0) + (snapshot.windowFrame ? 1 : 0);
  const lines = semanticLines.slice(0, headerLineCount);
  if (snapshot.revision != null) {
    lines.push(
      `State revision: ${snapshot.revision} (materialized ${snapshot.materializedRevision ?? snapshot.revision}, cache_hit=${snapshot.cacheHit === true ? "true" : "false"}, pending_actions=${snapshot.pendingActionCount ?? 0}).`,
    );
  }
  if (snapshot.screenshot) {
    lines.push(
      `Screenshot context: method=${snapshot.screenshot.captureMethod ?? "unknown"}, reliable_final_frame=${snapshot.screenshot.reliableFinalFrame === false ? "false" : "true"}, exact_window=${snapshot.screenshot.exactWindowMatch === true ? "true" : "false"}.`,
    );
  }
  lines.push(...semanticLines.slice(headerLineCount));
  return lines;
};

export const snapshotStateId = (snapshot: SnapshotDocument): string =>
  `state_${createHash("sha256")
    .update(appSemanticStateLines(snapshot).join("\n"))
    .digest("hex")
    .slice(0, 20)}`;

export const snapshotVisualStateId = (
  snapshot: SnapshotDocument,
): string | undefined => {
  const imagePath = snapshot.screenshot?.path ?? snapshot.screenshotPath;
  let bytes: Buffer | string | undefined;
  if (imagePath && path.isAbsolute(imagePath)) {
    try {
      bytes = fs.readFileSync(imagePath);
    } catch {
      // A missing image is represented as no visual identity, not a semantic
      // state change.
    }
  }
  if (!bytes && snapshot.screenshot?.data) bytes = snapshot.screenshot.data;
  return bytes
    ? `visual_${createHash("sha256").update(bytes).digest("hex").slice(0, 20)}`
    : undefined;
};

const formatAppStateBlock = (snapshot: SnapshotDocument) => {
  writeComputerStdout(`${appStateLines(snapshot).join("\n")}\n`);
};

const diffTargetFromSnapshot = (
  snapshot: SnapshotDocument,
  lineCount: number,
): StateDiffTarget => ({
  appName: snapshot.appName,
  bundleId: snapshot.bundleId ?? null,
  pid: snapshot.pid,
  windowTitle: snapshot.windowTitle ?? null,
  windowId: snapshot.windowId ?? null,
  capturedAt: snapshot.capturedAt ?? null,
  nodeCount: snapshot.nodeCount,
  lineCount,
});

export const snapshotDiff = (
  previous: SnapshotDocument | null,
  current: SnapshotDocument,
): StateDiff =>
  computeSnapshotDiff(
    previous,
    current,
    appSemanticStateLines,
    diffTargetFromSnapshot,
  );

const formatActionSettle = (settle?: AutomationSettle | null) => {
  if (!settle) return;
  const reason = settle.reason ? ` reason=${settle.reason}` : "";
  const source = settle.observed ? "AX quiet" : "fixed post-action wait";
  writeComputerStdout(
    `Action settle: ${source}; waited=${settle.waitedMs}ms quiet=${settle.quietMs}ms events=${settle.eventCount} timed_out=${settle.timedOut ? "true" : "false"}${reason}\n`,
  );
};

export const formatSnapshot = (snapshot: SnapshotDocument) => {
  const instructions = formatAppInstructions(snapshot.appInstructions);
  if (instructions) {
    writeComputerStdout(instructions);
  }
  formatAppStateBlock(snapshot);

  writeComputerStdout(
    formatScreenshotMarker(snapshot.screenshot, snapshot.screenshotPath),
  );
  printWarnings(snapshot.warnings);
};

export const formatAction = (
  payload: ActionPayload,
  snapshot: SnapshotDocument | null,
  stateDiff: StateDiff | null,
) => {
  writeComputerStdout(
    payload.message.replace(/\bAX[A-Za-z]+\b/g, (action) =>
      humanActionName(action),
    ),
  );
  writeComputerStdout("\n");
  formatActionSettle(payload.settle);
  if (snapshot) {
    if (stateDiff && shouldUseDiffOnly(stateDiff)) {
      writeComputerStdout(formatStateDiffBlock(stateDiff));
    } else {
      if (stateDiff) {
        writeComputerStdout(formatStateDiffBlock(stateDiff));
      }
      formatAppStateBlock(snapshot);
    }
  }
  writeComputerStdout(
    formatScreenshotMarker(payload.screenshot, payload.screenshotPath),
  );
  printWarnings(payload.warnings);
};

// Return only "regular" (user-launchable) apps. macOS exposes accessory and
// background helpers (Spotlight, LoginWindow, WindowManager, renderer helpers)
// that pollute the list and have no addressable UI for the agent.
const LISTED_ACTIVATION_POLICIES = new Set(["regular"]);

export const formatListApps = (payload: ListAppsPayload) => {
  const visible = payload.apps.filter((app) =>
    LISTED_ACTIVATION_POLICIES.has(app.activationPolicy),
  );
  // Put the user's current app first, then keep the usage prior for the rest.
  visible.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    const usesA = a.useCount ?? -1;
    const usesB = b.useCount ?? -1;
    if (usesA !== usesB) return usesB - usesA;
    return a.name.localeCompare(b.name);
  });

  for (const app of visible) {
    const flags: string[] = [];
    if (app.isRunning !== false) {
      flags.push("running");
    }
    if (app.isActive) {
      flags.push("frontmost");
    }
    if (app.lastUsedDate) {
      flags.push(`last-used=${app.lastUsedDate}`);
    }
    if (typeof app.useCount === "number" && Number.isFinite(app.useCount)) {
      flags.push(`uses=${app.useCount}`);
    }
    const bundle = app.bundleId ? ` — ${app.bundleId}` : "";
    writeComputerStdout(`${app.name}${bundle} [${flags.join(", ")}]\n`);
  }
  printWarnings(payload.warnings);
};

export const formatListWindows = (payload: ListWindowsPayload) => {
  for (const window of payload.windows) {
    const title = window.title ? ` — ${window.title}` : "";
    const bundle = window.bundleId ? ` — ${window.bundleId}` : "";
    const active = window.isActive ? " frontmost" : "";
    writeComputerStdout(
      `${window.appName}${title}${bundle} [window-id=${window.windowId}, pid=${window.pid}, frame=${window.frame.x},${window.frame.y},${window.frame.width},${window.frame.height}${active}]\n`,
    );
  }
  printWarnings(payload.warnings);
};

export const formatError = (payload: ErrorPayload) => {
  writeComputerStderr(payload.error);
  writeComputerStderr("\n");
  // Mirror the action/snapshot screenshot-marker contract on the error path
  // so failures still expose the diagnostic capture without requiring an
  // extra Read step.
  const marker = formatScreenshotMarker(
    payload.screenshot,
    payload.screenshotPath,
  );
  if (marker) writeComputerStderr(marker);
  for (const warning of payload.warnings ?? []) {
    writeComputerStderr(`[warning] ${warning}\n`);
  }
};
