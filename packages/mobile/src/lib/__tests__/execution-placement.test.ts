import { describe, expect, test } from "bun:test";
import {
  automaticExecutionResultText,
  automaticExecutionCancellationCommand,
  automaticExecutionConversationClientCreateId,
  bindAutomaticExecutionAdmission,
  buildAutomaticExecutionAdmission,
  executionSubjectForMobileWorkspace,
  isAutomaticExecutionPairCredentialRejection,
  readAutomaticExecutionDispatch,
  requestAutomaticExecutionCancellation,
  waitForAutomaticExecutionStatus,
} from "../execution-placement-core";

describe("automatic mobile execution admission", () => {
  test("workspace remains the subject instead of becoming a placement toggle", () => {
    expect(executionSubjectForMobileWorkspace(undefined)).toBe("portable");
    expect(executionSubjectForMobileWorkspace("computer")).toBe("computer");
    expect(executionSubjectForMobileWorkspace("cloud")).toBe("cloud");
    expect(executionSubjectForMobileWorkspace("project:stella")).toBe("cloud");
  });

  test("hashes the exact payload bytes into the pair-proof challenge", () => {
    const admission = buildAutomaticExecutionAdmission({
      idempotencyKey: "msg:01JPLACEMENT",
      conversationId: "conv:one",
      kind: "chat",
      prompt: "  hello  ",
    });
    expect(admission.body.payloadJson).toBe('{"prompt":"hello"}');
    expect(/^[a-f0-9]{64}$/.test(admission.body.payloadHash)).toBe(true);
    expect(admission.challenge).toBe(
      [
        "execution-placement-v1",
        admission.body.idempotencyKey,
        admission.body.conversationId,
        admission.body.payloadHash,
        "chat",
        "portable",
      ].join(":"),
    );
    expect("transport" in admission.body).toBe(false);
    expect("runOn" in admission.body).toBe(false);
    expect("desktopDeviceId" in admission.body).toBe(false);
  });

  test("computer-only intent is inferred from workspace", () => {
    const admission = buildAutomaticExecutionAdmission({
      idempotencyKey: "agent:01JPLACEMENT",
      conversationId: "conv:two",
      kind: "agent",
      prompt: "organize my desktop",
      workspace: "computer",
      requiredCapabilities: ["computer-use", "local-files"],
    });
    expect(admission.body.subject).toBe("computer");
    expect(admission.body.requiredCapabilities).toEqual([
      "agent",
      "computer-use",
      "local-files",
    ]);
  });

  test("resumes one committed dispatch through transient reads until terminal", async () => {
    const reads = [
      new Error("temporary reconnect"),
      { dispatchId: "mobile:stable", state: "computer_running" },
      {
        dispatchId: "mobile:stable",
        state: "completed",
        resultJson: JSON.stringify({ finalText: "finished once" }),
      },
    ];
    const updates: string[] = [];
    const terminal = await waitForAutomaticExecutionStatus({
      dispatchId: "mobile:stable",
      pollIntervalMs: 1,
      readStatus: async () => {
        const next = reads.shift();
        if (next instanceof Error) throw next;
        return next ?? null;
      },
      onUpdate: (dispatch) => updates.push(dispatch.state),
    });
    expect(updates).toEqual(["computer_running", "completed"]);
    expect(automaticExecutionResultText(terminal)).toBe("finished once");
    expect(reads).toHaveLength(0);
  });

  test("surfaces stale-account and computer-only terminal errors explicitly", async () => {
    await expect(
      waitForAutomaticExecutionStatus({
        dispatchId: "mobile:stale",
        pollIntervalMs: 1,
        readStatus: async () => null,
      }),
    ).rejects.toThrow("signed-in account");
    expect(
      automaticExecutionResultText({
        dispatchId: "mobile:computer",
        state: "failed",
        errorCode: "COMPUTER_REQUIRED_UNAVAILABLE",
      }),
    ).toContain("No eligible paired computer");
  });

  test("cancels a reconnect observer without inventing a fallback", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      waitForAutomaticExecutionStatus({
        dispatchId: "mobile:cancel",
        signal: abort.signal,
        readStatus: async () => ({
          dispatchId: "mobile:cancel",
          state: "cloud_running",
        }),
      }),
    ).rejects.toThrow("wait was canceled");
  });

  test("targets the random server dispatch id, never the client idempotency key", () => {
    const clientId = "mobile:client-message";
    const serverId = "exec:4f4b813a-5968-48ea-bb11-2f648b03e18e";
    const parsed = readAutomaticExecutionDispatch(
      {
        dispatchId: serverId,
        idempotencyKey: clientId,
        kind: "chat",
        ingress: "mobile",
        subject: "portable",
        conversationId: "conv:mobile",
        state: "cloud_running",
        placement: "cloud",
        revision: 2,
        createdAt: 1,
        updatedAt: 2,
      },
      { idempotencyKey: clientId },
    );
    let control = bindAutomaticExecutionAdmission(
      { clientIdempotencyKey: clientId },
      parsed,
    );
    control = requestAutomaticExecutionCancellation(control);
    expect(automaticExecutionCancellationCommand(control)).toEqual({
      dispatchId: serverId,
      cancelRequestId: `cancel:${clientId}`,
    });
  });

  test("carries stop-before-admission and restart cancel intent onto replayed admission", () => {
    const clientId = "mobile:restart-cancel";
    const serverId = "exec:bb30bd7d-e810-4e66-bf56-eebc18e84648";
    const stoppedBeforeAdmission = requestAutomaticExecutionCancellation({
      clientIdempotencyKey: clientId,
    });
    expect(
      automaticExecutionCancellationCommand(stoppedBeforeAdmission),
    ).toBeNull();

    // Process restart restores only the client id + durable cancel intent.
    // Idempotent admission recovers the random server id, then cancellation
    // fences that exact dispatch without creating an alternate executor.
    const restarted = bindAutomaticExecutionAdmission(
      stoppedBeforeAdmission,
      { dispatchId: serverId, idempotencyKey: clientId },
    );
    expect(automaticExecutionCancellationCommand(restarted)).toEqual({
      dispatchId: serverId,
      cancelRequestId: `cancel:${clientId}`,
    });
    expect(() =>
      bindAutomaticExecutionAdmission(restarted, {
        dispatchId: "exec:different",
        idempotencyKey: clientId,
      }),
    ).toThrow("different dispatch");
  });

  test("retries the exact cancel fence when stop arrives while status is polling", async () => {
    const clientId = "mobile:stop-while-polling";
    const serverId = "exec:8d9de86f-e969-43ae-ac42-cb2693e413a8";
    let control = bindAutomaticExecutionAdmission(
      { clientIdempotencyKey: clientId },
      { dispatchId: serverId, idempotencyKey: clientId },
    );
    const canceledDispatchIds: string[] = [];
    let cancelAttempts = 0;
    let reads = 0;

    const terminal = await waitForAutomaticExecutionStatus({
      dispatchId: serverId,
      pollIntervalMs: 1,
      beforeRead: async () => {
        const command = automaticExecutionCancellationCommand(control);
        if (!command) return;
        canceledDispatchIds.push(command.dispatchId);
        cancelAttempts += 1;
        if (cancelAttempts === 1) throw new Error("temporary reconnect");
      },
      readStatus: async () => {
        reads += 1;
        return reads === 1
          ? { dispatchId: serverId, state: "computer_running" }
          : { dispatchId: serverId, state: "canceled" };
      },
      onUpdate: (dispatch) => {
        if (dispatch.state === "computer_running") {
          control = requestAutomaticExecutionCancellation(control);
        }
      },
    });

    expect(terminal.state).toBe("canceled");
    expect(cancelAttempts).toBe(2);
    expect(canceledDispatchIds).toEqual([serverId, serverId]);
    expect(reads).toBe(2);
  });

  test("does not retry malformed server snapshots forever", async () => {
    let reads = 0;
    await expect(
      waitForAutomaticExecutionStatus({
        dispatchId: "exec:malformed",
        pollIntervalMs: 1,
        readStatus: async () => {
          reads += 1;
          throw new Error("Execution status response is malformed.");
        },
      }),
    ).rejects.toThrow("malformed");
    expect(reads).toBe(1);
  });

  test("rejects malformed and identity-swapped status snapshots", () => {
    expect(() =>
      readAutomaticExecutionDispatch({ dispatchId: "exec:partial" }),
    ).toThrow("malformed");
    expect(() =>
      readAutomaticExecutionDispatch(
        {
          dispatchId: "exec:other",
          idempotencyKey: "mobile:other",
          kind: "chat",
          ingress: "mobile",
          subject: "portable",
          conversationId: "conv:mobile",
          state: "cloud_running",
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
        },
        { dispatchId: "exec:expected" },
      ),
    ).toThrow("different dispatch identity");
  });

  test("treats a revoked pair as a pre-admission miss without changing work subject", () => {
    expect(
      isAutomaticExecutionPairCredentialRejection(
        new Error("This phone is not paired with that desktop"),
      ),
    ).toBe(true);
    expect(
      buildAutomaticExecutionAdmission({
        idempotencyKey: "mobile:revoked-portable",
        conversationId: "conv:portable",
        kind: "chat",
        prompt: "portable work",
      }).body.subject,
    ).toBe("portable");
    expect(
      buildAutomaticExecutionAdmission({
        idempotencyKey: "mobile:revoked-computer",
        conversationId: "conv:computer",
        kind: "chat",
        prompt: "computer work",
        workspace: "computer",
      }).body.subject,
    ).toBe("computer");
  });

  test("reuses one canonical conversation bootstrap identity across restarts", () => {
    const first = automaticExecutionConversationClientCreateId("cloud");
    const restarted = automaticExecutionConversationClientCreateId("cloud");
    expect(first).toBe("mobile-placement:cloud");
    expect(restarted).toBe(first);
    expect(
      automaticExecutionConversationClientCreateId("carplay computer"),
    ).toBe("mobile-placement:carplay-computer");
  });
});
