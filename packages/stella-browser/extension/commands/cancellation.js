/**
 * In-process cancellation and mutation provenance for chain-dispatched
 * extension commands. These fields are symbol-backed so they never cross the
 * native-messaging protocol or collide with user-supplied command keys.
 */
const COMMAND_EXECUTION = Symbol("stellaBrowserCommandExecution");

export function attachCommandExecution(command, signal) {
  const execution = {
    signal,
    cooperativeCancellationObserved: false,
    mutationDispatched: false,
    mutationOutcomeKnown: false,
  };
  Object.defineProperty(command, "signal", {
    configurable: true,
    enumerable: false,
    value: signal,
  });
  Object.defineProperty(command, COMMAND_EXECUTION, {
    configurable: true,
    enumerable: false,
    value: execution,
  });
  return execution;
}

export function throwIfCommandAborted(command) {
  const execution = command?.[COMMAND_EXECUTION];
  if (execution) execution.cooperativeCancellationObserved = true;
  const signal = command?.signal;
  if (signal?.aborted) {
    throw signal.reason || new Error("Browser command aborted");
  }
}

/** Call immediately before sending the first state-changing browser command. */
export function markCommandMutationDispatched(command) {
  throwIfCommandAborted(command);
  const execution = command?.[COMMAND_EXECUTION];
  if (execution) execution.mutationDispatched = true;
}

/** Call when the handler has positively observed its mutation complete. */
export function markCommandMutationOutcomeKnown(command) {
  const execution = command?.[COMMAND_EXECUTION];
  if (execution) execution.mutationOutcomeKnown = true;
}

export function mutationOutcomeIsUnknown(execution, mutationPotential = false) {
  if (execution?.mutationOutcomeKnown === true) return false;
  if (execution?.mutationDispatched === true) return true;
  // Older state-changing handlers do not expose their precise Chrome dispatch
  // boundary. Once invoked, absence of that proof must remain conservative.
  return (
    mutationPotential && execution?.cooperativeCancellationObserved !== true
  );
}

export function abortableCommandDelay(command, milliseconds) {
  const signal = command?.signal;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error("Browser command aborted"));
      return;
    }
    let settled = false;
    let timer;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () =>
      finish(() => {
        clearTimeout(timer);
        reject(signal.reason || new Error("Browser command aborted"));
      });
    timer = setTimeout(() => finish(resolve), milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
