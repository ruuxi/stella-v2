/**
 * Pure connector-match scorer shared by device discovery, the device
 * `connector_status` tool, and the cloud connect client. No I/O here: the
 * caller is a language model that already did the semantic work of picking
 * keywords, so this only ranks catalog entries against those tokens.
 */

export type ConnectorScoreFields = {
  id: string;
  name: string;
  category?: string;
  description?: string;
};

/** Lower-cased, de-duplicated alphanumeric tokens of a free-text query. */
export const tokenizeConnectorQuery = (value: string): string[] => [
  ...new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length > 1),
  ),
];

/**
 * Shared by connector discovery and direct connector-status resolution.
 * Exact id/name hits dominate so `discover gmail` always puts the Gmail
 * integration first even though "mail" appears in dozens of descriptions.
 */
export const scoreConnectorMatch = (
  tokens: readonly string[],
  fields: ConnectorScoreFields,
): number => {
  if (tokens.length === 0) return 0;
  const id = fields.id.toLowerCase();
  const name = fields.name.toLowerCase();
  const nameTokens = name.split(/[^a-z0-9]+/u).filter(Boolean);
  const idTokens = id.split(/[^a-z0-9]+/u).filter(Boolean);
  const category = (fields.category ?? "").toLowerCase();
  const description = (fields.description ?? "").toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (id === token || name === token) {
      score += 50;
    } else if (idTokens.includes(token) || nameTokens.includes(token)) {
      score += 30;
    } else if (
      idTokens.some((entry) => entry.startsWith(token)) ||
      nameTokens.some((entry) => entry.startsWith(token))
    ) {
      score += 20;
    } else if (id.includes(token) || name.includes(token)) {
      score += 12;
    } else if (category.includes(token)) {
      score += 6;
    } else if (description.includes(token)) {
      score += 3;
    }
  }
  return score;
};
