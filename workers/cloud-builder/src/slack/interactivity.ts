/** Block Kit actions: the progress message's Stop button. */

import { ORCHESTRATOR_INTERNAL_ORIGIN } from "../build-session/shared/keys.js";
import { slackTry } from "./api.js";
import { linkedOwner, loadInstallation, threadOwnerOf } from "./store.js";

type BlockAction = { action_id?: string; value?: string };

type InteractionPayload = {
  type?: string;
  team?: { id?: string };
  user?: { id?: string };
  channel?: { id?: string };
  message?: { ts?: string; thread_ts?: string };
  actions?: BlockAction[];
};

export const STOP_ACTION = "stella_stop";

export const stopValue = (conversationId: string, turnId: string): string =>
  JSON.stringify({ c: conversationId, t: turnId });

export const handleSlackInteraction = async (
  env: Cloudflare.Env,
  payload: InteractionPayload,
): Promise<void> => {
  if (payload.type !== "block_actions") return;
  const action = payload.actions?.[0];
  if (action?.action_id !== STOP_ACTION || !action.value) return;
  const teamId = payload.team?.id;
  const userId = payload.user?.id;
  if (!teamId || !userId) return;
  let target: { c?: unknown; t?: unknown };
  try {
    target = JSON.parse(action.value) as { c?: unknown; t?: unknown };
  } catch {
    return;
  }
  if (typeof target.c !== "string" || typeof target.t !== "string") return;
  const installation = await loadInstallation(env, teamId);
  if (!installation) return;
  const ownerId = await linkedOwner(env, teamId, userId);
  const threadOwner = await threadOwnerOf(env, target.c);
  if (!ownerId || ownerId !== threadOwner) {
    if (payload.channel?.id) {
      await slackTry(installation.botToken, "chat.postEphemeral", {
        channel: payload.channel.id,
        user: userId,
        ...(payload.message?.thread_ts
          ? { thread_ts: payload.message.thread_ts }
          : {}),
        text: "Only the person who asked can stop this.",
      });
    }
    return;
  }
  const response = await env.ORCHESTRATOR_SESSIONS.getByName(target.c).fetch(
    `${ORCHESTRATOR_INTERNAL_ORIGIN}/slack/stop`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ownerId,
        hostTurnId: target.t,
        slackUserId: userId,
      }),
    },
  );
  console.log(
    JSON.stringify({ event: "slack_stop_pressed", status: response.status }),
  );
  await response.body?.cancel().catch(() => undefined);
};
