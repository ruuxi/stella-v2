/**
 * Claude Code aliases are not Messages API model IDs. Keep cloud resolution
 * separate from the CLI, which resolves aliases using its authenticated account.
 * Anthropic API defaults, checked 2026-10-04:
 * https://code.claude.com/docs/en/model-config
 */
const CLOUD_CLAUDE_ALIASES: Readonly<Record<string, string>> = {
  default: "claude-opus-5-5",
  best: "claude-fable-5-1",
  fable: "claude-fable-5-1",
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-4-5",
  opusplan: "claude-sonnet-5-5",
};

export const resolveClaudeCloudModel = (selection: string): string => {
  const model = selection.replace(/\[1m\]$/u, "");
  return Object.hasOwn(CLOUD_CLAUDE_ALIASES, model)
    ? CLOUD_CLAUDE_ALIASES[model]!
    : model;
};

export const isClaudeCloudAlias = (model: string): boolean =>
  Object.hasOwn(CLOUD_CLAUDE_ALIASES, model.replace(/\[1m\]$/u, ""));
