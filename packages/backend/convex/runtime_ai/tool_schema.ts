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

export const normalizeProviderToolInputSchema = (
  schema: Record<string, unknown>,
): Record<string, unknown> => {
  const normalized = structuredClone(schema);
  const properties: Record<string, unknown> = isRecord(normalized.properties)
    ? { ...normalized.properties }
    : {};
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
