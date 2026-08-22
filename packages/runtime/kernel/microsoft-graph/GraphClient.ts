import { MICROSOFT_GRAPH_BASE_URL } from "./constants.js";

export type GraphHttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type GraphQuery = Record<
  string,
  string | number | boolean | undefined | null
>;

export type GraphRequestOptions = {
  method?: GraphHttpMethod;
  query?: GraphQuery;
  body?: unknown;
  headers?: Record<string, string>;
};

export type GraphTokenProvider = () => Promise<string>;

export type GraphFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<{
  status: number;
  ok: boolean;
  text: () => Promise<string>;
  headers?: { get(name: string): string | null };
}>;

/** Structured Graph API error that never carries the caller's credentials. */
export class GraphApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "GraphApiError";
  }
}

const isAbsoluteUrl = (value: string) => /^https?:\/\//i.test(value);

/**
 * Minimal, dependency-free Microsoft Graph REST client. Injects the shared
 * Microsoft grant's bearer token on every call and returns parsed JSON.
 *
 * Deliberately fetch-based (no `@microsoft/microsoft-graph-client` dependency)
 * to keep the first-party surface narrow while the shared connector execution
 * core is still pending. The token provider and fetch implementation are
 * injectable so services stay unit-testable without a live tenant.
 */
export class GraphClient {
  private readonly baseUrl: string;
  private readonly getAccessToken: GraphTokenProvider;
  private readonly fetchImpl: GraphFetch;

  constructor(options: {
    getAccessToken: GraphTokenProvider;
    baseUrl?: string;
    fetchImpl?: GraphFetch;
  }) {
    this.getAccessToken = options.getAccessToken;
    this.baseUrl = (options.baseUrl ?? MICROSOFT_GRAPH_BASE_URL).replace(
      /\/+$/,
      "",
    );
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as GraphFetch);
    if (!this.fetchImpl) {
      throw new Error("No fetch implementation available for GraphClient.");
    }
  }

  buildUrl(pathOrUrl: string, query?: GraphQuery): string {
    const base = isAbsoluteUrl(pathOrUrl)
      ? pathOrUrl
      : `${this.baseUrl}/${pathOrUrl.replace(/^\/+/, "")}`;
    if (!query) return base;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      params.append(key, String(value));
    }
    const qs = params.toString();
    if (!qs) return base;
    return `${base}${base.includes("?") ? "&" : "?"}${qs}`;
  }

  async request<T = unknown>(
    pathOrUrl: string,
    options: GraphRequestOptions = {},
  ): Promise<T> {
    const method = options.method ?? "GET";
    const url = this.buildUrl(pathOrUrl, options.query);
    const token = await this.getAccessToken();
    const hasBody = options.body !== undefined && method !== "GET";
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(options.headers ?? {}),
    };

    const response = await this.fetchImpl(url, {
      method,
      headers,
      ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
    });

    const raw = await response.text();
    if (!response.ok) {
      throw this.toApiError(response.status, raw, response.headers);
    }
    if (!raw) return undefined as unknown as T;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as unknown as T;
    }
  }

  get<T = unknown>(path: string, query?: GraphQuery) {
    return this.request<T>(path, { method: "GET", query });
  }

  post<T = unknown>(path: string, body?: unknown, query?: GraphQuery) {
    return this.request<T>(path, { method: "POST", body, query });
  }

  patch<T = unknown>(path: string, body?: unknown, query?: GraphQuery) {
    return this.request<T>(path, { method: "PATCH", body, query });
  }

  delete<T = unknown>(path: string, query?: GraphQuery) {
    return this.request<T>(path, { method: "DELETE", query });
  }

  private toApiError(
    status: number,
    raw: string,
    headers?: { get(name: string): string | null },
  ): GraphApiError {
    let code: string | undefined;
    let message = raw || `Microsoft Graph request failed (${status}).`;
    try {
      const parsed = JSON.parse(raw) as {
        error?: { code?: string; message?: string };
      };
      if (parsed?.error) {
        code = parsed.error.code;
        message =
          parsed.error.message ?? message ?? `Graph error (${status}).`;
      }
    } catch {
      // Non-JSON error body — keep the raw text as the message.
    }
    const requestId = headers?.get("request-id") ?? undefined;
    return new GraphApiError(message, status, code, requestId ?? undefined);
  }
}
