/** D1 access for the Slack tables (migrations/0009_slack.sql). */

import { decryptToken, encryptToken } from "./crypto.js";

const d1 = (env: Cloudflare.Env): D1Database => {
  if (!env.DB) throw new Error("The DB binding is missing.");
  return env.DB;
};

export type SlackInstallation = {
  teamId: string;
  enterpriseId: string | null;
  teamName: string;
  appId: string;
  botUserId: string;
  botToken: string;
};

export type SlackThreadBinding = {
  teamId: string;
  channelId: string;
  threadKey: string;
  conversationId: string;
  ownerId: string;
  requesterUserId: string;
  lastTurnTs: string | null;
};

export type CachedSlackMessage = {
  ts: string;
  threadTs: string | null;
  userId: string | null;
  isBot: boolean;
  text: string;
  files: Array<{ name: string }>;
};

const MESSAGE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const EVENT_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;
const USER_CACHE_MS = 24 * 60 * 60 * 1000;

export const saveInstallation = async (
  env: Cloudflare.Env,
  install: SlackInstallation & { scopes: string; installedBy: string },
): Promise<void> => {
  const sealed = await encryptToken(env, install.botToken);
  await d1(env).prepare(
    `INSERT INTO slack_installations
       (team_id, enterprise_id, team_name, app_id, bot_user_id, bot_token_enc, scopes, installed_by, installed_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (team_id) DO UPDATE SET
       enterprise_id = excluded.enterprise_id, team_name = excluded.team_name, app_id = excluded.app_id,
       bot_user_id = excluded.bot_user_id, bot_token_enc = excluded.bot_token_enc, scopes = excluded.scopes,
       installed_by = excluded.installed_by, installed_at = excluded.installed_at, revoked_at = NULL`,
  )
    .bind(
      install.teamId,
      install.enterpriseId,
      install.teamName,
      install.appId,
      install.botUserId,
      sealed,
      install.scopes,
      install.installedBy,
      Date.now(),
    )
    .run();
};

export const loadInstallation = async (
  env: Cloudflare.Env,
  teamId: string,
): Promise<SlackInstallation | null> => {
  const row = await d1(env).prepare(
    `SELECT team_id, enterprise_id, team_name, app_id, bot_user_id, bot_token_enc
       FROM slack_installations WHERE team_id = ? AND revoked_at IS NULL`,
  )
    .bind(teamId)
    .first<{
      team_id: string;
      enterprise_id: string | null;
      team_name: string;
      app_id: string;
      bot_user_id: string;
      bot_token_enc: string;
    }>();
  if (!row) return null;
  return {
    teamId: row.team_id,
    enterpriseId: row.enterprise_id,
    teamName: row.team_name,
    appId: row.app_id,
    botUserId: row.bot_user_id,
    botToken: await decryptToken(env, row.bot_token_enc),
  };
};

/** Uninstall or token revocation: the token is dropped, not just flagged. */
export const revokeInstallation = async (env: Cloudflare.Env, teamId: string): Promise<void> => {
  await d1(env).batch([
    d1(env).prepare(
      "UPDATE slack_installations SET revoked_at = ?, bot_token_enc = 'revoked' WHERE team_id = ?",
    ).bind(Date.now(), teamId),
    d1(env).prepare("DELETE FROM slack_messages WHERE team_id = ?").bind(teamId),
  ]);
};

export const linkedOwner = async (
  env: Cloudflare.Env,
  teamId: string,
  slackUserId: string,
): Promise<string | null> => {
  const row = await d1(env).prepare(
    "SELECT owner_id FROM slack_identities WHERE team_id = ? AND slack_user_id = ?",
  )
    .bind(teamId, slackUserId)
    .first<{ owner_id: string }>();
  return row?.owner_id ?? null;
};

export const linkIdentity = async (
  env: Cloudflare.Env,
  teamId: string,
  slackUserId: string,
  ownerId: string,
): Promise<void> => {
  await d1(env).prepare(
    `INSERT INTO slack_identities (team_id, slack_user_id, owner_id, linked_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (team_id, slack_user_id) DO UPDATE SET owner_id = excluded.owner_id, linked_at = excluded.linked_at`,
  )
    .bind(teamId, slackUserId, ownerId, Date.now())
    .run();
};

export const unlinkIdentity = async (env: Cloudflare.Env, teamId: string, slackUserId: string): Promise<boolean> => {
  const result = await d1(env).prepare("DELETE FROM slack_identities WHERE team_id = ? AND slack_user_id = ?")
    .bind(teamId, slackUserId)
    .run();
  return (result.meta.changes ?? 0) > 0;
};

/** Account deletion drops the links too; a reset keeps them but forgets every thread. */
export const purgeSlackOwner = async (env: Cloudflare.Env, ownerId: string, mode: "reset" | "delete"): Promise<void> => {
  const statements = [d1(env).prepare("DELETE FROM slack_threads WHERE owner_id = ?").bind(ownerId)];
  if (mode === "delete") {
    statements.push(d1(env).prepare("DELETE FROM slack_identities WHERE owner_id = ?").bind(ownerId));
  }
  await d1(env).batch(statements);
};

export const loadThread = async (
  env: Cloudflare.Env,
  teamId: string,
  channelId: string,
  threadKey: string,
): Promise<SlackThreadBinding | null> => {
  const row = await d1(env).prepare(
    `SELECT conversation_id, owner_id, requester_user_id, last_turn_ts
       FROM slack_threads WHERE team_id = ? AND channel_id = ? AND thread_key = ?`,
  )
    .bind(teamId, channelId, threadKey)
    .first<{ conversation_id: string; owner_id: string; requester_user_id: string; last_turn_ts: string | null }>();
  if (!row) return null;
  return {
    teamId,
    channelId,
    threadKey,
    conversationId: row.conversation_id,
    ownerId: row.owner_id,
    requesterUserId: row.requester_user_id,
    lastTurnTs: row.last_turn_ts,
  };
};

export const saveThread = async (env: Cloudflare.Env, binding: SlackThreadBinding): Promise<void> => {
  await d1(env).prepare(
    `INSERT INTO slack_threads
       (team_id, channel_id, thread_key, conversation_id, owner_id, requester_user_id, created_at, last_turn_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (team_id, channel_id, thread_key) DO UPDATE SET last_turn_ts = excluded.last_turn_ts`,
  )
    .bind(
      binding.teamId,
      binding.channelId,
      binding.threadKey,
      binding.conversationId,
      binding.ownerId,
      binding.requesterUserId,
      Date.now(),
      binding.lastTurnTs,
    )
    .run();
};

export const cacheMessage = async (
  env: Cloudflare.Env,
  teamId: string,
  channelId: string,
  message: CachedSlackMessage,
): Promise<void> => {
  const now = Date.now();
  const statements = [
    d1(env).prepare(
      `INSERT INTO slack_messages (team_id, channel_id, ts, thread_ts, user_id, is_bot, text, files_json, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (team_id, channel_id, ts) DO UPDATE SET text = excluded.text, files_json = excluded.files_json`,
    ).bind(
      teamId,
      channelId,
      message.ts,
      message.threadTs,
      message.userId,
      message.isBot ? 1 : 0,
      message.text.slice(0, 8_000),
      message.files.length ? JSON.stringify(message.files.slice(0, 10)) : null,
      now,
    ),
  ];
  if (Math.random() < 0.02) {
    statements.push(
      d1(env).prepare("DELETE FROM slack_messages WHERE received_at < ?").bind(now - MESSAGE_RETENTION_MS),
      d1(env).prepare("DELETE FROM slack_events WHERE received_at < ?").bind(now - EVENT_RETENTION_MS),
    );
  }
  await d1(env).batch(statements);
};

const toCached = (row: {
  ts: string;
  thread_ts: string | null;
  user_id: string | null;
  is_bot: number;
  text: string;
  files_json: string | null;
}): CachedSlackMessage => ({
  ts: row.ts,
  threadTs: row.thread_ts,
  userId: row.user_id,
  isBot: row.is_bot === 1,
  text: row.text,
  files: row.files_json ? (JSON.parse(row.files_json) as Array<{ name: string }>) : [],
});

/** A thread's root and replies, oldest first. */
export const cachedThread = async (
  env: Cloudflare.Env,
  teamId: string,
  channelId: string,
  threadTs: string,
  limit = 40,
): Promise<CachedSlackMessage[]> => {
  const rows = await d1(env).prepare(
    `SELECT ts, thread_ts, user_id, is_bot, text, files_json FROM slack_messages
      WHERE team_id = ? AND channel_id = ? AND (ts = ? OR thread_ts = ?)
      ORDER BY CAST(ts AS REAL) DESC LIMIT ?`,
  )
    .bind(teamId, channelId, threadTs, threadTs, limit)
    .all<Parameters<typeof toCached>[0]>();
  return rows.results.map(toCached).reverse();
};

/** Recent top-level messages in a channel, oldest first. */
export const cachedChannel = async (
  env: Cloudflare.Env,
  teamId: string,
  channelId: string,
  beforeTs: string,
  limit = 12,
): Promise<CachedSlackMessage[]> => {
  const rows = await d1(env).prepare(
    `SELECT ts, thread_ts, user_id, is_bot, text, files_json FROM slack_messages
      WHERE team_id = ? AND channel_id = ? AND (thread_ts IS NULL OR thread_ts = ts) AND CAST(ts AS REAL) < CAST(? AS REAL)
      ORDER BY CAST(ts AS REAL) DESC LIMIT ?`,
  )
    .bind(teamId, channelId, beforeTs, limit)
    .all<Parameters<typeof toCached>[0]>();
  return rows.results.map(toCached).reverse();
};

/** True the first time an event id is seen. */
export const claimEvent = async (env: Cloudflare.Env, eventId: string): Promise<boolean> => {
  const result = await d1(env).prepare(
    "INSERT INTO slack_events (event_id, received_at) VALUES (?, ?) ON CONFLICT (event_id) DO NOTHING",
  )
    .bind(eventId, Date.now())
    .run();
  return (result.meta.changes ?? 0) > 0;
};

export type SlackUserProfile = { name: string; realName: string | null; email: string | null; tz: string | null };

export const cachedUser = async (
  env: Cloudflare.Env,
  teamId: string,
  slackUserId: string,
): Promise<SlackUserProfile | null> => {
  const row = await d1(env).prepare(
    "SELECT name, real_name, email, tz, fetched_at FROM slack_users WHERE team_id = ? AND slack_user_id = ?",
  )
    .bind(teamId, slackUserId)
    .first<{ name: string; real_name: string | null; email: string | null; tz: string | null; fetched_at: number }>();
  if (!row || Date.now() - row.fetched_at > USER_CACHE_MS) return null;
  return { name: row.name, realName: row.real_name, email: row.email, tz: row.tz };
};

export const saveUser = async (
  env: Cloudflare.Env,
  teamId: string,
  slackUserId: string,
  profile: SlackUserProfile,
): Promise<void> => {
  await d1(env).prepare(
    `INSERT INTO slack_users (team_id, slack_user_id, name, real_name, email, tz, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (team_id, slack_user_id) DO UPDATE SET name = excluded.name, real_name = excluded.real_name,
       email = excluded.email, tz = excluded.tz, fetched_at = excluded.fetched_at`,
  )
    .bind(teamId, slackUserId, profile.name, profile.realName, profile.email, profile.tz, Date.now())
    .run();
};

export const threadOwnerOf = async (env: Cloudflare.Env, conversationId: string): Promise<string | null> => {
  const row = await d1(env).prepare("SELECT owner_id FROM slack_threads WHERE conversation_id = ? LIMIT 1")
    .bind(conversationId)
    .first<{ owner_id: string }>();
  return row?.owner_id ?? null;
};
