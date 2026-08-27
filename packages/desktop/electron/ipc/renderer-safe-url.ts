import { normalizeSafeExternalUrl } from "@stella/runtime/kernel/tools/network-guards";

export const PRIVILEGED_RENDERER_FETCH_TIMEOUT_MS = 30_000;

export async function normalizeUrlForPrivilegedRendererFetch(
  inputUrl: string,
): Promise<string> {
  return normalizeSafeExternalUrl(inputUrl);
}
