import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";
import type { AnySchema, ErrorObject, ValidateFunction } from "ajv";

// Handle both default and named exports
const Ajv = (AjvModule as any).default || AjvModule;
const addFormats = (addFormatsModule as any).default || addFormatsModule;

import type { Tool, ToolCall } from "../types.js";

// Detect if we're in a browser extension environment with strict CSP
// Chrome extensions with Manifest V3 don't allow eval/Function constructor
const isBrowserExtension =
  typeof globalThis !== "undefined" &&
  (globalThis as any).chrome?.runtime?.id !== undefined;

function canUseRuntimeCodegen(): boolean {
  if (isBrowserExtension) {
    return false;
  }

  try {
    new Function("return true;");
    return true;
  } catch {
    return false;
  }
}

// Whether this runtime may generate code from strings is decided at first
// USE, never at module load. Workers permit `new Function` while the script
// is being evaluated and refuse it once requests are served ("Code generation
// from strings disallowed for this context"), so an init-time probe would
// report true and every later `ajv.compile` would throw inside a tool call.
// The probe is memoized after the first request-time check.
let runtimeCodegenAvailable: boolean | undefined;
const isRuntimeCodegenAvailable = (): boolean =>
  (runtimeCodegenAvailable ??= canUseRuntimeCodegen());

let ajv: any | undefined;
const getToolAjv = (): any | null => {
  if (!isRuntimeCodegenAvailable()) return null;
  if (ajv !== undefined) return ajv;
  try {
    ajv = new Ajv({
      allErrors: true,
      strict: false,
      coerceTypes: true,
    });
    addFormats(ajv);
  } catch (_e) {
    ajv = null;
    console.warn("AJV validation disabled due to CSP restrictions");
  }
  return ajv;
};

let schemaAjv: any | undefined;
const schemaValidators = new WeakMap<object, ValidateFunction>();

const getSchemaAjv = (): any | null => {
  if (!isRuntimeCodegenAvailable()) return null;
  if (schemaAjv !== undefined) return schemaAjv;
  try {
    schemaAjv = new Ajv({
      allErrors: true,
      strict: false,
      coerceTypes: false,
    });
    addFormats(schemaAjv);
  } catch (_e) {
    schemaAjv = null;
    console.warn("AJV schema validation disabled due to CSP restrictions");
  }
  return schemaAjv;
};

const getSchemaValidator = (
  schema: AnySchema,
): ValidateFunction | undefined => {
  const validatorAjv = getSchemaAjv();
  if (!validatorAjv) return undefined;
  if (typeof schema === "boolean") return validatorAjv.compile(schema);
  const cached = schemaValidators.get(schema);
  if (cached) return cached;
  const validator: ValidateFunction = validatorAjv.compile(schema);
  schemaValidators.set(schema, validator);
  return validator;
};

/** Validate an unknown value without coercing it. */
export function isJsonSchemaValue<T>(
  schema: AnySchema,
  value: unknown,
): value is T {
  const validate = getSchemaValidator(schema);
  // Match tool validation's existing CSP behavior when AJV cannot compile.
  return validate ? validate(value) : true;
}

/** Return AJV's validation failures in a stable, consumer-friendly shape. */
export function getJsonSchemaValidationErrors(
  schema: AnySchema,
  value: unknown,
): readonly ErrorObject[] {
  const validate = getSchemaValidator(schema);
  if (!validate || validate(value)) return [];
  return validate.errors ?? [];
}

/**
 * Finds a tool by name and validates the tool call arguments against its JSON schema
 * @param tools Array of tool definitions
 * @param toolCall The tool call from the LLM
 * @returns The validated arguments
 * @throws Error if tool is not found or validation fails
 */
export function validateToolCall(tools: Tool[], toolCall: ToolCall): any {
  const tool = tools.find((t) => t.name === toolCall.name);
  if (!tool) {
    throw new Error(`Tool "${toolCall.name}" not found`);
  }
  return validateToolArguments(tool, toolCall);
}

/**
 * Validates tool call arguments against the tool's JSON schema
 * @param tool The tool definition with a JSON schema
 * @param toolCall The tool call from the LLM
 * @returns The validated (and potentially coerced) arguments
 * @throws Error with formatted message if validation fails
 */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): any {
  // Skip validation in environments where runtime code generation is unavailable.
  const toolAjv = getToolAjv();
  if (!toolAjv) {
    return toolCall.arguments;
  }

  // Compile the schema.
  const validate = toolAjv.compile(tool.parameters);

  // Clone arguments so AJV can safely mutate for type coercion
  const args = structuredClone(toolCall.arguments);

  // Validate the arguments (AJV mutates args in-place for type coercion)
  if (validate(args)) {
    return args;
  }

  // Format validation errors nicely
  const errors =
    validate.errors
      ?.map((err: any) => {
        const path = err.instancePath
          ? err.instancePath.substring(1)
          : err.params.missingProperty || "root";
        return `  - ${path}: ${err.message}`;
      })
      .join("\n") || "Unknown validation error";

  const errorMessage = `Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`;

  throw new Error(errorMessage);
}
