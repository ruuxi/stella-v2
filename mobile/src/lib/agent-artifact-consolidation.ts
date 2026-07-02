import type { ChatArtifact, MobileDisplayPayload } from "../types";
import { artifactPrimaryFilePath } from "./mobile-artifacts";

export type AgentWorkChatArtifact = ChatArtifact & {
  payload: Extract<MobileDisplayPayload, { kind: "agent-work" }>;
};

export type MapRouteChatArtifact = ChatArtifact & {
  payload: Extract<MobileDisplayPayload, { kind: "map-route" }>;
};

/**
 * Mobile port of the desktop agent-artifact consolidation semantics
 * (desktop: `path-to-viewer.ts` `isNoiseProducedPath` / `isDeclaredOutputPath`
 * + `agent-completion.ts` `rankDeliverablesFirst`). Files a background agent
 * produces fold INTO that turn's agent-work card as pills — revealed together
 * once the card settles — instead of popping as loose file cards while the
 * agent is still running.
 *
 * The desktop↔mobile bridge ships each synced row's artifacts as loose
 * display payloads with NO per-agent attribution (the `agent-work` payload
 * carries no file list), so consolidation here is row-scoped: a row that
 * carries an agent-work card treats its file artifacts as that card's
 * deliverables. Agents spawned on different turns ride different rows, which
 * keeps attribution correct across concurrent agents at the granularity
 * mobile can represent (one grouped card per spawning turn).
 */

/**
 * Declared deliverables home (`~/.stella/outputs/**`, or `state/outputs/**`
 * in dev). Mirrors desktop `DECLARED_OUTPUTS_RE`.
 */
const DECLARED_OUTPUTS_RE = /(?:^|[\\/])(?:\.stella|state)[\\/]outputs[\\/]/;

export const isDeclaredOutputPath = (filePath: string): boolean =>
  DECLARED_OUTPUTS_RE.test(filePath);

const NOISE_PATH_SEGMENTS = new Set(["node_modules", "__pycache__"]);
const NOISE_EXTS = new Set(["log", "tmp", "lock", "pid"]);

const extensionOf = (filePath: string): string | null => {
  const tail = filePath.split(/[\\/]/).pop() ?? filePath;
  const dot = tail.lastIndexOf(".");
  return dot <= 0 || dot === tail.length - 1
    ? null
    : tail.slice(dot + 1).toLowerCase();
};

/**
 * Snapshot-detected produced files sweep up incidental writes (browser
 * profiles, launch logs, caches, scratch dirs) alongside real deliverables.
 * Filter those from every user-facing artifact surface. A dot-segment means a
 * hidden/profile/cache dir and is always noise, with one carve-out: `.stella`
 * itself, since `~/.stella/outputs/**` is the declared deliverables home.
 * Mirrors desktop `isNoiseProducedPath`.
 */
export const isNoiseProducedPath = (filePath: string): boolean => {
  const trimmed = filePath.trim();
  if (!trimmed) return true;
  for (const segment of trimmed.split(/[\\/]/)) {
    if (!segment) continue;
    if (segment.startsWith(".") && segment !== ".stella") return true;
    if (NOISE_PATH_SEGMENTS.has(segment)) return true;
  }
  const ext = extensionOf(trimmed);
  return ext != null && NOISE_EXTS.has(ext);
};

/** True when the artifact's primary file path is a noise write. Pathless
 *  payloads (generated text, URLs…) are never noise. */
export const isNoiseFileArtifact = (artifact: ChatArtifact): boolean => {
  const filePath = artifactPrimaryFilePath(artifact.payload);
  return filePath != null && isNoiseProducedPath(filePath);
};

/**
 * Declared deliverables lead the list so any cap truncates incidental writes
 * instead of the files the user actually asked for. Stable within each group.
 * Mirrors desktop `rankDeliverablesFirst`.
 */
export const rankDeliverablesFirst = (
  artifacts: ChatArtifact[],
): ChatArtifact[] => {
  const isDeliverable = (artifact: ChatArtifact) => {
    const filePath = artifactPrimaryFilePath(artifact.payload);
    return filePath != null && isDeclaredOutputPath(filePath);
  };
  return [
    ...artifacts.filter(isDeliverable),
    ...artifacts.filter((artifact) => !isDeliverable(artifact)),
  ];
};

export type ConsolidatedRowArtifacts = {
  /** The row's agent lifecycle card(s) — normally one grouped card. */
  agentWork: AgentWorkChatArtifact[];
  /** Inline map cards (self-contained, never folded). */
  maps: MapRouteChatArtifact[];
  /**
   * Files folded into the agent-work card as pills. Populated only when the
   * row carries an agent-work card; noise-filtered, deliverables first.
   */
  agentFiles: ChatArtifact[];
  /**
   * Files rendered as standalone cards — rows with no background work keep
   * the classic inline presentation (orchestrator-direct outputs).
   */
  looseFiles: ChatArtifact[];
  /**
   * True once every agent-work card on the row reports `done` — the reveal
   * gate for `agentFiles`, mirroring the desktop completion card (files show
   * together at completion, never mid-run).
   */
  agentWorkSettled: boolean;
};

export const consolidateRowArtifacts = (
  artifacts: readonly ChatArtifact[],
): ConsolidatedRowArtifacts => {
  const agentWork: AgentWorkChatArtifact[] = [];
  const maps: MapRouteChatArtifact[] = [];
  const files: ChatArtifact[] = [];
  for (const artifact of artifacts) {
    if (artifact.payload.kind === "agent-work") {
      agentWork.push(artifact as AgentWorkChatArtifact);
    } else if (artifact.payload.kind === "map-route") {
      maps.push(artifact as MapRouteChatArtifact);
    } else if (!isNoiseFileArtifact(artifact)) {
      files.push(artifact);
    }
  }
  const ranked = rankDeliverablesFirst(files);
  const hasAgentWork = agentWork.length > 0;
  return {
    agentWork,
    maps,
    agentFiles: hasAgentWork ? ranked : [],
    looseFiles: hasAgentWork ? [] : ranked,
    agentWorkSettled:
      hasAgentWork &&
      agentWork.every((artifact) => artifact.payload.state === "done"),
  };
};
