import { describe, expect, test } from "bun:test";
import {
  OwnerTransferCoordinatorConflictError,
  acquireCoordinatorPass,
  bindCoordinatorAttempt,
  claimWorkspacePlan,
  classifyOwnerFenceRejection,
  createCoordinatorAttempt,
  createCoordinatorState,
  type OwnerTransferCoordinatorAttempt,
} from "../src/owner-transfer-coordinator.js";

const hash = (character: string): string => character.repeat(64);

const attempt = (
  overrides: Partial<OwnerTransferCoordinatorAttempt> = {},
): OwnerTransferCoordinatorAttempt => ({
  operationId: hash("1"),
  planFingerprint: hash("2"),
  fromOwnerId: "owner-source",
  toOwnerId: "owner-destination",
  fromOwnerHash: hash("3"),
  toOwnerHash: hash("4"),
  fromOwnerGeneration: "from-generation-1",
  toOwnerGeneration: "to-generation-1",
  migrationIdHash: hash("5"),
  leaseIdHash: hash("6"),
  leaseGeneration: 0,
  stageHash: hash("7"),
  planRevision: 1,
  passIdHash: hash("8"),
  ...overrides,
});

describe("durable owner-transfer coordinator", () => {
  test("derives owner hashes from exact bounded owner identities", async () => {
    const created = await createCoordinatorAttempt({
      control: {
        migrationId: "migration-1",
        leaseId: "lease-1",
        leaseGeneration: 0,
        stage: "products",
        planRevision: 1,
        fromOwnerGeneration: "from-generation-1",
        toOwnerGeneration: "to-generation-1",
      },
      operationId: hash("1"),
      planFingerprint: hash("2"),
      fromOwnerId: "owner-source",
      toOwnerId: "owner-destination",
      passId: "pass-1",
    });

    const digest = async (value: string): Promise<string> =>
      Buffer.from(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
      ).toString("hex");
    expect(created.fromOwnerId).toBe("owner-source");
    expect(created.toOwnerId).toBe("owner-destination");
    expect(created.fromOwnerHash).toBe(await digest("owner-source"));
    expect(created.toOwnerHash).toBe(await digest("owner-destination"));
    await expect(
      createCoordinatorAttempt({
        control: {
          migrationId: "migration-1",
          leaseId: "lease-1",
          leaseGeneration: 0,
          stage: "products",
          planRevision: 1,
          fromOwnerGeneration: "from-generation-1",
          toOwnerGeneration: "to-generation-1",
        },
        operationId: hash("1"),
        planFingerprint: hash("2"),
        fromOwnerId: " owner-source",
        toOwnerId: "owner-destination",
      }),
    ).rejects.toThrow(/owner identities are invalid/i);
  });

  test("replays a crash after copy-before-ack without dropping reservations", () => {
    const first = attempt();
    const state = createCoordinatorState(first, 1, {
      source: "source-reservation",
      destination: "destination-reservation",
    });
    state.sourceReservation.generation = "source-fence";
    state.destinationReservation.generation = "destination-fence";
    state.reservationsExpireAt = 10_000;
    state.phase = "copy_complete";
    state.result = { transferred: true };

    const recovered = structuredClone(state);
    bindCoordinatorAttempt(recovered, first, 2);
    expect(recovered.phase).toBe("copy_complete");
    expect(recovered.result).toEqual({ transferred: true });
    expect(recovered.sourceReservation.generation).toBe("source-fence");
    expect(recovered.destinationReservation.generation).toBe(
      "destination-fence",
    );

    const takeover = attempt({
      leaseGeneration: 1,
      leaseIdHash: hash("9"),
      passIdHash: hash("a"),
    });
    bindCoordinatorAttempt(recovered, takeover, 3);
    expect(recovered.leaseGeneration).toBe(1);
    expect(() => bindCoordinatorAttempt(recovered, first, 4)).toThrow(/stale/i);
  });

  test("rejects concurrent bounded passes and owner-generation drift", () => {
    const first = attempt();
    const state = createCoordinatorState(first, 1, {
      source: "source-reservation",
      destination: "destination-reservation",
    });
    acquireCoordinatorPass(state, first.passIdHash!, 2, 100);
    expect(() => acquireCoordinatorPass(state, hash("a"), 3, 100)).toThrow(
      OwnerTransferCoordinatorConflictError,
    );
    expect(() =>
      bindCoordinatorAttempt(
        state,
        attempt({ fromOwnerGeneration: "different-generation" }),
        4,
      ),
    ).toThrow(/different plan/i);
    expect(() =>
      bindCoordinatorAttempt(
        state,
        attempt({ fromOwnerId: "different-owner", fromOwnerHash: hash("3") }),
        4,
      ),
    ).toThrow(/different plan/i);
  });

  test("fails closed when a destination checkpoint changes concurrently", () => {
    const state = createCoordinatorState(attempt(), 1, {
      source: "source-reservation",
      destination: "destination-reservation",
    });
    const observation = {
      workspacePlanId: hash("b"),
      sourceHasState: true,
      sourceStateMarker: "sha256:source",
      destinationMarker: "absent",
      expectedDestinationMarker: "sha256:expected",
    };
    const plan = claimWorkspacePlan(state, observation);
    expect(plan.state).toBe("planned");
    expect(
      claimWorkspacePlan(state, {
        ...observation,
        destinationMarker: "sha256:expected",
      }),
    ).toBe(plan);
    expect(() =>
      claimWorkspacePlan(state, {
        ...observation,
        destinationMarker: "sha256:unrelated",
      }),
    ).toThrow(/destination checkpoint changed/i);
  });

  test("refuses to move a world onto an account that already has one", () => {
    const state = createCoordinatorState(attempt(), 1, {
      source: "source-reservation",
      destination: "destination-reservation",
    });
    expect(() =>
      claimWorkspacePlan(state, {
        workspacePlanId: hash("c"),
        sourceHasState: true,
        sourceStateMarker: "sha256:source",
        destinationMarker: "sha256:occupied",
        expectedDestinationMarker: "sha256:occupied",
      }),
    ).toThrow(/already has a world of its own/i);
  });

  test("distinguishes retryable purge and contention from permanent purge", () => {
    expect(classifyOwnerFenceRejection("owner_purge_permanent")).toEqual({
      retryable: false,
      code: "owner_purge_permanent",
    });
    expect(classifyOwnerFenceRejection("owner_purge_temporary")).toEqual({
      retryable: true,
      code: "owner_purge_temporary",
    });
    expect(classifyOwnerFenceRejection("transfer_busy")).toEqual({
      retryable: true,
      code: "transfer_busy",
    });
    expect(classifyOwnerFenceRejection(undefined)).toEqual({
      retryable: true,
      code: "transfer_unavailable",
    });
  });
});
