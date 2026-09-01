import type {
  BrowserBackend,
  BrowserHandoff,
  HandoffState,
  SafeObservation,
  SafeTab,
  TrustedVerification,
  TrustedVerificationState,
} from "../../src/browser-provider.js";
import { BrowserProfileSession } from "../../src/browser-profile-session.js";
import type { BrowserGatewayEnv } from "../../src/profile-session-core.js";

type FixtureEnv = BrowserGatewayEnv & {
  BROWSER_PROFILE_SESSIONS: DurableObjectNamespace<AlarmFixtureSession>;
};

const AUTHORITY = {
  ownerId: "https://auth.example|workerd-alarm-user",
  ownerGeneration: "workerd-alarm-generation",
  conversationId: "workerd-alarm-conversation",
  threadId: "workerd-alarm-thread",
  turnId: "workerd-alarm-turn",
  attemptGeneration: 1,
} as const;

const fixtureCommand = (
  requestId: string,
  action: "browser.open" | "browser.login_takeover",
  params: Readonly<Record<string, unknown>>,
) => ({
  schemaVersion: 1,
  authority: AUTHORITY,
  command: { schemaVersion: 1, requestId, action, params },
});

class DurableFaultBrowser implements BrowserBackend {
  private session: string | undefined;
  private policy: string | undefined;

  constructor(private readonly storage: DurableObjectStorage) {}

  async ensure(args: {
    sessionId?: string;
    storageState?: unknown;
    allowedOrigins: readonly string[];
    onSessionAcquired: (sessionId: string, policyDigest: string) => void;
  }): Promise<void> {
    this.session = args.sessionId ?? "workerd-browser-session";
    this.policy = "workerd-browser-policy";
    args.onSessionAcquired(this.session, this.policy);
  }

  sessionId(): string | undefined {
    return this.session;
  }

  policyDigest(): string | undefined {
    return this.policy;
  }

  async navigate(url: string): Promise<SafeObservation> {
    return { url, title: "Fixture", text: "Fixture" };
  }

  async observe(): Promise<SafeObservation> {
    return {
      url: "https://app.example/",
      title: "Fixture",
      text: "Fixture",
    };
  }

  async click(_selector: string): Promise<void> {}
  async fillNonSecret(_selector: string, _value: string): Promise<void> {}
  async press(_selector: string, _key: string): Promise<void> {}
  async select(_selector: string, _value: string): Promise<void> {}
  async wait(_selector: string, _timeoutMs: number): Promise<void> {}
  async focusTab(_tabId: string): Promise<void> {}

  async tabs(): Promise<readonly SafeTab[]> {
    return [];
  }

  async storageState(): Promise<unknown> {
    return {};
  }

  async verifyImportedStorageState(_args: {
    storageState: unknown;
    allowedOrigins: readonly string[];
    verification: TrustedVerification;
  }): Promise<void> {}

  async startHandoff(_args: {
    handoffTimeoutMs: number;
    expectedOrigin: string;
  }): Promise<BrowserHandoff> {
    return { handoffId: "workerd-handoff", targetId: "workerd-target" };
  }

  async renewLiveView(
    _liveViewTtlMs: number,
    _targetId?: string,
  ): Promise<string> {
    return "https://live.browser.run/workerd-fixture";
  }

  async handoffState(): Promise<HandoffState> {
    return { active: true, handoffId: "workerd-handoff" };
  }

  async completeHandoff(_success: boolean): Promise<void> {}

  async trustedVerify(
    _verification: TrustedVerification,
    _expectedState: TrustedVerificationState,
  ): Promise<boolean> {
    return true;
  }

  async closeContext(): Promise<void> {}

  async closeRemote(_sessionId?: string): Promise<void> {
    const remaining =
      (await this.storage.get<number>("fixture:close_failures")) ?? 0;
    if (remaining > 0) {
      await this.storage.put("fixture:close_failures", remaining - 1);
      throw new Error("injected workerd remote close failure");
    }
    const successes =
      (await this.storage.get<number>("fixture:close_successes")) ?? 0;
    await this.storage.put("fixture:close_successes", successes + 1);
    this.session = undefined;
    this.policy = undefined;
  }
}

export class AlarmFixtureSession extends BrowserProfileSession {
  private readonly fixtureState: DurableObjectState;

  constructor(ctx: DurableObjectState, env: BrowserGatewayEnv) {
    super(ctx, env, { browser: new DurableFaultBrowser(ctx.storage) });
    this.fixtureState = ctx;
  }

  private async setup(): Promise<Response> {
    const openResponse = await super.fetch(
      new Request("https://browser-profile/internal/turn/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          fixtureCommand(
            "00000000-0000-4000-8000-000000000801",
            "browser.open",
            {
              allowedOrigins: ["https://app.example"],
              startUrl: "https://app.example/login",
            },
          ),
        ),
      }),
    );
    if (!openResponse.ok) return openResponse;
    const suspensionResponse = await super.fetch(
      new Request("https://browser-profile/internal/turn/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          fixtureCommand(
            "00000000-0000-4000-8000-000000000802",
            "browser.login_takeover",
            {
              allowedOrigins: ["https://app.example"],
              displayOrigin: "https://app.example",
              startUrl: "https://app.example/login",
              expiresInMs: 60_000,
              verification: {
                expectedOrigin: "https://app.example",
                authenticatedSelector: "#authenticated",
                loggedOutSelector: "#login",
                resumeUrl: "https://app.example/account",
              },
            },
          ),
        ),
      }),
    );
    if (!suspensionResponse.ok) return suspensionResponse;
    const suspension = (await suspensionResponse.json()) as {
      suspension: { interactionId: string };
    };
    this.fixtureState.storage.sql.exec(
      "UPDATE interactions SET expires_at = ? WHERE interaction_id = ?",
      Date.now() - 1,
      suspension.suspension.interactionId,
    );
    await this.fixtureState.storage.put("fixture:close_failures", 1);
    await this.fixtureState.storage.put("fixture:close_successes", 0);
    await this.fixtureState.storage.setAlarm(Date.now() + 100);
    return Response.json({
      interactionId: suspension.suspension.interactionId,
    });
  }

  private async fixtureSnapshot(): Promise<Response> {
    const state = this.fixtureState.storage.sql
      .exec<{
        phase: string;
        active_interaction_id: string | null;
        browser_session_id: string | null;
      }>(
        "SELECT phase, active_interaction_id, browser_session_id FROM profile_state WHERE id = 0",
      )
      .toArray()[0];
    const interaction = this.fixtureState.storage.sql
      .exec<{ state: string; revision: number }>(
        "SELECT state, revision FROM interactions LIMIT 1",
      )
      .toArray()[0];
    return Response.json({
      state: state ?? null,
      interaction: interaction ?? null,
      closeFailures:
        (await this.fixtureState.storage.get<number>(
          "fixture:close_failures",
        )) ?? 0,
      closeSuccesses:
        (await this.fixtureState.storage.get<number>(
          "fixture:close_successes",
        )) ?? 0,
      alarm: await this.fixtureState.storage.getAlarm(),
    });
  }

  private async replayExpiredDecision(): Promise<Response> {
    const interactionId = this.fixtureState.storage.sql
      .exec<{ interaction_id: string }>(
        "SELECT interaction_id FROM interactions LIMIT 1",
      )
      .one().interaction_id;
    return super.fetch(
      new Request("https://browser-profile/internal/interactions/decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          authority: AUTHORITY,
          profileId: "default",
          profileEpoch: 1,
          interactionId,
          interactionRevision: 1,
          decision: "done",
        }),
      }),
    );
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/__test/setup") return this.setup();
    if (path === "/__test/state") return this.fixtureSnapshot();
    if (path === "/__test/replay-expired-decision") {
      return this.replayExpiredDecision();
    }
    return super.fetch(request);
  }
}

export default {
  async fetch(request: Request, env: FixtureEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/__test/")) {
      return new Response("not found", { status: 404 });
    }
    return env.BROWSER_PROFILE_SESSIONS.getByName("alarm-fixture").fetch(
      request,
    );
  },
} satisfies ExportedHandler<FixtureEnv>;
