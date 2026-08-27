import { useT } from "@/shared/i18n";

export function AgentAssistantUpdates({
  messages,
  max,
}: {
  messages: readonly string[];
  max?: number;
}) {
  const t = useT();
  const newestFirst = [...messages].reverse();
  const visible =
    typeof max === "number" ? newestFirst.slice(0, max) : newestFirst;
  if (visible.length === 0) return null;

  return (
    <ul
      className="chat-workspace-strip__task-progress"
      aria-live="polite"
      aria-label={t("shell.agentProgress.recentAgentMessages")}
    >
      {visible.map((message, index) => (
        <li
          key={`${messages.length - index}:${message}`}
          className="chat-workspace-strip__task-progress-item"
          data-newest={index === 0 ? "true" : undefined}
        >
          {message}
        </li>
      ))}
    </ul>
  );
}
