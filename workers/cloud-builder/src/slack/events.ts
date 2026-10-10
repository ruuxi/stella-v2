/**
 * Events API handling: a Slack message becomes a Stella turn.
 *
 * - **Triggers:** an `@Stella` mention in a channel or group DM, any direct
 *   message, and a reply from the thread's requester in a thread Stella is
 *   already working in. Everything else in channels Stella belongs to is
 *   cached (`slack_messages`) as context and answers nothing.
 * - **Whose Stella:** the requester's own linked account. An unlinked person
 *   gets the connect button privately. A thread belongs to whoever started
 *   it; another person's mention there is turned away politely.
 * - **Which conversation:** one Stella conversation per Slack thread (and one
 *   for a person's DM with Stella), id derived from the Slack coordinates.
 *   It is the requester's conversation like any new chat, so it reads their
 *   memory and shows in their Stella apps.
 * - **Delivery:** the conversation object is told where its replies go
 *   (`/slack/bind`, see `relay.ts`) before the turn starts.
 */

import {
  TURN_OWNER_GENERATION_HEADER,
  TURN_PLANE_PROTOCOL,
} from "@stella/contracts/turn-plane/turn-start";
import type { CloudTurnStartRequest } from "@stella/contracts/turn-plane/turn-start";
import {
  HEADER_CONVERSATION_ID,
  ORCHESTRATOR_INTERNAL_ORIGIN,
} from "../build-session/shared/keys.js";
import { HEADER_OWNER } from "../conversation-types.js";
import { unwrapRpc } from "../owner-store/errors.js";
import { HEADER_TURN_AUTH_KIND } from "../turn-start-request.js";
import { downloadSlackFile, slackTry, type SlackResponse } from "./api.js";
import { sha256Short } from "./crypto.js";
import {
  composePrompt,
  type ContextLine,
  type SlackPlace,
  slackToPlain,
} from "./format.js";
import {
  cacheMessage,
  cachedChannel,
  cachedThread,
  cachedUser,
  type CachedSlackMessage,
  linkedOwner,
  loadInstallation,
  loadThread,
  revokeInstallation,
  saveThread,
  saveUser,
  type SlackInstallation,
  type SlackUserProfile,
} from "./store.js";
import { publishHome, sendConnectPrompt } from "./ui.js";

type SlackFile = {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  mode?: string;
  url_private?: string;
  url_private_download?: string;
};

type SlackEvent = {
  type: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  channel?: string;
  channel_type?: string;
  files?: SlackFile[];
  tab?: string;
  tokens?: { bot?: string[] };
};

export type SlackEventEnvelope = {
  type: string;
  team_id?: string;
  event_id?: string;
  event?: SlackEvent;
  authorizations?: Array<{ team_id?: string }>;
};

const INLINE_FILE_LIMIT = 8 * 1024 * 1024;
const MAX_FILES = 4;
const DM_THREAD_KEY = "dm";

const log = (event: string, fields: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ event, ...fields }));
};

export const handleSlackEvent = async (
  env: Cloudflare.Env,
  envelope: SlackEventEnvelope,
): Promise<void> => {
  const event = envelope.event;
  const teamId = envelope.team_id ?? envelope.authorizations?.[0]?.team_id;
  if (!event || !teamId) return;
  if (
    event.type === "app_uninstalled" ||
    (event.type === "tokens_revoked" && event.tokens?.bot?.length)
  ) {
    await revokeInstallation(env, teamId);
    log("slack_installation_revoked", { teamId, reason: event.type });
    return;
  }
  const install = await loadInstallation(env, teamId);
  if (!install) return;
  if (event.type === "app_home_opened") {
    if (event.tab === "home" && event.user) {
      await publishHome(
        env,
        install,
        event.user,
        Boolean(await linkedOwner(env, teamId, event.user)),
      );
    }
    return;
  }
  if (event.type === "message" || event.type === "app_mention") {
    await handleMessage(env, install, event);
  }
};

const inferChannelType = (channelId: string): string =>
  channelId.startsWith("D")
    ? "im"
    : channelId.startsWith("G")
      ? "group"
      : "channel";

const displayName = (user: Record<string, unknown>): SlackUserProfile => {
  const profile = (user.profile ?? {}) as Record<string, unknown>;
  const pick = (value: unknown): string | null =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  return {
    name:
      pick(profile.display_name) ??
      pick(profile.real_name) ??
      pick(user.name) ??
      "someone",
    realName: pick(profile.real_name),
    email: pick(profile.email),
    tz: pick(user.tz),
  };
};

export const slackUser = async (
  env: Cloudflare.Env,
  install: SlackInstallation,
  slackUserId: string,
): Promise<SlackUserProfile> => {
  const cached = await cachedUser(env, install.teamId, slackUserId);
  if (cached) return cached;
  const info = await slackTry<
    SlackResponse & { user?: Record<string, unknown> }
  >(install.botToken, "users.info", {
    user: slackUserId,
  });
  const profile = info?.user
    ? displayName(info.user)
    : { name: slackUserId, realName: null, email: null, tz: null };
  if (info?.user)
    await saveUser(env, install.teamId, slackUserId, profile).catch(
      () => undefined,
    );
  return profile;
};

const describeChannel = async (
  install: SlackInstallation,
  channelId: string,
  channelType: string,
): Promise<SlackPlace> => {
  if (channelType === "im") return { kind: "dm" };
  if (channelType === "mpim") return { kind: "group-dm" };
  const info = await slackTry<
    SlackResponse & {
      channel?: { name?: string; is_private?: boolean; num_members?: number };
    }
  >(install.botToken, "conversations.info", {
    channel: channelId,
    include_num_members: true,
  });
  return {
    kind: "channel",
    name: info?.channel?.name ?? channelId,
    isPrivate: info?.channel?.is_private === true || channelType === "group",
    memberCount:
      typeof info?.channel?.num_members === "number"
        ? info.channel.num_members
        : null,
  };
};

const toCached = (event: SlackEvent, isBot: boolean): CachedSlackMessage => ({
  ts: event.ts!,
  threadTs: event.thread_ts ?? null,
  userId: event.user ?? null,
  isBot,
  text: event.text ?? "",
  files: (event.files ?? []).map((file) => ({
    name: file.name ?? file.title ?? "file",
  })),
});

/** First mention inside an existing thread with little cached: one history read. */
const backfillThread = async (
  env: Cloudflare.Env,
  install: SlackInstallation,
  channelId: string,
  threadTs: string,
): Promise<void> => {
  const replies = await slackTry<SlackResponse & { messages?: SlackEvent[] }>(
    install.botToken,
    "conversations.replies",
    {
      channel: channelId,
      ts: threadTs,
      limit: 15,
    },
  );
  for (const message of replies?.messages ?? []) {
    if (!message.ts || message.user === install.botUserId) continue;
    await cacheMessage(
      env,
      install.teamId,
      channelId,
      toCached(message, Boolean(message.bot_id)),
    ).catch(() => undefined);
  }
};

const base64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
};

const safeFileName = (name: string): string =>
  name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "_")
    .replace(/^\.+/u, "_")
    .slice(0, 120) || "file";

const ownerInternal = async (
  env: Cloudflare.Env,
  ownerId: string,
  ownerGeneration: string,
  name: string,
  args: unknown,
): Promise<unknown> =>
  unwrapRpc(
    await env.OWNER_GATES.getByName(ownerId).ownerInternal({
      name,
      args,
      ownerGeneration,
    }),
  );

/** The message's files, copied into the requester's drive as turn attachments. */
const importFiles = async (
  env: Cloudflare.Env,
  install: SlackInstallation,
  ownerId: string,
  ownerGeneration: string,
  ts: string,
  files: SlackFile[],
): Promise<{ attachments: string[]; skipped: string[] }> => {
  const attachments: string[] = [];
  const skipped: string[] = [];
  const day = new Date(Number(ts) * 1000).toISOString().slice(0, 10);
  for (const [index, file] of files.entries()) {
    const name = safeFileName(file.name ?? file.title ?? file.id);
    const url = file.url_private_download ?? file.url_private;
    if (index >= MAX_FILES || !url || (file.size ?? 0) > INLINE_FILE_LIMIT) {
      skipped.push(name);
      continue;
    }
    const bytes = await downloadSlackFile(
      install.botToken,
      url,
      INLINE_FILE_LIMIT,
    ).catch(() => null);
    if (!bytes) {
      skipped.push(name);
      continue;
    }
    const path = `Slack/${day}/${ts.replace(".", "-")}-${name}`;
    try {
      const result = (await ownerInternal(
        env,
        ownerId,
        ownerGeneration,
        "drive.turnFiles",
        {
          turnId: `slack-${ts}`,
          source: "slack",
          files: [
            {
              path,
              name,
              sizeBytes: bytes.byteLength,
              contentType: file.mimetype || "application/octet-stream",
              contentBase64: base64(bytes),
            },
          ],
        },
      )) as { files?: Array<{ path: string }> };
      const stored = result.files?.[0]?.path;
      if (stored) attachments.push(stored);
      else skipped.push(name);
    } catch (error) {
      log("slack_file_import_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      skipped.push(name);
    }
  }
  return { attachments, skipped };
};

const handleMessage = async (
  env: Cloudflare.Env,
  install: SlackInstallation,
  event: SlackEvent,
): Promise<void> => {
  const { subtype } = event;
  if (subtype && subtype !== "file_share" && subtype !== "thread_broadcast")
    return;
  const channelId = event.channel;
  const ts = event.ts;
  if (!channelId || !ts) return;
  const userId = event.user;
  const ownBot = userId === install.botUserId;
  const fromBot = ownBot || Boolean(event.bot_id) || !userId;
  if (!ownBot) {
    await cacheMessage(
      env,
      install.teamId,
      channelId,
      toCached(event, fromBot),
    ).catch((error: unknown) =>
      log("slack_cache_failed", {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  if (fromBot || !userId) return;
  const channelType = event.channel_type ?? inferChannelType(channelId);
  const isDm = channelType === "im";
  const text = event.text ?? "";
  const threadTs =
    event.thread_ts && event.thread_ts !== ts ? event.thread_ts : null;
  const mentionsBot = text.includes(`<@${install.botUserId}>`);

  let trigger: "mention" | "dm" | "reply";
  if (event.type === "app_mention") trigger = "mention";
  else if (isDm) trigger = "dm";
  else if (mentionsBot || !threadTs) return;
  else trigger = "reply";

  const threadKey = isDm ? DM_THREAD_KEY : (threadTs ?? ts);
  let binding = await loadThread(env, install.teamId, channelId, threadKey);
  if (trigger === "reply" && (!binding || binding.requesterUserId !== userId))
    return;

  const ownerId = await linkedOwner(env, install.teamId, userId);
  if (!ownerId) {
    await sendConnectPrompt(env, install, {
      channelId,
      slackUserId: userId,
      isDm,
      ...(threadTs ? { threadTs } : {}),
    });
    log("slack_unlinked_prompted", { teamId: install.teamId, trigger });
    return;
  }
  if (binding && binding.ownerId !== ownerId) {
    await slackTry(install.botToken, "chat.postEphemeral", {
      channel: channelId,
      user: userId,
      thread_ts: threadKey,
      text: `This thread is running on <@${binding.requesterUserId}>'s Stella. Mention @Stella in a new message to start your own.`,
    });
    return;
  }

  await slackTry(install.botToken, "reactions.add", {
    channel: channelId,
    timestamp: ts,
    name: "eyes",
  });

  const gate = env.OWNER_GATES.getByName(ownerId);
  const { ownerGeneration } = await gate.snapshot();
  const conversationId =
    binding?.conversationId ??
    `slack-${await sha256Short(`${install.teamId}:${channelId}:${threadKey}`)}`;

  const requester = await slackUser(env, install, userId);
  const names = async (id: string): Promise<string> =>
    (await slackUser(env, install, id)).name;
  const place = await describeChannel(install, channelId, channelType);
  const requestText = await slackToPlain(text, install.botUserId, names);

  let contextMessages: CachedSlackMessage[] = [];
  let contextLabel = "";
  if (!isDm) {
    if (binding) {
      const since = Number(binding.lastTurnTs ?? "0");
      contextMessages = (
        await cachedThread(env, install.teamId, channelId, threadKey)
      ).filter((message) => Number(message.ts) > since && message.ts !== ts);
      contextLabel = "New in the thread since your last reply (oldest first):";
    } else if (threadTs) {
      let cached = await cachedThread(env, install.teamId, channelId, threadTs);
      if (cached.filter((message) => message.ts !== ts).length < 2) {
        await backfillThread(env, install, channelId, threadTs);
        cached = await cachedThread(env, install.teamId, channelId, threadTs);
      }
      contextMessages = cached.filter((message) => message.ts !== ts);
      contextLabel = "Earlier in this thread (oldest first):";
    } else if (place.kind === "channel") {
      contextMessages = await cachedChannel(
        env,
        install.teamId,
        channelId,
        ts,
        10,
      );
      contextLabel = `Recent messages in #${place.name} (oldest first):`;
    }
  }
  const context: ContextLine[] = [];
  for (const message of contextMessages) {
    context.push({
      message,
      author: message.userId ? await names(message.userId) : "a bot",
      text: await slackToPlain(message.text, install.botUserId, names),
    });
  }

  const files = (event.files ?? []).filter(
    (file) => file.mode !== "tombstone" && file.mode !== "external",
  );
  const { attachments, skipped } = files.length
    ? await importFiles(env, install, ownerId, ownerGeneration, ts, files)
    : { attachments: [], skipped: [] };

  const prompt = composePrompt({
    requestText,
    requesterName: requester.name,
    teamName: install.teamName,
    place,
    firstTurn: !binding,
    context,
    contextLabel,
    tz: requester.tz,
    skippedFiles: skipped,
  });

  const clientMsgId = `slack:${channelId}:${ts}`.slice(0, 64);
  const stub = env.ORCHESTRATOR_SESSIONS.getByName(conversationId);
  const bound = await stub.fetch(`${ORCHESTRATOR_INTERNAL_ORIGIN}/slack/bind`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      teamId: install.teamId,
      channelId,
      threadTs: isDm ? null : threadKey,
      ownerId,
      requesterUserId: userId,
      shared: !isDm,
      clientMsgId,
      triggerTs: ts,
    }),
  });
  if (!bound.ok) {
    log("slack_bind_refused", { status: bound.status, conversationId });
    await slackTry(install.botToken, "reactions.remove", {
      channel: channelId,
      timestamp: ts,
      name: "eyes",
    });
    return;
  }

  const start: CloudTurnStartRequest = {
    protocol: TURN_PLANE_PROTOCOL,
    clientMsgId,
    prompt,
    lane: "chat",
    source: "slack",
    title:
      place.kind === "channel"
        ? `Slack · #${place.name}`
        : place.kind === "dm"
          ? "Slack DM"
          : "Slack group DM",
    ...(attachments.length ? { attachments } : {}),
  };
  const response = await stub.fetch(`${ORCHESTRATOR_INTERNAL_ORIGIN}/turn`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [HEADER_OWNER]: ownerId,
      [HEADER_TURN_AUTH_KIND]: "service",
      [HEADER_CONVERSATION_ID]: conversationId,
      [TURN_OWNER_GENERATION_HEADER]: ownerGeneration,
    },
    body: JSON.stringify(start),
  });
  if (!response.ok) {
    const failure = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    log("slack_turn_refused", {
      status: response.status,
      code: failure?.error?.code,
      conversationId,
    });
    await slackTry(install.botToken, "reactions.remove", {
      channel: channelId,
      timestamp: ts,
      name: "eyes",
    });
    await slackTry(install.botToken, "chat.postMessage", {
      channel: channelId,
      ...(isDm ? {} : { thread_ts: threadKey }),
      text: `:warning: ${failure?.error?.message ?? "Stella couldn't start on this. Try again in a moment."}`,
    });
    return;
  }
  binding = {
    teamId: install.teamId,
    channelId,
    threadKey,
    conversationId,
    ownerId,
    requesterUserId: binding?.requesterUserId ?? userId,
    lastTurnTs: ts,
  };
  await saveThread(env, binding);
  log("slack_turn_started", {
    teamId: install.teamId,
    trigger,
    conversationId,
    files: attachments.length,
  });
};
