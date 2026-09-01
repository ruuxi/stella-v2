import { DurableObject } from "cloudflare:workers";
import type { BrowserBackend } from "./browser-provider.js";
import { CloudflarePlaywrightProvider } from "./cloudflare-playwright-provider.js";
import {
  CloudflareDeviceCodeFixtureClient,
  type DeviceCodeFixtureClient,
} from "./device-code-fixture-client.js";
import { GatewayError, publicErrorResponse, safeErrorCode } from "./errors.js";
import {
  BrowserProfileSessionCore,
  type BrowserGatewayEnv,
} from "./profile-session-core.js";
import { SqliteProfileStore, type ProfileStore } from "./profile-store.js";
import {
  jsonNoStore,
  parseInteraction,
  parseOwnerPurge,
  parseProfileReset,
  parseTurnCommand,
} from "./protocol.js";
import { readJsonBody } from "./request-body.js";
import { suspensionAlarmDeadline } from "./suspension-alarm.js";

type Dependencies = Readonly<{
  store?: ProfileStore;
  browser?: BrowserBackend;
  now?: () => number;
  randomUuid?: () => string;
  deviceCodeFixture?: DeviceCodeFixtureClient;
}>;

const boundedConfigInteger = (
  value: string,
  minimum: number,
  maximum: number,
): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new GatewayError("internal_error", 500);
  }
  return parsed;
};

export class BrowserProfileSession extends DurableObject<BrowserGatewayEnv> {
  private readonly core: BrowserProfileSessionCore;
  private readonly durableState: DurableObjectState;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    ctx: DurableObjectState,
    env: BrowserGatewayEnv,
    dependencies: Dependencies = {},
  ) {
    super(ctx, env);
    this.durableState = ctx;
    const store = dependencies.store ?? new SqliteProfileStore(ctx.storage);
    const browser =
      dependencies.browser ??
      new CloudflarePlaywrightProvider(
        env.BROWSER,
        boundedConfigInteger(env.BROWSER_KEEP_ALIVE_MS, 10_000, 600_000),
      );
    if (
      (env.DEVICE_CODE_FIXTURE === undefined) !==
      (env.DEVICE_CODE_FIXTURE_ORIGIN === undefined)
    ) {
      throw new GatewayError("internal_error", 500);
    }
    const deviceCodeFixture =
      dependencies.deviceCodeFixture ??
      (env.DEVICE_CODE_FIXTURE && env.DEVICE_CODE_FIXTURE_ORIGIN
        ? new CloudflareDeviceCodeFixtureClient(
            env.DEVICE_CODE_FIXTURE,
            env.DEVICE_CODE_FIXTURE_ORIGIN,
            dependencies.now ?? Date.now,
          )
        : undefined);
    this.core = new BrowserProfileSessionCore({
      store,
      browser,
      bucket: env.BROWSER_PROFILES,
      kekV1: env.BROWSER_PROFILE_KEK_V1,
      liveViewTtlMs: boundedConfigInteger(
        env.BROWSER_LIVE_VIEW_TTL_MS,
        10_000,
        3_600_000,
      ),
      handoffTimeoutMs: boundedConfigInteger(
        env.BROWSER_HANDOFF_TIMEOUT_MS,
        60_000,
        30 * 60_000,
      ),
      ...(deviceCodeFixture ? { deviceCodeFixture } : {}),
      ...(dependencies.now ? { now: dependencies.now } : {}),
      ...(dependencies.randomUuid
        ? { randomUuid: dependencies.randomUuid }
        : {}),
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async fetch(request: Request): Promise<Response> {
    return this.exclusive(async () => {
      const path = new URL(request.url).pathname;
      let body: unknown;
      try {
        body = await readJsonBody(request);
        if (path === "/internal/turn/command") {
          const envelope = parseTurnCommand(body);
          try {
            const result = await this.core.turn(envelope);
            const expiresAt = suspensionAlarmDeadline(result);
            if (expiresAt !== undefined) {
              await this.durableState.storage.setAlarm(expiresAt);
            }
            return jsonNoStore(result);
          } catch (error) {
            const safe =
              error instanceof GatewayError
                ? error
                : new GatewayError("internal_error", 500);
            return jsonNoStore({
              schemaVersion: 1,
              outcome: "failed",
              requestId: envelope.command.requestId,
              code: safe.code,
              message: safe.message,
              ...(safe.code === "browser_unavailable"
                ? { outcomeUnknown: true }
                : {}),
            });
          }
        }
        if (path === "/internal/interactions/status") {
          return jsonNoStore(
            await this.core.interactionStatus(parseInteraction(body)),
          );
        }
        if (path === "/internal/interactions/live-view") {
          return jsonNoStore(await this.core.liveView(parseInteraction(body)));
        }
        if (path === "/internal/interactions/session-transfer-capability") {
          return jsonNoStore(
            await this.core.sessionTransferCapability(parseInteraction(body)),
          );
        }
        if (path === "/internal/interactions/session-transfer") {
          return jsonNoStore(
            await this.core.importSessionTransfer(
              parseInteraction(body, {
                requireSessionTransfer: true,
              }),
            ),
          );
        }
        if (path === "/internal/interactions/decision") {
          const result = await this.core.decide(
            parseInteraction(body, { requireDecision: true }),
          );
          if (this.core.hasActiveCleanupDebt()) {
            const alarm = await this.durableState.storage.getAlarm();
            if (alarm === null) {
              await this.durableState.storage.setAlarm(Date.now() + 30_000);
            }
          } else {
            await this.durableState.storage.deleteAlarm();
          }
          return jsonNoStore(result);
        }
        if (path === "/internal/owners/profile/reset") {
          const result = await this.core.reset(parseProfileReset(body));
          await this.durableState.storage.deleteAlarm();
          return jsonNoStore(result);
        }
        if (path === "/internal/owners/purge") {
          await this.durableState.storage.deleteAlarm();
          const result = await this.core.purge(parseOwnerPurge(body));
          return jsonNoStore(result);
        }
        throw new GatewayError("not_found", 404);
      } catch (error) {
        console.error(
          JSON.stringify({
            service: "browser-profile-session",
            event: "request_failed",
            route: path,
            code: safeErrorCode(error),
          }),
        );
        return publicErrorResponse(error);
      }
    });
  }

  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    try {
      await this.exclusive(() => this.core.expireActive());
    } catch (error) {
      // Native alarm retries stop after six attempts. Re-arm before the final
      // attempt is exhausted so a transient Browser Run outage cannot leave a
      // durable HUMAN_CONTROL cleanup debt permanently stranded.
      if ((alarmInfo?.retryCount ?? 0) >= 5) {
        console.error(
          JSON.stringify({
            service: "browser-gateway",
            event: "human_control_cleanup_deferred",
            code: safeErrorCode(error),
            retryCount: alarmInfo?.retryCount ?? 0,
          }),
        );
        await this.durableState.storage.setAlarm(Date.now() + 30_000);
        return;
      }
      throw error;
    }
  }
}
