import type {
  ComputerUseAction,
  ComputerUseAppSelector,
  ComputerUseRequest,
  ComputerUseResponse,
  ComputerUseTarget,
  JsonObject,
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

    const stateKeys = this.stateKeysForRequest(request);
    if (request.type === "wait_for_change") {
      const initialGeneration = await this.run(stateKeys, signal, async () => {
        this.assertSessionGenerationFresh(
          request.sessionId,
          stateKeys,
          request.afterStateId,
        );
        return this.currentGeneration(stateKeys);
      });
      const response = await operation();
      if (response.type === "wait_for_change") {
        return await this.run(stateKeys, signal, async () => {
          const generation = this.currentGeneration(stateKeys);
          if (generation !== initialGeneration) {
            throw new ComputerUseResourceStaleError(
              request.afterStateId,
              `resource_generation_${generation}`,
              {
                resourceKeys: stateKeys,
                observedResourceGeneration: initialGeneration,
                currentResourceGeneration: generation,
              },
            );
          }
          this.observe(request.sessionId, stateKeys);
          return this.withResourceGeneration(response, generation);
        });
      }
      return response;
    }

    const keys = this.keysForRequest(request);
    if (keys.length === 0) return await operation();
    return await this.run(keys, signal, async () => {
      const mutatingRequest =
        request.type === "action" || request.type === "batch";
      let mutationAttempted = false;
      let mutationSucceeded = false;
      if (request.type === "action" || request.type === "batch") {
        this.assertFreshObservation(request, stateKeys);
      }
      try {

        mutationAttempted = mutatingRequest;
        const response = await operation();
        mutationSucceeded =
          (request.type === "action" && response.type === "action") ||
          (request.type === "batch" && response.type === "batch");
        if (request.type === "get_app_state" && response.type === "app_state") {
          const generation = this.currentGeneration(stateKeys);
          this.observe(request.sessionId, stateKeys);
          return this.withResourceGeneration(response, generation);
        }
        return response;
      } finally {
        if (mutationAttempted) {
          this.advance(stateKeys);

          if (mutationSucceeded) this.observe(request.sessionId, stateKeys);
        }
      }
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
    if (
      request.type === "get_app_state" ||
      request.type === "wait_for_change"
    ) {
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
    if (
      request.type === "get_app_state" ||
      request.type === "wait_for_change"
    ) {
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

  private currentGeneration(resourceKeys: readonly string[]): number {
    return resourceKeys.reduce(
      (highest, key) =>
        Math.max(highest, this.resourceGenerations.get(key) ?? 0),
      0,
    );
  }

  private assertSessionGenerationFresh(
    sessionId: string,
    resourceKeys: readonly string[],
    observedStateId: string,
  ): void {
    const observations = this.sessionObservations.get(sessionId);
    const staleKeys = resourceKeys.filter((key) => {
      const current = this.resourceGenerations.get(key) ?? 0;
      const observed = observations?.get(key);
      return observed === undefined ? current > 0 : observed !== current;
    });
    if (staleKeys.length === 0) return;
    const currentGeneration = this.currentGeneration(resourceKeys);
    throw new ComputerUseResourceStaleError(
      observedStateId,
      `resource_generation_${currentGeneration}`,
      {
        resourceKeys: staleKeys,
        currentResourceGeneration: currentGeneration,
      },
    );
  }

  private assertFreshObservation(
    request: Extract<ComputerUseRequest, { type: "action" | "batch" }>,
    resourceKeys: readonly string[],
  ): void {
    const commands =
      request.type === "action" ? [request.command] : request.commands;
    const currentGeneration = this.currentGeneration(resourceKeys);
    const observations = this.sessionObservations.get(request.sessionId);
    for (const command of commands) {
      if (command.observedResourceGeneration !== undefined) {
        const observedGeneration = command.observedResourceGeneration!;
        const commandKeys = this.keysForTarget(command.target);
        const commandGeneration = this.currentGeneration(commandKeys);
        if (observedGeneration !== commandGeneration) {
          throw new ComputerUseResourceStaleError(
            command.observedStateId ??
              `resource_generation_${observedGeneration}`,
            `resource_generation_${commandGeneration}`,
            {
              resourceKeys: commandKeys,
              observedResourceGeneration: observedGeneration,
              currentResourceGeneration: commandGeneration,
            },
          );
        }
        continue;
      }

      const commandKeys = this.keysForTarget(command.target);
      const staleKeys = commandKeys.filter((key) => {
        const current = this.resourceGenerations.get(key) ?? 0;
        const observed = observations?.get(key);
        return observed === undefined ? current > 0 : observed !== current;
      });
      if (staleKeys.length > 0) {
        throw new ComputerUseResourceStaleError(
          command.observedStateId ?? "state_unobserved",
          `resource_generation_${currentGeneration}`,
          {
            resourceKeys: staleKeys,
            currentResourceGeneration: currentGeneration,
          },
        );
      }
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

  private advance(resourceKeys: readonly string[]): void {
    for (const key of resourceKeys) {
      this.resourceGenerations.set(
        key,
        (this.resourceGenerations.get(key) ?? 0) + 1,
      );
    }
  }

  private withResourceGeneration<TResponse extends ComputerUseResponse>(
    response: TResponse,
    resourceGeneration: number,
  ): TResponse {
    if (response.type !== "app_state" && response.type !== "wait_for_change") {
      return response;
    }
    return {
      ...response,
      state: { ...response.state, resourceGeneration },
    } as TResponse;
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

  constructor(
    readonly observedStateId: string,
    readonly currentStateId: string,
    details: {
      resourceKeys?: readonly string[];
      observedResourceGeneration?: number;
      currentResourceGeneration?: number;
      nativeObserved?: JsonObject;
      nativeCurrent?: JsonObject;
      nativeReason?: string;
    } = {},
  ) {
    super(
      `Computer state changed after the supplied snapshot (observed_state_id=${observedStateId}, current_state_id=${currentStateId}). Call get_app_state for the target, then retry with its new state_id.`,
    );
    this.name = "ComputerUseResourceStaleError";
    this.resourceKeys = details.resourceKeys;
    this.observedResourceGeneration = details.observedResourceGeneration;
    this.currentResourceGeneration = details.currentResourceGeneration;
    this.nativeObserved = details.nativeObserved;
    this.nativeCurrent = details.nativeCurrent;
    this.nativeReason = details.nativeReason;
  }

  readonly resourceKeys?: readonly string[];
  readonly observedResourceGeneration?: number;
  readonly currentResourceGeneration?: number;
  readonly nativeObserved?: JsonObject;
  readonly nativeCurrent?: JsonObject;
  readonly nativeReason?: string;
}

export const macComputerUseResourceArbiter = new ComputerUseResourceArbiter();
