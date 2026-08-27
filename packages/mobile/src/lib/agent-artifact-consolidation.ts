import type { ChatArtifact, MobileDisplayPayload, MobileTask } from "../types";
import {
  agentWorkArtifactId,
  artifactId,
  artifactPrimaryFilePath,
} from "./mobile-artifacts";

export type AgentWorkChatArtifact = ChatArtifact & {
  payload: Extract<MobileDisplayPayload, { kind: "agent-work" }>;
};

export type MapRouteChatArtifact = ChatArtifact & {
  payload: Extract<MobileDisplayPayload, { kind: "map-route" }>;
};

export const isAgentWorkArtifact = (
  artifact: ChatArtifact,
): artifact is AgentWorkChatArtifact => artifact.payload.kind === "agent-work";

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

export const isNoiseFileArtifact = (artifact: ChatArtifact): boolean => {
  const filePath = artifactPrimaryFilePath(artifact.payload);
  return filePath != null && isNoiseProducedPath(filePath);
};

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

  agentWork: AgentWorkChatArtifact[];

  maps: MapRouteChatArtifact[];

  agentFiles: ChatArtifact[];

  looseFiles: ChatArtifact[];

  agentWorkSettled: boolean;
};

export type AgentWorkCardSection = {
  key: string;

  agentId?: string;

  title?: string;
  files: ChatArtifact[];

  summary?: string;
};

export const agentWorkCardSections = (
  artifact: AgentWorkChatArtifact,
): AgentWorkCardSection[] | null => {
  const agents = artifact.payload.agents;
  if (agents === undefined) return null;
  const sections: AgentWorkCardSection[] = [];
  for (const agent of agents) {

    if (agent.files.length === 0 && !agent.summary) continue;
    sections.push({
      key: `${artifact.id}:${agent.agentId}`,
      agentId: agent.agentId,
      title: agent.title,
      files: agent.files.map((file, index) => ({
        id: artifactId(file, artifact.conversationId, index),
        conversationId: artifact.conversationId,
        payload: file,
      })),
      ...(agent.summary ? { summary: agent.summary } : {}),
    });
  }
  return sections;
};

export const inlineAgentWorkCardSections = (
  artifact: AgentWorkChatArtifact,
): AgentWorkCardSection[] | null =>
  artifact.payload.state === "done" ? agentWorkCardSections(artifact) : null;

export type AgentWorkCardRender = {

  key: string;
  payload: Extract<MobileDisplayPayload, { kind: "agent-work" }>;

  sections: AgentWorkCardSection[];
};

export const settledAgentWorkCards = (
  artifact: AgentWorkChatArtifact,
  tasks: readonly MobileTask[] = [],
): AgentWorkCardRender[] => {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const sectionById = new Map(
    (artifact.payload.agents ?? []).map((section) => [
      section.agentId,
      section,
    ]),
  );
  const agentIds = [
    ...new Set([
      ...(artifact.payload.agentIds ?? []),
      ...sectionById.keys(),
      ...tasks.map((task) => task.id),
    ]),
  ];
  if (agentIds.length <= 1) {

    const singleTask = agentIds[0] ? taskById.get(agentIds[0]) : undefined;
    const settledUnsuccessfully =
      artifact.payload.state === "done" &&
      (singleTask?.status === "error" || singleTask?.status === "canceled");
    return [
      {
        key: artifact.id,
        payload:
          settledUnsuccessfully && artifact.payload.failed !== true
            ? { ...artifact.payload, failed: true }
            : artifact.payload,
        sections: inlineAgentWorkCardSections(artifact) ?? [],
      },
    ];
  }

  return agentIds.map((agentId, index) => {
    const task = taskById.get(agentId);
    const rawSection = sectionById.get(agentId);
    const taskFinished = task ? task.status !== "running" : Boolean(rawSection);
    const done = artifact.payload.state === "done" || taskFinished;
    const subtitle = task
      ? task.status === "running"
        ? task.statusText || "Working in background"
        : task.status === "error"
          ? "Failed"
          : task.status === "canceled"
            ? "Canceled"
            : "Finished"
      : done
        ? "Finished"
        : "Working in background";
    const payload: Extract<MobileDisplayPayload, { kind: "agent-work" }> = {
      ...artifact.payload,
      state: done ? "done" : "running",
      agentIds: [agentId],
      total: 1,
      completed: done ? 1 : 0,
      title: task?.title || rawSection?.title || "Background work",
      subtitle,

      followUp: undefined,
      failed:
        task && (task.status === "error" || task.status === "canceled")
          ? true
          : undefined,
      createdAt:
        task && task.createdAt > 0
          ? task.createdAt
          : artifact.payload.createdAt,
      ...(artifact.payload.textOffsetsByAgentId?.[agentId] !== undefined
        ? {
            textOffset: artifact.payload.textOffsetsByAgentId[agentId],
            textOffsetsByAgentId: {
              [agentId]: artifact.payload.textOffsetsByAgentId[agentId],
            },
          }
        : index > 0
          ? { textOffset: undefined, textOffsetsByAgentId: undefined }
          : {}),
      ...(artifact.payload.agents !== undefined
        ? { agents: rawSection ? [rawSection] : [] }
        : {}),
    };
    const splitArtifact: AgentWorkChatArtifact = {
      ...artifact,

      id: index === 0 ? artifact.id : agentWorkArtifactId([agentId]),
      payload,
    };
    return {
      key: splitArtifact.id,
      payload,
      sections: inlineAgentWorkCardSections(splitArtifact) ?? [],
    };
  });
};

const expandInlineAgentWork = (
  artifacts: readonly ChatArtifact[],
  tasks: readonly MobileTask[],
): ChatArtifact[] => {
  const expanded: ChatArtifact[] = [];
  const agentCardIndexById = new Map<string, number>();
  for (const artifact of artifacts) {
    if (!isAgentWorkArtifact(artifact)) {
      expanded.push(artifact);
      continue;
    }
    for (const card of settledAgentWorkCards(artifact, tasks)) {
      const split = { ...artifact, id: card.key, payload: card.payload };
      const existingIndex = agentCardIndexById.get(card.key);
      if (existingIndex === undefined) {
        agentCardIndexById.set(card.key, expanded.length);
        expanded.push(split);
      } else {
        expanded[existingIndex] = split;
      }
    }
  }
  return expanded;
};

export const consolidateRowArtifacts = (
  artifacts: readonly ChatArtifact[],
  tasks: readonly MobileTask[] = [],
): ConsolidatedRowArtifacts => {
  const agentWork: AgentWorkChatArtifact[] = [];
  const maps: MapRouteChatArtifact[] = [];
  const files: ChatArtifact[] = [];
  for (const artifact of expandInlineAgentWork(artifacts, tasks)) {
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
