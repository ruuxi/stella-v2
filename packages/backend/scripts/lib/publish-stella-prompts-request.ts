export type PublishPromptInput = { id: string; content: string };

export const publishStellaPromptsRequest = async (args: {
  endpoint: URL;
  token: string;
  revision: string;
  prompts: readonly PublishPromptInput[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<string> => {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    args.timeoutMs ?? 10_000,
  );
  try {
    const response = await (args.fetchImpl ?? fetch)(args.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ revision: args.revision, prompts: args.prompts }),
      signal: controller.signal,
    });
    const responseBody = await response.text();
    if (!response.ok) {
      throw new Error(
        `Publish failed: HTTP ${response.status} ${responseBody}`,
      );
    }
    return responseBody;
  } finally {
    clearTimeout(timeout);
  }
};
