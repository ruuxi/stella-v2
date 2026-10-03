/**
 * The Stella backend worker's origin. It serves Better Auth at `/api/auth/*`
 * and the owner calls and views. Inlined into the browser bundle as a public
 * `NEXT_PUBLIC_*` value.
 */
export const readBackendUrl = (): string | null =>
  process.env.NEXT_PUBLIC_STELLA_BACKEND_URL?.trim().replace(/\/+$/, "") || null;

/** False on preview builds without the backend URL; auth UI hides itself. */
export const isBackendConfigured = (): boolean => readBackendUrl() !== null;
