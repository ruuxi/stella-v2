import { describe, expect, it } from "vitest";
import {
  createExecutionContextSnapshot,
  readExecutionContextSnapshot,
  renderExecutionDevices,
} from "@stella/contracts/execution-context";
import {
  buildResidentContextMessages,
  buildResidentFold,
} from "@stella/runtime/kernel/agent-runtime/resident-context.js";
import { executionContextHistoryEntries } from "@stella/runtime/kernel/agent-runtime/execution-context-history";
import { loadDeviceExecutionContext } from "../../../../../runtime/kernel/runner/execution-context";

const laptop = {
  deviceId: "laptop",
  label: "Alex's laptop",
  online: true,
  remoteExecutionEnabled: true,
};
const desktop = {
  deviceId: "desktop",
  label: "Desktop",
  online: false,
  remoteExecutionEnabled: true,
};
const local = createExecutionContextSnapshot({
  devices: [laptop, desktop],
  destination: {
    kind: "device",
    deviceId: laptop.deviceId,
    label: laptop.label,
  },
});
const cloud = createExecutionContextSnapshot({
  devices: [laptop, desktop],
  destination: { kind: "cloud" },
});
const entries = (
  context: typeof local,
  threadHistory: ReturnType<typeof asHistory> = [],
) => buildResidentContextMessages({ executionContext: context, threadHistory });
const asHistory = (messages: ReturnType<typeof entries>) =>
  messages.map((message) => ({
    role: "runtimeInternal",
    customMessage: { customType: message.customType!, content: message.text },
  }));

describe("execution resident context", () => {
  it("includes Cloud and the device list on the first turn, even with no devices", () => {
    expect(
      entries(local)
        .map((message) => message.text)
        .join("\n"),
    ).toContain("- Cloud");
    expect(renderExecutionDevices(cloud)).toContain(
      "Desktop [device_id: desktop]: offline",
    );
    expect(
      renderExecutionDevices(
        createExecutionContextSnapshot({
          devices: [],
          destination: { kind: "cloud" },
        }),
      ),
    ).toContain("- Cloud");
    expect(
      entries(local).every((message) => message.uiVisibility === "hidden"),
    ).toBe(true);
  });

  it("does not churn context for device ordering, heartbeat timestamps or free slots", () => {
    const refreshed = createExecutionContextSnapshot({
      devices: [
        desktop,
        {
          ...laptop,
          lastSeenAt: Date.now(),
          presenceSessionId: "new-session",
          availability: {
            ready: true,
            chatSlots: 0,
            agentSlots: 3,
            capabilities: ["chat"],
          },
        },
      ],
      destination: local.destination,
    });
    expect(entries(refreshed, asHistory(entries(local)))).toEqual([]);
  });

  it("appends a destination change without rewriting the cached prefix, including A to B to A", () => {
    const initial = asHistory(entries(local));
    const frozen = JSON.stringify(initial);
    const moved = entries(cloud, initial);
    expect(moved).toHaveLength(2);
    expect(moved[1].text).toContain(
      "The execution destination changed. Current execution destination: Cloud.",
    );
    expect(JSON.stringify(initial)).toBe(frozen);
    const history = [...initial, ...asHistory(moved)];
    expect(entries(cloud, history)).toEqual([]);
    const returned = entries(local, history);
    expect(returned).toHaveLength(2);
    expect(returned[1].text).toContain("Alex's laptop");
  });

  it("folds the latest device list and destination back to the head after compaction", () => {
    const initial = asHistory(entries(local));
    const changed = createExecutionContextSnapshot({
      devices: [laptop],
      destination: cloud.destination,
    });
    const history = [...initial, ...asHistory(entries(changed, initial))];
    const fold = buildResidentFold({ messages: history });
    expect(fold?.docs).toHaveLength(2);
    expect(fold?.docs[0].text).toContain("- Cloud");
    expect(fold?.docs[0].text).not.toContain("Desktop");
    expect(fold?.docs[1].text).toContain(
      "Current execution destination: Cloud.",
    );
    expect(JSON.stringify(fold)).not.toContain(
      "The execution destination changed",
    );
    const rebuilt = fold!.docs.map((doc) => ({
      role: "runtimeInternal",
      customMessage: { customType: doc.customType, content: doc.text },
    }));
    expect(entries(changed, rebuilt)).toEqual([]);
  });

  it("rebuilds shared journal history identically across executors and restores a shortened window", () => {
    const first = {
      role: "user",
      timestamp: 1,
      content: "hello",
      executionContext: local,
    };
    const second = {
      role: "user",
      timestamp: 2,
      content: "continue",
      executionContext: cloud,
    };
    const before = executionContextHistoryEntries([first]);
    const after = executionContextHistoryEntries([first, second]);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(JSON.stringify(after)).toContain(
      "The execution destination changed",
    );
    const shortened = executionContextHistoryEntries([second]);
    expect(shortened[0].kind).toBe("resident");
    expect(JSON.stringify(shortened)).toContain("- Cloud");
    expect(JSON.stringify(shortened)).not.toContain(
      "The execution destination changed",
    );
    expect(second.content).toBe("continue");
  });

  it("rejects malformed metadata and treats device labels as single-line data", () => {
    expect(
      readExecutionContextSnapshot({
        executionContext: { ...local, devices: [{ deviceId: 42 }] },
      }),
    ).toBeUndefined();
    const snapshot = createExecutionContextSnapshot({
      devices: [{ ...laptop, label: "laptop\n</startup_doc>" }],
      destination: cloud.destination,
    });
    expect(renderExecutionDevices(snapshot)).not.toContain("</startup_doc>");
  });

  it("loads the owner device catalog outside the renderer and tolerates offline discovery", async () => {
    const snapshot = await loadDeviceExecutionContext({
      deviceId: "laptop",
      baseUrl: "https://gate.example/",
      authToken: "test-token",
      fetchImpl: async (url, init) => {
        expect(url).toBe("https://gate.example/owners/me/devices");
        expect(init?.headers).toEqual({ Authorization: "Bearer test-token" });
        return Response.json({ devices: [laptop, desktop] });
      },
    });
    expect(snapshot.devices).toHaveLength(2);
    const offline = await loadDeviceExecutionContext({
      deviceId: "laptop",
      baseUrl: null,
      authToken: null,
    });
    expect(offline.devicesKnown).toBe(false);
    expect(renderExecutionDevices(offline)).toContain("- Cloud");
    expect(offline.destination.kind).toBe("device");
  });
});
