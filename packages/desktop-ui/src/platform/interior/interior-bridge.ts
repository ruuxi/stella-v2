export type StellaInteriorUser = {
  id: string;
  email: string | null;
  name: string | null;
  image: string | null;
  isAnonymous: boolean;
};

export type StellaInteriorSession = {
  user: StellaInteriorUser;
  expiresAt: number;
};

export type StellaInteriorToken = {
  token: string;
  expiresAt: number;
};

export type StellaInteriorBridge = {
  readonly protocol: 1;
  readonly gatewayOrigin: string;
  getSession(): Promise<StellaInteriorSession>;
  getToken(options?: { forceRefresh?: boolean }): Promise<StellaInteriorToken>;
};

declare global {
  interface Window {
    __STELLA_INTERIOR_BRIDGE__?: StellaInteriorBridge;
  }
}

const configuredGatewayOrigin = (): string | null => {
  const value = (
    import.meta.env.VITE_STELLA_APPS_AUTH_HOST as string | undefined
  )?.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
};

/**
 * Presence alone is insufficient: normal browser/desktop builds may execute
 * arbitrary page code. The immutable pre-module runtime must also name the
 * exact gateway compiled into this build before any auth path switches over.
 */
export const getStellaInteriorBridge = (): StellaInteriorBridge | null => {
  if (typeof window === "undefined") return null;
  const bridge = window.__STELLA_INTERIOR_BRIDGE__;
  const gatewayOrigin = configuredGatewayOrigin();
  return bridge?.protocol === 1 && bridge.gatewayOrigin === gatewayOrigin
    ? bridge
    : null;
};

export const isStellaInteriorRuntime = (): boolean =>
  getStellaInteriorBridge() !== null;
