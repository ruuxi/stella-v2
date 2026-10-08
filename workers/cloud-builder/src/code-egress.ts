/**
 * Where a General agent's `code` fetches go.
 *
 * The Dynamic Worker that runs an agent's code has this entrypoint as its
 * `globalOutbound`, so every `fetch` the model's code makes lands here first.
 * It applies the `web` tool's protections (a public http(s) target, no URL
 * that carries a credential, every redirect hop checked again) and then the
 * sandbox's general-agent egress budget, keyed by the owner world. The
 * orchestrator's code never gets an outbound at all.
 *
 * workerd has no resolver hook, so the address check is literal-only, as it
 * is for the `web` tool; Cloudflare's own egress policy backstops names that
 * resolve into private space.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { containsSecretLikeToken } from "@stella/runtime/kernel/tools/safety.js";
import { normalizeSafePublicUrl } from "@stella/runtime/kernel/tools/url-guard.js";
import { createGeneralAgentEgress } from "./sandbox-egress-policy.js";

export type CodeEgressProps = Readonly<{
  /** The owner world whose budget these requests draw on. */
  scope: string;
}>;

const MAX_REDIRECTS = 10;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
/** A cross-origin hop never carries the caller's credentials along. */
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];

/**
 * A refusal the cell can tell apart from the site's own 403: the header
 * names Stella, and the body says why.
 */
const refusal = (message: string): Response =>
  new Response(`Stella refused this request: ${message}`, {
    status: 403,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-stella-egress": "refused",
    },
  });

const reasonOf = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : "the URL is not allowed.";

/** The `web` tool's URL rule, which also upgrades http to https. */
const guardUrl = async (url: string): Promise<string> => {
  if (containsSecretLikeToken(url)) {
    throw new Error(
      "the URL contains what appears to be an API key or token. Secrets must not be sent in URLs.",
    );
  }
  return await normalizeSafePublicUrl(url);
};

/**
 * Follow redirects here rather than in the platform, so each hop passes the
 * same guard as the first. The body is buffered once so a 307/308 can send it
 * again; the cell built it in memory anyway.
 */
const fetchGuarded = async (request: Request): Promise<Response> => {
  const mode = request.redirect;
  const replayable =
    request.method === "GET" || request.method === "HEAD"
      ? null
      : await request.arrayBuffer();
  let url = request.url;
  let method = request.method;
  let body: ArrayBuffer | null = replayable;
  const headers = new Headers(request.headers);
  for (let hop = 0; ; hop += 1) {
    const response = await fetch(url, {
      method,
      headers,
      body,
      redirect: "manual",
      signal: request.signal,
    });
    const location = response.headers.get("location");
    if (mode === "manual" || !REDIRECT_STATUSES.has(response.status) || !location) {
      return response;
    }
    await response.body?.cancel().catch(() => undefined);
    if (mode === "error") {
      throw new TypeError("The request was redirected and its redirect mode is \"error\".");
    }
    if (hop >= MAX_REDIRECTS) {
      return refusal(`more than ${MAX_REDIRECTS} redirects.`);
    }
    let next: string;
    try {
      next = await guardUrl(new URL(location, url).toString());
    } catch (error) {
      return refusal(`a redirect went somewhere not allowed: ${reasonOf(error)}`);
    }
    if (new URL(next).origin !== new URL(url).origin) {
      for (const name of CREDENTIAL_HEADERS) headers.delete(name);
    }
    if (
      (response.status === 303 && method !== "HEAD") ||
      ((response.status === 301 || response.status === 302) && method === "POST")
    ) {
      method = "GET";
      body = null;
      headers.delete("content-type");
      headers.delete("content-length");
    }
    url = next;
  }
};

const budget = createGeneralAgentEgress({ fetch: fetchGuarded });

export const codeEgress = async (
  request: Request,
  scope: string,
): Promise<Response> => {
  let target: string;
  try {
    target = await guardUrl(request.url);
  } catch (error) {
    return refusal(reasonOf(error));
  }
  return await budget(new Request(target, request), undefined, {
    containerId: `code:${scope}`,
  });
};

export class CodeEgress extends WorkerEntrypoint<Env, CodeEgressProps> {
  async fetch(request: Request): Promise<Response> {
    return await codeEgress(request, this.ctx.props.scope);
  }
}
