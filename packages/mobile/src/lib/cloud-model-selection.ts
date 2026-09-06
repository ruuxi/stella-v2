import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import type { AutomaticExecutionTarget } from "./execution-placement-core";

export const usesCloudModelSettings = (
  target: AutomaticExecutionTarget,
  paired: boolean,
): boolean => target.mode === "cloud" || !paired;

export const managedCloudModelSelection = (
  model: string,
  previous: CloudExecutionSelection,
): CloudExecutionSelection => ({
  engine: "stella",
  provider: "stella",
  model,
  reasoningEffort: previous.reasoningEffort,
});

/** Do not issue a request after token resolution crosses an account boundary. */
export async function runOwnerBoundModelRequest<T>(args: {
  getToken: () => Promise<string>;
  isCurrent: () => boolean;
  request: (token: string) => Promise<T>;
}): Promise<T | undefined> {
  const token = await args.getToken();
  if (!args.isCurrent()) return undefined;
  const result = await args.request(token);
  return args.isCurrent() ? result : undefined;
}

/** Read the optional persisted route without promoting corrupt outbox data. */
export function parseCloudModelSelection(value: unknown): CloudExecutionSelection | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const model = typeof row.model === "string" ? row.model.trim() : "";
  const efforts: readonly unknown[] = ["default", "none", "minimal", "low", "medium", "high", "xhigh"];
  if (!model || !efforts.includes(row.reasoningEffort) || row.engine !== row.provider) return undefined;
  const reasoningEffort = row.reasoningEffort as CloudExecutionSelection["reasoningEffort"];
  switch (row.engine) {
    case "stella": return { engine: "stella", provider: "stella", model, reasoningEffort };
    case "anthropic": return { engine: "anthropic", provider: "anthropic", model, reasoningEffort };
    case "openai-codex": return { engine: "openai-codex", provider: "openai-codex", model, reasoningEffort };
    default: return undefined;
  }
}
