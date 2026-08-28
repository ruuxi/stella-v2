import {
  NodeReplKernelRegistry,
  type NodeReplCellObservation,
  type NodeReplKernelManagerOptions,
} from "../../computer-use/kernel.js";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import type { ToolDefinition } from "../types.js";
import { CODE_TOOL_NAME } from "../code-tool.js";
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
    description:
      'Run JavaScript with top-level await in Stella\'s persistent code runtime, or observe a previously yielded cell with cell_id; bindings persist within one generation (use var for reusable names). Call the immutable globals directly: codeRuntime, sky, browser, connect, and tools. There is no frozen namespace or frozen.browser object. End with an expression to return its value, or call codeRuntime.write(...); console.log and process.stdout are not output channels. codeRuntime also exposes emitImage/emitAudio/status/reset/help and cwd/home/tmp. Long cells yield with a generation-tagged cell ID; call code again with cell_id to receive only new output or terminate it. Observations use a monotonic cursor. browser controls owned tabs and defaults to in-app; use browser.use("external") only for the user\'s signed-in Chromium browser and browser.use("in-app") to switch back. Basic navigation is: const tab = await browser.tabs.new("https://example.com"); await tab.playwright.locator("#id").waitFor({ state: "visible" });. In cloud, call browser.requestLoginTakeover({ allowedOrigins: [origin], displayOrigin: origin, startUrl?, displayTitle?, verification: { expectedOrigin: origin, authenticatedSelector, loggedOutSelector, resumeUrl } }) when private human credential entry is required. All origins and URLs must use that one exact HTTPS origin; both distinct selectors are required and may only be #id, .class, or exact [data-testid="..."]; never ask for or type the credential in code. browser.requestDeviceCodeFixture({ expiresInMs? }) exercises the separate public device-code suspension path without exposing provider secrets. tools exposes allowed Stella tools and refreshes between cells. Use tools.$list() for exact names/access expressions; non-identifier names require bracket notation such as tools["mcp.server/tool"](...). Use tools.$search({ query: "<capability>" }) for ranked signatures, and tools.$describe(name) for a complete unfamiliar schema. Use Promise.all for independent calls. Nested tools retain permissions, cancellation, file changes, produced-file omissions, and route artifacts; tools requiring explicit approval are unavailable inside code and must be called directly. Unawaited calls are drained with a bounded deadline. Batch dependent browser/computer actions in one cell, pass state_id for UI-derived actions, and use sky.wait_for_change when a mutation must become observable.',
    promptSnippet:
      "Run persistent JavaScript, orchestrate allowed Stella tools, and control apps through the sky/browser/connect globals",
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
          description: "Generation-tagged ID returned by a running code cell.",
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
