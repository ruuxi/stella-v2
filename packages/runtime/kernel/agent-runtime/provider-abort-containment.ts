import type { AgentMessage } from "../agent-core/types.js";
import type { Api, Model } from "../../ai/types.js";
import type { ResolvedLlmRoute } from "../model-routing.js";
import {
  findRegistryModel,
  uniqueModelCandidates,
} from "../model-routing-matching.js";

export const QUARANTINE_PLACEHOLDER =
  "[content quarantined: triggered provider abort]";

const QUARANTINE_NOTE =
  `${QUARANTINE_PLACEHOLDER} — the original content of this entry repeatedly ` +
  "caused the model provider to abort the stream while replaying thread " +
  "history. It was removed from the model request only; the stored thread " +
  "record is unchanged.";

export const DETERMINISTIC_ABORT_THRESHOLD = 2;

const SUSPECT_TAIL_ENTRIES = 8;

const PROVIDER_ABORT_ERROR_PATTERNS: RegExp[] = [
  /provider aborted the response \(stop reason: "/i,
  /provider finish_reason: content_filter/i,
  /provider returned an error stop reason/i,
];

export const isProviderContentAbortMessage = (
  message: string | undefined,
): boolean => {
  const trimmed = message?.trim();
  if (!trimmed) return false;
  return PROVIDER_ABORT_ERROR_PATTERNS.some((pattern) => pattern.test(trimmed));
};

type AssistantEntry = Extract<AgentMessage, { role: "assistant" }>;

export const isInstantFirstCallFailure = (
  appended: AgentMessage[],
): boolean => {
  const assistants = appended.filter(
    (message): message is AssistantEntry => message.role === "assistant",
  );
  const hasToolResults = appended.some(
    (message) => message.role === "toolResult",
  );
  return (
    !hasToolResults &&
    assistants.length === 1 &&
    (assistants[0].stopReason === "error" ||
      assistants[0].stopReason === "aborted")
  );
};

export type QuarantineRecord = {
  key: string;
  toolName: string;
  timestamp: number;
};

export const QUARANTINE_CUSTOM_TYPE = "containment.quarantine";

export const serializeQuarantineRecord = (record: QuarantineRecord): string =>
  JSON.stringify(record);

export const parseQuarantineRecord = (
  content: unknown,
): QuarantineRecord | null => {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((block) =>
              block &&
              typeof block === "object" &&
              (block as { type?: string }).type === "text"
                ? String((block as { text?: unknown }).text ?? "")
                : "",
            )
            .join("")
        : "";
  try {
    const parsed = JSON.parse(text) as {
      key?: unknown;
      toolName?: unknown;
      timestamp?: unknown;
    };
    if (!parsed || typeof parsed.key !== "string" || !parsed.key) return null;
    return {
      key: parsed.key,
      toolName: typeof parsed.toolName === "string" ? parsed.toolName : "",
      timestamp:
        typeof parsed.timestamp === "number" && Number.isFinite(parsed.timestamp)
          ? parsed.timestamp
          : 0,
    };
  } catch {
    return null;
  }
};

export const toolResultQuarantineKey = (
  message: Extract<AgentMessage, { role: "toolResult" }>,
): string => `${message.timestamp}:${message.toolCallId}`;

const describeHistoryEntry = (message: AgentMessage, index: number): string => {
  const role =
    message.role === "toolResult"
      ? `toolResult:${message.toolName}`
      : message.role;
  const timestamp =
    typeof message.timestamp === "number" && message.timestamp > 0
      ? new Date(message.timestamp).toISOString()
      : "unknown-time";
  return `#${index} ${role} @ ${timestamp}`;
};

export type QuarantineApplication = {

  reappliedKeys: string[];

  newlyQuarantined: QuarantineRecord | null;
};

export type ContainmentFailureInput = {

  history: AgentMessage[];

  appended: AgentMessage[];

  errorMessage: string;

  swapAttempted?: { fromModelId: string; toModelId: string } | undefined;
};

export class ProviderAbortContainment {
  private consecutiveInstantAborts = 0;
  private lastAbortErrorMessage: string | undefined;
  private readonly quarantined = new Map<string, QuarantineRecord>();

  get consecutiveInstantAbortCount(): number {
    return this.consecutiveInstantAborts;
  }

  get quarantinedCount(): number {
    return this.quarantined.size;
  }

  get shouldQuarantine(): boolean {
    return this.consecutiveInstantAborts >= DETERMINISTIC_ABORT_THRESHOLD;
  }

  seedQuarantined(records: QuarantineRecord[]): void {
    for (const record of records) {
      if (!record.key || this.quarantined.has(record.key)) continue;
      this.quarantined.set(record.key, record);
    }
  }

  noteRunSuccess(): void {

    this.consecutiveInstantAborts = 0;
    this.lastAbortErrorMessage = undefined;
  }

  noteRunFailure(input: ContainmentFailureInput): string {
    const providerAbort = isProviderContentAbortMessage(input.errorMessage);
    const instant = isInstantFirstCallFailure(input.appended);
    if (!providerAbort || !instant) {
      this.consecutiveInstantAborts = 0;
      this.lastAbortErrorMessage = undefined;
      return input.errorMessage;
    }

    this.consecutiveInstantAborts += 1;
    this.lastAbortErrorMessage = input.errorMessage;
    if (this.consecutiveInstantAborts < DETERMINISTIC_ABORT_THRESHOLD) {
      return input.errorMessage;
    }
    return this.describeDeterministicAbort(input);
  }

  applyQuarantine(messages: AgentMessage[]): QuarantineApplication {
    const reappliedKeys = this.reapplyQuarantine(messages);

    if (!this.shouldQuarantine) {
      return { reappliedKeys, newlyQuarantined: null };
    }

    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.role !== "toolResult") continue;
      const key = toolResultQuarantineKey(message);
      if (this.quarantined.has(key)) continue;
      maskToolResult(message);
      const record: QuarantineRecord = {
        key,
        toolName: message.toolName,
        timestamp: message.timestamp,
      };
      this.quarantined.set(key, record);
      return { reappliedKeys, newlyQuarantined: record };
    }

    return { reappliedKeys, newlyQuarantined: null };
  }

  reapplyQuarantine(messages: AgentMessage[]): string[] {
    const reappliedKeys: string[] = [];
    for (const message of messages) {
      if (message.role !== "toolResult") continue;
      const key = toolResultQuarantineKey(message);
      if (!this.quarantined.has(key)) continue;
      if (maskToolResult(message)) {
        reappliedKeys.push(key);
      }
    }
    return reappliedKeys;
  }

  private describeDeterministicAbort(input: ContainmentFailureInput): string {
    const tail = input.history.slice(-SUSPECT_TAIL_ENTRIES);
    const baseIndex = input.history.length - tail.length;
    const suspects = tail
      .map((message, offset) => describeHistoryEntry(message, baseIndex + offset))
      .join(", ");
    const swapNote = input.swapAttempted
      ? ` An automatic retry on ${input.swapAttempted.toModelId} (after the safety abort on ${input.swapAttempted.fromModelId}) failed the same way, so this is not model-specific.`
      : "";
    const healNote = this.shouldQuarantine
      ? ` On the next resume Stella will quarantine the newest suspect tool-result entry from the model request (${this.quarantined.size} quarantined so far; stored thread history is preserved).`
      : "";
    return (
      `Thread context triggers a provider abort deterministically: ${this.consecutiveInstantAborts} consecutive runs died on the first model call while replaying existing thread history, before any new work happened. ` +
      `Provider error: ${this.lastAbortErrorMessage ?? input.errorMessage} ` +
      `Suspect content is in the trailing thread entries: ${suspects || "(no history entries)"}.` +
      swapNote +
      healNote
    );
  }
}

const maskToolResult = (
  message: Extract<AgentMessage, { role: "toolResult" }>,
): boolean => {
  const alreadyMasked =
    message.content.length === 1 &&
    message.content[0]?.type === "text" &&
    message.content[0].text.startsWith(QUARANTINE_PLACEHOLDER);
  if (alreadyMasked) return false;
  message.content = [{ type: "text", text: QUARANTINE_NOTE }];

  delete message.details;
  return true;
};

const FABLE_MODEL_RE = /fable-5/i;

const EXACT_FABLE_SLUG_RE = /(^|\/)claude-fable-5$/i;

export const SAFETY_SWAP_STELLA_MODEL_ID = "stella/anthropic/claude-opus-4.8";
const SAFETY_SWAP_STELLA_UPSTREAM_ID = "claude-opus-4.8";

const safetySwapTargetInCatalog = (): boolean =>
  findRegistryModel(
    "anthropic",
    uniqueModelCandidates([
      SAFETY_SWAP_STELLA_UPSTREAM_ID,
      "claude-opus-4-8",
      "anthropic/claude-opus-4.8",
    ]),
  ) !== null;

type ModelWithUpstream = Model<Api> & { upstreamModelId?: string };

const upstreamModelIdOf = (model: Model<Api>): string =>
  (model as ModelWithUpstream).upstreamModelId ?? model.id;

export const isFable5Route = (route: ResolvedLlmRoute): boolean =>
  FABLE_MODEL_RE.test(route.model.id) ||
  FABLE_MODEL_RE.test(upstreamModelIdOf(route.model));

export type SafetySwapRoute = {
  route: ResolvedLlmRoute;
  fromModelId: string;
  toModelId: string;
};

export const buildSafetyAbortSwapRoute = (
  current: ResolvedLlmRoute,
): SafetySwapRoute | null => {
  if (!isFable5Route(current)) return null;
  if (!safetySwapTargetInCatalog()) return null;

  const fromModelId = current.model.id;
  if (current.route === "stella") {
    const model: ModelWithUpstream = {
      ...(current.model as ModelWithUpstream),
      id: SAFETY_SWAP_STELLA_MODEL_ID,
      name: SAFETY_SWAP_STELLA_MODEL_ID.replace(/^stella\//, ""),
      upstreamModelId: SAFETY_SWAP_STELLA_UPSTREAM_ID,
    };
    return {
      route: { ...current, model },
      fromModelId,
      toModelId: model.id,
    };
  }

  if (!EXACT_FABLE_SLUG_RE.test(current.model.id)) return null;
  const toModelId = current.model.id.includes("/")
    ? current.model.id.replace(FABLE_MODEL_RE, "opus-4.8")
    : current.model.id.replace(FABLE_MODEL_RE, "opus-4-8");
  if (toModelId === current.model.id) return null;

  const model: ModelWithUpstream = {
    ...(current.model as ModelWithUpstream),
    id: toModelId,
    name: toModelId,
  };
  if ((current.model as ModelWithUpstream).upstreamModelId) {
    model.upstreamModelId = (
      current.model as ModelWithUpstream
    ).upstreamModelId!.replace(FABLE_MODEL_RE, "opus-4.8");
  }
  return {
    route: { ...current, model },
    fromModelId,
    toModelId,
  };
};

export const SAFETY_ABORT_FABLE_ATTEMPTS = 3;

export const safetyRetryStatusMessage = (args: {
  modelId: string;
  attempt: number;
}): string =>
  `${args.modelId} refused this request (safety) — retrying ` +
  `(attempt ${args.attempt} of ${SAFETY_ABORT_FABLE_ATTEMPTS})`;

export const safetySwapStatusMessage = (swap: {
  fromModelId: string;
  toModelId: string;
}): string =>
  `${swap.fromModelId} refused this request ${SAFETY_ABORT_FABLE_ATTEMPTS} ` +
  `times (safety), so this turn was retried on ${swap.toModelId}. ` +
  `Your configured model resumes next turn.`;
