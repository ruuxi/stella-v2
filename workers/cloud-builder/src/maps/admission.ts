import { RpcError } from "../owner-store/errors.js";
import type { MapsAdmission } from "./google-resolve.js";

export const ownerMapsAdmission =
  (ownerInternal: (name: string, args: unknown) => Promise<unknown>): MapsAdmission =>
  async ({ places, route }) => {
    try {
      await ownerInternal("maps.admit", { requestId: crypto.randomUUID(), places, route });
      return { ok: true };
    } catch (error) {
      if (error instanceof RpcError && (error.code === "RATE_LIMITED" || error.code === "FORBIDDEN")) {
        return { ok: false, status: error.code === "RATE_LIMITED" ? 429 : 403, error: error.message };
      }
      throw error;
    }
  };
