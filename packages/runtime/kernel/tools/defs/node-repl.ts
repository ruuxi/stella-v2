import {
  NodeReplKernelRegistry,
  type NodeReplCellObservation,
  type NodeReplKernelManagerOptions,
} from "../../computer-use/kernel.js";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import type { ToolDefinition } from "../types.js";
import { CODE_TOOL_NAME } from "../code-tool.js";
import {
  CODE_TOOL_DESCRIPTION,
  CODE_TOOL_PARAMETERS,
  CODE_TOOL_PROMPT_SNIPPET,
} from "./code-def.js";
import { isAgentToolSuspendedError } from "../../agent-core/suspension.js";

export type CodeToolOptions = NodeReplKernelManagerOptions & {
  registry?: NodeReplKernelRegistry;
};

export const createCodeTool = (options: CodeToolOptions): ToolDefinition => {
  const registry = options.registry ?? new NodeReplKernelRegistry(options);
  const observationDetails = (
    observation: NodeReplCellObservation,
    forceCell = false,
  ) => {
    const media = observation.content?.filter((item) => item.type !== "text");
    const includeCell =
      forceCell ||
      observation.status !== "completed" ||
      observation.reset !== undefined ||
      Boolean(media && media.length > 0);
    return {
      ...(includeCell
        ? {
            code: {
              cellId: observation.cellId,
              generation: observation.generation,
              status: observation.status,
              elapsedMs: observation.elapsedMs,
              fromCursor: observation.fromCursor,
              cursor: observation.cursor,
              ...(observation.reset ? { reset: observation.reset } : {}),
              ...(media && media.length > 0 ? { content: media } : {}),
            },
          }
        : {}),
      ...(observation.responseMeta ? { _meta: observation.responseMeta } : {}),
      ...(observation.mapArtifacts?.length === 1
        ? { map: observation.mapArtifacts[0] }
        : {}),
      ...(observation.mapArtifacts && observation.mapArtifacts.length > 1
        ? { maps: [...observation.mapArtifacts] }
        : {}),
    };
  };
  const modelText = (observation: NodeReplCellObservation): string =>
    (observation.content ?? [])
      .flatMap((item) => {
        if (item.type === "text") return [item.text];
        if (item.type === "audio") {
          return [
            `[Audio output available at ${item.path}${item.mimeType ? ` (${item.mimeType})` : ""}.]`,
          ];
        }
        return [];
      })
      .join("\n");
  const resultForObservation = (
    observation: NodeReplCellObservation,
    forceCellDetails = false,
  ) => {
    const tracked = {
      ...(observation.fileChanges && observation.fileChanges.length > 0
        ? { fileChanges: [...observation.fileChanges] }
        : {}),
      ...(observation.producedFiles && observation.producedFiles.length > 0
        ? { producedFiles: [...observation.producedFiles] }
        : {}),
      ...(observation.producedFilesOmitted
        ? { producedFilesOmitted: observation.producedFilesOmitted }
        : {}),
    };
    if (observation.status === "failed") {
      return {
        error: observation.error ?? "Code cell failed.",
        details: observationDetails(observation, forceCellDetails),
        ...tracked,
      };
    }
    if (observation.status === "running") {
      const text = modelText(observation);
      return {
        result: `${text}${text ? "\n" : ""}[code running: cellId=${JSON.stringify(observation.cellId)} generation=${observation.generation} cursor=${observation.cursor} elapsedMs=${observation.elapsedMs}]`,
        details: observationDetails(observation, forceCellDetails),
        ...tracked,
      };
    }
    const details = observationDetails(observation, forceCellDetails);
    const hasDetails =
      forceCellDetails ||
      observation.reset ||
      observation.responseMeta ||
      Boolean(observation.mapArtifacts?.length) ||
      observation.content?.some((item) => item.type !== "text");
    return {
      result: modelText(observation),
      ...(hasDetails ? { details } : {}),
      ...tracked,
    };
  };
  return {
    name: CODE_TOOL_NAME,
    agentTypes: [AGENT_IDS.ORCHESTRATOR, AGENT_IDS.GENERAL],
    description: CODE_TOOL_DESCRIPTION,
    promptSnippet: CODE_TOOL_PROMPT_SNIPPET,
    parameters: CODE_TOOL_PARAMETERS,
    execute: async (args, context, extras) => {
      const hasCode = typeof args.code === "string" && args.code.trim() !== "";
      const hasCellId =
        typeof args.cell_id === "string" && args.cell_id.trim() !== "";
      if (hasCode === hasCellId) {
        return { error: "Provide exactly one of code or cell_id." };
      }
      const timeoutMs =
        typeof args.timeout_ms === "number" &&
        Number.isFinite(args.timeout_ms) &&
        args.timeout_ms > 0
          ? Math.floor(args.timeout_ms)
          : undefined;
      const yieldTimeMs =
        typeof args.yield_time_ms === "number" &&
        Number.isFinite(args.yield_time_ms) &&
        args.yield_time_ms >= 0
          ? Math.floor(args.yield_time_ms)
          : undefined;
      const waitMs =
        typeof args.wait_ms === "number" &&
        Number.isFinite(args.wait_ms) &&
        args.wait_ms >= 0
          ? Math.floor(args.wait_ms)
          : undefined;
      const cursor =
        typeof args.cursor === "number" &&
        Number.isSafeInteger(args.cursor) &&
        args.cursor >= 0
          ? args.cursor
          : undefined;
      try {
        const observation = hasCode
          ? await registry.startCell(args.code as string, context, {
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
              ...(yieldTimeMs !== undefined ? { yieldTimeMs } : {}),
              ...(extras?.signal ? { signal: extras.signal } : {}),
              ...(extras?.onUpdate ? { onToolUpdate: extras.onUpdate } : {}),
              onResponseMeta: () => undefined,
            })
          : await registry.waitCell((args.cell_id as string).trim(), context, {
              ...(waitMs !== undefined ? { waitMs } : {}),
              ...(cursor !== undefined ? { afterCursor: cursor } : {}),
              ...(args.terminate === true ? { terminate: true } : {}),
              ...(extras?.signal ? { signal: extras.signal } : {}),
            });
        return resultForObservation(observation, hasCellId);
      } catch (error) {
        if (isAgentToolSuspendedError(error)) throw error;
        return {
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
};

/** @deprecated Internal source-compatibility alias; the returned tool is `code`. */
export const createNodeReplTool = createCodeTool;
