export type AlertFields = Record<string, string | number>;

const formatAlert = (text: string, fields?: AlertFields): string => {
  const lines = [text.trim()];
  if (fields) {
    for (const [name, value] of Object.entries(fields)) {
      lines.push(`${name}: ${String(value)}`);
    }
  }
  return lines.filter(Boolean).join("\n");
};

export const postAlert = async (
  text: string,
  fields?: AlertFields,
): Promise<void> => {
  const webhookUrl = process.env.STELLA_ALERT_WEBHOOK_URL?.trim();
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: formatAlert(text, fields) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Alerts must never break the state change or service route that emitted them.
  }
};
