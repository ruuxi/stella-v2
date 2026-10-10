/**
 * Sign in with ChatGPT on this computer: the 127.0.0.1 loopback listener and
 * the browser round trip. Node only (Electron main); the protocol itself
 * lives in `@stella/contracts/chatgpt-siwc*`.
 *
 * The listener serves exactly `GET /auth/callback` on 127.0.0.1, answers
 * unrelated requests (and callbacks for another attempt's state) without
 * ending the wait, and closes after the attempt.
 */

import type { Server } from "node:http";
import {
  CHATGPT_SIWC,
  ChatGptError,
  chatGptAuthorizeUrl,
  chatGptLoopbackRedirectUri,
  parseChatGptCallback,
  type ChatGptRegistration,
} from "@stella/contracts/chatgpt-siwc";
import {
  chatGptDiscovery,
  completeChatGptSignIn,
  createChatGptPendingSignIn,
} from "@stella/contracts/chatgpt-siwc-flows";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.js";

/** How long a browser sign-in may take before the listener gives up. */
const SIGN_IN_TIMEOUT_MS = 15 * 60_000;

export type ChatGptLoopback = {
  /** `http://127.0.0.1:<port>/auth/callback`, exact for this attempt. */
  redirectUri: string;
  port: number;
  /**
   * The full callback URL carrying `state`. Requests with another state are
   * refused without ending the wait.
   */
  waitForCallback(state: string): Promise<string>;
  close(): void;
};

const canceled = (signal?: AbortSignal): Error =>
  signal?.reason instanceof Error ? signal.reason : new ChatGptError("cancelled", "ChatGPT sign-in was canceled.");

/**
 * Listen on 127.0.0.1, preferring the documented port and falling back to
 * any free one (only the port may vary between sign-ins).
 */
export async function listenForChatGptCallback(options: { signal?: AbortSignal } = {}): Promise<ChatGptLoopback> {
  if (typeof process === "undefined" || (!process.versions?.node && !process.versions?.bun)) {
    throw new Error("ChatGPT sign-in on this computer needs Node.js.");
  }
  const { createServer } = await import("node:http");
  const attempt: { state: string | null; settle: ((value: string | Error) => void) | null } = {
    state: null,
    settle: null,
  };
  const result = new Promise<string>((resolve, reject) => {
    attempt.settle = (value) => {
      attempt.settle = null;
      if (value instanceof Error) reject(value);
      else resolve(value);
    };
  });
  const settle = (value: string | Error) => attempt.settle?.(value);
  // The callback may land before anyone awaits it.
  void result.catch(() => undefined);
  let port = 0;

  const server: Server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    const html = (status: number, body: string) => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
      res.end(body);
    };
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${CHATGPT_SIWC.loopbackHost}:${port}`);
    } catch {
      html(400, oauthErrorHtml("This sign-in link isn't valid."));
      return;
    }
    if (req.method !== "GET" || url.pathname !== CHATGPT_SIWC.loopbackPath || !attempt.settle) {
      html(404, oauthErrorHtml("Nothing is waiting for this sign-in."));
      return;
    }
    const states = url.searchParams.getAll("state");
    if (!attempt.state || states.length !== 1 || states[0] !== attempt.state) {
      html(400, oauthErrorHtml("This sign-in belongs to a different attempt. Return to the tab that started it."));
      return;
    }
    if (url.searchParams.has("error")) {
      html(400, oauthErrorHtml("ChatGPT sign-in didn't complete. You can close this tab and try again in Stella."));
    } else {
      html(200, oauthSuccessHtml("You're signed in to ChatGPT. Return to Stella; you can close this tab."));
    }
    settle(url.toString());
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;

  const listen = (candidate: number) =>
    new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.removeListener("error", onError);
        reject(error);
      };
      server.once("error", onError);
      server.listen(candidate, CHATGPT_SIWC.loopbackHost, () => {
        server.removeListener("error", onError);
        const address = server.address();
        port = address && typeof address !== "string" ? address.port : candidate;
        resolve();
      });
    });
  try {
    await listen(CHATGPT_SIWC.defaultLoopbackPort);
  } catch {
    await listen(0);
  }

  const deadline = AbortSignal.timeout(SIGN_IN_TIMEOUT_MS);
  const timeOut = () => settle(new ChatGptError("timeout", "ChatGPT sign-in timed out. Try again."));
  deadline.addEventListener("abort", timeOut, { once: true });
  const abort = () => settle(canceled(options.signal));
  options.signal?.addEventListener("abort", abort, { once: true });
  const close = () => {
    deadline.removeEventListener("abort", timeOut);
    options.signal?.removeEventListener("abort", abort);
    settle(new ChatGptError("cancelled", "ChatGPT sign-in was canceled."));
    server.close();
    server.closeAllConnections?.();
  };
  if (options.signal?.aborted) abort();

  return {
    redirectUri: chatGptLoopbackRedirectUri(port),
    port,
    waitForCallback: (state) => {
      attempt.state = state;
      return result;
    },
    close,
  };
}

/** A saved registration being signed in again on this computer. */
export type ChatGptSavedRegistration = {
  clientId: string;
  subject?: string;
  /** Retained ID token from the last sign-in; omitted after signing out. */
  idTokenHint?: string;
  email?: string;
};

/**
 * Run the whole sign-in on this computer: listener first, then the browser
 * with fresh state, nonce and PKCE and this host's id. A new registration
 * reports its issued client id through `onRegistration` before the one-time
 * code exchange, so a failed exchange can sign in again with it instead of
 * registering another app.
 */
export async function loginChatGpt(options: {
  hostId: string;
  saved?: ChatGptSavedRegistration;
  /** Ask for consent again, to enable ChatGPT plan usage after a decline. */
  reconsent?: boolean;
  openUrl: (url: string) => void;
  onRegistration?: (clientId: string) => void | Promise<void>;
  signal?: AbortSignal;
}): Promise<ChatGptRegistration> {
  const discovery = await chatGptDiscovery({ signal: options.signal });
  const listener = await listenForChatGptCallback({ signal: options.signal });
  try {
    const pending = await createChatGptPendingSignIn();
    const saved = options.saved;
    options.openUrl(
      chatGptAuthorizeUrl({
        authorizationEndpoint: discovery.authorization_endpoint,
        hostId: options.hostId,
        redirectUri: listener.redirectUri,
        state: pending.state,
        nonce: pending.nonce,
        challenge: pending.challenge,
        ...(saved ? { clientId: saved.clientId } : {}),
        ...(saved?.idTokenHint ? { idTokenHint: saved.idTokenHint } : {}),
        ...(saved?.email ? { loginHint: saved.email } : {}),
        ...(options.reconsent ? { reconsent: true } : {}),
      }),
    );
    const callbackUrl = await listener.waitForCallback(pending.state);
    const callback = parseChatGptCallback(callbackUrl, {
      state: pending.state,
      ...(saved ? { savedClientId: saved.clientId } : {}),
    });
    if (!saved) await options.onRegistration?.(callback.clientId);
    if (options.signal?.aborted) throw canceled(options.signal);
    return await completeChatGptSignIn(
      {
        callback,
        verifier: pending.verifier,
        nonce: pending.nonce,
        redirectUri: listener.redirectUri,
        ...(saved?.subject ? { expectedSubject: saved.subject } : {}),
      },
      { signal: options.signal },
    );
  } finally {
    listener.close();
  }
}
