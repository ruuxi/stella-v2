/**
 * The Stella backend worker origin: Better Auth (`/api/auth`), backend calls,
 * live views and conversation sockets. Public build-time config.
 */
export const backendUrl = (
  (import.meta.env.VITE_STELLA_BACKEND_URL as string | undefined) ?? ""
)
  .trim()
  .replace(/\/+$/, "");

/** `backendUrl`, or a readable error when this build was not configured. */
export const requireBackendUrl = (): string => {
  if (!backendUrl) throw new Error("VITE_STELLA_BACKEND_URL is not set.");
  return backendUrl;
};
