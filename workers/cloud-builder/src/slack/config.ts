/**
 * Slack app settings, read from Worker secrets:
 *
 *   SLACK_CLIENT_ID, SLACK_CLIENT_SECRET   OAuth v2 install
 *   SLACK_SIGNING_SECRET                   request signatures (events, interactivity, commands)
 *
 * Bot tokens are per workspace (D1 `slack_installations`), never a secret here.
 * Missing settings turn the Slack routes off rather than failing readiness.
 */

export type SlackSecret = "SLACK_CLIENT_ID" | "SLACK_CLIENT_SECRET" | "SLACK_SIGNING_SECRET";

export const slackSecret = (env: Cloudflare.Env, name: SlackSecret): string | null => {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

export const slackConfigured = (env: Cloudflare.Env): boolean =>
  Boolean(
    slackSecret(env, "SLACK_CLIENT_ID") &&
      slackSecret(env, "SLACK_CLIENT_SECRET") &&
      slackSecret(env, "SLACK_SIGNING_SECRET"),
  );

/** The branded origin Slack calls and links point at (`STELLA_AUTH_URL`). */
export const slackPublicOrigin = (env: Cloudflare.Env, request?: Request): string => {
  const configured = (env as unknown as Record<string, unknown>).STELLA_AUTH_URL;
  if (typeof configured === "string" && configured.trim()) return configured.trim().replace(/\/+$/u, "");
  return request ? new URL(request.url).origin : "";
};

export const SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "chat:write",
  "commands",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "reactions:write",
  "users:read",
  "users:read.email",
] as const;

export const SLACK_PATHS = {
  install: "/api/slack/install",
  oauthCallback: "/api/slack/oauth/callback",
  events: "/api/slack/events",
  interactivity: "/api/slack/interactivity",
  commands: "/api/slack/commands",
  link: "/api/slack/link",
  linkStart: "/api/slack/link/start",
  linkFinish: "/api/slack/link/finish",
  linkConfirm: "/api/slack/link/confirm",
} as const;
