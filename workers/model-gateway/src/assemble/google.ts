import { frameJson, type SseFrame } from "./sse.js";
import {
  asRecord,
  asString,
  type Assembler,
  type AssembleOutcome,
} from "./types.js";

/**
 * Google Generative AI `streamGenerateContent?alt=sse` -> `GenerateContentResponse`.
 *
 * Chunks are merged per candidate `index`: consecutive text parts with the
 * same `thought` flag concatenate (a `thoughtSignature` on a later fragment is
 * kept on the merged part), `functionCall` / `inlineData` / `executableCode`
 * parts are kept whole, `finishReason` and `usageMetadata` come from the last
 * chunk carrying them (Gemini reports cumulative usage), and
 * `promptFeedback` / `modelVersion` / `responseId` are carried through.
 */
type Candidate = {
  index: number;
  role: string | undefined;
  parts: Record<string, unknown>[];
  extras: Record<string, unknown>;
};

const isTextPart = (part: Record<string, unknown>): boolean =>
  typeof part.text === "string" &&
  part.functionCall === undefined &&
  part.inlineData === undefined &&
  part.fileData === undefined &&
  part.executableCode === undefined &&
  part.codeExecutionResult === undefined &&
  part.functionResponse === undefined;

export const createGoogleAssembler = (): Assembler => {
  const candidates = new Map<number, Candidate>();
  let usageMetadata: Record<string, unknown> | undefined;
  let promptFeedback: Record<string, unknown> | undefined;
  let modelVersion: string | undefined;
  let responseId: string | undefined;
  let sawChunk = false;
  let error: unknown;

  const candidateFor = (index: number): Candidate => {
    let candidate = candidates.get(index);
    if (!candidate) {
      candidate = { index, role: undefined, parts: [], extras: {} };
      candidates.set(index, candidate);
    }
    return candidate;
  };

  const appendPart = (candidate: Candidate, raw: unknown): void => {
    const part = asRecord(raw);
    if (!part) return;
    const previous = candidate.parts[candidate.parts.length - 1];
    if (
      previous &&
      isTextPart(part) &&
      isTextPart(previous) &&
      (previous.thought === true) === (part.thought === true) &&
      // A signed fragment closes the run: the signature belongs to exactly
      // the text accumulated so far.
      previous.thoughtSignature === undefined
    ) {
      previous.text = `${previous.text as string}${part.text as string}`;
      if (part.thoughtSignature !== undefined)
        previous.thoughtSignature = part.thoughtSignature;
      return;
    }
    candidate.parts.push({ ...part });
  };

  const push = (frame: SseFrame): void => {
    if (error !== undefined) return;
    const chunk = frameJson(frame);
    if (!chunk) return;
    if (
      chunk.error &&
      typeof chunk.error === "object" &&
      chunk.candidates === undefined
    ) {
      error = chunk;
      return;
    }
    sawChunk = true;
    const chunkUsage = asRecord(chunk.usageMetadata);
    if (chunkUsage) usageMetadata = chunkUsage;
    const feedback = asRecord(chunk.promptFeedback);
    if (feedback) promptFeedback = feedback;
    if (typeof chunk.modelVersion === "string")
      modelVersion = chunk.modelVersion;
    if (typeof chunk.responseId === "string") responseId = chunk.responseId;

    const chunkCandidates = Array.isArray(chunk.candidates)
      ? chunk.candidates
      : [];
    for (const raw of chunkCandidates) {
      const entry = asRecord(raw);
      if (!entry) continue;
      const index = typeof entry.index === "number" ? entry.index : 0;
      const candidate = candidateFor(index);
      const content = asRecord(entry.content);
      if (content) {
        if (typeof content.role === "string") candidate.role = content.role;
        if (Array.isArray(content.parts)) {
          for (const part of content.parts) appendPart(candidate, part);
        }
      }
      for (const [key, value] of Object.entries(entry)) {
        if (key === "index" || key === "content" || value === undefined)
          continue;
        candidate.extras[key] = value;
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
        message: "The model provider stream carried no content.",
      };
    }
    const ordered = Array.from(candidates.values()).sort(
      (a, b) => a.index - b.index,
    );
    const blocked = promptFeedback?.blockReason !== undefined;
    if (ordered.length === 0 && !blocked) {
      return {
        ok: false,
        message: "The model provider stream carried no candidates.",
      };
    }
    if (
      ordered.some(
        (candidate) => candidate.extras.finishReason === undefined,
      ) &&
      !blocked
    ) {
      return {
        ok: false,
        message:
          "The model provider stream ended before the candidate finished.",
      };
    }
    const body: Record<string, unknown> = {};
    if (ordered.length > 0) {
      body.candidates = ordered.map((candidate) => ({
        content: {
          ...(candidate.role !== undefined ? { role: candidate.role } : {}),
          parts: candidate.parts,
        },
        ...candidate.extras,
        index: candidate.index,
      }));
    }
    if (promptFeedback) body.promptFeedback = promptFeedback;
    if (usageMetadata) body.usageMetadata = usageMetadata;
    if (modelVersion !== undefined) body.modelVersion = modelVersion;
    if (responseId !== undefined) body.responseId = responseId;
    return { ok: true, body };
  };

  return { push, finish };
};
