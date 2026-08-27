export type StateDiffTarget = {
  appName?: string | null;
  bundleId?: string | null;
  pid?: number | null;
  windowTitle?: string | null;
  windowId?: string | number | null;
  capturedAt?: string | null;
  nodeCount?: number | null;
  lineCount: number;
};

export type StateDiffStatus =
  | "baseline"
  | "different-target"
  | "unchanged"
  | "changed";

export type StateDiff = {
  status: StateDiffStatus;
  sameTarget: boolean;
  previous?: StateDiffTarget | null;
  current: StateDiffTarget;
  addedLineCount: number;
  removedLineCount: number;
  changedLineCount: number;
  addedLines: string[];
  removedLines: string[];
  maxLines: number;
  truncated: boolean;
};

const DEFAULT_MAX_DIFF_LINES = 80;

const normalizeTargetText = (value?: string | number | null) =>
  value == null ? "" : String(value).trim().toLowerCase();

export const stateDiffMaxLines = () => {
  const raw = process.env.STELLA_COMPUTER_MAX_DIFF_LINES;
  if (!raw) return DEFAULT_MAX_DIFF_LINES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MAX_DIFF_LINES;
  return Math.floor(parsed);
};

const sameTarget = (previous: StateDiffTarget, current: StateDiffTarget) => {
  const previousWindow = normalizeTargetText(previous.windowId);
  const currentWindow = normalizeTargetText(current.windowId);
  if (previousWindow && currentWindow && previousWindow !== currentWindow) {
    return false;
  }

  const previousBundle = normalizeTargetText(previous.bundleId);
  const currentBundle = normalizeTargetText(current.bundleId);
  if (previousBundle || currentBundle) {
    return previousBundle === currentBundle;
  }

  const previousApp = normalizeTargetText(previous.appName);
  const currentApp = normalizeTargetText(current.appName);
  if (previousApp || currentApp) {
    return previousApp === currentApp;
  }

  return previous.pid != null && previous.pid === current.pid;
};

const occurrenceTokens = (lines: readonly string[]) => {
  const counts = new Map<string, number>();
  const tokens: string[] = [];
  for (const line of lines) {
    const occurrence = (counts.get(line) ?? 0) + 1;
    counts.set(line, occurrence);
    tokens.push(`${line}\u0000${occurrence}`);
  }
  return tokens;
};

const orderedDelta = (left: readonly string[], right: readonly string[]) => {
  const leftTokens = occurrenceTokens(left);
  const rightTokens = occurrenceTokens(right);
  const leftPositions = new Map(
    leftTokens.map((token, index) => [token, index] as const),
  );
  const candidates = rightTokens.flatMap((token, rightIndex) => {
    const leftIndex = leftPositions.get(token);
    return leftIndex === undefined ? [] : [{ leftIndex, rightIndex }];
  });

  const tails: number[] = [];
  const tailCandidateIndices: number[] = [];
  const previousCandidateIndices = new Array<number>(candidates.length).fill(
    -1,
  );
  for (let index = 0; index < candidates.length; index += 1) {
    const leftIndex = candidates[index]!.leftIndex;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (tails[middle]! < leftIndex) low = middle + 1;
      else high = middle;
    }
    if (low > 0) {
      previousCandidateIndices[index] = tailCandidateIndices[low - 1]!;
    }
    tails[low] = leftIndex;
    tailCandidateIndices[low] = index;
  }

  const stableLeft = new Set<number>();
  const stableRight = new Set<number>();
  let cursor = tailCandidateIndices[tails.length - 1] ?? -1;
  while (cursor >= 0) {
    const candidate = candidates[cursor]!;
    stableLeft.add(candidate.leftIndex);
    stableRight.add(candidate.rightIndex);
    cursor = previousCandidateIndices[cursor]!;
  }

  return {
    removed: left.filter((_line, index) => !stableLeft.has(index)),
    added: right.filter((_line, index) => !stableRight.has(index)),
  };
};

const truncateLines = (lines: readonly string[], maxLines: number) => {
  if (maxLines <= 0) return [];
  return lines.slice(0, maxLines);
};

export const computeStateDiff = (input: {
  previousLines?: readonly string[] | null;
  currentLines: readonly string[];
  previousTarget?: StateDiffTarget | null;
  currentTarget: StateDiffTarget;
  maxLines?: number;
}): StateDiff => {
  const maxLines = input.maxLines ?? stateDiffMaxLines();
  const previous = input.previousTarget ?? null;
  const current = input.currentTarget;
  if (!previous || !input.previousLines) {
    return {
      status: "baseline",
      sameTarget: false,
      previous,
      current,
      addedLineCount: 0,
      removedLineCount: 0,
      changedLineCount: 0,
      addedLines: [],
      removedLines: [],
      maxLines,
      truncated: false,
    };
  }

  const targetMatches = sameTarget(previous, current);
  if (!targetMatches) {
    return {
      status: "different-target",
      sameTarget: false,
      previous,
      current,
      addedLineCount: 0,
      removedLineCount: 0,
      changedLineCount: 0,
      addedLines: [],
      removedLines: [],
      maxLines,
      truncated: false,
    };
  }

  const { added, removed } = orderedDelta(
    input.previousLines,
    input.currentLines,
  );
  const changedLineCount = added.length + removed.length;
  const addedBudget = Math.ceil(maxLines / 2);
  const removedBudget = Math.floor(maxLines / 2);
  const visibleAdded = truncateLines(added, addedBudget);
  const visibleRemoved = truncateLines(removed, removedBudget);

  return {
    status: changedLineCount === 0 ? "unchanged" : "changed",
    sameTarget: true,
    previous,
    current,
    addedLineCount: added.length,
    removedLineCount: removed.length,
    changedLineCount,
    addedLines: visibleAdded,
    removedLines: visibleRemoved,
    maxLines,
    truncated:
      visibleAdded.length < added.length ||
      visibleRemoved.length < removed.length,
  };
};

const attr = (name: string, value?: string | number | boolean | null) => {
  if (value == null || value === "") return "";
  return ` ${name}="${String(value).replaceAll('"', "&quot;")}"`;
};

export const shouldUseDiffOnly = (diff: StateDiff | null | undefined) =>
  !!diff &&
  diff.sameTarget &&
  (diff.status === "unchanged" ||
    (diff.status === "changed" && !diff.truncated));

export const formatStateDiffBlock = (diff: StateDiff) => {
  const lines = [
    `<app_state_diff${attr("status", diff.status)}${attr("same_target", diff.sameTarget)}${attr(
      "previous_captured_at",
      diff.previous?.capturedAt,
    )}${attr("current_captured_at", diff.current.capturedAt)}${attr(
      "previous_nodes",
      diff.previous?.nodeCount,
    )}${attr("current_nodes", diff.current.nodeCount)}${attr(
      "added",
      diff.addedLineCount,
    )}${attr("removed", diff.removedLineCount)}${attr("truncated", diff.truncated)}>`,
  ];

  if (diff.status === "baseline") {
    lines.push("No previous app state was available; full app_state follows.");
  } else if (diff.status === "different-target") {
    lines.push(
      "The target changed since the previous snapshot; full app_state follows.",
    );
  } else if (diff.status === "unchanged") {
    lines.push(
      "No accessibility-tree line changes detected since the previous snapshot.",
    );
  } else {
    if (diff.addedLines.length > 0) {
      lines.push("Added lines:");
      lines.push(...diff.addedLines.map((line) => `+ ${line}`));
    }
    if (diff.removedLines.length > 0) {
      lines.push("Removed lines:");
      lines.push(...diff.removedLines.map((line) => `- ${line}`));
    }
    if (diff.truncated) {
      lines.push(
        `Diff truncated to ${diff.maxLines} lines; run snapshot/get-state for the full refreshed tree.`,
      );
    }
  }

  lines.push("</app_state_diff>");
  return `${lines.join("\n")}\n`;
};
