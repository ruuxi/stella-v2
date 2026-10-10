/**
 * Slack routes (all self-authenticating, mounted above the service gate):
 *
 *   GET  /api/slack/install          start the OAuth v2 install (any workspace)
 *   GET  /api/slack/oauth/callback   store the workspace's bot token
 *   POST /api/slack/events           Events API (signed)
 *   POST /api/slack/interactivity    buttons (signed)
 *   POST /api/slack/commands         /stella (signed)
 *   GET  /api/slack/link             connect a Slack user to a Stella account
 *   POST /api/slack/link/start       sign in to Stella (Google or email link)
 *   GET  /api/slack/link/finish      signed in: confirm the link
 *   POST /api/slack/link/confirm     write the link
 *
 * Slack expects an answer within three seconds, so events are acknowledged
 * at once and handled in `waitUntil`.
 */

import { createAuth } from "../auth/auth.js";
import { slackCall, slackTry, type SlackResponse } from "./api.js";
import {
  SLACK_BOT_SCOPES,
  SLACK_PATHS,
  slackConfigured,
  slackPublicOrigin,
  slackSecret,
} from "./config.js";
import { verifySlackSignature } from "./crypto.js";
import {
  handleSlackEvent,
  slackUser,
  type SlackEventEnvelope,
} from "./events.js";
import { handleSlackInteraction } from "./interactivity.js";
import {
  signConfirmToken,
  signInstallState,
  verifyConfirmToken,
  verifyInstallState,
  verifyLinkToken,
} from "./link-state.js";
import {
  claimEvent,
  linkedOwner,
  linkIdentity,
  loadInstallation,
  saveInstallation,
  unlinkIdentity,
} from "./store.js";
import { connectBlocks, connectUrl, publishHome } from "./ui.js";

const MAX_BODY_BYTES = 1_000_000;

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/gu,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );

const page = (title: string, bodyHtml: string, status = 200): Response =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${escapeHtml(title)}</title>` +
      `<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:30rem;margin:12vh auto;padding:0 1.5rem;line-height:1.5;color:#1d1d24}` +
      `h1{font-size:1.3rem;margin:0 0 .6rem}p{color:#4a4a55;margin:.4rem 0 1rem}` +
      `button,.button{display:block;width:100%;box-sizing:border-box;font:inherit;font-weight:600;padding:.8rem 1rem;border-radius:.6rem;border:1px solid #d5d5de;background:#fff;color:#1d1d24;margin:.6rem 0;cursor:pointer;text-align:center;text-decoration:none}` +
      `.primary{background:#1d1d24;color:#fff;border-color:#1d1d24}input{font:inherit;width:100%;box-sizing:border-box;padding:.75rem;border-radius:.6rem;border:1px solid #d5d5de}` +
      `.muted{font-size:.9rem;color:#777}hr{border:0;border-top:1px solid #eee;margin:1.2rem 0}</style>` +
      `<h1>${escapeHtml(title)}</h1>${bodyHtml}`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );

const readBody = async (request: Request): Promise<string | null> => {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return null;
  const text = await request.text();
  return text.length > MAX_BODY_BYTES ? null : text;
};

const verified = async (
  env: Cloudflare.Env,
  request: Request,
  body: string,
): Promise<boolean> => {
  const secret = slackSecret(env, "SLACK_SIGNING_SECRET");
  if (!secret) return false;
  return await verifySlackSignature(
    secret,
    body,
    request.headers.get("x-slack-request-timestamp"),
    request.headers.get("x-slack-signature"),
  );
};

const logError = (event: string, error: unknown): void => {
  console.error(
    JSON.stringify({
      event,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
};

// ── Install ────────────────────────────────────────────────────────────────

const install = async (
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> => {
  const clientId = slackSecret(env, "SLACK_CLIENT_ID");
  if (!clientId || !slackConfigured(env))
    return page(
      "Slack isn't set up",
      "<p>Stella's Slack app isn't configured here yet.</p>",
      503,
    );
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
  url.searchParams.set(
    "redirect_uri",
    `${slackPublicOrigin(env, request)}${SLACK_PATHS.oauthCallback}`,
  );
  url.searchParams.set("state", await signInstallState(env));
  return Response.redirect(url.toString(), 302);
};

type OAuthAccess = SlackResponse & {
  access_token?: string;
  scope?: string;
  bot_user_id?: string;
  app_id?: string;
  team?: { id?: string; name?: string };
  enterprise?: { id?: string } | null;
  authed_user?: { id?: string };
};

const oauthCallback = async (
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> => {
  const url = new URL(request.url);
  if (url.searchParams.get("error")) {
    return page(
      "Installation canceled",
      "<p>Nothing was installed. You can close this tab.</p>",
    );
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  if (!code || !(await verifyInstallState(env, state))) {
    return page(
      "Couldn't install Stella",
      "<p>That install link expired. Start the install again.</p>",
      400,
    );
  }
  let access: OAuthAccess;
  try {
    access = await slackCall<OAuthAccess>(null, "oauth.v2.access", {
      client_id: slackSecret(env, "SLACK_CLIENT_ID"),
      client_secret: slackSecret(env, "SLACK_CLIENT_SECRET"),
      code,
      redirect_uri: `${slackPublicOrigin(env, request)}${SLACK_PATHS.oauthCallback}`,
    });
  } catch (error) {
    logError("slack_oauth_exchange_failed", error);
    return page(
      "Couldn't install Stella",
      "<p>Slack didn't accept the install. Try again.</p>",
      502,
    );
  }
  const teamId = access.team?.id;
  if (
    !access.access_token ||
    !teamId ||
    !access.bot_user_id ||
    !access.app_id
  ) {
    return page(
      "Couldn't install Stella",
      "<p>Slack's answer was missing the bot token. Try again.</p>",
      502,
    );
  }
  await saveInstallation(env, {
    teamId,
    enterpriseId: access.enterprise?.id ?? null,
    teamName: access.team?.name ?? teamId,
    appId: access.app_id,
    botUserId: access.bot_user_id,
    botToken: access.access_token,
    scopes: access.scope ?? "",
    installedBy: access.authed_user?.id ?? "",
  });
  console.log(JSON.stringify({ event: "slack_installed", teamId }));
  const open = `slack://app?team=${encodeURIComponent(teamId)}&id=${encodeURIComponent(access.app_id)}`;
  return page(
    `Stella is in ${access.team?.name ?? "your workspace"}`,
    `<p>Mention <b>@Stella</b> in a channel (invite her first with <code>/invite @Stella</code>) or send her a direct message. Each person connects their own Stella account the first time.</p>` +
      `<a class="button primary" href="${escapeHtml(open)}">Open Slack</a>`,
  );
};

// ── Events, interactivity, commands ────────────────────────────────────────

const events = async (
  request: Request,
  env: Cloudflare.Env,
  ctx: ExecutionContext,
): Promise<Response> => {
  const body = await readBody(request);
  if (body === null) return new Response("Too large", { status: 413 });
  let envelope: SlackEventEnvelope & { challenge?: string };
  try {
    envelope = JSON.parse(body) as SlackEventEnvelope & { challenge?: string };
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const signed = await verified(env, request, body);
  if (envelope.type === "url_verification") {
    if (!signed && slackSecret(env, "SLACK_SIGNING_SECRET"))
      return new Response("Unauthorized", { status: 401 });
    return new Response(envelope.challenge ?? "", {
      headers: { "content-type": "text/plain" },
    });
  }
  if (!signed) return new Response("Unauthorized", { status: 401 });
  if (envelope.type !== "event_callback")
    return new Response("", { status: 200 });
  if (envelope.event_id && !(await claimEvent(env, envelope.event_id))) {
    return new Response("", { status: 200 });
  }
  ctx.waitUntil(
    handleSlackEvent(env, envelope).catch((error: unknown) =>
      logError("slack_event_failed", error),
    ),
  );
  return new Response("", { status: 200 });
};

const interactivity = async (
  request: Request,
  env: Cloudflare.Env,
  ctx: ExecutionContext,
): Promise<Response> => {
  const body = await readBody(request);
  if (body === null) return new Response("Too large", { status: 413 });
  if (!(await verified(env, request, body)))
    return new Response("Unauthorized", { status: 401 });
  const payload = new URLSearchParams(body).get("payload");
  if (!payload) return new Response("", { status: 200 });
  ctx.waitUntil(
    handleSlackInteraction(env, JSON.parse(payload)).catch((error: unknown) =>
      logError("slack_interaction_failed", error),
    ),
  );
  return new Response("", { status: 200 });
};

const ephemeral = (text: string, blocks?: unknown[]): Response =>
  Response.json({
    response_type: "ephemeral",
    text,
    ...(blocks ? { blocks } : {}),
  });

const commands = async (
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> => {
  const body = await readBody(request);
  if (body === null) return new Response("Too large", { status: 413 });
  if (!(await verified(env, request, body)))
    return new Response("Unauthorized", { status: 401 });
  const form = new URLSearchParams(body);
  const teamId = form.get("team_id") ?? "";
  const userId = form.get("user_id") ?? "";
  const action = (form.get("text") ?? "").trim().toLowerCase();
  const installation = await loadInstallation(env, teamId);
  if (!installation)
    return ephemeral("Stella isn't installed in this workspace anymore.");
  const owner = await linkedOwner(env, teamId, userId);
  if (action === "disconnect" || action === "unlink") {
    const removed = await unlinkIdentity(env, teamId, userId);
    await publishHome(env, installation, userId, false);
    return ephemeral(
      removed
        ? "Disconnected. Stella won't act for you in this workspace until you connect again."
        : "Your Stella account wasn't connected here.",
    );
  }
  if (action === "status") {
    return ephemeral(
      owner
        ? "Your Stella account is connected. Mention @Stella or DM her to hand her something."
        : "Your Stella account isn't connected yet. Run `/stella connect`.",
    );
  }
  if (owner && action !== "connect") {
    return ephemeral(
      "Your Stella account is connected. Mention @Stella in a channel or DM her. `/stella disconnect` to disconnect.",
    );
  }
  const url = await connectUrl(env, teamId, userId);
  return ephemeral(
    "Connect your Stella account",
    connectBlocks(
      url,
      owner
        ? "*Connect a different Stella account?* This replaces the current one."
        : "*Connect your Stella account to use Stella here.*",
    ),
  );
};

// ── Linking ────────────────────────────────────────────────────────────────

const linkPage = async (
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> => {
  const token = new URL(request.url).searchParams.get("s") ?? "";
  const subject = await verifyLinkToken(env, token);
  if (!subject) {
    return page(
      "This link expired",
      "<p>Go back to Slack and run <code>/stella connect</code> for a fresh one.</p>",
      400,
    );
  }
  const installation = await loadInstallation(env, subject.teamId);
  if (!installation)
    return page(
      "Stella isn't installed",
      "<p>Stella was removed from that workspace.</p>",
      410,
    );
  const who = await slackUser(env, installation, subject.slackUserId);
  const hidden = `<input type="hidden" name="s" value="${escapeHtml(token)}">`;
  const google = slackGoogleEnabled(env)
    ? `<form method="post" action="${SLACK_PATHS.linkStart}">${hidden}<input type="hidden" name="method" value="google"><button class="primary" type="submit">Continue with Google</button></form>`
    : "";
  return page(
    "Connect Slack to Stella",
    `<p>Sign in to the Stella account that <b>@${escapeHtml(who.name)}</b> in <b>${escapeHtml(installation.teamName)}</b> should use. Stella will work on your requests from Slack with this account.</p>` +
      google +
      `<form method="post" action="${SLACK_PATHS.linkStart}">${hidden}<input type="hidden" name="method" value="email">` +
      `<input type="email" name="email" required placeholder="you@example.com" value="${escapeHtml(who.email ?? "")}" autocomplete="email">` +
      `<button type="submit">Email me a sign-in link</button></form>` +
      `<p class="muted">Use the same Google account or email you sign in to Stella with.</p>`,
  );
};

const slackGoogleEnabled = (env: Cloudflare.Env): boolean => {
  const secret = (env as unknown as Record<string, unknown>)
    .GOOGLE_CLIENT_SECRET;
  return typeof secret === "string" && secret.trim().length > 0;
};

type AuthApi = {
  signInSocial(input: {
    body: { provider: "google"; callbackURL: string; disableRedirect: true };
    headers: Headers;
  }): Promise<{ url?: string }>;
  signInMagicLink(input: {
    body: { email: string; callbackURL: string };
    headers: Headers;
  }): Promise<unknown>;
  verifyOneTimeToken(input: {
    body: { token: string };
    headers: Headers;
    returnHeaders: true;
  }): Promise<{
    headers: Headers;
    response: { user?: { id?: unknown; email?: unknown; name?: unknown } };
  }>;
};

const authApi = (env: Cloudflare.Env): AuthApi =>
  (createAuth(env as never) as unknown as { api: AuthApi }).api;

const linkStart = async (
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> => {
  const body = await readBody(request);
  if (body === null) return new Response("Too large", { status: 413 });
  const form = new URLSearchParams(body);
  const token = form.get("s") ?? "";
  if (!(await verifyLinkToken(env, token))) {
    return page(
      "This link expired",
      "<p>Go back to Slack and run <code>/stella connect</code> for a fresh one.</p>",
      400,
    );
  }
  const origin = slackPublicOrigin(env, request);
  const callbackURL = `${origin}${SLACK_PATHS.linkFinish}?s=${encodeURIComponent(token)}`;
  const headers = new Headers({ origin });
  if (form.get("method") === "google" && slackGoogleEnabled(env)) {
    const started = await authApi(env).signInSocial({
      body: { provider: "google", callbackURL, disableRedirect: true },
      headers,
    });
    if (!started.url)
      return page(
        "Couldn't start Google sign-in",
        "<p>Try the email option instead.</p>",
        502,
      );
    return Response.redirect(started.url, 302);
  }
  const email = (form.get("email") ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    return page(
      "Check that email",
      "<p>That doesn't look like an email address. Go back and try again.</p>",
      400,
    );
  }
  try {
    await authApi(env).signInMagicLink({
      body: { email, callbackURL },
      headers,
    });
  } catch (error) {
    logError("slack_link_magic_failed", error);
    return page(
      "Couldn't send the email",
      "<p>Try again in a minute.</p>",
      502,
    );
  }
  return page(
    "Check your email",
    `<p>We sent a sign-in link to <b>${escapeHtml(email)}</b>. Open it on this device to finish connecting Slack.</p>`,
  );
};

const linkFinish = async (
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> => {
  const url = new URL(request.url);
  const token = url.searchParams.get("s") ?? "";
  const ott = url.searchParams.get("ott") ?? "";
  const subject = await verifyLinkToken(env, token);
  if (!subject || !ott) {
    return page(
      "This link expired",
      "<p>Go back to Slack and run <code>/stella connect</code> for a fresh one.</p>",
      400,
    );
  }
  let user: { id?: unknown; email?: unknown } | undefined;
  try {
    user = (
      await authApi(env).verifyOneTimeToken({
        body: { token: ott },
        headers: new Headers({ origin: slackPublicOrigin(env, request) }),
        returnHeaders: true,
      })
    ).response.user;
  } catch {
    console.error(JSON.stringify({ event: "slack_link_ott_failed" }));
  }
  if (typeof user?.id !== "string" || !user.id) {
    return page(
      "Sign-in didn't finish",
      "<p>Go back to Slack and run <code>/stella connect</code> to try again.</p>",
      400,
    );
  }
  const installation = await loadInstallation(env, subject.teamId);
  if (!installation)
    return page(
      "Stella isn't installed",
      "<p>Stella was removed from that workspace.</p>",
      410,
    );
  const who = await slackUser(env, installation, subject.slackUserId);
  const confirm = await signConfirmToken(env, subject, user.id);
  const email =
    typeof user.email === "string" ? user.email : "this Stella account";
  return page(
    "Connect this account?",
    `<p>Slack user <b>@${escapeHtml(who.name)}</b> in <b>${escapeHtml(installation.teamName)}</b> will use the Stella account <b>${escapeHtml(email)}</b>. Stella will act for them with this account when they mention her or message her in Slack.</p>` +
      `<form method="post" action="${SLACK_PATHS.linkConfirm}"><input type="hidden" name="c" value="${escapeHtml(confirm)}"><button class="primary" type="submit">Connect</button></form>` +
      `<p class="muted">Didn't start this from Slack yourself? Close this page.</p>`,
  );
};

const linkConfirm = async (
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> => {
  const body = await readBody(request);
  if (body === null) return new Response("Too large", { status: 413 });
  const confirmed = await verifyConfirmToken(
    env,
    new URLSearchParams(body).get("c") ?? "",
  );
  if (!confirmed) {
    return page(
      "This link expired",
      "<p>Go back to Slack and run <code>/stella connect</code> for a fresh one.</p>",
      400,
    );
  }
  const installation = await loadInstallation(env, confirmed.teamId);
  if (!installation)
    return page(
      "Stella isn't installed",
      "<p>Stella was removed from that workspace.</p>",
      410,
    );
  await linkIdentity(
    env,
    confirmed.teamId,
    confirmed.slackUserId,
    confirmed.ownerId,
  );
  console.log(
    JSON.stringify({
      event: "slack_identity_linked",
      teamId: confirmed.teamId,
    }),
  );
  await slackTry(installation.botToken, "chat.postMessage", {
    channel: confirmed.slackUserId,
    text: "Your Stella account is connected. Mention @Stella in a channel or message me here to hand me something.",
  });
  await publishHome(env, installation, confirmed.slackUserId, true);
  const open = `slack://app?team=${encodeURIComponent(installation.teamId)}&id=${encodeURIComponent(installation.appId)}`;
  return page(
    "Connected",
    `<p>Go back to Slack and mention <b>@Stella</b> again.</p><a class="button primary" href="${escapeHtml(open)}">Open Slack</a>`,
  );
};

// ── Router ─────────────────────────────────────────────────────────────────

export const handleSlackRoute = async (
  request: Request,
  env: Cloudflare.Env,
  ctx: ExecutionContext,
): Promise<Response | null> => {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith("/api/slack/")) return null;
  const method = request.method;
  try {
    if (pathname === SLACK_PATHS.events && method === "POST")
      return await events(request, env, ctx);
    if (pathname === SLACK_PATHS.interactivity && method === "POST")
      return await interactivity(request, env, ctx);
    if (pathname === SLACK_PATHS.commands && method === "POST")
      return await commands(request, env);
    if (pathname === SLACK_PATHS.install && method === "GET")
      return await install(request, env);
    if (pathname === SLACK_PATHS.oauthCallback && method === "GET")
      return await oauthCallback(request, env);
    if (pathname === SLACK_PATHS.link && method === "GET")
      return await linkPage(request, env);
    if (pathname === SLACK_PATHS.linkStart && method === "POST")
      return await linkStart(request, env);
    if (pathname === SLACK_PATHS.linkFinish && method === "GET")
      return await linkFinish(request, env);
    if (pathname === SLACK_PATHS.linkConfirm && method === "POST")
      return await linkConfirm(request, env);
  } catch (error) {
    logError("slack_route_failed", error);
    return new Response("Something went wrong.", { status: 500 });
  }
  return new Response("Not found", { status: 404 });
};
