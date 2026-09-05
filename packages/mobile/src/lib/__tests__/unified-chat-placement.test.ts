import { describe, expect, test } from "bun:test";
import {
  automaticExecutionResultText,
  buildAutomaticExecutionAdmission,
  waitForAutomaticExecutionStatus,
} from "../execution-placement-core";
import {
  unifiedChatPlacementAdmission,
  unifiedChatPlacementStatusText,
} from "../unified-chat-placement";

const DISPATCH_ID = "exec:0c9a5ff1-9f92-4a37-9c0f-53a5cbb6e4f5";

/** Replay one server-side placement ladder through the chat's own observer. */
const observePlacement = async (states: string[]) => {
  const remaining = [...states];
  const statusTexts: string[] = [];
  const observedDispatchIds = new Set<string>();
  const terminal = await waitForAutomaticExecutionStatus({
    dispatchId: DISPATCH_ID,
    pollIntervalMs: 1,
    readStatus: async () => {
      const state = remaining.shift();
      if (!state) return null;
      return {
        dispatchId: DISPATCH_ID,
        state,
        ...(state === "completed"
          ? { resultJson: JSON.stringify({ finalText: "here you go" }) }
          : {}),
      };
    },
    onUpdate: (dispatch) => {
      observedDispatchIds.add(dispatch.dispatchId);
      const statusText = unifiedChatPlacementStatusText(dispatch);
      if (statusText) statusTexts.push(statusText);
    },
  });
  return { terminal, statusTexts, observedDispatchIds };
};

describe("the one chat's placement offer", () => {
  test("offers the computer without requiring it", () => {
    const admission = buildAutomaticExecutionAdmission(
      unifiedChatPlacementAdmission({
        dispatchId: "mobile:00000000000000001:one-chat",
        conversationId: "conv:one-chat",
        prompt: "what did I miss",
      }),
    );
    expect(admission.body.subject).toBe("computer");
    // "computer-use" would make a desktop that does not advertise it
    // ineligible; ordinary chat work must still reach that desktop.
    expect(admission.body.requiredCapabilities).toEqual(["chat"]);
    expect(admission.body.kind).toBe("chat");
    // Nothing in the envelope names a destination — the service decides.
    expect("transport" in admission.body).toBe(false);
    expect("runOn" in admission.body).toBe(false);
    expect("desktopDeviceId" in admission.body).toBe(false);
  });

  test("still offers the computer an image, which either placement can read", () => {
    const admission = buildAutomaticExecutionAdmission(
      unifiedChatPlacementAdmission({
        dispatchId: "mobile:00000000000000002:one-chat",
        conversationId: "conv:one-chat",
        prompt: "what is this",
        attachments: [{ path: "uploads/2026-08-29/receipt.png", kind: "image" }],
      }),
    );
    expect(admission.body.subject).toBe("computer");
    expect(admission.body.requiredCapabilities).toEqual([
      "chat",
      "attachments",
    ]);
    expect(admission.body.payload.attachments).toEqual([
      "uploads/2026-08-29/receipt.png",
    ]);
  });

  test("names the hosted subject for a document, which only the cloud can open", () => {
    const admission = buildAutomaticExecutionAdmission(
      unifiedChatPlacementAdmission({
        dispatchId: "mobile:00000000000000003:one-chat",
        conversationId: "conv:one-chat",
        prompt: "is this rent legal",
        attachments: [
          { path: "uploads/2026-08-29/receipt.png", kind: "image" },
          { path: "uploads/2026-08-29/lease.pdf", kind: "file" },
        ],
      }),
    );
    expect(admission.body.subject).toBe("cloud");
    // The envelope is unchanged: both placements would read the same paths.
    // Only the destination differs, and the user never sees it.
    expect(admission.body.payload.attachments).toEqual([
      "uploads/2026-08-29/receipt.png",
      "uploads/2026-08-29/lease.pdf",
    ]);
  });

  test("falls back to cloud on the same dispatch when no computer claims it", async () => {
    const { terminal, statusTexts, observedDispatchIds } =
      await observePlacement([
        "offering",
        "cloud_committed",
        "cloud_running",
        "completed",
      ]);
    expect(statusTexts).toEqual([]);
    expect(terminal.state).toBe("completed");
    expect(automaticExecutionResultText(terminal)).toBe("here you go");
    // One turn, one executor: a fallback never opens a second dispatch.
    expect([...observedDispatchIds]).toEqual([DISPATCH_ID]);
  });

  test("runs on the computer when it claims the offer", async () => {
    const { terminal, statusTexts, observedDispatchIds } =
      await observePlacement([
        "offering",
        "computer_claimed",
        "computer_accepted",
        "computer_running",
        "completed",
      ]);
    expect(statusTexts).toEqual([]);
    expect(terminal.state).toBe("completed");
    expect([...observedDispatchIds]).toEqual([DISPATCH_ID]);
  });

  test("keeps reconciliation invisible while continuing the same turn", async () => {
    const { statusTexts } = await observePlacement([
      "computer_running",
      "reconciliation_required",
      "computer_running",
      "completed",
    ]);
    expect(statusTexts).toEqual([]);
  });

  test("keeps a state the phone does not recognize off the surface", () => {
    expect(
      unifiedChatPlacementStatusText({
        dispatchId: DISPATCH_ID,
        state: "some_future_state",
      }),
    ).toBeUndefined();
  });
});
