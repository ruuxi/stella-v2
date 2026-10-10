/**
 * GitHub App routes:
 *
 *   GET  /api/cloud/projects/github/callback   the App's Setup URL and OAuth callback
 *   POST /api/cloud/projects/github/webhook    installation lifecycle events
 *
 * The callback is a top-level redirect from github.com with no Stella
 * credential; the signed `state` (`src/oauth-state.ts`) routes it to the
 * owner's object, which spends the nonce. It proves which GitHub user can
 * reach the installation and ends by showing a connect code; the bind
 * happens only when the owner types that code into Stella
 * (`projects.finishGithubConnect`). See `owner-store/domains/projects.ts`.
 */

import type { RpcResponse } from "@stella/contracts/backend/protocol";
import { signOAuthState, verifyOAuthState } from "../oauth-state.js";
import {
  formatConnectCode,
  GITHUB_INSTALL_STATE_KIND,
  GITHUB_VERIFY_STATE_KIND,
} from "../owner-store/domains/projects.js";
import {
  EMPTY_ACCOUNT,
  exchangeUserCode,
  fetchInstallationAccount,
  fetchOAuthUser,
  githubAuthorizeUrl,
  GithubError,
  githubSecret,
  INSTALLATION_ID_PATTERN,
  installationIndex,
  verifyInstallationBelongsToUser,
} from "./github.js";
import { json } from "../http/response.js";

const CALLBACK_PATH = "/api/cloud/projects/github/callback";
const WEBHOOK_PATH = "/api/cloud/projects/github/webhook";
const MAX_WEBHOOK_BYTES = 1_000_000;
const RESTART = "Start the GitHub connection again from Stella — links are single-use and last 15 minutes.";

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );

/** `detail` and `extra` are HTML; escape anything user- or GitHub-supplied. */
const page = (title: string, detail: string, status = 200, extra = ""): Response =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${title}</title>` +
      `<body style="font-family:system-ui,-apple-system,sans-serif;max-width:34rem;margin:18vh auto;padding:0 1.5rem;line-height:1.5">` +
      `<h1 style="font-size:1.25rem;margin:0 0 .5rem">${title}</h1>` +
      `<p style="margin:0;color:#555">${detail}</p>${extra}</body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );

const internal = async (env: Cloudflare.Env, ownerId: string, name: string, args: unknown): Promise<RpcResponse> => {
  const gate = env.OWNER_GATES.getByName(ownerId);
  const { ownerGeneration } = await gate.snapshot();
  return await gate.ownerInternal({ name, args, ownerGeneration });
};

const callback = async (request: Request, env: Cloudflare.Env): Promise<Response> => {
  const url = new URL(request.url);
  const stateToken = url.searchParams.get("state")?.trim();
  const queryInstallationId = url.searchParams.get("installation_id")?.trim();
  const code = url.searchParams.get("code")?.trim();
  const redirectUri = `${url.origin}${url.pathname}`;
  if (url.searchParams.get("setup_action") === "request" && !queryInstallationId) {
    return page(
      "Install request sent",
      "GitHub asked an owner of that account to approve the Stella app. Connect again from Stella once they have.",
    );
  }
  if (!stateToken || (!queryInstallationId && !code)) {
    return page(
      "Couldn't finish connecting GitHub",
      "That link was missing its installation details. Start the connection again from Stella.",
      400,
    );
  }
  const state = await verifyOAuthState(env, stateToken);
  if (!state) return page("That connection link expired", RESTART, 400);

  let verifyNonce: string;
  let installationId: string;
  try {
    if (state.kind === GITHUB_INSTALL_STATE_KIND) {
      if (!queryInstallationId || !INSTALLATION_ID_PATTERN.test(queryInstallationId)) {
        return page("Couldn't finish connecting GitHub", RESTART, 400);
      }
      const begun = await internal(env, state.ownerId, "projects.githubBeginVerify", {
        nonce: state.nonce,
        installationId: queryInstallationId,
      });
      const verify = begun.ok ? (begun.value as { nonce: string; exp: number } | null) : null;
      if (!verify) return page("That connection link expired", RESTART, 400);
      installationId = queryInstallationId;
      verifyNonce = verify.nonce;
      if (!code) {
        // The installation id in the query string authorizes nothing; send
        // the browser to GitHub to prove who is connecting.
        const verifyState = await signOAuthState(env, {
          ownerId: state.ownerId,
          kind: GITHUB_VERIFY_STATE_KIND,
          nonce: verify.nonce,
          exp: verify.exp,
          extra: { installationId },
        });
        return Response.redirect(githubAuthorizeUrl(env, verifyState, redirectUri), 302);
      }
    } else if (state.kind === GITHUB_VERIFY_STATE_KIND && state.extra?.installationId && code) {
      // The signed state, not the query string, names the installation.
      installationId = state.extra.installationId;
      verifyNonce = state.nonce;
    } else {
      return page("Couldn't finish connecting GitHub", RESTART, 400);
    }

    const userToken = await exchangeUserCode(env, code, redirectUri);
    const verified = await verifyInstallationBelongsToUser(env, userToken, installationId);
    if (!verified.ok) {
      console.error(JSON.stringify({ event: "github_connect_rejected", installationId }));
      return page("Couldn't finish connecting GitHub", escapeHtml(verified.reason), 400);
    }
    const account =
      verified.account.accountLogin || verified.account.accountType
        ? verified.account
        : ((await fetchInstallationAccount(env, installationId)) ?? EMPTY_ACCOUNT);
    // The connecting user, for commit authorship; best effort.
    const connector = await fetchOAuthUser(userToken).catch(() => undefined);
    const claimed = await internal(env, state.ownerId, "projects.githubClaim", {
      nonce: verifyNonce,
      installationId,
      accountLogin: account.accountLogin.slice(0, 200),
      accountType: account.accountType.slice(0, 50),
      ...(connector ? { githubLogin: connector.login, githubUserId: connector.id } : {}),
    });
    const connectCode = claimed.ok ? (claimed.value as { connectCode: string } | null)?.connectCode : undefined;
    if (!connectCode) return page("Couldn't finish connecting GitHub", RESTART, 400);
    // The code is shown, never redirected with: this handler has no Stella
    // session, so typing the code into Stella is what supplies the other
    // half of the proof.
    return page(
      "One step left",
      `Enter this code in Stella to finish connecting ${escapeHtml(account.accountLogin) || "GitHub"}. ` +
        "It works once, only in the Stella account that started this connection, and expires in 10 minutes.",
      200,
      `<p style="margin:1.25rem 0 0;font:600 1.6rem/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;user-select:all">` +
        `${escapeHtml(formatConnectCode(connectCode))}</p>`,
    );
  } catch (error) {
    if (error instanceof GithubError) {
      return page("Couldn't finish connecting GitHub", escapeHtml(error.message), 400);
    }
    console.error(
      JSON.stringify({
        event: "github_callback_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return page("Couldn't finish connecting GitHub", "Stella hit an error. Try again.", 502);
  }
};

const hmacHex = async (secret: string, body: string): Promise<string> => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const constantTimeEqual = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
};

/** Without this a revoked installation stays listed and fails only at clone time. */
const webhook = async (request: Request, env: Cloudflare.Env): Promise<Response> => {
  const secret = githubSecret(env, "GITHUB_WEBHOOK_SECRET");
  if (!secret) return json({ error: "Not configured" }, 503);
  if (Number(request.headers.get("content-length") ?? "0") > MAX_WEBHOOK_BYTES) {
    return json({ error: "Payload too large" }, 413);
  }
  const raw = await request.text();
  if (raw.length > MAX_WEBHOOK_BYTES) return json({ error: "Payload too large" }, 413);
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  if (!constantTimeEqual(signature, `sha256=${await hmacHex(secret, raw)}`)) {
    return json({ error: "Unauthorized" }, 401);
  }
  const event = request.headers.get("x-github-event") ?? "";
  if (event !== "installation") return json({ ok: true, ignored: event });
  let body: { action?: string; installation?: { id?: number } };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json({ error: "Invalid payload" }, 400);
  }
  const installationId = body.installation?.id;
  if (typeof installationId !== "number") return json({ ok: true, ignored: "no installation id" });
  const status =
    body.action === "deleted"
      ? "deleted"
      : body.action === "suspend"
        ? "suspended"
        : body.action === "unsuspend"
          ? "active"
          : null;
  if (!status) return json({ ok: true, ignored: body.action ?? "" });
  const row = await installationIndex(env).prepare("SELECT owner_id FROM github_installations WHERE installation_id = ?")
    .bind(String(installationId))
    .first<{ owner_id: string }>();
  if (!row) return json({ ok: true, ignored: "unknown installation" });
  const response = await internal(env, row.owner_id, "projects.githubInstallationStatus", {
    installationId: String(installationId),
    status,
  });
  if (!response.ok) return json({ error: response.error.message }, 502);
  return json({ ok: true });
};

export const handleProjectsRoute = async (request: Request, env: Cloudflare.Env): Promise<Response | null> => {
  const { pathname } = new URL(request.url);
  if (pathname === CALLBACK_PATH && request.method === "GET") return await callback(request, env);
  if (pathname === WEBHOOK_PATH && request.method === "POST") return await webhook(request, env);
  return null;
};
