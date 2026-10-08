export const STELLA_PROMPT_SCHEMA_VERSION = 2 as const;

export const STELLA_PROMPT_IDS = [
  "agents/orchestrator.md",
  "agents/general.md",
  "prompts/thread-compaction.md",
  "prompts/fallback-orchestrator.md",
  "prompts/fallback-subagent.md",
  "prompts/personality.md",
  "prompts/synthesis.md",
] as const;

export const STELLA_PROMPT_ID_SET = new Set<string>(STELLA_PROMPT_IDS);
export const STELLA_PROMPT_COUNT = STELLA_PROMPT_IDS.length;
export const STELLA_PROMPT_MAX_CONTENT_BYTES = 256 * 1024;
export const STELLA_PROMPT_MAX_TOTAL_CONTENT_BYTES = 1024 * 1024;
export const STELLA_PROMPT_MAX_MANIFEST_BYTES = 1200 * 1024;
export const STELLA_PROMPT_REVISION_PATTERN = /^[0-9a-f]{64}$/;

/*
 * Condition fences.
 *
 * One agent prompt source serves every environment. A line that is exactly
 * `<!-- when desktop -->`, `<!-- when cloud -->`, `<!-- when tool:NAME -->`
 * or `<!-- when !tool:NAME -->` opens a block that a matching
 * `<!-- end -->` line closes; text outside every block is shared. A block
 * renders when its condition holds and all the blocks around it render.
 *
 * `tool:NAME` holds when NAME is in the agent's tool set for this turn. The
 * set is the agent's real tool names, plus `history` when its `code` tool
 * carries the conversation history client and `memory` when it carries the
 * orchestrator's memory client. Only the names in
 * `STELLA_PROMPT_FENCE_TOOLS` may be named, so a typo fails the bundle sync
 * instead of silently dropping text.
 *
 * Fences are allowed in `agents/*.md` only; the sync script rejects them
 * anywhere else. The published bundle keeps raw sources, so a prompt's digest
 * and the publication revision do not depend on how it is rendered.
 */

export type StellaPromptEnvironment = "desktop" | "cloud";

export type StellaPromptRenderContext = Readonly<{
  env: StellaPromptEnvironment;
  tools: ReadonlySet<string>;
}>;

export const STELLA_PROMPT_FENCE_TOOLS = [
  "ask_user",
  "history",
  "memory",
  "request_secure_input",
  "send_message",
  "spawn_agent",
  "switch_destination",
  "use_secure_value",
] as const;

const FENCE_TOOL_SET = new Set<string>(STELLA_PROMPT_FENCE_TOOLS);

/**
 * The tool set a prompt renders against: tool names plus the `history` and
 * `memory` clients its `code` tool carries.
 */
export const stellaPromptTools = (
  toolNames: Iterable<string>,
  options: Readonly<{ history: boolean; memory: boolean }>,
): ReadonlySet<string> => {
  const tools = new Set(toolNames);
  if (options.history) tools.add("history");
  if (options.memory) tools.add("memory");
  return tools;
};

type FenceCondition =
  | Readonly<{ kind: "env"; env: StellaPromptEnvironment }>
  | Readonly<{ kind: "tool"; name: string; negated: boolean }>;

type FenceLine =
  | Readonly<{ kind: "text" }>
  | Readonly<{ kind: "open"; condition: FenceCondition }>
  | Readonly<{ kind: "close" }>
  /** `opens` keeps a misspelled opening fence balanced against its end. */
  | Readonly<{ kind: "invalid"; reason: string; opens: boolean }>;

const OPEN_FENCE = /^<!-- when (\S+) -->$/u;
const CLOSE_FENCE = "<!-- end -->";
const TOOL_CONDITION = /^(!?)tool:([A-Za-z0-9_-]+)$/u;

const classifyLine = (line: string): FenceLine => {
  const trimmed = line.trim();
  if (trimmed === CLOSE_FENCE) return { kind: "close" };
  const open = OPEN_FENCE.exec(trimmed);
  if (open) {
    const condition = open[1]!;
    if (condition === "desktop" || condition === "cloud") {
      return { kind: "open", condition: { kind: "env", env: condition } };
    }
    const tool = TOOL_CONDITION.exec(condition);
    if (!tool) {
      return {
        kind: "invalid",
        reason: `unknown condition "${condition}"`,
        opens: true,
      };
    }
    if (!FENCE_TOOL_SET.has(tool[2]!)) {
      return {
        kind: "invalid",
        reason: `tool "${tool[2]}" is not in STELLA_PROMPT_FENCE_TOOLS`,
        opens: true,
      };
    }
    return {
      kind: "open",
      condition: { kind: "tool", name: tool[2]!, negated: tool[1] === "!" },
    };
  }
  if (trimmed.includes("<!-- when") || trimmed.includes("<!-- end")) {
    return {
      kind: "invalid",
      reason:
        "a fence must be a whole line: `<!-- when <condition> -->` or `<!-- end -->`",
      opens: false,
    };
  }
  return { kind: "text" };
};

/** Every fence problem in `source`, one message per problem; empty when valid. */
export const validateStellaPromptFences = (source: string): string[] => {
  const errors: string[] = [];
  const open: number[] = [];
  source.split("\n").forEach((line, index) => {
    const fence = classifyLine(line);
    if (fence.kind === "invalid") {
      errors.push(`line ${index + 1}: ${fence.reason}`);
      if (fence.opens) open.push(index + 1);
    } else if (fence.kind === "open") {
      open.push(index + 1);
    } else if (fence.kind === "close" && open.pop() === undefined) {
      errors.push(`line ${index + 1}: <!-- end --> closes no fence`);
    }
  });
  for (const line of open) {
    errors.push(`line ${line}: fence is never closed`);
  }
  return errors;
};

export const hasStellaPromptFences = (source: string): boolean =>
  source
    .split("\n")
    .some((line) => classifyLine(line).kind !== "text");

const conditionHolds = (
  condition: FenceCondition,
  context: StellaPromptRenderContext,
): boolean =>
  condition.kind === "env"
    ? condition.env === context.env
    : context.tools.has(condition.name) !== condition.negated;

/**
 * Render one prompt source for one environment and tool set. Fence lines and
 * the text of every block whose condition fails are dropped; a blank line
 * left next to another blank line (or at the start) by a dropped block is
 * dropped with it, so a source without fences renders byte for byte.
 * Throws on a malformed source.
 */
export const renderStellaPrompt = (
  source: string,
  context: StellaPromptRenderContext,
): string => {
  const errors = validateStellaPromptFences(source);
  if (errors.length > 0) {
    throw new Error(`Invalid prompt fences: ${errors.join("; ")}`);
  }
  const output: string[] = [];
  const included: boolean[] = [];
  let droppedSinceLastLine = false;
  for (const line of source.split("\n")) {
    const fence = classifyLine(line);
    if (fence.kind === "open") {
      included.push(
        included.every(Boolean) && conditionHolds(fence.condition, context),
      );
      droppedSinceLastLine = true;
      continue;
    }
    if (fence.kind === "close") {
      included.pop();
      droppedSinceLastLine = true;
      continue;
    }
    if (!included.every(Boolean)) {
      droppedSinceLastLine = true;
      continue;
    }
    if (
      droppedSinceLastLine &&
      line.trim() === "" &&
      (output.length === 0 || output[output.length - 1]!.trim() === "")
    ) {
      continue;
    }
    output.push(line);
    droppedSinceLastLine = false;
  }
  return output.join("\n");
};
