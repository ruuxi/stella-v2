import { useEffect, useState } from "react";
import type { EventRecord } from "@/features/chat/lib/event-transforms";

const EMPTY_EVENTS: EventRecord[] = [];

type UseScheduledEventsOptions = {
  conversationId: string | undefined;
  enabled: boolean;

  maxItems: number;
};

export function useScheduledEvents({
  conversationId,
  enabled,
  maxItems,
}: UseScheduledEventsOptions): EventRecord[] {
  const [events, setEvents] = useState<EventRecord[]>(EMPTY_EVENTS);

  useEffect(() => {
    if (!enabled || !conversationId || !window.electronAPI?.schedule) {
      setEvents(EMPTY_EVENTS);
      return;
    }

    let cancelled = false;
    const scheduleApi = window.electronAPI.schedule;

    const load = async () => {
      try {
        const nextEvents = await scheduleApi.listConversationEvents({
          conversationId,
          maxItems,
        });
        if (cancelled) {
          return;
        }
        setEvents(nextEvents as EventRecord[]);
      } catch {
        if (cancelled) {
          return;
        }
        setEvents(EMPTY_EVENTS);
      }
    };

    void load();
    const unsubscribe = scheduleApi.onUpdated(() => {
      void load();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [conversationId, enabled, maxItems]);

  return events;
}
