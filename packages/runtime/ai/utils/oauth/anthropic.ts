/**
 * Anthropic OAuth flow (Claude Pro/Max)
 *
 * NOTE: This module uses Node.js http.createServer for the OAuth callback server.
 * It is only intended for CLI use, not browser environments. Constants, the
 * token exchange and refresh are shared with every device that signs in
 * (`@stella/contracts/engine-oauth*`).
 */

import type { Server } from "node:http";
import {
	ANTHROPIC_OAUTH,
	anthropicAuthorizeUrl,
	createPkce,
	parseAuthorizationInput,
} from "@stella/contracts/engine-oauth";
import { exchangeAnthropicCode, refreshAnthropicTokens } from "@stella/contracts/engine-oauth-flows";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthPrompt, OAuthProviderInterface } from "./types.js";

type CallbackServerInfo = {
	server: Server;
	redirectUri: string;
	cancelWait: () => void;
	waitForCode: () => Promise<{ code: string; state: string } | null>;
};

type NodeApis = {
	createServer: typeof import("node:http").createServer;
};

let nodeApis: NodeApis | null = null;
let nodeApisPromise: Promise<NodeApis> | null = null;

const CALLBACK_HOST = ANTHROPIC_OAUTH.loopbackHost;
const CALLBACK_PORT = ANTHROPIC_OAUTH.loopbackPort;
const CALLBACK_PATH = ANTHROPIC_OAUTH.loopbackPath;
const REDIRECT_URI = ANTHROPIC_OAUTH.loopbackRedirectUri;
/** Credentials are treated as expired this long before the provider says. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

const throwIfOAuthAborted = (signal?: AbortSignal): void => {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error ? signal.reason : new Error("OAuth login was canceled.");
};

async function getNodeApis(): Promise<NodeApis> {
	if (nodeApis) return nodeApis;
	if (!nodeApisPromise) {
		if (typeof process === "undefined" || (!process.versions?.node && !process.versions?.bun)) {
			throw new Error("Anthropic OAuth is only available in Node.js environments");
		}
		nodeApisPromise = import("node:http").then((httpModule) => ({
			createServer: httpModule.createServer,
		}));
	}
	nodeApis = await nodeApisPromise;
	return nodeApis;
}

function formatErrorDetails(error: unknown): string {
	if (error instanceof Error) {
		const details: string[] = [`${error.name}: ${error.message}`];
		const errorWithCode = error as Error & { code?: string; errno?: number | string; cause?: unknown };
		if (errorWithCode.code) details.push(`code=${errorWithCode.code}`);
		if (typeof errorWithCode.errno !== "undefined") details.push(`errno=${String(errorWithCode.errno)}`);
		if (typeof error.cause !== "undefined") {
			details.push(`cause=${formatErrorDetails(error.cause)}`);
		}
		if (error.stack) {
			details.push(`stack=${error.stack}`);
		}
		return details.join("; ");
	}
	return String(error);
}

async function startCallbackServer(expectedState: string): Promise<CallbackServerInfo> {
	const { createServer } = await getNodeApis();

	return new Promise((resolve, reject) => {
		let settleWait: ((value: { code: string; state: string } | null) => void) | undefined;
		const waitForCodePromise = new Promise<{ code: string; state: string } | null>((resolveWait) => {
			let settled = false;
			settleWait = (value) => {
				if (settled) return;
				settled = true;
				resolveWait(value);
			};
		});

		const server = createServer((req, res) => {
			try {
				const url = new URL(req.url || "", "http://localhost");
				if (url.pathname !== CALLBACK_PATH) {
					res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Callback route not found."));
					return;
				}

				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				const error = url.searchParams.get("error");

				if (error) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Anthropic authentication did not complete.", `Error: ${error}`));
					return;
				}

				if (!code || !state) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Missing code or state parameter."));
					return;
				}

				if (state !== expectedState) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("State mismatch."));
					return;
				}

				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthSuccessHtml("Anthropic authentication completed. You can close this window."));
				settleWait?.({ code, state });
			} catch {
				res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("Internal error");
			}
		});

		server.on("error", (err) => {
			reject(err);
		});

		server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
			resolve({
				server,
				redirectUri: REDIRECT_URI,
				cancelWait: () => {
					settleWait?.(null);
				},
				waitForCode: () => waitForCodePromise,
			});
		});
	});
}

async function exchangeAuthorizationCode(
	code: string,
	state: string,
	verifier: string,
	redirectUri: string,
): Promise<OAuthCredentials> {
	let signIn: Awaited<ReturnType<typeof exchangeAnthropicCode>>;
	try {
		signIn = await exchangeAnthropicCode({ code, state, verifier, redirectUri });
	} catch (error) {
		throw new Error(
			`Token exchange request failed. redirect_uri=${redirectUri}; details=${formatErrorDetails(error)}`,
		);
	}
	// Which Claude account signed in, so several can be kept apart.
	return {
		refresh: signIn.tokens.refresh,
		access: signIn.tokens.access,
		expires: signIn.tokens.expiresAt - EXPIRY_MARGIN_MS,
		...signIn.identity,
	};
}

/**
 * Login with Anthropic OAuth (authorization code + PKCE)
 */
export async function loginAnthropic(options: {
	onAuth: (info: { url: string; instructions?: string }) => void;
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
	onProgress?: (message: string) => void;
	onManualCodeInput?: () => Promise<string>;
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	throwIfOAuthAborted(options.signal);
	const { verifier, challenge } = await createPkce();
	const server = await startCallbackServer(verifier);
	const abortWait = () => server.cancelWait();
	options.signal?.addEventListener("abort", abortWait, { once: true });
	if (options.signal?.aborted) abortWait();

	let code: string | undefined;
	let state: string | undefined;
	let redirectUriForExchange = REDIRECT_URI;

	try {
		options.onAuth({
			url: anthropicAuthorizeUrl({ challenge, state: verifier, redirectUri: REDIRECT_URI }),
			instructions:
				"Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.",
		});

		if (options.onManualCodeInput) {
			let manualInput: string | undefined;
			let manualError: Error | undefined;
			const manualPromise = options
				.onManualCodeInput()
				.then((input) => {
					manualInput = input;
					server.cancelWait();
				})
				.catch((err) => {
					manualError = err instanceof Error ? err : new Error(String(err));
					server.cancelWait();
				});

			const result = await server.waitForCode();
			throwIfOAuthAborted(options.signal);

			if (manualError) {
				throw manualError;
			}

			if (result?.code) {
				code = result.code;
				state = result.state;
				redirectUriForExchange = REDIRECT_URI;
			} else if (manualInput) {
				const parsed = parseAuthorizationInput(manualInput);
				if (parsed.state && parsed.state !== verifier) {
					throw new Error("OAuth state mismatch");
				}
				code = parsed.code;
				state = parsed.state ?? verifier;
			}

			if (!code) {
				await manualPromise;
				if (manualError) {
					throw manualError;
				}
				if (manualInput) {
					const parsed = parseAuthorizationInput(manualInput);
					if (parsed.state && parsed.state !== verifier) {
						throw new Error("OAuth state mismatch");
					}
					code = parsed.code;
					state = parsed.state ?? verifier;
				}
			}
		} else {
			const result = await server.waitForCode();
			throwIfOAuthAborted(options.signal);
			if (result?.code) {
				code = result.code;
				state = result.state;
				redirectUriForExchange = REDIRECT_URI;
			}
		}

		throwIfOAuthAborted(options.signal);
		if (!code) {
			const input = await options.onPrompt({
				message: "Paste the authorization code or full redirect URL:",
				placeholder: REDIRECT_URI,
			});
			const parsed = parseAuthorizationInput(input);
			if (parsed.state && parsed.state !== verifier) {
				throw new Error("OAuth state mismatch");
			}
			code = parsed.code;
			state = parsed.state ?? verifier;
		}

		if (!code) {
			throw new Error("Missing authorization code");
		}

		if (!state) {
			throw new Error("Missing OAuth state");
		}

		options.onProgress?.("Exchanging authorization code for tokens...");
		throwIfOAuthAborted(options.signal);
		return exchangeAuthorizationCode(code, state, verifier, redirectUriForExchange);
	} finally {
		options.signal?.removeEventListener("abort", abortWait);
		server.server.close();
	}
}

/**
 * Refresh Anthropic OAuth token
 */
export async function refreshAnthropicToken(refreshToken: string): Promise<OAuthCredentials> {
	let tokens: Awaited<ReturnType<typeof refreshAnthropicTokens>>;
	try {
		tokens = await refreshAnthropicTokens(refreshToken);
	} catch (error) {
		throw new Error(`Anthropic token refresh request failed. details=${formatErrorDetails(error)}`);
	}
	return {
		refresh: tokens.refresh,
		access: tokens.access,
		expires: tokens.expiresAt - EXPIRY_MARGIN_MS,
	};
}

export const anthropicOAuthProvider: OAuthProviderInterface = {
	id: "anthropic",
	name: "Anthropic (Claude Pro/Max)",
	usesCallbackServer: true,

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginAnthropic({
			onAuth: callbacks.onAuth,
			onPrompt: callbacks.onPrompt,
			onProgress: callbacks.onProgress,
			onManualCodeInput: callbacks.onManualCodeInput,
			signal: callbacks.signal,
		});
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshAnthropicToken(credentials.refresh);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};
