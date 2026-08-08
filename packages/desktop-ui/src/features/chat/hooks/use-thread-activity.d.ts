import type { DesktopThreadActivityRecord } from "@/features/chat/thread-activity-types";

export declare const useThreadActivity: (conversationId?: string | null) => {
  records: DesktopThreadActivityRecord[];
  isInitialLoading: boolean;
};
