export type StellaUser = {
  userId: string | null;
  username: string;
  anonymous: boolean;
};

export type StellaOperationArg = {
  name: string;
  type: "string" | "number" | "boolean";
  description?: string;
  required?: boolean;
};

export type StellaOperationDef = {
  name: string;
  description: string;
  args?: StellaOperationArg[];
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
};

type OperationInvocation = {
  invocationId: string;
  name: string;
  argsJson: string;
};

export type StellaAppContext = {
  appId: string;
  convexSiteUrl: string;
  bridge?: boolean;
};

type BridgeResponse = { id: string; result?: unknown; error?: string };
type Session = { token: string; user: StellaUser; expiresAt: number };

declare global {
  interface Window {
    __STELLA_APP_CONTEXT__?: StellaAppContext;
    stella?: Stella;
  }
}

const requestBridge = (() => {
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  if (typeof window !== "undefined") {
    window.addEventListener("message", (event: MessageEvent<BridgeResponse>) => {
      if (!event.data?.id || !pending.has(event.data.id)) return;
      const entry = pending.get(event.data.id)!;
      pending.delete(event.data.id);
      event.data.error
        ? entry.reject(new Error(event.data.error))
        : entry.resolve(event.data.result);
    });
  }
  return (method: string, params?: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timeout = window.setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Stella bridge timed out for ${method}.`));
      }, 15_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      window.parent.postMessage(
        { source: "stella-app", id, method, params },
        "*",
      );
    });
})();

export class Stella {
  readonly context: StellaAppContext;
  private sessionPromise: Promise<Session> | null = null;

  constructor(context: StellaAppContext) {
    this.context = context;
  }

  private async session(): Promise<Session> {
    if (this.context.bridge) {
      return (await requestBridge("session", {
        appId: this.context.appId,
      })) as Session;
    }
    if (!this.sessionPromise) {
      this.sessionPromise = fetch(
        `${this.context.convexSiteUrl}/api/apps/session`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ appId: this.context.appId }),
        },
      ).then(async (response) => {
        const body = (await response.json()) as Session & { error?: string };
        if (!response.ok) throw new Error(body.error ?? "Could not start app session.");
        return body;
      });
    }
    const session = await this.sessionPromise;
    if (session.expiresAt <= Date.now() + 5_000) {
      this.sessionPromise = null;
      return this.session();
    }
    return session;
  }

  private async call(path: string, body: unknown): Promise<any> {
    if (this.context.bridge) return requestBridge(path, body);
    const session = await this.session();
    const response = await fetch(
      `${this.context.convexSiteUrl}/api/apps/${path}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? `Stella ${path} failed.`);
    return payload;
  }

  readonly user = {
    get: async (): Promise<StellaUser> => (await this.session()).user,
  };

  private registeredOperations = new Map<string, StellaOperationDef>();
  private operationsListening = false;

  /**
   * Two-speed operations layer: the app declares named deterministic
   * functions once, its own UI calls them directly, and the Stella agent
   * invokes the same functions with model-chosen arguments. Handlers run
   * only inside this app instance; the platform sees names, argument
   * descriptors, and JSON results — never code.
   */
  readonly operations = {
    register: async (defs: StellaOperationDef[]): Promise<void> => {
      for (const def of defs) {
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(def.name)) {
          throw new Error(`Operation name ${def.name} must be kebab-case.`);
        }
        if (typeof def.handler !== "function") {
          throw new Error(`Operation ${def.name} needs a handler function.`);
        }
        this.registeredOperations.set(def.name, def);
      }
      const manifest = defs.map((def) => ({
        name: def.name,
        description: def.description,
        args: (def.args ?? []).map((arg) => ({
          name: arg.name,
          type: arg.type,
          ...(arg.description ? { description: arg.description } : {}),
          ...(arg.required ? { required: true } : {}),
        })),
      }));
      const outcome = (await this.call("operations/describe", {
        operations: manifest,
      })) as { eligible?: boolean };
      this.startOperationsTransport(outcome?.eligible !== false);
    },
  };

  private validateOperationArgs(
    def: StellaOperationDef,
    args: Record<string, unknown>,
  ): void {
    const declared = def.args ?? [];
    for (const key of Object.keys(args)) {
      if (!declared.some((arg) => arg.name === key)) {
        throw new Error(`Unexpected argument ${key} for ${def.name}.`);
      }
    }
    for (const arg of declared) {
      const value = args[arg.name];
      if (value === undefined) {
        if (arg.required) {
          throw new Error(`${def.name} requires the ${arg.name} argument.`);
        }
        continue;
      }
      if (typeof value !== arg.type) {
        throw new Error(`${def.name} argument ${arg.name} must be a ${arg.type}.`);
      }
    }
  }

  private async runOperation(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; resultJson?: string; errorMessage?: string }> {
    try {
      const def = this.registeredOperations.get(name);
      if (!def) throw new Error(`Operation ${name} is not registered.`);
      this.validateOperationArgs(def, args);
      const result = await def.handler(args);
      const resultJson = JSON.stringify(result ?? null);
      if (resultJson.length > 8 * 1024) {
        throw new Error(`Operation ${name} returned more than 8 KB.`);
      }
      return { ok: true, resultJson };
    } catch (error) {
      return {
        ok: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private startOperationsTransport(eligible: boolean): void {
    if (this.operationsListening || typeof window === "undefined") return;
    this.operationsListening = true;
    if (this.context.bridge) {
      window.addEventListener(
        "message",
        (
          event: MessageEvent<{
            source?: string;
            kind?: string;
            invocationId?: string;
            name?: string;
            args?: Record<string, unknown>;
          }>,
        ) => {
          const message = event.data;
          if (
            event.source !== window.parent ||
            message?.source !== "stella-host" ||
            message.kind !== "stella-operation" ||
            !message.invocationId ||
            !message.name
          ) {
            return;
          }
          void this.runOperation(message.name, message.args ?? {}).then(
            (outcome) => {
              window.parent.postMessage(
                {
                  source: "stella-app",
                  kind: "stella-operation-result",
                  invocationId: message.invocationId,
                  ...outcome,
                },
                "*",
              );
            },
          );
        },
      );
      return;
    }
    // Standalone transport: only owner sessions are eligible; poll while the
    // page is visible so a closed or backgrounded app never claims work.
    if (!eligible) return;
    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const payload = (await this.call("operations/poll", {})) as {
          invocations?: OperationInvocation[];
        };
        for (const invocation of payload.invocations ?? []) {
          const outcome = await this.runOperation(
            invocation.name,
            JSON.parse(invocation.argsJson) as Record<string, unknown>,
          );
          await this.call("operations/result", {
            invocationId: invocation.invocationId,
            ...outcome,
          });
        }
      } catch {
        // Transient polling failures are retried on the next interval.
      }
    };
    window.setInterval(() => void poll(), 3_500);
    void poll();
  }

  readonly storage = {
    get: async <T>(key: string): Promise<T | null> =>
      (await this.call("storage/get", { key })).value as T | null,
    set: async (key: string, value: unknown): Promise<void> => {
      await this.call("storage/set", { key, value });
    },
    delete: async (key: string): Promise<void> => {
      await this.call("storage/delete", { key });
    },
    list: async (): Promise<Array<{ key: string; value: unknown }>> =>
      (await this.call("storage/list", {})).entries,
  };

  async share(data: ShareData): Promise<void> {
    if (this.context.bridge) {
      await requestBridge("share", data);
    } else if (navigator.share) {
      await navigator.share(data);
    } else {
      await navigator.clipboard.writeText(data.url ?? data.text ?? "");
    }
  }

  async fetch(
    input: string,
    init?: RequestInit & { binary?: boolean },
  ): Promise<Response> {
    if (!this.context.bridge) {
      const response = await fetch(
        new URL("/api/apps/fetch", window.location.origin),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input,
            init: {
              method: init?.method,
              headers: init?.headers,
              body: typeof init?.body === "string" ? init.body : undefined,
            },
          }),
        },
      );
      if (!response.ok && response.headers.get("content-type")?.includes("application/json")) {
        const payload = (await response.json()) as { error?: string };
        throw new Error(payload.error ?? "Stella fetch failed.");
      }
      return response;
    }
    const result = (await requestBridge("fetch", {
      input,
      init: { ...init, body: typeof init?.body === "string" ? init.body : undefined },
      binary: init?.binary === true,
    })) as { status: number; headers: Record<string, string>; body: string; base64?: boolean };
    const bytes = result.base64
      ? Uint8Array.from(atob(result.body), (char) => char.charCodeAt(0))
      : result.body;
    return new Response(bytes, { status: result.status, headers: result.headers });
  }
}

export const createStella = (
  context = window.__STELLA_APP_CONTEXT__,
): Stella => {
  if (!context?.appId || !context.convexSiteUrl) {
    throw new Error("This app is missing its Stella platform context.");
  }
  return new Stella(context);
};

export const stella =
  typeof window === "undefined" ? undefined : createStella();
if (typeof window !== "undefined" && stella) window.stella = stella;
