import { describe, expect, test } from "vitest";
import {
  cloudAgentActivationCard,
  cloudAgentTerminalCard,
} from "../../../../../workers/cloud-builder/src/cloud-agent-lifecycle";
import {
  decodeRecord,
  type JournalRecord,
} from "../../../src/features/cloud/conversation-protocol";
import { journalRecordsToMessageRecords } from "../../../src/features/cloud/journal-message-records";
import { journalRecordsToCloudActivityEvents } from "../../../src/features/cloud/journal-activity-files";
import { buildBackgroundTaskLifecycleIndex } from "../../../src/features/chat/lib/background-task-lifecycle";

const control = {
  threadId: "thread-1",
  attemptGeneration: 1,
  threadUpdatedAt: 30,
  status: "running",
  description: "Write report",
} as const;
const activation = (attempt: number, turnId: string, steered = false) =>
  cloudAgentActivationCard({
    parentTurnId: turnId,
    toolCallId: `call-${attempt}-${steered}`,
    outcome: {
      kind: attempt === 1 ? "spawn_agent" : "send_input",
      fingerprint: "test",
      control: { ...control, attemptGeneration: attempt },
      ...(steered ? { disposition: "steered" } : {}),
    },
  });
const row = (card: unknown, seq: number, turnId: string): JournalRecord => {
  const parsed = decodeRecord({
    kind: "card",
    card,
    seq,
    turnId,
    createdAtMs: seq * 10,
  });
  if (!parsed) throw new Error("Worker lifecycle card failed client decode");
  return parsed;
};
const message = (
  seq: number,
  turnId: string,
  role: "user" | "assistant",
  hidden = false,
): JournalRecord => ({
  kind: "message",
  seq,
  turnId,
  createdAtMs: seq * 10,
  role,
  hidden,
  payload: { content: role === "user" ? "Please work" : "I started it" },
});

describe("cloud lifecycle journal", () => {
  test("worker records decorate the spawning reply and complete the same card across replay and follow-ups", () => {
    const start = row(activation(1, "root-1"), 3, "root-1");
    const records = [
      message(1, "root-1", "user"),
      message(2, "root-1", "assistant"),
      start,
    ];
    const spawned = journalRecordsToMessageRecords(records);
    expect(spawned[1]?.toolEvents[0]?.type).toBe("agent-started");
    expect(
      [
        ...buildBackgroundTaskLifecycleIndex(
          journalRecordsToCloudActivityEvents(records),
        ).byStartEventId.values(),
      ][0]?.status,
    ).toBe("running");
    records.push(
      message(4, "wake-1", "user", true),
      row(
        cloudAgentTerminalCard({
          ...control,
          status: "completed",
          lifecycleReport: "The report is ready.",
        }),
        5,
        "wake-1",
      ),
    );
    records.push(
      message(6, "root-2", "user"),
      message(7, "root-2", "assistant"),
      row(activation(2, "root-2"), 8, "root-2"),
    );
    records.push(row(activation(2, "root-2", true), 9, "root-2"));
    records.push(
      message(10, "wake-2", "user", true),
      row(
        cloudAgentTerminalCard({
          ...control,
          attemptGeneration: 2,
          status: "failed",
          lifecycleReport: "Provider failed",
        }),
        11,
        "wake-2",
      ),
    );
    const activities = journalRecordsToCloudActivityEvents(records);
    const messages = journalRecordsToMessageRecords(records);
    expect(
      messages
        .flatMap((entry) => entry.toolEvents)
        .filter((event) => event.type.startsWith("agent-")),
    ).toEqual(activities);
    const index = buildBackgroundTaskLifecycleIndex([
      ...activities,
      ...activities,
    ]);
    const states = [...index.byStartEventId.values()];
    expect(states).toHaveLength(2);
    expect(states[0]).toMatchObject({
      status: "completed",
      isFollowUp: false,
      completion: { summary: "The report is ready." },
    });
    expect(states[1]).toMatchObject({
      status: "failed",
      isFollowUp: true,
      progressText: "Continuing with your latest instruction",
      errorText: "Provider failed",
    });
  });

  test("cancel and incomplete payloads are handled without inventing a completion", () => {
    expect(cloudAgentTerminalCard(control)).toBeNull();
    const canceled = row(
      cloudAgentTerminalCard({
        ...control,
        status: "canceled",
        lifecycleReport: "Stopped",
      }),
      2,
      "wake",
    );
    expect(journalRecordsToCloudActivityEvents([canceled])[0]).toMatchObject({
      type: "agent-canceled",
      payload: { error: "Stopped" },
    });
    expect(
      decodeRecord({
        kind: "card",
        seq: 1,
        turnId: "root",
        card: {
          type: "agent-lifecycle",
          eventId: "bad",
          event: {
            type: "agent-completed",
            payload: { agentId: "a", attemptGeneration: 1 },
          },
        },
      }),
    ).toBeNull();
  });
});
