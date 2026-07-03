import type { ChatArtifact, MobileDisplayPayload } from "../types";
import { artifactId, artifactPrimaryFilePath } from "./mobile-artifacts";

export type AgentWorkChatArtifact = ChatArtifact & {
  payload: Extract<MobileDisplayPayload, { kind: "agent-work" }>;
};

export type MapRouteChatArtifact = ChatArtifact & {
  payload: Extract<MobileDisplayPayload, { kind: "map-route" }>;
};

export const isAgentWorkArtifact = (
  artifact: ChatArtifact,
): artifact is AgentWorkChatArtifact => artifact.payload.kind === "agent-work";

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
   * Fallback-only: files folded into the agent-work card as pills when the
   * bridge predates per-agent sections. Populated only when the row carries
   * an agent-work card WITHOUT a desktop-computed `agents` list;
   * noise-filtered, deliverables first.
   */
  agentFiles: ChatArtifact[];
  /**
   * Files rendered as standalone cards. Rows with no background work keep
   * the classic inline presentation; on bridge-consolidated rows (any
   * agent-work card carrying an `agents` list) the remaining loose files are
   * orchestrator-direct by contract and render standalone too.
   */
  looseFiles: ChatArtifact[];
  /**
   * True once every agent-work card on the row reports `done` — the reveal
   * gate for `agentFiles`, mirroring the desktop completion card (files show
   * together at completion, never mid-run). Bridge-computed sections need no
   * gate: they only exist once their agent completed.
   */
  agentWorkSettled: boolean;
};

/** One pill group on the agent-work card. */
export type AgentWorkCardSection = {
  key: string;
  /** Header naming the agent's task; omitted for fallback folding (the card
   *  title already names the work). */
  title?: string;
  files: ChatArtifact[];
};

/**
 * Desktop-computed per-agent file sections for one agent-work card, mapped
 * to openable `ChatArtifact`s. Returns `null` when the payload predates the
 * consolidating bridge (no `agents` field) — callers fall back to row-scoped
 * folding. File ids reuse the path-keyed `artifactId` so the same file
 * dedupes against the artifacts browser.
 */
export const agentWorkCardSections = (
  artifact: AgentWorkChatArtifact,
): AgentWorkCardSection[] | null => {
  const agents = artifact.payload.agents;
  if (agents === undefined) return null;
  const sections: AgentWorkCardSection[] = [];
  for (const agent of agents) {
    if (agent.files.length === 0) continue;
    sections.push({
      key: `${artifact.id}:${agent.agentId}`,
      title: agent.title,
      files: agent.files.map((file, index) => ({
        id: artifactId(file, artifact.conversationId, index),
        conversationId: artifact.conversationId,
        payload: file,
      })),
    });
  }
  return sections;
};

/**
 * Sections for the INLINE chat card. Files appear on the finish card only,
 * matching desktop: each bridge section exists once ITS agent completed, but
 * the card itself can still be running (a multi-agent group with stragglers,
 * or a thread resumed via `send_input` keeps a prior run's rollup files), so
 * this gates on the whole card settling. Live mid-run files intentionally
 * remain on the activity pill/sheet, which reads the task stream — never
 * inline in the transcript.
 */
export const inlineAgentWorkCardSections = (
  artifact: AgentWorkChatArtifact,
): AgentWorkCardSection[] | null =>
  artifact.payload.state === "done" ? agentWorkCardSections(artifact) : null;

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
  // A card carrying an `agents` list marks a consolidating bridge: agent
  // files ride the card's own sections and whatever is left loose on the row
  // is orchestrator-direct. Older desktops omit the field entirely, so the
  // row's files fold into the card as an unattributed group instead.
  const bridgeConsolidated = agentWork.some(
    (artifact) => artifact.payload.agents !== undefined,
  );
  const fold = hasAgentWork && !bridgeConsolidated;
  return {
    agentWork,
    maps,
    agentFiles: fold ? ranked : [],
    looseFiles: fold ? [] : ranked,
    agentWorkSettled:
      hasAgentWork &&
      agentWork.every((artifact) => artifact.payload.state === "done"),
  };
};
