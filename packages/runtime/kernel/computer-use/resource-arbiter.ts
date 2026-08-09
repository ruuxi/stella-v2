import type {
  ComputerUseAction,
  ComputerUseAppSelector,
  ComputerUseRequest,
  ComputerUseResponse,
  ComputerUseTarget,
} from "./contract.js";

const GLOBAL_HID_RESOURCE = "global-hid";

const GLOBAL_HID_ACTIONS = new Set<ComputerUseAction["type"]>([
  "click_point",
  "drag",
  "press_key",
  "type_text",
]);

type LockWaiter = {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

type ResourceLock = {
  held: boolean;
  waiters: LockWaiter[];
};

const abortError = (signal: AbortSignal) =>
  signal.reason instanceof Error
    ? signal.reason
    : new Error("Computer-use resource wait aborted.");

const normalizedTargetValue = (value: string) =>
  value.trim().toLocaleLowerCase();

const selectorKey = (target: ComputerUseAppSelector) =>
  target.type === "app"
    ? `app:${normalizedTargetValue(target.app)}`
    : `window:${normalizedTargetValue(target.windowId)}:${normalizedTargetValue(target.app ?? "")}`;

const targetFallbackKeys = (target: ComputerUseTarget): string[] => {
  if (target.type === "app") {
    return [`app:${normalizedTargetValue(target.app)}`];
  }
  const keys = [`window:${normalizedTargetValue(target.windowId)}`];
  if (target.app?.trim()) {
    keys.push(`app:${normalizedTargetValue(target.app)}`);
  }
  return keys;
};

const uniqueSorted = (keys: readonly string[]) =>
  [...new Set(keys.filter(Boolean))].sort();

/**
 * Serializes typed Computer Use requests that address the same OS resource.
 * Locks are process-wide through the shared instance used by the macOS
 * session factory. Multiple resources are always acquired in lexical order,
 * so opposite-order batches cannot deadlock.
 */
export class ComputerUseResourceArbiter {
  private readonly locks = new Map<string, ResourceLock>();
  private readonly canonicalTargets = new Map<string, string>();
  private readonly resourceGenerations = new Map<string, number>();
  private readonly sessionObservations = new Map<string, Map<string, number>>();

  async runRequest<TResponse extends ComputerUseResponse>(
    request: ComputerUseRequest,
    signal: AbortSignal | undefined,
    operation: () => Promise<TResponse>,
  ): Promise<TResponse> {
    if (request.type === "resolve_target") {
      const response = await operation();
      if (response.type === "target_policy") {
        this.canonicalTargets.set(
          selectorKey(request.selector),
          `app:${normalizedTargetValue(response.policy.bundleIdentifier)}`,
        );
      }
      return response;
    }

    const keys = this.keysForRequest(request);
    if (keys.length === 0) return await operation();
    return await this.run(keys, signal, async () => {
      const stateKeys = this.stateKeysForRequest(request);
      if (request.type === "action" || request.type === "batch") {
        this.assertFreshObservation(request.sessionId, stateKeys);
      }

      const response = await operation();
      if (request.type === "get_app_state" && response.type === "app_state") {
        this.observe(request.sessionId, stateKeys);
      } else if (
        (request.type === "action" && response.type === "action") ||
        (request.type === "batch" && response.type === "batch")
      ) {
        this.advanceAndObserve(request.sessionId, stateKeys);
      }
      return response;
    });
  }

  forgetSession(sessionId: string): void {
    this.sessionObservations.delete(sessionId);
  }

  async run<T>(
    resourceKeys: readonly string[],
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    const releases: Array<() => void> = [];
    try {
      for (const key of uniqueSorted(resourceKeys)) {
        releases.push(await this.acquire(key, signal));
      }
      if (signal?.aborted) throw abortError(signal);
      return await operation();
    } finally {
      while (releases.length > 0) releases.pop()?.();
    }
  }

  private keysForRequest(request: ComputerUseRequest): string[] {
    if (
      request.type === "list_apps" ||
      request.type === "list_windows" ||
      request.type === "resolve_target"
    ) {
      return [];
    }
    if (request.type === "get_app_state") {
      return this.keysForTarget(request.target);
    }
    if (request.type === "action") {
      return uniqueSorted([
        ...this.keysForTarget(request.command.target),
        ...(GLOBAL_HID_ACTIONS.has(request.command.action.type)
          ? [GLOBAL_HID_RESOURCE]
          : []),
      ]);
    }
    return uniqueSorted(
      request.commands.flatMap((command) => [
        ...this.keysForTarget(command.target),
        ...(GLOBAL_HID_ACTIONS.has(command.action.type)
          ? [GLOBAL_HID_RESOURCE]
          : []),
      ]),
    );
  }

  private stateKeysForRequest(request: ComputerUseRequest): string[] {
    if (request.type === "get_app_state") {
      return this.keysForTarget(request.target);
    }
    if (request.type === "action") {
      return this.keysForTarget(request.command.target);
    }
    if (request.type === "batch") {
      return uniqueSorted(
        request.commands.flatMap((command) =>
          this.keysForTarget(command.target),
        ),
      );
    }
    return [];
  }

  private assertFreshObservation(
    sessionId: string,
    resourceKeys: readonly string[],
  ): void {
    const observations = this.sessionObservations.get(sessionId);
    const staleKeys = resourceKeys.filter(
      (key) =>
        observations?.get(key) !== (this.resourceGenerations.get(key) ?? 0),
    );
    if (staleKeys.length > 0) {
      throw new ComputerUseResourceStaleError(staleKeys);
    }
  }

  private observe(sessionId: string, resourceKeys: readonly string[]): void {
    const observations =
      this.sessionObservations.get(sessionId) ?? new Map<string, number>();
    this.sessionObservations.set(sessionId, observations);
    for (const key of resourceKeys) {
      observations.set(key, this.resourceGenerations.get(key) ?? 0);
    }
  }

  private advanceAndObserve(
    sessionId: string,
    resourceKeys: readonly string[],
  ): void {
    for (const key of resourceKeys) {
      this.resourceGenerations.set(
        key,
        (this.resourceGenerations.get(key) ?? 0) + 1,
      );
    }
    this.observe(sessionId, resourceKeys);
  }

  private keysForTarget(target: ComputerUseTarget): string[] {
    const canonical = this.canonicalTargets.get(selectorKey(target));
    if (target.type === "app") {
      return canonical ? [canonical] : targetFallbackKeys(target);
    }
    return uniqueSorted([
      ...targetFallbackKeys(target),
      ...(canonical ? [canonical] : []),
    ]);
  }

  private acquire(
    key: string,
    signal: AbortSignal | undefined,
  ): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const lock = this.locks.get(key) ?? { held: false, waiters: [] };
    this.locks.set(key, lock);

    if (!lock.held) {
      lock.held = true;
      return Promise.resolve(this.releaseFor(key, lock));
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: LockWaiter = {
        resolve,
        reject,
        ...(signal ? { signal } : {}),
      };
      lock.waiters.push(waiter);
      if (signal) {
        waiter.onAbort = () => {
          const index = lock.waiters.indexOf(waiter);
          if (index < 0) return;
          lock.waiters.splice(index, 1);
          signal.removeEventListener("abort", waiter.onAbort!);
          reject(abortError(signal));
          if (!lock.held && lock.waiters.length === 0) {
            this.locks.delete(key);
          }
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
        if (signal.aborted) waiter.onAbort();
      }
    });
  }

  private releaseFor(key: string, lock: ResourceLock): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (;;) {
        const waiter = lock.waiters.shift();
        if (!waiter) {
          lock.held = false;
          if (this.locks.get(key) === lock) this.locks.delete(key);
          return;
        }
        waiter.signal?.removeEventListener("abort", waiter.onAbort!);
        if (waiter.signal?.aborted) {
          waiter.reject(abortError(waiter.signal));
          continue;
        }
        waiter.resolve(this.releaseFor(key, lock));
        return;
      }
    };
  }
}

export class ComputerUseResourceStaleError extends Error {
  readonly code = "stale_observation";
  readonly retryable = true;

  constructor(readonly resourceKeys: readonly string[]) {
    super(
      "Computer state changed after this session observed it. Call get_app_state for the target, then retry the action.",
    );
    this.name = "ComputerUseResourceStaleError";
  }
}

export const macComputerUseResourceArbiter = new ComputerUseResourceArbiter();
