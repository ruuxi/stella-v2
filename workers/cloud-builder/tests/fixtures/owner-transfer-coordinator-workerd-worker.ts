import { DurableObject } from "cloudflare:workers";
import { BuildSession } from "../../src/index.js";
import { OwnerTransferCoordinator } from "../../src/owner-transfer-coordinator-do.js";
import type { OwnerTransferCoordinatorState } from "../../src/owner-transfer-coordinator.js";

type FixtureEnv = {
  BUILD_SESSIONS: DurableObjectNamespace<FakeOwnerFence>;
  OWNER_TRANSFER_COORDINATORS: DurableObjectNamespace<TestOwnerTransferCoordinator>;
  REAL_BUILD_SESSIONS: DurableObjectNamespace<BuildSession>;
  REAL_OWNER_TRANSFER_COORDINATORS: DurableObjectNamespace<RealFenceOwnerTransferCoordinator>;
};

export { BuildSession };

type FenceRegistration = {
  ownerId: string;
  leaseId: string;
  sessionId: string;
  turnId: string;
  ownerGeneration: string;
  generation: string;
};

type FenceState = {
  registerDelayMs: number;
  calls: {
    register: number;
    assertTransfer: number;
    unregister: number;
  };
  generation: number;
  active?: FenceRegistration;
};

const COORDINATOR_STATE_KEY = "ownerTransferCoordinator";
const TEST_ALARM_COUNT_KEY = "__testOwnerTransferAlarmCount";
const FENCE_STATE_KEY = "fakeOwnerFence";

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

const sleep = async (delayMs: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};

const asRecord = async (request: Request): Promise<Record<string, unknown>> =>
  ((await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null) ?? {};

const stringField = (body: Record<string, unknown>, key: string): string =>
  typeof body[key] === "string" ? body[key] : "";

const emptyFenceState = (): FenceState => ({
  registerDelayMs: 0,
  calls: { register: 0, assertTransfer: 0, unregister: 0 },
  generation: 0,
});

/**
 * A deliberately small, durable owner-fence peer. The coordinator itself is
 * the production class; this fake replaces only its remote BUILD_SESSIONS
 * dependency so Workerd can exercise the coordinator's real storage, input
 * gate, alarm, and isolate-restart behavior deterministically.
 */
export class FakeOwnerFence extends DurableObject {
  private async state(): Promise<FenceState> {
    return (
      (await this.ctx.storage.get<FenceState>(FENCE_STATE_KEY)) ??
      emptyFenceState()
    );
  }

  private async persist(state: FenceState): Promise<void> {
    await this.ctx.storage.put(FENCE_STATE_KEY, state);
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/__test/snapshot") {
      const state = await this.state();
      return json(state);
    }
    if (path === "/__test/configure") {
      const body = await asRecord(request);
      const delay = body.registerDelayMs;
      if (
        typeof delay !== "number" ||
        !Number.isSafeInteger(delay) ||
        delay < 0 ||
        delay > 2_000
      ) {
        return json({ code: "bad_request" }, 400);
      }
      const state = await this.state();
      state.registerDelayMs = delay;
      await this.persist(state);
      return json({ configured: true });
    }

    const body = await asRecord(request);
    const state = await this.state();
    if (path === "/owner-fence/register") {
      state.calls.register += 1;
      await this.persist(state);
      if (state.registerDelayMs > 0) await sleep(state.registerDelayMs);

      const registration = {
        ownerId: stringField(body, "ownerId"),
        leaseId: stringField(body, "leaseId"),
        sessionId: stringField(body, "sessionId"),
        turnId: stringField(body, "turnId"),
        ownerGeneration: stringField(body, "ownerGeneration"),
      };
      if (
        Object.values(registration).some((value) => value.length === 0) ||
        request.headers.get("x-stella-owner-fence-id") !== registration.ownerId
      ) {
        return json({ code: "bad_request" }, 400);
      }
      if (
        state.active &&
        (state.active.leaseId !== registration.leaseId ||
          state.active.ownerId !== registration.ownerId ||
          state.active.sessionId !== registration.sessionId ||
          state.active.turnId !== registration.turnId ||
          state.active.ownerGeneration !== registration.ownerGeneration)
      ) {
        return json({ code: "transfer_busy" }, 409);
      }
      if (!state.active) {
        state.generation += 1;
        state.active = {
          ...registration,
          generation: `fake-fence-generation-${state.generation}`,
        };
      }
      await this.persist(state);
      return json({ generation: state.active.generation });
    }

    if (path === "/owner-fence/assert-transfer") {
      state.calls.assertTransfer += 1;
      await this.persist(state);
      const matches =
        state.active?.ownerId === stringField(body, "ownerId") &&
        request.headers.get("x-stella-owner-fence-id") ===
          stringField(body, "ownerId") &&
        state.active?.leaseId === stringField(body, "leaseId") &&
        state.active.sessionId === stringField(body, "sessionId") &&
        state.active.turnId === stringField(body, "turnId") &&
        state.active.ownerGeneration === stringField(body, "ownerGeneration");
      return matches
        ? json({ generation: state.active!.generation })
        : json({ code: "transfer_busy" }, 409);
    }

    if (path === "/owner-fence/unregister") {
      state.calls.unregister += 1;
      const generation = stringField(body, "generation");
      const matches =
        state.active?.ownerId === stringField(body, "ownerId") &&
        request.headers.get("x-stella-owner-fence-id") ===
          stringField(body, "ownerId") &&
        state.active?.leaseId === stringField(body, "leaseId") &&
        state.active.sessionId === stringField(body, "sessionId") &&
        state.active.turnId === stringField(body, "turnId") &&
        state.active.ownerGeneration === stringField(body, "ownerGeneration") &&
        (!generation || state.active.generation === generation);
      if (matches) delete state.active;
      await this.persist(state);
      return json({ unregistered: matches });
    }

    return json({ error: "Not found." }, 404);
  }
}

/** The production coordinator with observation-only fixture endpoints. */
export class TestOwnerTransferCoordinator extends OwnerTransferCoordinator {
  private readonly bootId = crypto.randomUUID();

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/__test/snapshot") {
      const [state, alarmAt, alarmCount] = await Promise.all([
        this.ctx.storage.get<OwnerTransferCoordinatorState>(
          COORDINATOR_STATE_KEY,
        ),
        this.ctx.storage.getAlarm(),
        this.ctx.storage.get<number>(TEST_ALARM_COUNT_KEY),
      ]);
      return json({
        bootId: this.bootId,
        objectId: this.ctx.id.toString(),
        state: state ?? null,
        alarmAt,
        alarmCount: alarmCount ?? 0,
      });
    }
    if (path === "/__test/schedule-alarm") {
      const body = await asRecord(request);
      const delayMs = body.delayMs;
      if (
        typeof delayMs !== "number" ||
        !Number.isSafeInteger(delayMs) ||
        delayMs < 25 ||
        delayMs > 5_000
      ) {
        return json({ code: "bad_request" }, 400);
      }
      const alarmAt = Date.now() + delayMs;
      await this.ctx.storage.setAlarm(alarmAt);
      return json({ scheduled: true, alarmAt });
    }
    return await super.fetch(request);
  }

  override async alarm(): Promise<void> {
    await super.alarm();
    const alarmCount =
      (await this.ctx.storage.get<number>(TEST_ALARM_COUNT_KEY)) ?? 0;
    await this.ctx.storage.put(TEST_ALARM_COUNT_KEY, alarmCount + 1);
  }
}

/** Production coordinator wired to the production BuildSession owner fence. */
export class RealFenceOwnerTransferCoordinator extends OwnerTransferCoordinator {
  constructor(ctx: DurableObjectState, env: FixtureEnv) {
    super(ctx, { BUILD_SESSIONS: env.REAL_BUILD_SESSIONS });
  }

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/__test/snapshot") {
      const state = await this.ctx.storage.get<OwnerTransferCoordinatorState>(
        COORDINATOR_STATE_KEY,
      );
      return json({ objectId: this.ctx.id.toString(), state: state ?? null });
    }
    return await super.fetch(request);
  }
}

const forward = async (
  stub: DurableObjectStub,
  request: Request,
  targetPath: string,
): Promise<Response> => {
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();
  return await stub.fetch(`https://fixture.invalid${targetPath}`, {
    method: request.method,
    headers: request.headers,
    ...(body ? { body } : {}),
  });
};

export default {
  async fetch(request: Request, env: FixtureEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") return json({ ok: true });

    const coordinator = url.pathname.match(
      /^\/coordinator\/([a-f0-9]{64})(\/.*)$/u,
    );
    if (coordinator) {
      return await forward(
        env.OWNER_TRANSFER_COORDINATORS.getByName(
          `owner-transfer-${coordinator[1]}`,
        ),
        request,
        coordinator[2],
      );
    }

    const realCoordinator = url.pathname.match(
      /^\/real-coordinator\/([a-f0-9]{64})(\/.*)$/u,
    );
    if (realCoordinator) {
      return await forward(
        env.REAL_OWNER_TRANSFER_COORDINATORS.getByName(
          `owner-transfer-${realCoordinator[1]}`,
        ),
        request,
        realCoordinator[2],
      );
    }

    const fence = url.pathname.match(/^\/fence\/([a-f0-9]{64})(\/.*)$/u);
    if (fence) {
      return await forward(
        env.BUILD_SESSIONS.getByName(`owner-purge-${fence[1]}`),
        request,
        fence[2],
      );
    }
    const realFence = url.pathname.match(
      /^\/real-fence\/([a-f0-9]{64})(\/.*)$/u,
    );
    if (realFence) {
      return await forward(
        env.REAL_BUILD_SESSIONS.getByName(`owner-purge-${realFence[1]}`),
        request,
        realFence[2],
      );
    }
    return json({ error: "Not found." }, 404);
  },
};
