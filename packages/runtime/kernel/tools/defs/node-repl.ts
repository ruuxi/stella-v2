import {
  NodeReplKernelRegistry,
  type NodeReplCellObservation,
  type NodeReplKernelManagerOptions,
} from "../../computer-use/kernel.js";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import {
  isMapRouteArtifact,
  type MapRouteArtifact,
} from "@stella/contracts/map-artifact";
import type { ToolDefinition } from "../types.js";

export type NodeReplToolOptions = NodeReplKernelManagerOptions & {
  registry?: NodeReplKernelRegistry;
};

export const createNodeReplTool = (
  options: NodeReplToolOptions,
): ToolDefinition => {
  const registry = options.registry ?? new NodeReplKernelRegistry(options);
  const mapArtifactsByCellId = new Map<
    string,
    { maps: MapRouteArtifact[]; delivered: number; touchedAt: number }
  >();
  const pruneMapArtifacts = () => {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [cellId, state] of mapArtifactsByCellId) {
      if (state.touchedAt < cutoff) mapArtifactsByCellId.delete(cellId);
    }
  };
  const collectMapArtifact =
    (maps: MapRouteArtifact[]) => (nested: unknown) => {
      if (!nested || typeof nested !== "object" || Array.isArray(nested))
        return;
      const detailsValue = (nested as { details?: unknown }).details;
      if (
        !detailsValue ||
        typeof detailsValue !== "object" ||
        Array.isArray(detailsValue)
      ) {
        return;
      }
      const details = detailsValue as Record<string, unknown>;
      if (isMapRouteArtifact(details.map)) maps.push(details.map);
    };
  const observationDetails = (
    observation: NodeReplCellObservation,
    forceCell = false,
    maps: readonly MapRouteArtifact[] = [],
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
            nodeRepl: {
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
      ...(maps.length === 1 ? { map: maps[0] } : {}),
      ...(maps.length > 1 ? { maps } : {}),
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
    maps: readonly MapRouteArtifact[] = [],
  ) => {
    const tracked = {
      ...(observation.fileChanges && observation.fileChanges.length > 0
        ? { fileChanges: [...observation.fileChanges] }
        : {}),
      ...(observation.producedFiles && observation.producedFiles.length > 0
        ? { producedFiles: [...observation.producedFiles] }
        : {}),
    };
    if (observation.status === "failed") {
      return {
        error: observation.error ?? "Node REPL cell failed.",
        details: observationDetails(observation, forceCellDetails, maps),
        ...tracked,
      };
    }
    if (observation.status === "running") {
      const text = modelText(observation);
      return {
        result: `${text}${text ? "\n" : ""}[node_repl running: cellId=${JSON.stringify(observation.cellId)} generation=${observation.generation} cursor=${observation.cursor} elapsedMs=${observation.elapsedMs}]`,
        details: observationDetails(observation, forceCellDetails, maps),
        ...tracked,
      };
    }
    const details = observationDetails(observation, forceCellDetails, maps);
    const hasDetails =
      forceCellDetails ||
      observation.reset ||
      observation.responseMeta ||
      maps.length > 0 ||
      observation.content?.some((item) => item.type !== "text");
    return {
      result: modelText(observation),
      ...(hasDetails ? { details } : {}),
      ...tracked,
    };
  };
  return {
    name: "node_repl",
    agentTypes: [AGENT_IDS.ORCHESTRATOR, AGENT_IDS.GENERAL],
    description:
      'Run JavaScript in a persistent Node REPL with top-level await, or observe a previously yielded cell with cell_id. bindings persist within one generation (use var for reusable names). nodeRepl exposes write/emitImage/emitAudio/status/reset/help and cwd/home/tmp. Long cells yield with a generation-tagged cell ID; call node_repl again with cell_id to receive only new output or terminate it. Observations return a monotonic cursor; pass cursor explicitly to replay from a known position. frozen sky controls desktop apps; frozen browser controls owned browser tabs (use browser.use("external") only for the user\'s signed-in Chromium browser; follow the installed stella-browser and stella-computer skills for complete APIs). frozen connect runs third-party integrations. immutable tools exposes allowed Stella tools and refreshes between cells. Use tools.$list() for exact names/access expressions; non-identifier names require bracket notation such as tools["mcp.server/tool"](...). await tools.$search({ query: "<capability>" }) returns scoped signatures with a valid access expression. Use Promise.all for independent calls. Nested tools retain cancellation and file tracking, and unawaited calls are drained with a bounded deadline. Batch dependent browser/computer actions in one cell; pass state_id for UI-derived actions and use sky.wait_for_change when a mutation must become observable.',
    promptSnippet:
      "Run persistent JavaScript, orchestrate allowed Stella tools, and control apps through frozen sky/browser/connect clients",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "JavaScript to evaluate with top-level await.",
        },
        timeout_ms: {
          type: "number",
          description: "Optional evaluation timeout in milliseconds.",
        },
        yield_time_ms: {
          type: "number",
          description:
            "How long to await a new cell before returning a resumable cell_id. Defaults to 30000ms.",
        },
        cell_id: {
          type: "string",
          description:
            "Generation-tagged ID returned by a running node_repl cell.",
        },
        wait_ms: {
          type: "number",
          description:
            "How long to observe cell_id for terminal output. Defaults to 10000ms.",
        },
        cursor: {
          type: "number",
          description:
            "Optional prior cursor for cell_id. The response contains only content after this cursor and does not consume content if the wait is aborted.",
        },
        terminate: {
          type: "boolean",
          description:
            "Terminate cell_id and reset its persistent REPL generation.",
        },
      },
    },
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
        pruneMapArtifacts();
        if (hasCode) {
          const maps: MapRouteArtifact[] = [];
          const observation = await registry.startCell(
            args.code as string,
            context,
            {
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
              ...(yieldTimeMs !== undefined ? { yieldTimeMs } : {}),
              ...(extras?.signal ? { signal: extras.signal } : {}),
              ...(extras?.onUpdate ? { onToolUpdate: extras.onUpdate } : {}),
              onToolResult: collectMapArtifact(maps),
              onResponseMeta: () => undefined,
            },
          );
          if (observation.status === "running") {
            mapArtifactsByCellId.set(observation.cellId, {
              maps,
              delivered: maps.length,
              touchedAt: Date.now(),
            });
          }
          return resultForObservation(observation, false, maps);
        }

        const cellId = (args.cell_id as string).trim();
        const state = mapArtifactsByCellId.get(cellId);
        const observation = await registry.waitCell(cellId, context, {
          ...(waitMs !== undefined ? { waitMs } : {}),
          ...(cursor !== undefined ? { afterCursor: cursor } : {}),
          ...(args.terminate === true ? { terminate: true } : {}),
          ...(extras?.signal ? { signal: extras.signal } : {}),
        });
        const maps = state ? state.maps.slice(state.delivered) : [];
        if (state) {
          state.delivered = state.maps.length;
          state.touchedAt = Date.now();
          if (observation.status !== "running") {
            mapArtifactsByCellId.delete(cellId);
          }
        }
        return resultForObservation(observation, true, maps);
      } catch (error) {
        if (hasCellId) {
          mapArtifactsByCellId.delete((args.cell_id as string).trim());
        }
        return {
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
};
