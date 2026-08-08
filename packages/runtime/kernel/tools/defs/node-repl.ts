import {
  NodeReplKernelRegistry,
  type NodeReplKernelManagerOptions,
} from "../../computer-use/kernel.js";
import type {
  FileChangeRecord,
  ProducedFileRecord,
} from "@stella/contracts/file-changes";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import type { ToolDefinition } from "../types.js";

export type NodeReplToolOptions = NodeReplKernelManagerOptions & {
  registry?: NodeReplKernelRegistry;
};

export const createNodeReplTool = (
  options: NodeReplToolOptions,
): ToolDefinition => {
  const registry = options.registry ?? new NodeReplKernelRegistry(options);
  return {
    name: "node_repl",
    agentTypes: [AGENT_IDS.ORCHESTRATOR, AGENT_IDS.GENERAL],
    description:
      'Run JavaScript in a persistent Node REPL with top-level await. Setup is already done: bindings persist between calls; nodeRepl exposes write/emitImage and cwd/home/tmp; frozen sky controls desktop apps; frozen browser controls owned browser tabs (browser.documentation() returns its full API; Object.keys() lists methods on any of its objects); frozen connect runs third-party app integrations — discover/connectors/actions/schema/call (connect.documentation() explains them); and an immutable tools object exposes this agent\'s allowed Stella tools (its entries can change between calls — never call Object.freeze on it). Use Promise.all with tools methods for independent calls. Nested tools preserve normal permissions, cancellation, file tracking, and produced-file tracking. Batch dependent browser/computer actions in one cell, then observe only when the next action needs fresh state. Use fresh element IDs from the latest sky app state. await tools.$search({ query: "<capability>" }) looks up additional callable tool signatures by capability.',
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
      },
      required: ["code"],
    },
    execute: async (args, context, extras) => {
      if (typeof args.code !== "string" || args.code.trim() === "") {
        return { error: "code is required." };
      }
      const timeoutMs =
        typeof args.timeout_ms === "number" &&
        Number.isFinite(args.timeout_ms) &&
        args.timeout_ms > 0
          ? Math.floor(args.timeout_ms)
          : undefined;
      try {
        const fileChanges: FileChangeRecord[] = [];
        const producedFiles: ProducedFileRecord[] = [];
        const result = await registry.evaluate(args.code, context, {
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(extras?.signal ? { signal: extras.signal } : {}),
          ...(extras?.onUpdate ? { onToolUpdate: extras.onUpdate } : {}),
          onToolResult: (nested) => {
            if (nested.fileChanges) fileChanges.push(...nested.fileChanges);
            if (nested.producedFiles)
              producedFiles.push(...nested.producedFiles);
          },
        });
        return {
          result,
          ...(fileChanges.length > 0 ? { fileChanges } : {}),
          ...(producedFiles.length > 0 ? { producedFiles } : {}),
        };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
};
