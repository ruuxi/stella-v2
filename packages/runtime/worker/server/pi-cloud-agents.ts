/**
 * Cloud agents of a conversation stored in the cloud, for the pi-durable
 * chat that runs it on this computer (`StellaAgentsHost.remote`). Each runs
 * as a whole in the conversation's object, so it keeps working while this
 * computer sleeps: a `piAgent` turn starts it, messages it or pauses it, and
 * its reports come back through the journal (`desktop-journal`).
 */
import { createHash } from "node:crypto";
import type { RemoteAgentHost } from "@stella/agent/stella/agents";
import {
  TURN_PLANE_PROTOCOL,
  TURN_PROMPT_MAX_CHARS,
  type CloudPiAgentRequest,
} from "@stella/contracts/turn-plane/turn-start";
import type { OpenSession } from "./sessions.js";

const TURN_TIMEOUT_MS = 30_000;

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "agent";

export const cloudAgentsFor = (
  session: OpenSession,
  conversationId: string,
): RemoteAgentHost | undefined => {
  // A conversation kept on this computer has no object to run them in.
  if (conversationId.startsWith("local_")) return undefined;
  const deviceId = session.config.deviceId;
  const turn = async (piAgent: CloudPiAgentRequest, prompt: string, key: string): Promise<void> => {
    const auth = session.runnerCell.get()?.getStellaSiteAuth();
    if (!auth) throw new Error("Sign in to run agents in the cloud.");
    if (prompt.length > TURN_PROMPT_MAX_CHARS) {
      throw new Error(`A cloud agent's brief or message is at most ${TURN_PROMPT_MAX_CHARS} characters.`);
    }
    const response = await fetch(
      `${auth.baseUrl.replace(/\/+$/, "")}/conversations/${encodeURIComponent(conversationId)}/turns`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${auth.authToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          protocol: TURN_PLANE_PROTOCOL,
          // Stable per call, so a retried start is the same turn.
          clientMsgId: `pia:${digest(`${conversationId}\0${key}`).slice(0, 40)}`,
          prompt,
          lane: "chat",
          source: "desktop",
          piAgent,
        }),
        signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
      },
    );
    if (response.ok) return;
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `The cloud did not take the agent's turn (${response.status}).`);
  };
  return {
    start: async ({ key, description, prompt }) => {
      // Chosen here, so this computer and the cloud name the agent alike.
      const threadId = `${slug(description)}-${digest(`${conversationId}\0${key}`).slice(0, 6)}`;
      await turn({ op: "start", threadId, description, originDeviceId: deviceId }, prompt, `start:${key}`);
      return { threadId };
    },
    message: async ({ key, threadId, message }) => {
      await turn({ op: "message", threadId, originDeviceId: deviceId }, message, `message:${key}`);
    },
    pause: async (threadId) => {
      await turn({ op: "pause", threadId, originDeviceId: deviceId }, "Pause.", `pause:${threadId}:${Date.now()}`);
    },
  };
};
