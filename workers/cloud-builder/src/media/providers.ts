/**
 * Which media provider serves a request. Media, music and read-aloud run on
 * fal or OpenRouter, so a deployment needs only one of `FAL_KEY` and
 * `OPENROUTER_API_KEY`. Each capability lists the providers that can serve it
 * in order of preference; the first one with a key wins, unless
 * `STELLA_MEDIA_PROVIDER` (`fal` | `openrouter`) names another configured one.
 */

export type MediaProvider = "fal" | "openrouter";

const KEY_NAMES: Record<MediaProvider, string> = {
  fal: "FAL_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

const read = (env: object, name: string): string | null => {
  const value = (env as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

export const mediaProviderKey = (env: object, provider: MediaProvider): string | null =>
  read(env, KEY_NAMES[provider]);

const forcedProvider = (env: object): MediaProvider | null => {
  const value = read(env, "STELLA_MEDIA_PROVIDER")?.toLowerCase();
  return value === "fal" || value === "openrouter" ? value : null;
};

/** The provider for something `supported` (preferred first) can run on, or null when none is set up. */
export const pickMediaProvider = (
  env: object,
  supported: readonly MediaProvider[],
): { provider: MediaProvider; apiKey: string } | null => {
  const configured = supported.flatMap((provider) => {
    const apiKey = mediaProviderKey(env, provider);
    return apiKey ? [{ provider, apiKey }] : [];
  });
  const forced = forcedProvider(env);
  return configured.find((entry) => entry.provider === forced) ?? configured[0] ?? null;
};
