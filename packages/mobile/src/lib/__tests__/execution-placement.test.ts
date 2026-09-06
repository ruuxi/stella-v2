import { describe, expect, test } from "bun:test";
import {
  automaticExecutionResultText,
  automaticExecutionCancellationCommand,
  automaticExecutionConversationClientCreateId,
  bindAutomaticExecutionAdmission,
  buildAutomaticExecutionAdmission,
  isAutomaticExecutionPairCredentialRejection,
  readAutomaticExecutionDispatch,
  requestAutomaticExecutionCancellation,
  waitForAutomaticExecutionStatus,
} from "../execution-placement-core";

describe("automatic mobile execution admission", () => {
  test("carries an explicit cloud model while stripping it from Computer dispatch", () => {
    const input = {
      idempotencyKey: "msg:model",
      conversationId: "conv:model",
      kind: "chat" as const,
      prompt: "hello",
      execution: { engine: "stella" as const, provider: "stella" as const, model: "stella/sonnet", reasoningEffort: "high" as const },
    };
    const cloud = buildAutomaticExecutionAdmission({ ...input, target: { mode: "cloud" } });
    expect(cloud.body.payload.execution).toEqual(input.execution);
    const computer = buildAutomaticExecutionAdmission({ ...input, target: { mode: "device", deviceId: "desktop" } });
    expect(computer.body.payload.execution).toBeUndefined();
  });

  test("defaults an unstated subject to portable work", () => {
    const admission = buildAutomaticExecutionAdmission({
      idempotencyKey: "msg:01JDEFAULT",
      conversationId: "conv:default",
      kind: "chat",
      prompt: "what is on my calendar",
    });
    expect(admission.body.subject).toBe("portable");
    expect("workspace" in admission.body).toBe(false);
  });

  test("hashes the exact payload bytes into the pair-proof challenge", () => {
    const admission = buildAutomaticExecutionAdmission({
      idempotencyKey: "msg:01JPLACEMENT",
      conversationId: "conv:one",
      kind: "chat",
      prompt: "  hello  ",
    });
    expect(admission.payloadJson).toBe(
      JSON.stringify({
        schemaVersion: 1,
        prompt: "hello",
        conversationId: "conv:one",
        clientMsgId: "msg:01JPLACEMENT",
      }),
    );
    expect(admission.body.payload.prompt).toBe("hello");
    expect(/^[a-f0-9]{64}$/.test(admission.payloadHash)).toBe(true);
    expect(admission.challenge).toBe(
      [
        "execution-placement-v1",
        admission.body.idempotencyKey,
        admission.body.conversationId,
        admission.payloadHash,
        "chat",
        "portable",
        "automatic",
        "",
      ].join(":"),
    );
    expect("transport" in admission.body).toBe(false);
    expect("runOn" in admission.body).toBe(false);
    expect("desktopDeviceId" in admission.body).toBe(false);
  });

  test("opts new chat sends into journal identity without changing legacy retry bytes", () => {
    const legacy = { idempotencyKey: "mobile-retry", conversationId: "conv", kind: "chat" as const, prompt: "same" };
    const previous = buildAutomaticExecutionAdmission(legacy);
    expect(previous.body.payload.userMessageEventId).toBeUndefined();
    const next = buildAutomaticExecutionAdmission({ ...legacy, userMessageEventId: "mobile-retry" });
    expect(next.body.payload.userMessageEventId).toBe("mobile-retry");
    expect(next.payloadHash).not.toBe(previous.payloadHash);
    expect(buildAutomaticExecutionAdmission(legacy).payloadHash).toBe(previous.payloadHash);
  });

  test("carries an explicit computer subject and binds it into the challenge", () => {
    const admission = buildAutomaticExecutionAdmission({
      idempotencyKey: "agent:01JPLACEMENT",
      conversationId: "conv:two",
      kind: "agent",
      prompt: "organize my desktop",
      subject: "computer",
      requiredCapabilities: ["computer-use", "local-files"],
    });
    expect(admission.body.subject).toBe("computer");
    expect("workspace" in admission.body).toBe(false);
    expect(admission.challenge.endsWith(":agent:computer:automatic:")).toBe(
      true,
    );
    expect(admission.body.requiredCapabilities).toEqual([
      "agent",
      "computer-use",
      "local-files",
    ]);
  });

  test("binds an exact computer choice into the signed request", () => {
    const admission = buildAutomaticExecutionAdmission({
      idempotencyKey: "mobile:exact-computer",
      conversationId: "conv:exact-computer",
      kind: "chat",
      prompt: "run this there",
      target: { mode: "device", deviceId: "desktop-windows" },
    });
    expect(admission.body).toMatchObject({
      targetMode: "device",
      targetDeviceId: "desktop-windows",
    });
    expect(admission.challenge.endsWith(":device:desktop-windows")).toBe(true);
  });

  test("binds a cloud override without a desktop identity", () => {
    const admission = buildAutomaticExecutionAdmission({
      idempotencyKey: "mobile:exact-cloud",
      conversationId: "conv:exact-cloud",
      kind: "chat",
      prompt: "run this in cloud",
      target: { mode: "cloud" },
    });
    expect(admission.body.targetMode).toBe("cloud");
    expect("targetDeviceId" in admission.body).toBe(false);
    expect(admission.challenge.endsWith(":cloud:")).toBe(true);
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
    const restarted = bindAutomaticExecutionAdmission(stoppedBeforeAdmission, {
      dispatchId: serverId,
      idempotencyKey: clientId,
    });
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

  test("recognizes the server invalid-phone-credential refusal for automatic cloud fallback", () => {
    expect(isAutomaticExecutionPairCredentialRejection(new Error("This phone credential is invalid."))).toBe(true);
    expect(isAutomaticExecutionPairCredentialRejection(new Error("This phone credential is incomplete."))).toBe(true);
    expect(isAutomaticExecutionPairCredentialRejection(new Error("Request timed out."))).toBe(false);
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
        subject: "computer",
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
