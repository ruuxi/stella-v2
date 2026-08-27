import type { HookEvent, HookDefinition, HookEventMap } from "./types.js";

export class HookEmitter {
  private hooks: HookDefinition[] = [];

  register(hook: HookDefinition): void {
    this.hooks.push(hook);
  }

  registerAll(hooks: HookDefinition[]): void {
    for (const hook of hooks) {
      this.register(hook);
    }
  }

  has(event: HookEvent): boolean {
    for (const hook of this.hooks) {
      if (hook.event === event) return true;
    }
    return false;
  }

  async emit<E extends HookEvent>(
    event: E,
    payload: HookEventMap[E]["payload"],
    filterContext?: { tool?: string; agentType?: string },
  ): Promise<HookEventMap[E]["result"] | void> {
    const matching = this.hooks.filter((hook) => {
      if (hook.event !== event) return false;
      if (
        hook.filter?.tool &&
        filterContext?.tool &&
        hook.filter.tool !== filterContext.tool
      ) {
        return false;
      }
      if (
        hook.filter?.agentType &&
        filterContext?.agentType &&
        hook.filter.agentType !== filterContext.agentType
      ) {
        return false;
      }
      return true;
    });

    if (matching.length === 0) {
      return undefined;
    }

    const isMergeableEvent = event === "agent_end";

    let lastResult: HookEventMap[E]["result"] | void = undefined;
    let merged: Record<string, unknown> | undefined;

    for (const hook of matching) {
      try {
        const result = await (
          hook.handler as (
            p: HookEventMap[E]["payload"],
          ) => Promise<HookEventMap[E]["result"] | void>
        )(payload);
        if (result === undefined || result === null) {
          continue;
        }
        if (isMergeableEvent && typeof result === "object") {

          const filtered: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(
            result as Record<string, unknown>,
          )) {
            if (value === undefined) continue;
            filtered[key] = value;
          }
          merged = merged ? { ...merged, ...filtered } : filtered;
          continue;
        }
        lastResult = result;
        if (
          event === "before_tool" &&
          typeof result === "object" &&
          (result as Record<string, unknown>).cancel
        ) {
          return result;
        }
      } catch (error) {
        console.error(
          `[stella:hook] Error in ${event} hook:`,
          (error as Error).message,
        );
      }
    }

    if (merged) {
      return merged as HookEventMap[E]["result"];
    }
    return lastResult;
  }

  async emitAll<E extends HookEvent>(
    event: E,
    payload: HookEventMap[E]["payload"],
    filterContext?: { tool?: string; agentType?: string },
  ): Promise<Array<HookEventMap[E]["result"]>> {
    const matching = this.hooks.filter((hook) => {
      if (hook.event !== event) return false;
      if (
        hook.filter?.tool &&
        filterContext?.tool &&
        hook.filter.tool !== filterContext.tool
      ) {
        return false;
      }
      if (
        hook.filter?.agentType &&
        filterContext?.agentType &&
        hook.filter.agentType !== filterContext.agentType
      ) {
        return false;
      }
      return true;
    });

    const results: Array<HookEventMap[E]["result"]> = [];
    for (const hook of matching) {
      try {
        const result = await (
          hook.handler as (
            p: HookEventMap[E]["payload"],
          ) => Promise<HookEventMap[E]["result"] | void>
        )(payload);
        if (result !== undefined && result !== null) {
          results.push(result as HookEventMap[E]["result"]);
        }
      } catch (error) {
        console.error(
          `[stella:hook] Error in ${event} hook:`,
          (error as Error).message,
        );
      }
    }
    return results;
  }

  clear(): void {
    this.hooks = [];
  }

  clearBySource(source: "bundled" | "extension"): void {
    this.hooks = this.hooks.filter((hook) => {
      const hookSource = hook.source ?? "extension";
      return hookSource !== source;
    });
  }
}
