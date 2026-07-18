import type { RuntimeListModelsRequest } from "@stella/contracts/model-catalog";
import { createRuntimeUnavailableError } from "@stella/contracts/protocol/rpc-peer";
import type { StellaHostRunner } from "../stella-host-runner.js";

type ModelListingRunner = Pick<StellaHostRunner, "listModels">;

export const listRuntimeModelsForPicker = async (
  runner: ModelListingRunner | null,
  payload: unknown,
) => {
  if (!runner) {
    throw createRuntimeUnavailableError(
      "Stella runtime is not ready to list models.",
    );
  }
  const request: RuntimeListModelsRequest = {
    forceRefresh:
      Boolean(payload) &&
      typeof payload === "object" &&
      (payload as { forceRefresh?: unknown }).forceRefresh === true,
  };
  return await runner.listModels(request);
};
