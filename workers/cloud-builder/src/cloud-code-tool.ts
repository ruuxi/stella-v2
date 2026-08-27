import { Value } from "@sinclair/typebox/value";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type {
  AgentTool,
  AgentToolResult,
} from "@stella/runtime/kernel/agent-core/types.js";
import {
  CODE_TOOL_NAME,
  LEGACY_NODE_REPL_TOOL_NAME,
  toolRequiresExplicitApproval,
} from "@stella/runtime/kernel/tools/code-tool.js";
import { sanitizeToolVisibleText } from "@stella/runtime/kernel/tools/safety.js";
import {
  boundedJsonPreview,
  cloneBoundedJsonValue,
  truncateUtf8,
  type BoundedJsonLimits,
} from "./cloud-code-bounds.js";
import {
  CLOUD_CODE_MAX_CONCURRENT_TOOL_CALLS,
  CLOUD_CODE_MAX_SOURCE_BYTES,
  CLOUD_CODE_MAX_TIMEOUT_MS,
  CLOUD_CODE_MAX_TOOL_CALLS,
  executeCloudCode,
  prepareCloudCodeTools,
  type CloudCodeExecutionRequest,
  type CloudCodeExecutionResult,
  type CloudCodeToolDefinition,
} from "./cloud-code-executor.js";
import { sha256Hex } from "./hash.js";

const CLOUD_CODE_MODEL_OUTPUT_MAX_BYTES = 50_000;
const CLOUD_CODE_NESTED_RESULT_MAX_BYTES = 128 * 1024;

const CLOUD_CODE_PARAMETERS = Type.Object(
  {
    code: Type.String({
      minLength: 1,
      maxLength: CLOUD_CODE_MAX_SOURCE_BYTES,
      description:
        'An async JavaScript function expression, for example `async () => { return await codemode.web({ query: "..." }); }`.',
    }),
    timeout_ms: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: CLOUD_CODE_MAX_TIMEOUT_MS,
        description: "Optional execution deadline in milliseconds.",
      }),
    ),
  },
  { additionalProperties: false },
);

/** Agent tools may carry source metadata not represented by the core Tool type. */
export type CloudCodeSourceAgentTool = AgentTool & {
  approval?: unknown;
  outputSchema?: TSchema;
  /** Fail-closed: absence means direct-only, never Code-callable. */
  codeEligibility?: "read_only";
};

export type CloudCodeExecute = (
  request: CloudCodeExecutionRequest,
) => Promise<CloudCodeExecutionResult>;

export type CreateCloudCodeAgentToolOptions = Readonly<{
  loader: WorkerLoader;
  tools: readonly CloudCodeSourceAgentTool[];
  /** Stable owner-generation + conversation + turn identity. */
  executionScope: string;
  /** Test seam; production always uses the official Dynamic Worker executor. */
  executeCode?: CloudCodeExecute;
}>;

const NESTED_RESULT_LIMITS: BoundedJsonLimits = Object.freeze({
  maxBytes: CLOUD_CODE_NESTED_RESULT_MAX_BYTES,
  maxDepth: 16,
  maxNodes: 4_096,
  maxEntries: 4_096,
  maxStringBytes: CLOUD_CODE_NESTED_RESULT_MAX_BYTES,
});

const modelTextForResult = (result: CloudCodeExecutionResult): string => {
  const sections: string[] = [];
  if (result.ok) {
    sections.push(boundedJsonPreview(result.result, CLOUD_CODE_MODEL_OUTPUT_MAX_BYTES));
  } else {
    sections.push(`Error (${result.code}): ${result.error}`);
  }
  if (result.logs && result.logs.length > 0) {
    sections.push(`[console]\n${result.logs.join("\n")}`);
  }
  return truncateUtf8(
    sanitizeToolVisibleText(sections.filter(Boolean).join("\n\n")),
    CLOUD_CODE_MODEL_OUTPUT_MAX_BYTES,
  );
};

const nestedResultForCode = (
  rawName: string,
  result: AgentToolResult<unknown>,
): Readonly<{ content: AgentToolResult<unknown>["content"] }> => {
  if (result.isError) {
    throw new Error(`Nested tool "${rawName}" reported an error.`);
  }
  const value = cloneBoundedJsonValue(
    { content: result.content },
    NESTED_RESULT_LIMITS,
  );
  if (!value.ok) {
    throw new Error(`Nested tool "${rawName}" returned too much data.`);
  }
  return value.value as Readonly<{ content: AgentToolResult<unknown>["content"] }>;
};

const definitionForAgentTool = (
  tool: CloudCodeSourceAgentTool,
): CloudCodeToolDefinition => ({
  rawName: tool.name,
  description: tool.description,
  inputSchema: tool.parameters,
  ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
  approval: toolRequiresExplicitApproval(tool.approval)
    ? "required"
    : "not_required",
  execute: async (input, context) => {
    // TypeBox schemas can be checked without eval in workerd. Some discovered
    // MCP sources provide plain JSON Schema instead; those tools retain their
    // own host-side validation rather than compiling untrusted schemas with
    // Ajv/new Function in the Worker.
    if (
      Object.getOwnPropertySymbols(tool.parameters).includes(
        Symbol.for("TypeBox.Kind"),
      ) &&
      !Value.Check(tool.parameters, input)
    ) {
      throw new Error(`Nested tool "${tool.name}" received invalid arguments.`);
    }
    const result = await tool.execute(
      context.toolCallId,
      input as Record<string, unknown>,
      context.signal,
    );
    return nestedResultForCode(tool.name, result);
  },
});

const buildDescription = (
  typeDeclarations: string,
  mappings: readonly { rawName: string; sanitizedName: string }[],
): string => {
  const exactMappings = mappings
    .map(({ rawName, sanitizedName }) => `- ${sanitizedName} -> ${rawName}`)
    .join("\n");
  return `Run JavaScript in a fresh isolated Cloudflare Dynamic Worker. Pass an async function expression. The sandbox receives no Stella environment bindings or account secrets, and outbound network access is blocked; call host tools only through the typed \`codemode\` namespace. Only explicitly audited read-only tools are available inside code; unknown, mutating, destructive, and approval-required tools stay direct-only. One execution may make at most ${CLOUD_CODE_MAX_TOOL_CALLS} nested tool calls, with at most ${CLOUD_CODE_MAX_CONCURRENT_TOOL_CALLS} running concurrently. Return a structured-cloneable value.\n\nExact code identifier -> raw tool-name mapping:\n${exactMappings || "(no nested tools)"}\n\nAvailable types:\n\`\`\`ts\n${typeDeclarations}\n\`\`\``;
};

/**
 * Adapt the exact live AgentTool array—including discovered/MCP-style names—
 * into Cloudflare Code Mode without putting host bindings or credentials in
 * generated code.
 */
export const createCloudCodeAgentTool = (
  options: CreateCloudCodeAgentToolOptions,
): AgentTool => {
  const sourceTools = options.tools.filter(
    (tool) =>
      tool.name !== CODE_TOOL_NAME &&
      tool.name !== LEGACY_NODE_REPL_TOOL_NAME &&
      tool.codeEligibility === "read_only" &&
      !toolRequiresExplicitApproval(tool.approval),
  );
  const prepared = prepareCloudCodeTools(
    sourceTools.map(definitionForAgentTool),
  );
  const executeCode = options.executeCode ?? executeCloudCode;

  return {
    name: CODE_TOOL_NAME,
    label: "Code",
    workingText: "Running code",
    description: buildDescription(
      prepared.typeDeclarations,
      prepared.nameMappings,
    ),
    parameters: CLOUD_CODE_PARAMETERS as TSchema,
    execute: async (toolCallId, params, signal) => {
      const args = params as Static<typeof CLOUD_CODE_PARAMETERS>;
      const executionId = `code:${await sha256Hex(
        `${options.executionScope}\0${toolCallId}`,
      )}`;
      const result = await executeCode({
        loader: options.loader,
        code: args.code,
        tools: prepared,
        executionId,
        ...(args.timeout_ms === undefined
          ? {}
          : { timeoutMs: args.timeout_ms }),
        ...(signal ? { signal } : {}),
      });
      const text = modelTextForResult(result);
      return {
        content: [{ type: "text", text }],
        details: result.ok
          ? { code: { ok: true, output: text, toolCallId } }
          : {
              code: {
                ok: false,
                code: result.code,
                error: result.error,
                ...(result.tool ? { tool: result.tool } : {}),
                ...(result.cleanup ? { cleanup: result.cleanup } : {}),
                toolCallId,
              },
            },
        isError: !result.ok,
      };
    },
  };
};
