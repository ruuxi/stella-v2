/**
 * The generic OAuth helpers the Sign in with ChatGPT flows share: PKCE and
 * form encoding. Pure, so Node, Electron, Workers and React Native can use
 * it (React Native passes its own crypto primitives).
 */

export const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

/** The two primitives PKCE needs; React Native supplies its own. */
export type PkceCrypto = {
  randomBytes(length: number): Uint8Array;
  sha256(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
};

/** Web Crypto, as Node, Electron and browsers have it. */
export const webPkceCrypto: PkceCrypto = {
  randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
  sha256: async (data) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>)),
};

export const createPkce = async (
  primitives: PkceCrypto = webPkceCrypto,
): Promise<{ verifier: string; challenge: string }> => {
  const verifier = base64UrlEncode(primitives.randomBytes(32));
  const challenge = base64UrlEncode(
    await primitives.sha256(new TextEncoder().encode(verifier)),
  );
  return { verifier, challenge };
};

export const formEncode = (values: Record<string, string>): string =>
  Object.entries(values)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
