export const DEV_MODE_PROMPT_START = "<!-- stella:dev-mode-only -->";
export const DEV_MODE_PROMPT_END = "<!-- /stella:dev-mode-only -->";

export const applyDeveloperModePromptGate = (
  body: string,
  developerModeEnabled: boolean,
): string => {
  if (!body.includes(DEV_MODE_PROMPT_START)) return body;
  const lines = body.split("\n");
  const kept: string[] = [];
  let inDevBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === DEV_MODE_PROMPT_START) {
      inDevBlock = true;
      continue;
    }
    if (trimmed === DEV_MODE_PROMPT_END) {
      inDevBlock = false;
      continue;
    }
    if (inDevBlock && !developerModeEnabled) continue;
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
};
