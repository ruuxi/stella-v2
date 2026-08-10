import { describe, expect, it, vi } from "vitest";

import { createLocalDictationDownloader } from "../../../desktop/electron/dictation/local-dictation-download.js";

describe("local dictation download coordinator", () => {
  it("starts installation without requiring the model to be ready first", async () => {
    const downloadModel = vi.fn(async () => ({
      available: true,
      model: "parakeet",
    }));
    const download = createLocalDictationDownloader({ downloadModel });

    await expect(download()).resolves.toMatchObject({ available: true });
    expect(downloadModel).toHaveBeenCalledOnce();
  });

  it("deduplicates concurrent installation requests", async () => {
    let finish: ((value: { available: boolean; model: string }) => void) | null =
      null;
    const downloadModel = vi.fn(
      () =>
        new Promise<{ available: boolean; model: string }>((resolve) => {
          finish = resolve;
        }),
    );
    const download = createLocalDictationDownloader({ downloadModel });

    const first = download();
    const second = download();
    expect(downloadModel).toHaveBeenCalledOnce();
    finish?.({ available: true, model: "parakeet" });

    await expect(first).resolves.toMatchObject({ available: true });
    await expect(second).resolves.toMatchObject({ available: true });
  });
});
