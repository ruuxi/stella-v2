const ROOT_COMBINATOR_KEYS = ["oneOf", "anyOf", "allOf"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

const objectBranches = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const intersectRequired = (branches: Record<string, unknown>[]): string[] => {
  if (branches.length === 0) return [];
  const [first, ...rest] = branches.map(
    (branch) => new Set(stringArray(branch.required)),
  );
  return [...first].filter((name) =>
    rest.every((required) => required.has(name)),
  );
};

/**
 * Return a provider-facing copy of a tool input schema.
 *
 * Anthropic custom tools reject root-level `oneOf`, `anyOf`, and `allOf`.
 * OpenAI-compatible routers can forward the same schema to Anthropic or to
 * other providers with similarly narrow tool-schema support, so normalize at
 * every wire boundary instead of keying the behavior to the selected model.
 *
 * Nested combinators remain intact. Root alternatives are conservatively
 * loosened into one object: branch properties are retained, `allOf` required
 * fields are unioned, and only fields required by every `oneOf`/`anyOf`
 * branch remain required. Stella keeps the original schema for execution-side
 * validation, so this compatibility copy cannot authorize invalid arguments.
 */
export const normalizeProviderToolInputSchema = (
  schema: Record<string, unknown>,
): Record<string, unknown> => {
  const normalized = structuredClone(schema);
  const rootProperties = isRecord(normalized.properties)
    ? normalized.properties
    : {};
  const properties: Record<string, unknown> = { ...rootProperties };
  const required = new Set(stringArray(normalized.required));

  for (const key of ROOT_COMBINATOR_KEYS) {
    const branches = objectBranches(normalized[key]);
    for (const branch of branches) {
      if (isRecord(branch.properties)) {
        Object.assign(properties, branch.properties);
      }
    }
    if (key === "allOf") {
      for (const branch of branches) {
        for (const name of stringArray(branch.required)) required.add(name);
      }
    } else {
      for (const name of intersectRequired(branches)) required.add(name);
    }
    delete normalized[key];
  }

  return {
    ...normalized,
    type: "object",
    properties,
    required: [...required],
  };
};
