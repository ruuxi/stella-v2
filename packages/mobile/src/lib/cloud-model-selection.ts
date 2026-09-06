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
