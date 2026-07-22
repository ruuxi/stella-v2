import assert from "node:assert/strict";
import { buildActivityTasks } from "../../desktop-ui/src/features/chat/lib/event-transforms.ts";
import { buildBackgroundTaskLifecycleIndex } from "../../desktop-ui/src/features/chat/lib/background-task-lifecycle.ts";

const completedSuccess = buildActivityTasks(
  [
    {
      threadId: "scan-x-for-what-ai-builders-are-discussing",
      conversationId: "live-demo",
      agentType: "general",
      description: "Resume the narrowed X scan after Stella restarted",
      status: "running",
      attemptGeneration: 4,
      rootRunId: "restart-run",
      startedAt: 100,
      updatedAt: 200,
    },
  ],
  {
    "scan-x-for-what-ai-builders-are-discussing": {
      status: "completed",
      attemptGeneration: 4,
      runId: "restart-run",
      observedAtMs: 300,
      statusText: "exec_command exited 0",
      toolActivity: {
        toolName: "exec_command",
        label: "exec_command exited 0",
        state: "completed",
        exitCode: 0,
      },
    },
  },
)[0];

assert.equal(completedSuccess.status, "completed");
assert.equal(
  completedSuccess.description,
  "Resume the narrowed X scan after Stella restarted",
);
assert.notEqual(completedSuccess.description, "exec_command exited 0");

const manager = buildActivityTasks(
  [
    {
      threadId: "manager",
      conversationId: "manager-demo",
      agentType: "manager",
      description: "Coordinate the live demo agents",
      status: "completed",
      attemptGeneration: 2,
      rootRunId: "older-run",
      startedAt: 100,
      completedAt: 200,
      updatedAt: 200,
    },
  ],
  {
    manager: {
      status: "running",
      attemptGeneration: 3,
      runId: "newer-run",
      observedAtMs: 300,
      statusText: "exec_command exited 0",
    },
  },
)[0];

assert.equal(manager.status, "running");
assert.equal(manager.description, "Coordinate the live demo agents");

const followUpLifecycle = buildBackgroundTaskLifecycleIndex([
  {
    _id: "follow-up-start",
    timestamp: 100,
    type: "agent-started",
    payload: {
      agentId: "scan-x-for-what-ai-builders-are-discussing",
      description: "Resume the narrowed X scan after Stella restarted",
      statusText: "Resume the narrowed X scan after Stella restarted",
      isFollowUp: true,
      attemptGeneration: 4,
    },
  },
  {
    _id: "tool-completed",
    timestamp: 200,
    type: "agent-progress",
    payload: {
      agentId: "scan-x-for-what-ai-builders-are-discussing",
      statusText: "exec_command exited 0",
      attemptGeneration: 4,
    },
  },
  {
    _id: "agent-completed",
    timestamp: 300,
    type: "agent-completed",
    payload: {
      agentId: "scan-x-for-what-ai-builders-are-discussing",
      result: "Finished the narrowed scan.",
      attemptGeneration: 4,
    },
  },
]);

assert.equal(
  followUpLifecycle.byStartEventId.get("follow-up-start")?.title,
  "Resume the narrowed X scan after Stella restarted",
);

const legacy = buildActivityTasks(
  [
    {
      threadId: "legacy-opaque-row",
      conversationId: "legacy",
      agentType: "general",
      description: "Task",
      status: "running",
      attemptGeneration: 1,
      startedAt: 100,
      updatedAt: 200,
    },
  ],
  {
    "legacy-opaque-row": {
      status: "completed",
      attemptGeneration: 1,
      observedAtMs: 300,
      statusText: "Finished Read",
    },
  },
)[0];

assert.equal(legacy.description, "Task");
console.log(
  "Activity titles preserve explicit descriptions across tool completion.",
);
