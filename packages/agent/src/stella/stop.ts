/**
 * Stop: abort what a conversation is running, and leave the stop in its
 * transcript. pi-durable records a stopped reply only when one had started
 * streaming (it keeps the partial as an `aborted` assistant entry). A Stop
 * before the reply began, or while its tools ran, would leave no trace, and
 * every reader of the transcript (the journal mirror, the chat views, the
 * chat log) would take the turn for one that completed. So the same `aborted`
 * assistant entry, with no content, is written first whenever pi will not
 * write one. Assistants that stopped are never model context, so it changes
 * nothing the model reads.
 */
import type { Context } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, LiveDoc, type Conversation, type Harness } from "@earendil-works/pi-durable";

export async function stopStella(harness: Harness, root: Conversation, context: Context): Promise<void> {
  const { model } = await root.agent(context);
  await harness.commit(async (tx) => {
    const live = await tx.doc(LiveDoc, root.id);
    // Nothing running, or a reply streaming that pi keeps as the stopped one.
    if (!live.run || live.generation?.message) return undefined;
    const stopped: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "stella-stop",
      provider: model?.provider ?? "stella",
      model: model?.modelId ?? "stopped",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "aborted",
      timestamp: Date.now(),
    };
    await tx.appendEntry(root.id, { kind: AssistantEntry.kind, model: [stopped] });
    return undefined;
  }, context);
  await root.abort(context);
}
