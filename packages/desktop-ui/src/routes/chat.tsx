import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { ChatApp } from "@/app/chat/App";
import { readActiveConversationIdCache } from "@/features/chat/services/active-conversation-cache";

const ChatSearch = z.object({
  c: z.string().optional(),
});

export const Route = createFileRoute("/chat")({
  validateSearch: ChatSearch,

  beforeLoad: async ({ search }) => {
    if (search.c) return;

    const cached = readActiveConversationIdCache();
    if (cached) {
      throw redirect({ to: "/chat", search: { c: cached }, replace: true });
    }

    const api = window.electronAPI?.localChat;
    if (!api) return;
    let activeConversationId: string | null = null;
    try {
      activeConversationId = await api.getOrCreateDefaultConversationId();
    } catch {
      activeConversationId = null;
    }
    if (activeConversationId) {
      throw redirect({
        to: "/chat",
        search: { c: activeConversationId },
        replace: true,
      });
    }
  },
  component: ChatApp,
});
