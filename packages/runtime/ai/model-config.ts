// STELLA-GUARD: model-provider-config
// This file resolves model-provider credentials and headers from user-owned
// configuration. Do not log resolved values or weaken secret handling.

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { AnySchema } from "ajv";
import {
  getJsonSchemaValidationErrors,
  isJsonSchemaValue,
} from "./utils/validation.js";
import type { Api, Model } from "./types.js";

export type ModelsJsonModel = Partial<
  Omit<Model<Api>, "id" | "name" | "provider" | "baseUrl" | "api">
> & {
  id: string;
  name?: string;
  api?: Api;
  baseUrl?: string;
};

export type ModelsJsonModelOverride = Partial<
  Pick<
    Model<Api>,
    | "name"
    | "reasoning"
    | "thinkingLevelMap"
    | "input"
    | "cost"
    | "contextWindow"
    | "maxTokens"
    | "toolOutputTokenLimit"
    | "headers"
    | "compat"
  >
>;

export type ModelsJsonProvider = {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: Api;
  headers?: Record<string, string>;
  compat?: Model<Api>["compat"];
  authHeader?: boolean;
  models?: ModelsJsonModel[];
  modelOverrides?: Record<string, ModelsJsonModelOverride>;
};

export type RemoteCatalogModel = Omit<Model<Api>, "provider" | "cost"> & {
  provider?: string;
  cost?: Model<Api>["cost"];
};

type ModelsJson = {
  providers: Record<string, ModelsJsonProvider>;
};

const stringSchema = { type: "string" } as const;
const numberSchema = { type: "number" } as const;
const booleanSchema = { type: "boolean" } as const;
const nullSchema = { type: "null" } as const;
const nonEmptyStringSchema = { type: "string", minLength: 1 } as const;
const nullableStringSchema = {
  anyOf: [stringSchema, nullSchema],
} as const;
const stringRecordSchema = {
  type: "object",
  patternProperties: { "^(.*)$": stringSchema },
} as const;
const textOrImageSchema = {
  anyOf: [
    { const: "text", type: "string" },
    { const: "image", type: "string" },
  ],
} as const;
const stringOrNumberSchema = {
  anyOf: [stringSchema, numberSchema],
} as const;
const thinkingLevelMapSchema = {
  type: "object",
  properties: {
    off: nullableStringSchema,
    minimal: nullableStringSchema,
    low: nullableStringSchema,
    medium: nullableStringSchema,
    high: nullableStringSchema,
    xhigh: nullableStringSchema,
  },
} as const;
const percentileCutoffsSchema = {
  type: "object",
  properties: {
    p50: numberSchema,
    p75: numberSchema,
    p90: numberSchema,
    p99: numberSchema,
  },
} as const;
const chatTemplateKwargSchema = {
  anyOf: [
    stringSchema,
    numberSchema,
    booleanSchema,
    nullSchema,
    {
      type: "object",
      properties: {
        $var: {
          anyOf: [
            { const: "thinking.enabled", type: "string" },
            { const: "thinking.effort", type: "string" },
          ],
        },
        omitWhenOff: booleanSchema,
      },
      required: ["$var"],
    },
  ],
} as const;
const compatSchema = {
  type: "object",
  properties: {
    supportsStore: booleanSchema,
    supportsDeveloperRole: booleanSchema,
    supportsReasoningEffort: booleanSchema,
    supportsUsageInStreaming: booleanSchema,
    maxTokensField: {
      anyOf: [
        { const: "max_completion_tokens", type: "string" },
        { const: "max_tokens", type: "string" },
      ],
    },
    requiresToolResultName: booleanSchema,
    requiresAssistantAfterToolResult: booleanSchema,
    requiresThinkingAsText: booleanSchema,
    requiresReasoningContentOnAssistantMessages: booleanSchema,
    replayReasoningContentField: booleanSchema,
    thinkingFormat: {
      anyOf: [
        { const: "openai", type: "string" },
        { const: "openrouter", type: "string" },
        { const: "deepseek", type: "string" },
        { const: "zai", type: "string" },
        { const: "qwen", type: "string" },
        { const: "chat-template", type: "string" },
        { const: "qwen-chat-template", type: "string" },
      ],
    },
    chatTemplateKwargs: {
      type: "object",
      patternProperties: { "^(.*)$": chatTemplateKwargSchema },
    },
    openRouterRouting: {
      type: "object",
      properties: {
        allow_fallbacks: booleanSchema,
        require_parameters: booleanSchema,
        data_collection: {
          anyOf: [
            { const: "deny", type: "string" },
            { const: "allow", type: "string" },
          ],
        },
        zdr: booleanSchema,
        enforce_distillable_text: booleanSchema,
        order: { type: "array", items: stringSchema },
        only: { type: "array", items: stringSchema },
        ignore: { type: "array", items: stringSchema },
        quantizations: { type: "array", items: stringSchema },
        sort: {
          anyOf: [
            stringSchema,
            {
              type: "object",
              properties: {
                by: stringSchema,
                partition: nullableStringSchema,
              },
            },
          ],
        },
        max_price: {
          type: "object",
          properties: {
            prompt: stringOrNumberSchema,
            completion: stringOrNumberSchema,
            image: stringOrNumberSchema,
            audio: stringOrNumberSchema,
            request: stringOrNumberSchema,
          },
        },
        preferred_min_throughput: {
          anyOf: [numberSchema, percentileCutoffsSchema],
        },
        preferred_max_latency: {
          anyOf: [numberSchema, percentileCutoffsSchema],
        },
      },
    },
    vercelGatewayRouting: {
      type: "object",
      properties: {
        only: { type: "array", items: stringSchema },
        order: { type: "array", items: stringSchema },
      },
    },
    zaiToolStream: booleanSchema,
    supportsStrictMode: booleanSchema,
    cacheControlFormat: { const: "anthropic", type: "string" },
    sendSessionAffinityHeaders: booleanSchema,
    sendSessionIdHeader: booleanSchema,
    supportsLongCacheRetention: booleanSchema,
    supportsEagerToolInputStreaming: booleanSchema,
    // dormant: nothing reads these since tool_search removal; kept only so
    // generated model catalogs (contracts/models.generated.ts) still validate.
    supportsToolReferences: booleanSchema,
    supportsToolSearch: booleanSchema,
    deferredToolsMode: { const: "kimi", type: "string" },
  },
} as const;
const costSchema = {
  type: "object",
  properties: {
    input: numberSchema,
    output: numberSchema,
    cacheRead: numberSchema,
    cacheWrite: numberSchema,
  },
} as const;
const remoteCatalogCostSchema = {
  type: "object",
  properties: {
    input: { type: "number", minimum: 0 },
    output: { type: "number", minimum: 0 },
    cacheRead: { type: "number", minimum: 0 },
    cacheWrite: { type: "number", minimum: 0 },
  },
  required: ["input", "output", "cacheRead", "cacheWrite"],
} as const;
const openRouterAutoSentinelCostSchema = {
  type: "object",
  properties: {
    input: { const: -1_000_000, type: "number" },
    output: { const: -1_000_000, type: "number" },
    cacheRead: { const: 0, type: "number" },
    cacheWrite: { const: 0, type: "number" },
  },
  required: ["input", "output", "cacheRead", "cacheWrite"],
} as const;
const modelFieldProperties = {
  name: nonEmptyStringSchema,
  reasoning: booleanSchema,
  thinkingLevelMap: thinkingLevelMapSchema,
  input: { type: "array", items: textOrImageSchema },
  cost: costSchema,
  contextWindow: { type: "number", exclusiveMinimum: 0 },
  maxTokens: { type: "number", exclusiveMinimum: 0 },
  toolOutputTokenLimit: { type: "number", exclusiveMinimum: 0 },
  headers: stringRecordSchema,
  compat: compatSchema,
} as const;
const modelDefinitionSchema = {
  type: "object",
  properties: {
    id: nonEmptyStringSchema,
    api: nonEmptyStringSchema,
    baseUrl: nonEmptyStringSchema,
    ...modelFieldProperties,
  },
  required: ["id"],
} as const satisfies AnySchema;
const modelOverrideSchema = {
  type: "object",
  properties: modelFieldProperties,
} as const satisfies AnySchema;
const providerSchema = {
  type: "object",
  properties: {
    name: nonEmptyStringSchema,
    baseUrl: nonEmptyStringSchema,
    apiKey: nonEmptyStringSchema,
    api: nonEmptyStringSchema,
    headers: stringRecordSchema,
    compat: compatSchema,
    authHeader: booleanSchema,
    models: { type: "array", items: modelDefinitionSchema },
    modelOverrides: {
      type: "object",
      patternProperties: { "^(.*)$": modelOverrideSchema },
    },
  },
} as const satisfies AnySchema;
const modelsJsonSchema = {
  type: "object",
  properties: {
    providers: {
      type: "object",
      patternProperties: { "^(.*)$": providerSchema },
    },
  },
  required: ["providers"],
} as const satisfies AnySchema;

const remoteCatalogModelProperties = {
  id: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  provider: nonEmptyStringSchema,
  reasoning: booleanSchema,
  thinkingLevelMap: thinkingLevelMapSchema,
  input: { type: "array", items: textOrImageSchema },
  cost: remoteCatalogCostSchema,
  contextWindow: { type: "number", exclusiveMinimum: 0 },
  maxTokens: { type: "number", exclusiveMinimum: 0 },
  headers: stringRecordSchema,
  compat: compatSchema,
} as const;
const remoteCatalogRequired = [
  "id",
  "name",
  "reasoning",
  "input",
  "contextWindow",
  "maxTokens",
] as const;
const remoteCatalogModelSchema = {
  type: "object",
  properties: {
    ...remoteCatalogModelProperties,
    api: nonEmptyStringSchema,
    baseUrl: nonEmptyStringSchema,
  },
  required: [...remoteCatalogRequired, "api", "baseUrl"],
} as const satisfies AnySchema;
// Azure deployments resolve their endpoint from request options or the user's
// resource configuration, so their catalog models intentionally use an empty
// baseUrl. Key this exception to the transport contract rather than the
// provider name; every other remote transport still requires a URL.
const azureRemoteCatalogModelSchema = {
  type: "object",
  properties: {
    ...remoteCatalogModelProperties,
    api: { const: "azure-openai-responses", type: "string" },
    baseUrl: stringSchema,
  },
  required: [...remoteCatalogRequired, "api", "baseUrl"],
} as const satisfies AnySchema;
// OpenRouter's automatic router cannot know the selected upstream model's
// price until request routing. Its catalog uses this exact sentinel contract;
// keep the exception pinned to that transport/model shape so no other
// negative or non-finite cost can enter the runtime catalog.
const openRouterAutoRemoteCatalogModelSchema = {
  type: "object",
  properties: {
    ...remoteCatalogModelProperties,
    id: { const: "openrouter/auto", type: "string" },
    provider: { const: "openrouter", type: "string" },
    api: { const: "openai-completions", type: "string" },
    baseUrl: {
      const: "https://openrouter.ai/api/v1",
      type: "string",
    },
    cost: openRouterAutoSentinelCostSchema,
  },
  required: [...remoteCatalogRequired, "provider", "cost", "api", "baseUrl"],
} as const satisfies AnySchema;

// `providerId` is the authoritative identity derived from the fetched
// endpoint/cache key. Entry-controlled `provider` metadata is not trusted to
// select provider-specific validation exceptions before the runtime overwrites
// it during composition.
const remoteCatalogSchemaFor = (
  providerId: string,
  value: unknown,
): AnySchema => {
  if (!value || typeof value !== "object") return remoteCatalogModelSchema;
  if (
    providerId === "openrouter" &&
    "id" in value &&
    value.id === "openrouter/auto"
  ) {
    return openRouterAutoRemoteCatalogModelSchema;
  }
  return "api" in value && value.api === "azure-openai-responses"
    ? azureRemoteCatalogModelSchema
    : remoteCatalogModelSchema;
};

export const isRemoteCatalogModel = (
  providerId: string,
  value: unknown,
): value is RemoteCatalogModel =>
  isJsonSchemaValue<RemoteCatalogModel>(
    remoteCatalogSchemaFor(providerId, value),
    value,
  );

export const getRemoteCatalogModelValidationErrors = (
  providerId: string,
  value: unknown,
): string[] =>
  getJsonSchemaValidationErrors(
    remoteCatalogSchemaFor(providerId, value),
    value,
  )
    .slice(0, 8)
    .map(
      (error) =>
        `${error.instancePath || "root"}: ${error.message ?? "is invalid"}`,
    );

/** Strip JSONC line comments and trailing commas without touching strings. */
const stripJsonComments = (value: string): string =>
  value
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/gu, (match) =>
      match[0] === '"' ? match : "",
    )
    .replace(
      /"(?:\\.|[^"\\])*"|,(\s*[}\]])/gu,
      (match, tail: string | undefined) =>
        tail ?? (match[0] === '"' ? match : ""),
    );

export class ModelConfig {
  private constructor(
    private readonly providers: ReadonlyMap<string, ModelsJsonProvider>,
    private readonly error?: string,
  ) {}

  static empty(): ModelConfig {
    return new ModelConfig(new Map());
  }

  static async load(filePath: string | undefined): Promise<ModelConfig> {
    if (!filePath) return new ModelConfig(new Map());
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return new ModelConfig(new Map());
      }
      return new ModelConfig(
        new Map(),
        `Failed to load models.json: ${error instanceof Error ? error.message : String(error)}\n\nFile: ${filePath}`,
      );
    }

    try {
      const parsed = JSON.parse(stripJsonComments(content)) as unknown;
      if (!isJsonSchemaValue<ModelsJson>(modelsJsonSchema, parsed)) {
        const details = getJsonSchemaValidationErrors(modelsJsonSchema, parsed)
          .slice(0, 8)
          .map(
            (error) =>
              `  - ${error.instancePath || "root"}: ${error.message ?? "is invalid"}`,
          )
          .join("\n");
        throw new Error(`Invalid models.json schema:\n${details}`);
      }
      const providers = new Map<string, ModelsJsonProvider>();
      for (const [providerId, provider] of Object.entries(parsed.providers)) {
        if (!providerId.trim()) {
          throw new Error(`Invalid provider configuration: ${providerId}`);
        }
        providers.set(providerId, structuredClone(provider));
      }
      return new ModelConfig(providers);
    } catch (error) {
      return new ModelConfig(
        new Map(),
        `Failed to parse models.json: ${error instanceof Error ? error.message : String(error)}\n\nFile: ${filePath}`,
      );
    }
  }

  getProvider(providerId: string): ModelsJsonProvider | undefined {
    return this.providers.get(providerId);
  }

  getProviderIds(): readonly string[] {
    return [...this.providers.keys()];
  }

  getError(): string | undefined {
    return this.error;
  }
}

const ENV_REFERENCE =
  /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/gu;

export const getModelConfigCommandInvocation = (
  command: string,
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
  } = {},
): { executable: string; args: string[] } => {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform === "win32") {
    const comspec = Object.entries(env).find(
      ([name, value]) => name.toLowerCase() === "comspec" && Boolean(value),
    )?.[1];
    return {
      executable: comspec || "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }
  return {
    executable: env.SHELL || "/bin/sh",
    args: ["-lc", command],
  };
};

export const resolveModelConfigValue = (
  config: string | undefined,
): string | undefined => {
  if (!config) return undefined;
  if (config.startsWith("!")) {
    try {
      const invocation = getModelConfigCommandInvocation(config.slice(1));
      const value = execFileSync(invocation.executable, invocation.args, {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }).trim();
      return value || undefined;
    } catch {
      return undefined;
    }
  }

  let missing = false;
  const escapedDollar = "\u0000stella-dollar\u0000";
  const escapedBang = "\u0000stella-bang\u0000";
  const resolved = config
    .replace(/\$\$/gu, escapedDollar)
    .replace(/\$!/gu, escapedBang)
    .replace(ENV_REFERENCE, (_match, braced: string, bare: string) => {
      const value = process.env[braced || bare];
      if (value === undefined) missing = true;
      return value ?? "";
    })
    .replaceAll(escapedDollar, "$")
    .replaceAll(escapedBang, "!");
  return missing ? undefined : resolved;
};

export const isModelConfigValueConfigured = (
  config: string | undefined,
): boolean => {
  if (!config) return false;
  if (config.startsWith("!")) return config.slice(1).trim().length > 0;
  let missing = false;
  config
    .replace(/\$\$/gu, "")
    .replace(/\$!/gu, "")
    .replace(ENV_REFERENCE, (_match, braced: string, bare: string) => {
      if (process.env[braced || bare] === undefined) missing = true;
      return "";
    });
  return !missing;
};

export const resolveModelConfigHeaders = (
  headers: Record<string, string> | undefined,
  context: string,
): Record<string, string> | undefined => {
  if (!headers) return undefined;
  const resolved: Record<string, string> = {};
  for (const [name, config] of Object.entries(headers)) {
    const value = resolveModelConfigValue(config);
    if (value === undefined) {
      throw new Error(
        `Required models.json header "${name}" for ${context} could not be resolved.`,
      );
    }
    resolved[name] = value;
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
};
