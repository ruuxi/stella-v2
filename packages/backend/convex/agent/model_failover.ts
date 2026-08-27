import {
  isAbortError,
  isContextOverflowError,
  isConvexInternalError,
  isToolLoopExhaustionError,
} from "../lib/error_classification";

function shouldFailover(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (isContextOverflowError(error)) return false;
  if (isConvexInternalError(error)) return false;
  if (isToolLoopExhaustionError(error)) return false;

  return true;
}

export function withModelFailover<T>(
  primaryFn: () => T,
  fallbackFn?: () => T,
  options?: { onFallback?: (error: unknown) => void },
): T {
  try {
    return primaryFn();
  } catch (error) {

    if (!fallbackFn) throw error;

    if (!shouldFailover(error)) throw error;

    console.warn(
      `[model-failover] Primary model failed, attempting fallback. Error: ${
        (error as Error)?.message ?? String(error)
      }`,
    );

    options?.onFallback?.(error);

    return fallbackFn();
  }
}

export async function withModelFailoverAsync<T>(
  primaryFn: () => Promise<T>,
  fallbackFn?: () => Promise<T>,
  options?: { onFallback?: (error: unknown) => void },
): Promise<T> {
  try {
    return await primaryFn();
  } catch (error) {

    if (!fallbackFn) throw error;

    if (!shouldFailover(error)) throw error;

    console.warn(
      `[model-failover] Primary model failed, attempting fallback. Error: ${
        (error as Error)?.message ?? String(error)
      }`,
    );

    options?.onFallback?.(error);

    return await fallbackFn();
  }
}
