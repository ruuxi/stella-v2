/**
 * Signed, short-lived tokens for the Slack flows, on the shared
 * `OAUTH_STATE_SECRET` signer. The subject field carries a Slack identity
 * (`slack:<team>:<user>`) before linking, and the proven Stella owner id on
 * the confirm step.
 */

import { signOAuthState, verifyOAuthState } from "../oauth-state.js";

export const LINK_KIND = "slack_link";
export const CONFIRM_KIND = "slack_link_confirm";
export const INSTALL_KIND = "slack_install";

const LINK_TTL_MS = 30 * 60_000;
const CONFIRM_TTL_MS = 10 * 60_000;
const INSTALL_TTL_MS = 15 * 60_000;

export type SlackSubject = { teamId: string; slackUserId: string };

export const signLinkToken = async (
  env: Cloudflare.Env,
  subject: SlackSubject,
): Promise<string> =>
  await signOAuthState(env, {
    ownerId: `slack:${subject.teamId}:${subject.slackUserId}`,
    kind: LINK_KIND,
    nonce: crypto.randomUUID(),
    exp: Date.now() + LINK_TTL_MS,
    extra: { team: subject.teamId, user: subject.slackUserId },
  });

export const verifyLinkToken = async (
  env: Cloudflare.Env,
  token: string,
): Promise<SlackSubject | null> => {
  const state = await verifyOAuthState(env, token);
  if (!state || state.kind !== LINK_KIND) return null;
  const teamId = state.extra?.team;
  const slackUserId = state.extra?.user;
  if (
    !teamId ||
    !slackUserId ||
    state.ownerId !== `slack:${teamId}:${slackUserId}`
  )
    return null;
  return { teamId, slackUserId };
};

export const signConfirmToken = async (
  env: Cloudflare.Env,
  subject: SlackSubject,
  ownerId: string,
): Promise<string> =>
  await signOAuthState(env, {
    ownerId,
    kind: CONFIRM_KIND,
    nonce: crypto.randomUUID(),
    exp: Date.now() + CONFIRM_TTL_MS,
    extra: { team: subject.teamId, user: subject.slackUserId },
  });

export const verifyConfirmToken = async (
  env: Cloudflare.Env,
  token: string,
): Promise<(SlackSubject & { ownerId: string }) | null> => {
  const state = await verifyOAuthState(env, token);
  if (!state || state.kind !== CONFIRM_KIND) return null;
  const teamId = state.extra?.team;
  const slackUserId = state.extra?.user;
  if (!teamId || !slackUserId) return null;
  return { teamId, slackUserId, ownerId: state.ownerId };
};

export const signInstallState = async (env: Cloudflare.Env): Promise<string> =>
  await signOAuthState(env, {
    ownerId: "slack-install",
    kind: INSTALL_KIND,
    nonce: crypto.randomUUID(),
    exp: Date.now() + INSTALL_TTL_MS,
  });

export const verifyInstallState = async (
  env: Cloudflare.Env,
  token: string,
): Promise<boolean> => {
  const state = await verifyOAuthState(env, token);
  return Boolean(state && state.kind === INSTALL_KIND);
};
