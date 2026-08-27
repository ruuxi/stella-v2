export type StellaUser = {
  userId: string | null;
  username: string;
  anonymous: boolean;
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
