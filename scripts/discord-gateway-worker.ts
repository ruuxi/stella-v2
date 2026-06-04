const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_GATEWAY_VERSION = 10;
const DIRECT_MESSAGES_INTENT = 1 << 12;

export const DISCORD_GATEWAY_INTENTS = DIRECT_MESSAGES_INTENT;

type DiscordGatewayPayload = {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
};

type DiscordMessageAttachment = {
  id?: string;
  filename?: string;
  content_type?: string;
  size?: number;
  url?: string;
  proxy_url?: string;
};

type DiscordMessageCreate = {
  id?: string;
  channel_id?: string;
  guild_id?: string | null;
  type?: number;
  content?: string;
  timestamp?: string;
  author?: {
    id?: string;
    bot?: boolean;
    username?: string;
    global_name?: string | null;
  };
  attachments?: DiscordMessageAttachment[];
};

type ConvexDiscordGatewayAttachment = {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: number;
  url?: string;
  proxyUrl?: string;
  kind?: string;
};

export type ConvexDiscordGatewayMessage = {
  id: string;
  channelId: string;
  authorId: string;
  authorUsername?: string;
  authorGlobalName?: string;
  content: string;
  timestamp?: number;
  attachments?: ConvexDiscordGatewayAttachment[];
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const trimOptional = (value: string | null | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

const inferAttachmentKind = (mimeType: string | undefined): string => {
  const normalized = (mimeType ?? "").toLowerCase();
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("video/")) return "video";
  if (normalized.startsWith("audio/")) return "voice";
  return "file";
};

const parseTimestampMs = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const buildDiscordGatewayIngestUrl = (siteUrl: string): string => {
  const trimmed = siteUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("CONVEX_SITE_URL is required");
  }
  return `${trimmed}/api/discord/gateway_message`;
};

export const resolveDiscordGatewayIntents = (extraIntents: string | undefined): number => {
  const parsed = Number(extraIntents);
  if (!Number.isFinite(parsed) || parsed < 0) return DISCORD_GATEWAY_INTENTS;
  return DISCORD_GATEWAY_INTENTS | Math.floor(parsed);
};

export const toConvexDiscordGatewayMessage = (
  event: DiscordMessageCreate,
  botUserId?: string,
): ConvexDiscordGatewayMessage | null => {
  if (event.guild_id) return null;
  if (event.type !== undefined && event.type !== 0 && event.type !== 19) {
    return null;
  }

  const author = event.author;
  if (!event.id || !event.channel_id || !author?.id) return null;
  if (author.bot || (botUserId && author.id === botUserId)) return null;

  const content = event.content?.trim() ?? "";
  const attachments = (event.attachments ?? [])
    .map((attachment): ConvexDiscordGatewayAttachment | null => {
      const mimeType = trimOptional(attachment.content_type);
      const url = trimOptional(attachment.url);
      const proxyUrl = trimOptional(attachment.proxy_url);
      if (!attachment.id && !attachment.filename && !url && !proxyUrl) {
        return null;
      }
      return {
        id: trimOptional(attachment.id),
        name: trimOptional(attachment.filename),
        mimeType,
        size: attachment.size,
        url,
        proxyUrl,
        kind: inferAttachmentKind(mimeType),
      };
    })
    .filter((attachment): attachment is ConvexDiscordGatewayAttachment => Boolean(attachment));

  if (!content && attachments.length === 0) return null;

  return {
    id: event.id,
    channelId: event.channel_id,
    authorId: author.id,
    authorUsername: trimOptional(author.username),
    authorGlobalName: trimOptional(author.global_name),
    content,
    timestamp: parseTimestampMs(event.timestamp),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
};

const fetchDiscordGatewayUrl = async (botToken: string): Promise<string> => {
  const response = await fetch(`${DISCORD_API}/gateway/bot`, {
    headers: { Authorization: `Bot ${botToken}` },
  });
  if (!response.ok) {
    throw new Error(`Discord gateway lookup failed: ${response.status} ${await response.text()}`);
  }
  const body = await response.json() as { url?: string };
  if (!body.url) {
    throw new Error("Discord gateway lookup returned no URL");
  }
  return `${body.url}?v=${DISCORD_GATEWAY_VERSION}&encoding=json`;
};

const postWithRetry = async (
  ingestUrl: string,
  sharedSecret: string,
  message: ConvexDiscordGatewayMessage,
) => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(ingestUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sharedSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(message),
      });
      if (response.ok) return;
      lastError = new Error(`Convex ingest failed: ${response.status} ${await response.text()}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250 * attempt);
  }
  throw lastError;
};

class DiscordGatewayWorker {
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private sequence: number | null = null;
  private botUserId: string | undefined;

  constructor(
    private readonly botToken: string,
    private readonly ingestUrl: string,
    private readonly sharedSecret: string,
    private readonly intents: number,
  ) {}

  async run() {
    let backoffMs = 1_000;
    for (;;) {
      try {
        await this.connectOnce();
        backoffMs = 1_000;
      } catch (error) {
        console.error("[discord-gateway] connection failed:", error);
      } finally {
        this.clearHeartbeat();
      }

      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30_000);
    }
  }

  private async connectOnce() {
    const gatewayUrl = await fetchDiscordGatewayUrl(this.botToken);
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(gatewayUrl);
      let opened = false;

      const sendJson = (payload: unknown) => {
        ws.send(JSON.stringify(payload));
      };

      const heartbeat = () => {
        sendJson({ op: 1, d: this.sequence });
      };

      const identify = () => {
        sendJson({
          op: 2,
          d: {
            token: this.botToken,
            intents: this.intents,
            properties: {
              os: process.platform,
              browser: "stella-discord-gateway",
              device: "stella-discord-gateway",
            },
          },
        });
      };

      ws.addEventListener("open", () => {
        opened = true;
        console.log("[discord-gateway] connected");
      });

      ws.addEventListener("message", async (event) => {
        let payload: DiscordGatewayPayload;
        try {
          payload = JSON.parse(String(event.data));
        } catch (error) {
          console.error("[discord-gateway] invalid gateway payload:", error);
          return;
        }

        if (typeof payload.s === "number") {
          this.sequence = payload.s;
        }

        if (payload.op === 10) {
          const hello = payload.d as { heartbeat_interval?: number };
          this.clearHeartbeat();
          this.heartbeatTimer = setInterval(
            heartbeat,
            Math.max(hello.heartbeat_interval ?? 45_000, 1_000),
          );
          heartbeat();
          identify();
          return;
        }

        if (payload.op === 1) {
          heartbeat();
          return;
        }

        if (payload.op === 7 || payload.op === 9) {
          ws.close();
          return;
        }

        if (payload.op !== 0) return;

        if (payload.t === "READY") {
          const ready = payload.d as { user?: { id?: string } };
          this.botUserId = ready.user?.id;
          console.log("[discord-gateway] ready");
          return;
        }

        if (payload.t !== "MESSAGE_CREATE") return;

        const message = toConvexDiscordGatewayMessage(
          payload.d as DiscordMessageCreate,
          this.botUserId,
        );
        if (!message) return;

        try {
          await postWithRetry(this.ingestUrl, this.sharedSecret, message);
        } catch (error) {
          console.error("[discord-gateway] failed to forward message:", error);
        }
      });

      ws.addEventListener("close", (event) => {
        console.log(
          "[discord-gateway] disconnected",
          event.code,
          event.reason || "no reason",
        );
        resolve();
      });

      ws.addEventListener("error", (event) => {
        if (opened) {
          console.error("[discord-gateway] websocket error:", event);
          return;
        }
        reject(event);
      });
    });
  }

  private clearHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }
}

const main = async () => {
  const botToken = process.env.DISCORD_BOT_TOKEN?.trim();
  const convexSiteUrl = process.env.CONVEX_SITE_URL?.trim();
  const sharedSecret = process.env.DISCORD_GATEWAY_SHARED_SECRET?.trim();
  if (!botToken) throw new Error("DISCORD_BOT_TOKEN is required");
  if (!convexSiteUrl) throw new Error("CONVEX_SITE_URL is required");
  if (!sharedSecret) throw new Error("DISCORD_GATEWAY_SHARED_SECRET is required");

  const worker = new DiscordGatewayWorker(
    botToken,
    buildDiscordGatewayIngestUrl(convexSiteUrl),
    sharedSecret,
    resolveDiscordGatewayIntents(process.env.DISCORD_GATEWAY_EXTRA_INTENTS),
  );
  await worker.run();
};

if (import.meta.main) {
  main().catch((error) => {
    console.error("[discord-gateway] fatal:", error);
    process.exit(1);
  });
}
