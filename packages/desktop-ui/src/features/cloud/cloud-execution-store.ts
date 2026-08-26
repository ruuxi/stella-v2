import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";

export const CLOUD_EXECUTION_CHANGED_EVENT = "stella:cloud-execution-changed";

let localSelection: CloudExecutionSelection | null = null;
let authorityAccountScope: string | null = null;
const listeners = new Set<() => void>();

const sameExecution = (
  left: CloudExecutionSelection,
  right: CloudExecutionSelection,
): boolean =>
  left.engine === right.engine &&
  left.provider === right.provider &&
  left.model === right.model &&
  left.reasoningEffort === right.reasoningEffort;

const emit = (): void => {
  for (const listener of listeners) listener();
};

/**
 * Bridges the short gap between a successful settings mutation and Convex's
 * reactive query update. Turn dispatch reads this snapshot synchronously, so
 * closing the picker and immediately pressing Send cannot resurrect the old
 * cloud route.
 */
export const publishCloudExecutionSelection = (
  execution: CloudExecutionSelection,
): void => {
  localSelection = execution;
  emit();
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<CloudExecutionSelection>(CLOUD_EXECUTION_CHANGED_EVENT, {
        detail: execution,
      }),
    );
  }
};

export const reconcileCloudExecutionSelection = (
  serverSelection: CloudExecutionSelection | undefined,
): void => {
  if (
    localSelection &&
    serverSelection &&
    sameExecution(localSelection, serverSelection)
  ) {
    localSelection = null;
    emit();
  }
};

export const getCloudExecutionSelectionSnapshot =
  (): CloudExecutionSelection | null => localSelection;

export const subscribeCloudExecutionSelection = (
  listener: () => void,
): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * Establishes the auth subject that owns the renderer-local picker override.
 * A successful settings mutation can outpace its reactive query, so the
 * override intentionally survives ordinary renders. It must not survive an
 * owner handoff: otherwise the next owner's first turn can inherit the prior
 * owner's explicit provider/model route.
 */
export const retireCloudExecutionClientAuthority = (
  accountScope: string,
): void => {
  if (authorityAccountScope === accountScope) return;
  authorityAccountScope = accountScope;
  if (localSelection === null) return;
  localSelection = null;
  emit();
};

export const resetCloudExecutionSelectionForTests = (): void => {
  authorityAccountScope = null;
  localSelection = null;
  emit();
};
