import { getAuthHeaders } from "@/global/auth/services/auth-token";
import type { CatalogApiResponse } from "@/global/settings/lib/model-catalog";
import { STELLA_MODELS_PATH } from "@/shared/stella-api";
import { backendUrl } from "./backend-client";

/**
 * `GET /api/stella/models` on the backend worker. The bearer (when signed in)
 * picks the plan audience. The last body is kept with its ETag, so a refetch
 * the catalog hasn't changed since costs a 304.
 */
let last: { etag: string; body: CatalogApiResponse } | null = null;

export const fetchStellaModels = async (): Promise<CatalogApiResponse> => {
  if (!backendUrl) throw new Error("VITE_STELLA_BACKEND_URL is not set.");
  const headers = await getAuthHeaders(
    last ? { "If-None-Match": last.etag } : {},
  );
  const response = await fetch(`${backendUrl}${STELLA_MODELS_PATH}`, {
    headers,
  });
  if (response.status === 304 && last) return last.body;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as CatalogApiResponse;
  const etag = response.headers.get("etag");
  last = etag ? { etag, body } : null;
  return body;
};
