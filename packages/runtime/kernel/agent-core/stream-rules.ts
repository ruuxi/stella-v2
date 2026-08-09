/**
 * Stream rules: mid-stream pathology detection for the agent loop.
 *
 * The loop watches text and tool-call deltas as they stream. When a rule
 * fires, the in-flight attempt is aborted, the partial output is discarded
 * from context (it never reaches durable history), and the call is retried
 * with an ephemeral `<system-reminder>` correction that exists only for
 * the retry request — so a recovered turn carries zero context penalty.
 *
 * This mostly pays off on small/fast models (the managed tier's DeepSeek
 * V4 Flash) that occasionally write tool calls as prose, leak think tags,
 * or fall into repetition loops; on strong models the rules simply never
 * fire. Patterns are deliberately high-precision: a missed pathology costs
 * one wasted turn, a false positive costs a good one.
 */

export type StreamRuleScope = "text" | "toolcall" | "both";

export interface StreamRule {
	/** Stable identifier for logs and tests. */
	id: string;
	/** Which streamed content the rule watches. Thinking is never watched. */
	scope: StreamRuleScope;
	/** Fires when the accumulated block buffer matches. Must not use /g. */
	pattern?: RegExp;
	/** Programmatic alternative to `pattern` for non-regex detection. */
	detect?: (buffer: string) => boolean;
	/** Model-facing correction injected into the retry request. */
	correction: string;
}

/** Extra attempts granted per assistant response when rules fire. */
export const STREAM_RULE_MAX_RETRIES = 2;

/** Per-block buffer cap; rules only ever need a local window. */
const BUFFER_WINDOW = 8_000;

/** Consecutive identical non-empty lines that count as a runaway loop. */
const REPEATED_LINE_THRESHOLD = 15;

/**
 * True when the buffer tail is stuck in a loop: either the same non-empty
 * line repeated many times, or the tail is one short unit stamped over and
 * over (single-line degeneration like "no no no no …").
 */
export const detectRepetitionLoop = (buffer: string): boolean => {
	const tail = buffer.slice(-BUFFER_WINDOW);
	const lines = tail.split("\n");

	// Complete lines only — the last entry is still streaming.
	let run = 1;
	for (let index = lines.length - 2; index > 0; index--) {
		const line = lines[index] ?? "";
		if (line.trim().length < 3) break;
		if (line !== lines[index - 1]) break;
		run++;
		if (run >= REPEATED_LINE_THRESHOLD) return true;
	}

	const lastLine = lines[lines.length - 1] ?? "";
	if (lastLine.length >= 400) {
		const REPEATS = 16;
		for (let unitLength = 2; unitLength <= 24; unitLength++) {
			const unit = lastLine.slice(-unitLength);
			if (unit.trim().length === 0) continue;
			if (lastLine.length < unitLength * REPEATS) break;
			if (lastLine.endsWith(unit.repeat(REPEATS))) return true;
		}
	}
	return false;
};

export const DEFAULT_STREAM_RULES: StreamRule[] = [
	{
		id: "tool-call-as-text",
		scope: "text",
		// DeepSeek-family special tokens (both ASCII and fullwidth-bar forms)
		// plus the common XML-ish markers small models fall back to when they
		// hallucinate the tool protocol into visible text.
		pattern:
			/<｜tool▁calls?▁begin｜>|<\|tool[▁_]?calls?[▁_]begin\|>|<tool_call>|<function_call>/,
		correction:
			"Your previous attempt started writing a tool call as plain text and was cancelled. " +
			"Never print tool-call markup in your reply — invoke tools only through the tool-calling interface, " +
			"then continue the response normally.",
	},
	{
		id: "think-tag-leak",
		scope: "text",
		pattern: /(?:^|\n)<think>/,
		correction:
			"Your previous attempt leaked raw <think> tags into the visible reply and was cancelled. " +
			"Keep reasoning internal and write only the final user-facing response.",
	},
	{
		id: "repetition-loop",
		scope: "both",
		detect: detectRepetitionLoop,
		correction:
			"Your previous attempt got stuck repeating the same content and was cancelled. " +
			"Re-issue the response concisely, without repeating lines.",
	},
];

export interface StreamRuleMonitor {
	/**
	 * Feed one accumulated delta. Returns the first rule that fires, once;
	 * subsequent observations after a hit return null (the attempt is
	 * already being aborted).
	 */
	observe: (
		kind: "text" | "toolcall",
		contentIndex: number,
		delta: string,
	) => StreamRule | null;
}

export const createStreamRuleMonitor = (
	rules: StreamRule[],
): StreamRuleMonitor => {
	const buffers = new Map<string, string>();
	let fired = false;

	return {
		observe(kind, contentIndex, delta) {
			if (fired || rules.length === 0) return null;
			const key = `${kind}:${contentIndex}`;
			const buffer = ((buffers.get(key) ?? "") + delta).slice(-BUFFER_WINDOW);
			buffers.set(key, buffer);

			for (const rule of rules) {
				if (rule.scope !== "both" && rule.scope !== kind) continue;
				const hit = rule.pattern
					? rule.pattern.test(buffer)
					: (rule.detect?.(buffer) ?? false);
				if (hit) {
					fired = true;
					return rule;
				}
			}
			return null;
		},
	};
};
