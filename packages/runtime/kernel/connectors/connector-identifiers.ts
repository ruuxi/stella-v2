const CONNECTOR_ID_ALIASES = {
  people_data_labs: "peopledatalabs",
} as const;

const TOOLKIT_BY_CONNECTOR_ID = {
  "21risk": "_21risk",
  "2chat": "_2chat",
  "1password": "_1password",
} as const;

export const canonicalizeConnectorId = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  return (
    CONNECTOR_ID_ALIASES[normalized as keyof typeof CONNECTOR_ID_ALIASES] ??
    normalized
  );
};

export const compatibleConnectorIds = (value: string): readonly string[] => {
  const canonical = canonicalizeConnectorId(value);
  const aliases = Object.entries(CONNECTOR_ID_ALIASES)
    .filter(([, target]) => target === canonical)
    .map(([alias]) => alias);
  return [canonical, ...aliases];
};

export const normalizeBackendComposioIdentity = (
  idValue: string,
  toolkitValue: string,
): { id: string; toolkit: string } | null => {
  const id = canonicalizeConnectorId(idValue);
  const rawToolkit = toolkitValue.trim().toLowerCase();
  const toolkit = canonicalizeConnectorId(rawToolkit);
  const expectedToolkit =
    TOOLKIT_BY_CONNECTOR_ID[id as keyof typeof TOOLKIT_BY_CONNECTOR_ID] ?? id;
  if (
    !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(id) ||
    !/^_?[a-z0-9][a-z0-9_-]{0,127}$/u.test(rawToolkit) ||
    toolkit !== expectedToolkit
  ) {
    return null;
  }
  return { id, toolkit: expectedToolkit.toUpperCase() };
};

export const isSafeBackendComposioActionName = (
  idValue: string,
  actionName: string,
): boolean => {
  if (/^[A-Z][A-Z0-9_]{1,127}$/u.test(actionName)) return true;
  const connectorId = canonicalizeConnectorId(idValue);
  return (
    (connectorId === "44api" && /^44API_[A-Z0-9_]{1,122}$/u.test(actionName)) ||
    (connectorId === "7shifts" &&
      /^7SHIFTS_[A-Z0-9_]{1,120}$/u.test(actionName))
  );
};
