import { frameJson, isDoneFrame, type SseFrame } from "./sse.js";
import {
  asRecord,
  asString,
  type Assembler,
  type AssembleOutcome,
} from "./types.js";

/**
 * OpenAI Chat Completions stream -> `ChatCompletion`.
 *
 * Chunks are merged by `choices[i].index`: text-like delta fields append,
 * `tool_calls` merge by their own `index` (id/type/name set once, arguments
 * appended), `reasoning_details` concatenate, `finish_reason` is the last
 * non-null value, and `usage` comes from the last chunk that carried it
 * (`stream_options.include_usage`).
 *
 * Reasoning fields vary by gateway — DeepSeek `reasoning_content`, OpenRouter
 * `reasoning` + `reasoning_details`, some OpenAI-compatible hosts
 * `reasoning_text` — and each is folded into the same-named message field so
 * the caller's adapter sees exactly what a non-streaming call returns.
 */
const APPEND_FIELDS = [
  "content",
  "reasoning_content",
  "reasoning",
  "reasoning_text",
  "refusal",
] as const;

type ToolCall = {
  index: number;
  id?: string;
  type?: string;
  function: { name?: string; arguments: string };
};

type Choice = {
  index: number;
  role: string;
  fields: Partial<Record<(typeof APPEND_FIELDS)[number], string>>;
  toolCalls: Map<number, ToolCall>;
  reasoningDetails: unknown[] | undefined;
  finishReason: string | null;
  logprobs: unknown;
};

export const createOpenAICompletionsAssembler = (): Assembler => {
  const choices = new Map<number, Choice>();
  let id: string | undefined;
  let model: string | undefined;
  let created: number | undefined;
  let systemFingerprint: string | null | undefined;
  let serviceTier: unknown;
  let usage: Record<string, unknown> | undefined;
  let sawChunk = false;
  let sawDone = false;
  let error: unknown;

  const choiceFor = (index: number): Choice => {
    let choice = choices.get(index);
    if (!choice) {
      choice = {
        index,
        role: "assistant",
        fields: {},
        toolCalls: new Map(),
        reasoningDetails: undefined,
        finishReason: null,
        logprobs: null,
      };
      choices.set(index, choice);
    }
    return choice;
  };

  const push = (frame: SseFrame): void => {
    if (error !== undefined || sawDone) return;
    if (isDoneFrame(frame)) {
      sawDone = true;
      return;
    }
    const chunk = frameJson(frame);
    if (!chunk) return;
    if (
      chunk.error &&
      typeof chunk.error === "object" &&
      chunk.choices === undefined
    ) {
      error = chunk;
      return;
    }
    sawChunk = true;
    if (typeof chunk.id === "string") id = chunk.id;
    if (typeof chunk.model === "string") model = chunk.model;
    if (typeof chunk.created === "number") created = chunk.created;
    if (chunk.system_fingerprint !== undefined) {
      systemFingerprint = chunk.system_fingerprint as string | null;
    }
    if (chunk.service_tier !== undefined) serviceTier = chunk.service_tier;
    const chunkUsage = asRecord(chunk.usage);
    if (chunkUsage) usage = chunkUsage;

    const chunkChoices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const raw of chunkChoices) {
      const entry = asRecord(raw);
      if (!entry) continue;
      const index = typeof entry.index === "number" ? entry.index : 0;
      const choice = choiceFor(index);
      const delta = asRecord(entry.delta);
      if (delta) {
        if (typeof delta.role === "string" && delta.role)
          choice.role = delta.role;
        for (const field of APPEND_FIELDS) {
          const value = delta[field];
          if (typeof value === "string") {
            choice.fields[field] = (choice.fields[field] ?? "") + value;
          }
        }
        if (Array.isArray(delta.reasoning_details)) {
          choice.reasoningDetails = [
            ...(choice.reasoningDetails ?? []),
            ...delta.reasoning_details,
          ];
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const rawCall of delta.tool_calls) {
            const call = asRecord(rawCall);
            if (!call) continue;
            const callIndex =
              typeof call.index === "number"
                ? call.index
                : choice.toolCalls.size;
            let merged = choice.toolCalls.get(callIndex);
            if (!merged) {
              merged = { index: callIndex, function: { arguments: "" } };
              choice.toolCalls.set(callIndex, merged);
            }
            if (typeof call.id === "string" && !merged.id) merged.id = call.id;
            if (typeof call.type === "string" && !merged.type)
              merged.type = call.type;
            const fn = asRecord(call.function);
            if (fn) {
              if (
                typeof fn.name === "string" &&
                fn.name &&
                !merged.function.name
              ) {
                merged.function.name = fn.name;
              }
              if (typeof fn.arguments === "string") {
                merged.function.arguments += fn.arguments;
              }
            }
          }
        }
      }
      if (typeof entry.finish_reason === "string") {
        choice.finishReason = entry.finish_reason;
      }
      if (entry.logprobs !== undefined && entry.logprobs !== null) {
        choice.logprobs = entry.logprobs;
      }
    }
  };

  const finish = (): AssembleOutcome => {
    if (error !== undefined) {
      const detail = asRecord(error);
      const inner = asRecord(detail?.error);
      return {
        ok: false,
        message:
          asString(inner?.message) ??
          "The model provider reported a streaming error.",
        detail: error,
      };
    }
    if (!sawChunk) {
      return {
        ok: false,
        message: "The model provider stream carried no completion chunks.",
      };
    }
    const ordered = Array.from(choices.values()).sort(
      (a, b) => a.index - b.index,
    );
    const complete =
      sawDone ||
      (ordered.length > 0 &&
        ordered.every((choice) => choice.finishReason !== null));
    if (!complete) {
      return {
        ok: false,
        message:
          "The model provider stream ended before the completion finished.",
      };
    }
    const body: Record<string, unknown> = {
      id: id ?? "",
      object: "chat.completion",
      created: created ?? Math.floor(Date.now() / 1000),
      model: model ?? "",
      choices: ordered.map((choice) => {
        const message: Record<string, unknown> = {
          role: choice.role,
          content: choice.fields.content ?? null,
        };
        if (choice.fields.refusal !== undefined)
          message.refusal = choice.fields.refusal;
        if (choice.fields.reasoning_content !== undefined) {
          message.reasoning_content = choice.fields.reasoning_content;
        }
        if (choice.fields.reasoning !== undefined)
          message.reasoning = choice.fields.reasoning;
        if (choice.fields.reasoning_text !== undefined) {
          message.reasoning_text = choice.fields.reasoning_text;
        }
        if (choice.reasoningDetails !== undefined) {
          message.reasoning_details = choice.reasoningDetails;
        }
        if (choice.toolCalls.size > 0) {
          message.tool_calls = Array.from(choice.toolCalls.values())
            .sort((a, b) => a.index - b.index)
            .map((call) => ({
              id: call.id ?? "",
              type: call.type ?? "function",
              function: {
                name: call.function.name ?? "",
                arguments: call.function.arguments,
              },
            }));
        }
        return {
          index: choice.index,
          message,
          finish_reason: choice.finishReason,
          logprobs: choice.logprobs,
        };
      }),
    };
    if (systemFingerprint !== undefined)
      body.system_fingerprint = systemFingerprint;
    if (serviceTier !== undefined) body.service_tier = serviceTier;
    if (usage) body.usage = usage;
    return { ok: true, body };
  };

  return { push, finish };
};
