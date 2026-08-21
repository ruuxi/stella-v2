/**
 * Developer-mode gating for shipped agent prompts.
 *
 * Engine/model routing guidance inside the bundled agent-metadata markdown is
 * fenced with HTML comment markers:
 *
 *   <!-- stella:dev-mode-only -->
 *   ...routing guidance...
 *   <!-- /stella:dev-mode-only -->
 *
 * At assembly time (`runner/context.ts`) the fenced content is included only
 * when developer mode is on; the marker lines themselves are always removed,
 * so with developer mode ON the assembled prompt is byte-for-byte identical
 * to the pre-marker prompt, and with it OFF the session context genuinely
 * contains none of the routing text.
 */

export const DEV_MODE_PROMPT_START = "<!-- stella:dev-mode-only -->";
export const DEV_MODE_PROMPT_END = "<!-- /stella:dev-mode-only -->";

/**
 * Strip developer-mode markers from a prompt body, dropping the fenced
 * content when `developerModeEnabled` is false. Collapses any blank-line
 * runs the removal leaves behind so the disabled output reads as if the
 * section never existed. Bodies without markers pass through untouched.
 */
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
