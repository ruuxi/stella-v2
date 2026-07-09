import { describe, expect, it } from "bun:test";

import { buildManagedModelPriceEntries } from "../convex/lib/models_dev";

describe("managed model price entries", () => {
  it("fills Muse Spark from static overrides when models.dev is empty", () => {
    const { entries, missingModels } = buildManagedModelPriceEntries({
      data: {},
      modelIds: ["meta/muse-spark-1.1"],
      syncedAt: 1,
    });

    expect(missingModels).toEqual([]);
    expect(entries).toEqual([
      {
        model: "meta/muse-spark-1.1",
        source: "static",
        sourceProvider: "meta",
        sourceModelId: "muse-spark-1.1",
        inputPerMillionUsd: 1.25,
        outputPerMillionUsd: 4.25,
        cacheReadPerMillionUsd: 0,
        cacheWritePerMillionUsd: 0,
        reasoningPerMillionUsd: 4.25,
        modalitiesInput: ["text", "image", "video", "pdf"],
        modalitiesOutput: ["text"],
        sourceUpdatedAt: "",
        syncedAt: 1,
      },
    ]);
  });

  it("still reports truly unknown models as missing", () => {
    const { entries, missingModels } = buildManagedModelPriceEntries({
      data: {},
      modelIds: ["unknown/not-a-real-model"],
      syncedAt: 1,
    });
    expect(entries).toEqual([]);
    expect(missingModels).toEqual(["unknown/not-a-real-model"]);
  });
});
