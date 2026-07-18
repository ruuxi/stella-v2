import { describe, expect, it, vi } from "vitest";
import { isRuntimeUnavailableError } from "@stella/contracts/protocol/rpc-peer";
import { listRuntimeModelsForPicker } from "../../../desktop/electron/ipc/model-catalog-listing";

describe("listRuntimeModelsForPicker", () => {
  it("rejects while the runtime runner is unavailable instead of publishing an empty catalog", async () => {
    const result = listRuntimeModelsForPicker(null, undefined).catch(
      (error: unknown) => error,
    );

    const error = await result;
    expect(isRuntimeUnavailableError(error)).toBe(true);
    expect(error).toMatchObject({
      message: "Stella runtime is not ready to list models.",
    });
  });

  it("forwards only an exact force-refresh request to the runner", async () => {
    const snapshot = {
      revision: 7,
      models: [],
      runtimeManagedProviders: [],
      refreshedAt: null,
    };
    const listModels = vi.fn(async () => snapshot);

    await expect(
      listRuntimeModelsForPicker({ listModels }, { forceRefresh: true }),
    ).resolves.toEqual(snapshot);
    await expect(
      listRuntimeModelsForPicker({ listModels }, { forceRefresh: "true" }),
    ).resolves.toEqual(snapshot);
    expect(listModels).toHaveBeenNthCalledWith(1, { forceRefresh: true });
    expect(listModels).toHaveBeenNthCalledWith(2, { forceRefresh: false });
  });
});
