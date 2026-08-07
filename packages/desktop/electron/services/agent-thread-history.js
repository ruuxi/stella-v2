export const listAgentThreadMessages = (store, args = {}) => {
  const rawThreadId = Reflect.get(args, "threadId");
  const threadId = typeof rawThreadId === "string" ? rawThreadId.trim() : "";
  if (!threadId) throw new Error("threadId is required.");
  const rawLimit = Reflect.get(args, "limit");
  const limit = Math.min(
    300,
    Math.max(1, Math.floor(typeof rawLimit === "number" ? rawLimit : 200)),
  );
  const threadMessages = store.loadThreadMessages(threadId, limit);
  const lifecycleById = new Map(
    store
      .listLifecycleEventsByIds(
        threadMessages.flatMap((message) => {
          const eventId = message.customMessage?.eventId;
          return message.customMessage?.customType === "runtime.task_lifecycle" &&
            eventId
            ? [eventId]
            : [];
        }),
      )
      .map((event) => [event._id, event]),
  );
  const projected = threadMessages
    .flatMap((message) => {
      if (message.payload?.role === "assistant") {
        const content = message.payload.content
          .flatMap((block) =>
            block.type === "text" && block.text.trim() ? [block.text] : [],
          )
          .join("\n\n")
          .trim();
        return content
          ? [
              {
                ...(message.entryId ? { entryId: message.entryId } : {}),
                timestamp: message.timestamp,
                role: "assistant",
                content,
              },
            ]
          : [];
      }
      if (message.payload?.role === "toolResult") return [];
      if (message.customMessage) {
        const lifecycleEvent = message.customMessage.eventId
          ? lifecycleById.get(message.customMessage.eventId)
          : undefined;
        return lifecycleEvent
          ? [
              {
                ...(message.entryId ? { entryId: message.entryId } : {}),
                timestamp: message.timestamp,
                role: "lifecycle",
                content: "",
                lifecycleEvent,
              },
            ]
          : [];
      }
      const content = message.content.trim();
      if (!content || (message.role !== "assistant" && message.role !== "user")) {
        return [];
      }
      return [
        {
          ...(message.entryId ? { entryId: message.entryId } : {}),
          timestamp: message.timestamp,
          role: message.role,
          content,
        },
      ];
    });
  const authored = new Set(
    projected.map((message) => `${message.role}\0${message.content.trim()}`),
  );
  const agentRecord = store.getAgentRecord(threadId);
  const storedPrompt = agentRecord ? Reflect.get(agentRecord, "prompt") : undefined;
  if (agentRecord && typeof storedPrompt === "string" && storedPrompt.trim()) {
    const content = storedPrompt.trim();
    const key = `user\0${content}`;
    if (!authored.has(key)) {
      authored.add(key);
      const promptCreatedAt = Reflect.get(agentRecord, "promptCreatedAt");
      projected.push({
        entryId: `${threadId}:durable-initial-instruction`,
        timestamp:
          typeof promptCreatedAt === "number"
            ? promptCreatedAt
            : agentRecord.startedAt,
        role: "user",
        content,
      });
    }
  }
  if (agentRecord?.parentAgentId) {
    const parentRecord = store.getAgentRecord(agentRecord.parentAgentId);
    if (parentRecord?.conversationId === agentRecord.conversationId) {
      const parentRows = store.loadThreadMessages(agentRecord.parentAgentId);
      const successfulCalls = new Map();
      for (const row of parentRows) {
        const payload = row.payload;
        if (
          payload?.role !== "toolResult" ||
          payload.isError ||
          (payload.toolName !== "spawn_agent" && payload.toolName !== "send_input")
        ) {
          continue;
        }
        const text = payload.content
          .flatMap((block) =>
            block.type === "text" && block.text.trim() ? [block.text] : [],
          )
          .join("\n");
        try {
          const result = JSON.parse(text);
          if (result.thread_id === threadId) {
            successfulCalls.set(payload.toolCallId, payload.toolName);
          }
        } catch {
          // Only structured successful results prove exact child ownership.
        }
      }
      for (const row of parentRows) {
        if (row.payload?.role !== "assistant") continue;
        for (const [index, block] of row.payload.content.entries()) {
          if (block.type !== "toolCall") continue;
          const toolName = successfulCalls.get(block.id);
          if (!toolName || toolName !== block.name) continue;
          const content =
            toolName === "spawn_agent"
              ? typeof block.arguments.prompt === "string"
                ? block.arguments.prompt.trim()
                : ""
              : block.arguments.thread_id === threadId &&
                  typeof block.arguments.message === "string"
                ? block.arguments.message.trim()
                : "";
          const key = `user\0${content}`;
          if (!content || authored.has(key)) continue;
          authored.add(key);
          projected.push({
            entryId: `${row.entryId ?? block.id}:recovered-input:${index}`,
            timestamp: row.timestamp,
            role: "user",
            content,
          });
        }
      }
    }
  }
  if (agentRecord?.result?.trim()) {
    const content = agentRecord.result.trim();
    const key = `assistant\0${content}`;
    if (!authored.has(key)) {
      projected.push({
        entryId: `${threadId}:durable-final-result`,
        timestamp: agentRecord.completedAt ?? agentRecord.updatedAt,
        role: "assistant",
        content,
      });
    }
  }
  const seenLifecycleIds = new Set(
    projected.flatMap((message) =>
      message.role === "lifecycle" && message.lifecycleEvent
        ? [message.lifecycleEvent._id]
        : [],
    ),
  );
  for (const entry of store.listThreadLifecycleEntries(threadId, limit)) {
    if (seenLifecycleIds.has(entry.event._id)) continue;
    seenLifecycleIds.add(entry.event._id);
    projected.push({
      entryId: entry.entryId,
      timestamp: entry.event.timestamp,
      role: "lifecycle",
      content: "",
      lifecycleEvent: entry.event,
    });
  }
  // Array.sort is stable: equal timestamps retain durable append order from
  // each source instead of being scrambled by opaque entry IDs.
  return projected.sort((a, b) => a.timestamp - b.timestamp);
};
