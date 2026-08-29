import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "../src/hash.js";
import { WORLD_REGISTRY_SEGMENT } from "../src/turn-state-registry.js";

const packageRoot = new URL("..", import.meta.url);
const hash = (character: string): string => character.repeat(64);
const port = 19_000 + Math.floor(Math.random() * 1_000);
const origin = `http://127.0.0.1:${port}`;

type Attempt = {
  operationId: string;
  planFingerprint: string;
  fromOwnerId: string;
  toOwnerId: string;
  fromOwnerHash: string;
  toOwnerHash: string;
  fromOwnerGeneration: string;
  toOwnerGeneration: string;
  migrationIdHash: string;
  leaseIdHash: string;
  leaseGeneration: number;
  stageHash: string;
  planRevision: number;
  passIdHash: string;
};

const coordinatorAttempt = (args: {
  operation: string;
  from: string;
  to: string;
  pass: string;
}): Promise<Attempt> =>
  Promise.all([sha256Hex(args.from), sha256Hex(args.to)]).then(
    ([fromOwnerHash, toOwnerHash]) => ({
      operationId: hash(args.operation),
      planFingerprint: hash("2"),
      fromOwnerId: args.from,
      toOwnerId: args.to,
      fromOwnerHash,
      toOwnerHash,
      fromOwnerGeneration: `from-generation-${args.operation}`,
      toOwnerGeneration: `to-generation-${args.operation}`,
      migrationIdHash: hash("5"),
      leaseIdHash: hash("6"),
      leaseGeneration: 0,
      stageHash: hash("7"),
      planRevision: 1,
      passIdHash: hash(args.pass),
    }),
  );

const pause = async (delayMs: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};

const requestJson = async (
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, any> }> => {
  const response = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    ...(body
      ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>,
  };
};

const coordinatorPath = (attempt: Attempt, path: string): string =>
  `/coordinator/${attempt.operationId}${path}`;
const fencePath = (ownerHash: string, path: string): string =>
  `/fence/${ownerHash}${path}`;
const realCoordinatorPath = (attempt: Attempt, path: string): string =>
  `/real-coordinator/${attempt.operationId}${path}`;
const realFencePath = (ownerHash: string, path: string): string =>
  `/real-fence/${ownerHash}${path}`;

const eventually = async <T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 8_000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let latest = await read();
  while (!accept(latest) && Date.now() < deadline) {
    await pause(25);
    latest = await read();
  }
  if (!accept(latest)) {
    throw new Error(`condition not reached: ${JSON.stringify(latest)}`);
  }
  return latest;
};

describe("OwnerTransferCoordinator real Durable Object", () => {
  let persistencePath = "";
  let workerd: ChildProcess | null = null;
  let workerdOutput = "";

  const startWorkerd = async (): Promise<void> => {
    workerdOutput = "";
    const child = spawn(
      process.execPath,
      [
        "x",
        "wrangler",
        "dev",
        "--config",
        "tests/fixtures/owner-transfer-coordinator-workerd.wrangler.jsonc",
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--local",
        "--persist-to",
        persistencePath,
        "--show-interactive-dev-session=false",
      ],
      {
        cwd: packageRoot,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    workerd = child;
    const observe = (chunk: unknown): void => {
      workerdOutput += String(chunk);
    };
    child.stdout?.on("data", observe);
    child.stderr?.on("data", observe);

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`wrangler exited before readiness:\n${workerdOutput}`);
      }
      try {
        const response = await fetch(`${origin}/`);
        if (response.ok) return;
      } catch {
        // Workerd is still starting.
      }
      await pause(50);
    }
    throw new Error(`workerd did not become ready:\n${workerdOutput}`);
  };

  const stopWorkerd = async (): Promise<void> => {
    const child = workerd;
    workerd = null;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), pause(5_000)]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  };

  const restartWorkerd = async (): Promise<void> => {
    await stopWorkerd();
    await startWorkerd();
  };

  beforeAll(async () => {
    persistencePath = await mkdtemp(
      join(tmpdir(), "stella-owner-transfer-workerd-"),
    );
    await startWorkerd();
  });

  afterAll(async () => {
    await stopWorkerd();
    if (persistencePath.includes("stella-owner-transfer-workerd-")) {
      await rm(persistencePath, { recursive: true, force: true });
    }
  });

  test("reserves production BuildSession owner fences with exact bound owner identities", async () => {
    const attempt = await coordinatorAttempt({
      operation: "d",
      from: "real-source-owner",
      to: "real-destination-owner",
      pass: "e",
    });
    const reserved = await requestJson(
      realCoordinatorPath(attempt, "/reserve"),
      { attempt },
    );
    expect(reserved).toMatchObject({
      status: 200,
      body: {
        status: "reserved",
        reservation: {
          turnId: `owner-transfer:${attempt.operationId}`,
          source: {
            leaseId: expect.any(String),
            generation: expect.any(String),
          },
          destination: {
            leaseId: expect.any(String),
            generation: expect.any(String),
          },
        },
      },
    });

    const snapshot = await requestJson(
      realCoordinatorPath(attempt, "/__test/snapshot"),
    );
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.state.phase).toBe("reserved");
    expect(snapshot.body.state.fromOwnerId).toBe(attempt.fromOwnerId);
    expect(snapshot.body.state.toOwnerId).toBe(attempt.toOwnerId);

    const sourceAssertion = await requestJson(
      realFencePath(attempt.fromOwnerHash, "/owner-fence/assert-transfer"),
      {
        ownerId: attempt.fromOwnerId,
        leaseId: snapshot.body.state.sourceReservation.leaseId,
        sessionId: snapshot.body.objectId,
        turnId: `owner-transfer:${attempt.operationId}`,
        ownerGeneration: attempt.fromOwnerGeneration,
      },
    );
    expect(sourceAssertion.status).toBe(200);
    expect(sourceAssertion.body.ok).toBe(true);
    expect(sourceAssertion.body.generation).toBe(
      snapshot.body.state.sourceReservation.generation,
    );

    const destinationAssertion = await requestJson(
      realFencePath(attempt.toOwnerHash, "/owner-fence/assert-transfer"),
      {
        ownerId: attempt.toOwnerId,
        leaseId: snapshot.body.state.destinationReservation.leaseId,
        sessionId: snapshot.body.objectId,
        turnId: `owner-transfer:${attempt.operationId}`,
        ownerGeneration: attempt.toOwnerGeneration,
      },
    );
    expect(destinationAssertion.status).toBe(200);
    expect(destinationAssertion.body.ok).toBe(true);
    expect(destinationAssertion.body.generation).toBe(
      snapshot.body.state.destinationReservation.generation,
    );

    const workspacePlanId = "f".repeat(64);
    const workspaceHash = await sha256Hex(WORLD_REGISTRY_SEGMENT);
    const plan = await requestJson(
      realCoordinatorPath(attempt, "/workspace/plan"),
      {
        attempt,
        observation: {
          workspacePlanId,
          sourceHasState: true,
          sourceStateMarker: "source-marker",
          destinationMarker: "absent",
          expectedDestinationMarker: "destination-marker",
        },
      },
    );
    expect(plan).toMatchObject({
      status: 200,
      body: { plan: { state: "planned" } },
    });
    const manifest = {
      schemaVersion: 1,
      transferOperationId: attempt.operationId,
      sourceOwnerHash: attempt.fromOwnerHash,
      sourceOwnerGeneration: attempt.fromOwnerGeneration,
      sourceWorkspaceHash: workspaceHash,
      destinationOwnerHash: attempt.toOwnerHash,
      destinationOwnerGeneration: attempt.toOwnerGeneration,
      destinationWorkspaceHash: workspaceHash,
      count: 1,
      fingerprint: "a".repeat(64),
    };
    expect(
      await requestJson(
        realCoordinatorPath(attempt, "/workspace/turn-state/exported"),
        { attempt, workspacePlanId, manifest },
      ),
    ).toMatchObject({
      status: 200,
      body: { turnState: { cursor: 0, phase: "staging" } },
    });
    expect(
      await requestJson(realCoordinatorPath(attempt, "/workspace/copied"), {
        attempt,
        workspacePlanId,
      }),
    ).toMatchObject({ status: 409, body: { code: "owner_transfer_conflict" } });
    expect(
      await requestJson(
        realCoordinatorPath(attempt, "/workspace/turn-state/staged"),
        {
          attempt,
          workspacePlanId,
          manifestFingerprint: manifest.fingerprint,
          previousCursor: 0,
          nextCursor: 1,
        },
      ),
    ).toMatchObject({
      status: 200,
      body: { turnState: { cursor: 1, phase: "staging" } },
    });
    const activationReceipt = "b".repeat(64);
    expect(
      await requestJson(
        realCoordinatorPath(attempt, "/workspace/turn-state/activated"),
        {
          attempt,
          workspacePlanId,
          manifestFingerprint: manifest.fingerprint,
          activationReceipt,
        },
      ),
    ).toMatchObject({
      status: 200,
      body: { turnState: { phase: "activated", activationReceipt } },
    });
    expect(
      await requestJson(realCoordinatorPath(attempt, "/workspace/copied"), {
        attempt,
        workspacePlanId,
      }),
    ).toMatchObject({ status: 200, body: { plan: { state: "copied" } } });
    expect(
      await requestJson(realCoordinatorPath(attempt, "/workspace/retired"), {
        attempt,
        workspacePlanId,
      }),
    ).toMatchObject({ status: 409, body: { code: "owner_transfer_conflict" } });
    const emptyReceipt = "c".repeat(64);
    expect(
      await requestJson(
        realCoordinatorPath(attempt, "/workspace/turn-state/retired"),
        {
          attempt,
          workspacePlanId,
          manifestFingerprint: manifest.fingerprint,
          activationReceipt,
          emptyReceipt,
        },
      ),
    ).toMatchObject({
      status: 200,
      body: { turnState: { phase: "retired", emptyReceipt } },
    });
    expect(
      await requestJson(realCoordinatorPath(attempt, "/workspace/retired"), {
        attempt,
        workspacePlanId,
      }),
    ).toMatchObject({ status: 200, body: { plan: { state: "retired" } } });

    const forgedOwnerId = `${attempt.fromOwnerId}-forged`;
    const forgedReplay = await requestJson(
      realCoordinatorPath(attempt, "/reserve"),
      {
        attempt: {
          ...attempt,
          fromOwnerId: forgedOwnerId,
          fromOwnerHash: await sha256Hex(forgedOwnerId),
        },
      },
    );
    expect(forgedReplay.status).toBe(409);
    expect(forgedReplay.body.code).toBe("owner_transfer_conflict");

    expect(
      await requestJson(realCoordinatorPath(attempt, "/abort"), {
        attempt,
        permanent: false,
      }),
    ).toEqual({
      status: 200,
      body: { aborted: true, permanent: false },
    });
  }, 30_000);

  test("serializes reserve races and preserves renew, ack, abort, and alarms across isolate restarts", async () => {
    const first = await coordinatorAttempt({
      operation: "1",
      from: "3",
      to: "4",
      pass: "8",
    });
    const competing = { ...first, passIdHash: hash("9") };

    const mismatchedOwnerHash = await requestJson(
      coordinatorPath(first, "/reserve"),
      {
        attempt: { ...first, fromOwnerId: "forged-source-owner" },
      },
    );
    expect(mismatchedOwnerHash).toEqual({
      status: 400,
      body: { code: "bad_request", message: "Malformed request." },
    });

    expect(
      await requestJson(fencePath(first.fromOwnerHash, "/__test/configure"), {
        registerDelayMs: 650,
      }),
    ).toEqual({ status: 200, body: { configured: true } });

    let firstFinishedAt = 0;
    const firstReserve = requestJson(coordinatorPath(first, "/reserve"), {
      attempt: first,
    }).then((result) => {
      firstFinishedAt = Date.now();
      return result;
    });
    await eventually(
      async () =>
        await requestJson(fencePath(first.fromOwnerHash, "/__test/snapshot")),
      (result) => result.body.calls?.register === 1,
    );

    let competingSettled = false;
    let competingFinishedAt = 0;
    const competingReserve = requestJson(
      coordinatorPath(competing, "/reserve"),
      { attempt: competing },
    ).then((result) => {
      competingSettled = true;
      competingFinishedAt = Date.now();
      return result;
    });
    await pause(100);
    expect(competingSettled).toBe(false);

    const [reserved, rejected] = await Promise.all([
      firstReserve,
      competingReserve,
    ]);
    expect(reserved).toMatchObject({
      status: 200,
      body: {
        status: "reserved",
        reservation: {
          turnId: `owner-transfer:${first.operationId}`,
          source: { generation: "fake-fence-generation-1" },
          destination: { generation: "fake-fence-generation-1" },
        },
      },
    });
    expect(rejected.status).toBe(409);
    expect(rejected.body.code).toBe("transfer_busy");
    expect(competingFinishedAt).toBeGreaterThanOrEqual(firstFinishedAt);

    const reboundOwnerId = `${first.fromOwnerId}-rebound`;
    const reboundIdentity = await requestJson(
      coordinatorPath(first, "/reserve"),
      {
        attempt: {
          ...first,
          fromOwnerId: reboundOwnerId,
          fromOwnerHash: await sha256Hex(reboundOwnerId),
        },
      },
    );
    expect(reboundIdentity.status).toBe(409);
    expect(reboundIdentity.body.code).toBe("owner_transfer_conflict");

    await requestJson(fencePath(first.fromOwnerHash, "/__test/configure"), {
      registerDelayMs: 0,
    });
    const beforeRestart = await requestJson(
      coordinatorPath(first, "/__test/snapshot"),
    );
    expect(beforeRestart.body.state.phase).toBe("reserved");
    expect(beforeRestart.body.state.activePass.passIdHash).toBe(
      first.passIdHash,
    );
    expect(beforeRestart.body.state.sourceReservation.generation).toBe(
      "fake-fence-generation-1",
    );
    expect(beforeRestart.body.state.destinationReservation.generation).toBe(
      "fake-fence-generation-1",
    );

    await restartWorkerd();
    const afterRestart = await requestJson(
      coordinatorPath(first, "/__test/snapshot"),
    );
    expect(afterRestart.body.bootId).not.toBe(beforeRestart.body.bootId);
    expect(afterRestart.body.objectId).toBe(beforeRestart.body.objectId);
    expect(afterRestart.body.state.phase).toBe("reserved");
    expect(afterRestart.body.state.activePass).toEqual(
      beforeRestart.body.state.activePass,
    );
    expect(afterRestart.body.state.sourceReservation).toEqual(
      beforeRestart.body.state.sourceReservation,
    );
    expect(afterRestart.body.state.destinationReservation).toEqual(
      beforeRestart.body.state.destinationReservation,
    );

    const sourceBeforeAlarm = await requestJson(
      fencePath(first.fromOwnerHash, "/__test/snapshot"),
    );
    const destinationBeforeAlarm = await requestJson(
      fencePath(first.toOwnerHash, "/__test/snapshot"),
    );
    expect(sourceBeforeAlarm.body.calls.register).toBe(1);
    expect(destinationBeforeAlarm.body.calls.register).toBe(1);

    const scheduled = await requestJson(
      coordinatorPath(first, "/__test/schedule-alarm"),
      { delayMs: 100 },
    );
    expect(scheduled.status).toBe(200);
    expect(scheduled.body.scheduled).toBe(true);
    const renewed = await eventually(
      async () => await requestJson(coordinatorPath(first, "/__test/snapshot")),
      (result) => result.body.alarmCount >= 1,
    );
    expect(renewed.body.state.phase).toBe("reserved");
    expect(renewed.body.state.sourceReservation).toEqual(
      beforeRestart.body.state.sourceReservation,
    );
    expect(renewed.body.state.destinationReservation).toEqual(
      beforeRestart.body.state.destinationReservation,
    );
    expect(renewed.body.alarmAt).toBeGreaterThan(Date.now());

    const sourceAfterAlarm = await requestJson(
      fencePath(first.fromOwnerHash, "/__test/snapshot"),
    );
    const destinationAfterAlarm = await requestJson(
      fencePath(first.toOwnerHash, "/__test/snapshot"),
    );
    expect(sourceAfterAlarm.body.calls.register).toBe(2);
    expect(destinationAfterAlarm.body.calls.register).toBe(2);
    // Initial acquisition has no generations yet and therefore does not
    // contact assert-transfer. The first real pair comes from the alarm
    // before it renews both registrations.
    expect(sourceAfterAlarm.body.calls.assertTransfer).toBe(1);
    expect(destinationAfterAlarm.body.calls.assertTransfer).toBe(1);

    const copied = await requestJson(coordinatorPath(first, "/copied"), {
      attempt: first,
      result: { transferred: true, receipt: "workerd-copy" },
    });
    expect(copied).toEqual({
      status: 200,
      body: {
        status: "copy_complete",
        result: { transferred: true, receipt: "workerd-copy" },
      },
    });
    const acknowledged = await requestJson(coordinatorPath(first, "/ack"), {
      attempt: first,
    });
    expect(acknowledged).toEqual({
      status: 200,
      body: { acknowledged: true, replayed: false },
    });
    const acknowledgedState = await requestJson(
      coordinatorPath(first, "/__test/snapshot"),
    );
    expect(acknowledgedState.body.state.phase).toBe("acknowledged");
    expect(acknowledgedState.body.state.result).toEqual({
      transferred: true,
      receipt: "workerd-copy",
    });
    expect(acknowledgedState.body.state.sourceReservation.generation).toBe(
      undefined,
    );
    expect(acknowledgedState.body.state.destinationReservation.generation).toBe(
      undefined,
    );
    expect(acknowledgedState.body.alarmAt).toBeNull();
    const sourceAfterAck = await requestJson(
      fencePath(first.fromOwnerHash, "/__test/snapshot"),
    );
    const destinationAfterAck = await requestJson(
      fencePath(first.toOwnerHash, "/__test/snapshot"),
    );
    expect(sourceAfterAck.body.active).toBe(undefined);
    expect(destinationAfterAck.body.active).toBe(undefined);
    expect(sourceAfterAck.body.calls.unregister).toBe(1);
    expect(destinationAfterAck.body.calls.unregister).toBe(1);

    await restartWorkerd();
    const acknowledgedAfterRestart = await requestJson(
      coordinatorPath(first, "/__test/snapshot"),
    );
    expect(acknowledgedAfterRestart.body.bootId).not.toBe(
      acknowledgedState.body.bootId,
    );
    expect(acknowledgedAfterRestart.body.state.phase).toBe("acknowledged");
    expect(acknowledgedAfterRestart.body.state.result).toEqual(
      acknowledgedState.body.state.result,
    );
    expect(
      await requestJson(coordinatorPath(first, "/ack"), { attempt: first }),
    ).toEqual({
      status: 200,
      body: { acknowledged: true, replayed: true },
    });
    const abortAfterAcknowledge = await requestJson(
      coordinatorPath(first, "/abort"),
      { attempt: first, permanent: false },
    );
    expect(abortAfterAcknowledge.status).toBe(409);
    expect(abortAfterAcknowledge.body.code).toBe("owner_transfer_conflict");
    expect(
      (await requestJson(coordinatorPath(first, "/__test/snapshot"))).body.state
        .phase,
    ).toBe("acknowledged");

    const abortable = await coordinatorAttempt({
      operation: "c",
      from: "a",
      to: "b",
      pass: "1",
    });
    expect(
      await requestJson(coordinatorPath(abortable, "/reserve"), {
        attempt: abortable,
      }),
    ).toMatchObject({ status: 200, body: { status: "reserved" } });
    expect(
      await requestJson(coordinatorPath(abortable, "/abort"), {
        attempt: abortable,
        permanent: false,
      }),
    ).toEqual({
      status: 200,
      body: { aborted: true, permanent: false },
    });
    const retryableState = await requestJson(
      coordinatorPath(abortable, "/__test/snapshot"),
    );
    expect(retryableState.body.state.phase).toBe("retryable_blocked");
    expect(retryableState.body.state.activePass).toBe(undefined);
    expect(retryableState.body.alarmAt).toBeNull();
    const abortSourceFence = await requestJson(
      fencePath(abortable.fromOwnerHash, "/__test/snapshot"),
    );
    const abortDestinationFence = await requestJson(
      fencePath(abortable.toOwnerHash, "/__test/snapshot"),
    );
    expect(abortSourceFence.body.active).toBe(undefined);
    expect(abortDestinationFence.body.active).toBe(undefined);
    expect(abortSourceFence.body.calls.unregister).toBe(1);
    expect(abortDestinationFence.body.calls.unregister).toBe(1);

    await restartWorkerd();
    const retryableAfterRestart = await requestJson(
      coordinatorPath(abortable, "/__test/snapshot"),
    );
    expect(retryableAfterRestart.body.bootId).not.toBe(
      retryableState.body.bootId,
    );
    expect(retryableAfterRestart.body.state.phase).toBe("retryable_blocked");
    const retryPass = { ...abortable, passIdHash: hash("3") };
    expect(
      await requestJson(coordinatorPath(retryPass, "/reserve"), {
        attempt: retryPass,
      }),
    ).toMatchObject({ status: 200, body: { status: "reserved" } });
    const staleAbort = await requestJson(coordinatorPath(abortable, "/abort"), {
      attempt: abortable,
      permanent: true,
    });
    expect(staleAbort.status).toBe(409);
    expect(staleAbort.body.code).toBe("transfer_busy");
    const afterStaleAbort = await requestJson(
      coordinatorPath(retryPass, "/__test/snapshot"),
    );
    expect(afterStaleAbort.body.state.phase).toBe("reserved");
    expect(afterStaleAbort.body.state.activePass.passIdHash).toBe(
      retryPass.passIdHash,
    );
    expect(
      await requestJson(coordinatorPath(retryPass, "/abort"), {
        attempt: retryPass,
        permanent: true,
      }),
    ).toEqual({
      status: 200,
      body: { aborted: true, permanent: true },
    });
    const permanentlyBlocked = {
      ...retryPass,
      passIdHash: hash("4"),
    };
    const blocked = await requestJson(
      coordinatorPath(permanentlyBlocked, "/reserve"),
      { attempt: permanentlyBlocked },
    );
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("owner_purge_permanent");
  }, 60_000);
});
