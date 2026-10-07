/**
 * The two ways a delegated result gets back into a live voice session.
 *
 * Everything else about delegation is shared (`delegation-controller.ts`);
 * this is the whole of the protocol difference.
 *
 *   - **GPT-Live** has out-of-band channels: `session.commentary.append` for
 *     text it should say and `session.thinking.append` for things it should
 *     merely know. Nothing is owed back, so a superseded task is simply
 *     dropped — telling the model about work the user has moved on from would
 *     only invite it to mention it.
 *   - **Realtime** (OpenAI BYOK, xAI) has only the function-call loop. The
 *     result is the `function_call_output` for the call that asked, and
 *     `response.create` is what makes the model speak it. A superseded call
 *     still gets its output — an unanswered function call wedges the
 *     conversation — but no `response.create`, so the stale answer stays
 *     unspoken while remaining visible as context.
 */

import type { DelegationChannel } from "./delegation-controller";
import type { SessionAppendChannel } from "./session-append-channel";

export const createAppendDelegationChannel = (
  appends: SessionAppendChannel,
): DelegationChannel => ({
  announceStart: (taskId, text) => {
    appends.append("thinking", text, taskId);
  },
  reportProgress: (taskId, text) => {
    appends.append("thinking", text, taskId);
  },
  complete: (taskId, outcome) => {
    if (outcome.kind === "superseded") return;
    appends.append("commentary", outcome.text, taskId);
  },
});

export const createFunctionCallDelegationChannel = (
  send: (event: Record<string, unknown>) => void,
): DelegationChannel => ({
  complete: (taskId, outcome) => {
    send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: taskId,
        output: outcome.text,
      },
    });
    if (outcome.kind === "superseded") return;
    send({ type: "response.create" });
  },
});
