/**
 * Demoted-tool catalog helpers.
 *
 * Demoted tools leave the model's direct tool list whenever `node_repl` is
 * available and become callable only as `tools.<name>(args)` inside the REPL.
 * This module renders the compact TypeScript-style signature catalog that is
 * appended to node_repl's description each turn, and implements the
 * deterministic scorer behind the in-REPL `tools.$search({ query })` lookup.
 *
 * Everything here is pure and never throws: a malformed schema degrades to
 * `unknown`, a malformed catalog degrades to an empty section/result list.
 */

export type DemotedToolCatalogEntry = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  resultSchema?: Record<string, unknown>;
  approval?: unknown;
  sideEffects?: unknown;
  reversible?: boolean;
  annotations?: Record<string, unknown>;
  label?: string;
  workingText?: string;
  demoted?: {
    searchTerms?: readonly string[];
    requiredConnectorProvider?: string;
  };
};

export type ToolSearchResult = {
  name: string;
  signature: string;
  description?: string;
};

/** Full, lossless docs returned only after an authorized `$describe` call. */
export type ToolDescription = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  invocation: string;
  outputSchema?: Record<string, unknown>;
  resultSchema?: Record<string, unknown>;
  approval?: unknown;
  sideEffects?: unknown;
  reversible?: boolean;
  annotations?: Record<string, unknown>;
  label?: string;
  workingText?: string;
};

const MAX_SCHEMA_RENDER_DEPTH = 6;
const MAX_COMMENT_CHARS = 120;
/** Union/enum members rendered before collapsing the tail into "…". */
const MAX_UNION_MEMBERS = 8;
/**
 * Hard cap on one rendered signature inside a `$search` result. Keeps any
 * result far below MAX_NODE_REPL_PROTOCOL_MESSAGE_BYTES so the kernel's
 * all-or-nothing protocol-size failure is unreachable in practice.
 */
const MAX_SEARCH_SIGNATURE_CHARS = 2000;
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Estimated tokens for budget accounting: chars / 4, rounded up. */
const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export const DEFAULT_CATALOG_TOKEN_BUDGET = 2000;

const renderKey = (key: string): string =>
  IDENTIFIER_RE.test(key) ? key : JSON.stringify(key);

const renderLiteral = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "unknown";
  } catch {
    return "unknown";
  }
};

const dedupeUnion = (parts: string[]): string => {
  const unique = [...new Set(parts.filter((part) => part.length > 0))];
  if (unique.length === 0) return "unknown";
  if (unique.length > MAX_UNION_MEMBERS) {
    return [...unique.slice(0, MAX_UNION_MEMBERS), "…"].join(" | ");
  }
  return unique.join(" | ");
};

const renderSchema = (schema: unknown, depth: number): string => {
  if (depth > MAX_SCHEMA_RENDER_DEPTH) return "unknown";
  if (schema === true) return "unknown";
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return "unknown";
  }
  const record = schema as Record<string, unknown>;
  if ("const" in record) return renderLiteral(record.const);
  if (Array.isArray(record.enum)) {
    return dedupeUnion(record.enum.map(renderLiteral));
  }
  const variants = Array.isArray(record.anyOf)
    ? record.anyOf
    : Array.isArray(record.oneOf)
      ? record.oneOf
      : null;
  if (variants) {
    return dedupeUnion(
      variants.map((variant) => schemaToTs(variant, depth + 1)),
    );
  }
  const type = record.type;
  if (Array.isArray(type)) {
    return dedupeUnion(
      type.map((entry) => schemaToTs({ ...record, type: entry }, depth + 1)),
    );
  }
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const items = schemaToTs(record.items, depth + 1);
      return `Array<${items}>`;
    }
    case "object": {
      const properties =
        record.properties &&
        typeof record.properties === "object" &&
        !Array.isArray(record.properties)
          ? (record.properties as Record<string, unknown>)
          : null;
      if (!properties || Object.keys(properties).length === 0) {
        return "Record<string, unknown>";
      }
      const required = new Set(
        Array.isArray(record.required)
          ? record.required.filter(
              (entry): entry is string => typeof entry === "string",
            )
          : [],
      );
      const fields = Object.entries(properties).map(
        ([key, propertySchema]) =>
          `${renderKey(key)}${required.has(key) ? "" : "?"}: ${schemaToTs(propertySchema, depth + 1)}`,
      );
      return `{ ${fields.join("; ")} }`;
    }
    default:
      return "unknown";
  }
};

/** Minimal JSON-Schema → TypeScript-ish renderer. Never throws. */
export const schemaToTs = (schema: unknown, depth = 0): string => {
  try {
    return renderSchema(schema, depth);
  } catch {
    return "unknown";
  }
};

/** `tools.<name>(input: {...}): Promise<unknown>` — never throws. */
export const renderToolSignature = (tool: {
  name: string;
  parameters?: Record<string, unknown>;
}): string => {
  try {
    return `tools.${tool.name}(input: ${schemaToTs(tool.parameters)}): Promise<unknown>`;
  } catch {
    return `tools.${tool.name}(input: unknown): Promise<unknown>`;
  }
};

const firstDescriptionLine = (
  description: unknown,
  maxChars = MAX_COMMENT_CHARS,
): string => {
  if (typeof description !== "string") return "";
  const line = description.split("\n", 1)[0]?.trim() ?? "";
  if (line.length <= maxChars) return line;
  return `${line.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
};

const namespaceOf = (tool: DemotedToolCatalogEntry): string => {
  const provider = tool.demoted?.requiredConnectorProvider;
  if (typeof provider === "string" && provider.length > 0) return provider;
  const head = tool.name.split("_", 1)[0];
  return head && head.length > 0 ? head : tool.name;
};

type CatalogBlock = {
  tool: DemotedToolCatalogEntry;
  text: string;
  cost: number;
};

const renderToolBlock = (tool: DemotedToolCatalogEntry): CatalogBlock => {
  const comment = firstDescriptionLine(tool.description);
  const lines = comment ? [`// ${comment}`] : [];
  lines.push(renderToolSignature(tool));
  const text = lines.join("\n");
  return { tool, text, cost: estimateTokens(`${text}\n`) };
};

/**
 * Token-budgeted catalog section for node_repl's description.
 *
 * Tools are grouped by namespace (`demoted.requiredConnectorProvider`,
 * falling back to the `<prefix>` of `<prefix>_rest` names). Within each
 * namespace the cheapest signatures are preferred; namespaces are drained
 * round-robin against one shared budget so a single verbose namespace cannot
 * starve the rest. Namespace stub lines and the header are free — only tool
 * comment+signature blocks count against the budget.
 */
export const buildCatalogSection = (
  demoted: readonly DemotedToolCatalogEntry[],
  budgetTokens = DEFAULT_CATALOG_TOKEN_BUDGET,
): string => {
  try {
    const valid = (demoted ?? []).filter(
      (tool): tool is DemotedToolCatalogEntry =>
        Boolean(tool) && typeof tool.name === "string" && tool.name.length > 0,
    );
    if (valid.length === 0) return "";

    const namespaces = new Map<string, CatalogBlock[]>();
    for (const tool of valid) {
      const namespace = namespaceOf(tool);
      const queue = namespaces.get(namespace) ?? [];
      queue.push(renderToolBlock(tool));
      namespaces.set(namespace, queue);
    }
    for (const queue of namespaces.values()) {
      queue.sort(
        (left, right) =>
          left.cost - right.cost ||
          left.tool.name.localeCompare(right.tool.name),
      );
    }

    const namespaceNames = [...namespaces.keys()].sort((left, right) =>
      left.localeCompare(right),
    );
    const shown = new Map<string, CatalogBlock[]>(
      namespaceNames.map((name) => [name, []]),
    );
    let remaining = Number.isFinite(budgetTokens)
      ? Math.max(0, budgetTokens)
      : DEFAULT_CATALOG_TOKEN_BUDGET;
    // Stub lines are always rendered (they are the map of what exists), but
    // they still consume the shared budget so the section cannot grow
    // unboundedly with namespace count. Estimated with the widest "shown"
    // variant; only the header stays free.
    for (const name of namespaceNames) {
      const total = namespaces.get(name)?.length ?? 0;
      const stubEstimate = estimateTokens(
        `- ${name} (${total} tool${total === 1 ? "" : "s"}, ${total} shown)\n`,
      );
      remaining = Math.max(0, remaining - stubEstimate);
    }
    const rotation = namespaceNames.filter(
      (name) => (namespaces.get(name)?.length ?? 0) > 0,
    );
    const cursors = new Map<string, number>(rotation.map((name) => [name, 0]));
    let active = [...rotation];
    while (active.length > 0) {
      const next: string[] = [];
      for (const name of active) {
        const queue = namespaces.get(name) ?? [];
        const cursor = cursors.get(name) ?? 0;
        const block = queue[cursor];
        if (!block) continue;
        if (block.cost > remaining) {
          // Cheapest-first queue: nothing later in this namespace fits either.
          continue;
        }
        remaining -= block.cost;
        shown.get(name)?.push(block);
        cursors.set(name, cursor + 1);
        if (cursor + 1 < queue.length) next.push(name);
      }
      // Every namespace in `next` consumed a block this pass, so the loop
      // makes progress toward the finite block count and must terminate.
      active = next;
    }

    const shownCount = [...shown.values()].reduce(
      (sum, blocks) => sum + blocks.length,
      0,
    );
    const total = valid.length;
    const header =
      shownCount === total
        ? `## Demoted tools (COMPLETE — all ${total} shown; call via tools.<name> inside node_repl)`
        : `## Demoted tools (PARTIAL — ${shownCount} of ${total} shown; find the rest with await tools.$search({ query }))`;

    const lines: string[] = [header];
    for (const name of namespaceNames) {
      const totalInNamespace = namespaces.get(name)?.length ?? 0;
      const shownBlocks = [...(shown.get(name) ?? [])].sort((left, right) =>
        left.tool.name.localeCompare(right.tool.name),
      );
      lines.push(
        `- ${name} (${totalInNamespace} tool${totalInNamespace === 1 ? "" : "s"}, ${shownBlocks.length} shown)`,
      );
      for (const block of shownBlocks) lines.push(block.text);
    }
    return lines.join("\n");
  } catch {
    return "";
  }
};

const singularize = (token: string): string =>
  token.length > 3 && token.endsWith("s") && !token.endsWith("ss")
    ? token.slice(0, -1)
    : token;

/** camelCase- and snake_case-aware tokenizer with naive singularization. */
export const tokenizeToolQuery = (value: string): string[] => {
  if (typeof value !== "string") return [];
  const spaced = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  const tokens = spaced
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  return [...new Set(tokens.map(singularize))];
};

const collectPropertyText = (
  schema: unknown,
  depth: number,
  sink: string[],
): void => {
  if (depth > MAX_SCHEMA_RENDER_DEPTH) return;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  const record = schema as Record<string, unknown>;
  const properties =
    record.properties &&
    typeof record.properties === "object" &&
    !Array.isArray(record.properties)
      ? (record.properties as Record<string, unknown>)
      : null;
  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      sink.push(key);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const description = (value as Record<string, unknown>).description;
        if (typeof description === "string") sink.push(description);
        collectPropertyText(value, depth + 1, sink);
      }
    }
  }
  if (record.items) collectPropertyText(record.items, depth + 1, sink);
};

/**
 * Deterministic relevance score for one tool against pre-tokenized query
 * terms. Weights: exact name 20 > name substring 8 > description/search-term
 * text 4 > input property text 2. Never throws; garbage scores 0.
 */
export const scoreToolSearch = (
  tool: DemotedToolCatalogEntry,
  queryTokens: readonly string[],
): number => {
  try {
    if (!tool || typeof tool.name !== "string" || queryTokens.length === 0) {
      return 0;
    }
    const nameLower = tool.name.toLowerCase();
    const nameTokens = new Set(tokenizeToolQuery(tool.name));
    const descriptionText = [
      typeof tool.description === "string" ? tool.description : "",
      ...(tool.demoted?.searchTerms ?? []),
    ]
      .join(" ")
      .toLowerCase();
    const propertySink: string[] = [];
    collectPropertyText(tool.parameters, 0, propertySink);
    const propertyText = propertySink.join(" ").toLowerCase();

    let score = 0;
    for (const token of queryTokens) {
      if (token === singularize(nameLower) || token === nameLower) {
        score += 20;
      } else if (nameLower.includes(token) || nameTokens.has(token)) {
        score += 8;
      }
      if (descriptionText.includes(token)) score += 4;
      if (propertyText.includes(token)) score += 2;
    }
    return score;
  } catch {
    return 0;
  }
};

const clampSearchLimit = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 6;
  return Math.max(1, Math.min(12, Math.floor(value)));
};

const toSearchResult = (tool: DemotedToolCatalogEntry): ToolSearchResult => {
  const description = firstDescriptionLine(tool.description, 200);
  const rendered = renderToolSignature(tool);
  const signature =
    rendered.length > MAX_SEARCH_SIGNATURE_CHARS
      ? `${rendered.slice(0, MAX_SEARCH_SIGNATURE_CHARS - 1)}…`
      : rendered;
  return {
    name: tool.name,
    signature,
    ...(description ? { description } : {}),
  };
};

/**
 * Rank `tools` against `query` and return compact callable signatures. Full
 * JSON schemas deliberately remain host-side until `$describe` selects one
 * exact tool. An exact name query short-circuits straight to that tool. Ties
 * break by name for determinism. Never throws.
 */
export const searchToolCatalog = (
  tools: readonly DemotedToolCatalogEntry[],
  query: string,
  limit?: number,
): ToolSearchResult[] => {
  try {
    const valid = (tools ?? []).filter(
      (tool): tool is DemotedToolCatalogEntry =>
        Boolean(tool) && typeof tool.name === "string" && tool.name.length > 0,
    );
    const normalized =
      typeof query === "string" ? query.trim().toLowerCase() : "";
    if (!normalized) return [];
    const exact = valid.filter(
      (tool) => tool.name.toLowerCase() === normalized,
    );
    if (exact.length > 0) return exact.map(toSearchResult);
    const queryTokens = tokenizeToolQuery(normalized);
    return valid
      .map((tool) => ({ tool, score: scoreToolSearch(tool, queryTokens) }))
      .filter((entry) => entry.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.tool.name.localeCompare(right.tool.name),
      )
      .slice(0, clampSearchLimit(limit))
      .map((entry) => toSearchResult(entry.tool));
  } catch {
    return [];
  }
};

/**
 * Build full on-demand documentation for one exact tool. This helper performs
 * no lookup or authorization itself; callers must first select from the live,
 * context-filtered catalog used for invocation.
 */
export const describeToolCatalogEntry = (
  tool: DemotedToolCatalogEntry & {
    description: string;
    parameters: Record<string, unknown>;
  },
): ToolDescription => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.parameters,
  invocation: `tools.${tool.name}(args)`,
  ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
  ...(tool.resultSchema ? { resultSchema: tool.resultSchema } : {}),
  ...(tool.approval !== undefined ? { approval: tool.approval } : {}),
  ...(tool.sideEffects !== undefined ? { sideEffects: tool.sideEffects } : {}),
  ...(tool.reversible !== undefined ? { reversible: tool.reversible } : {}),
  ...(tool.annotations ? { annotations: tool.annotations } : {}),
  ...(tool.label ? { label: tool.label } : {}),
  ...(tool.workingText ? { workingText: tool.workingText } : {}),
});
