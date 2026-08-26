import { afterEach, describe, expect, test } from "vitest";
import {
  cloudAttachmentsStore,
  withAttachmentPreamble,
} from "../../../src/features/cloud/cloud-composer-store";

afterEach(() => {
  cloudAttachmentsStore.clear();
});

describe("cloud composer attachments", () => {
  test("replaces duplicate drive paths without disturbing other attachments", () => {
    cloudAttachmentsStore.add({
      path: "reports/one.pdf",
      name: "one.pdf",
      sizeBytes: 10,
    });
    cloudAttachmentsStore.add({
      path: "reports/two.pdf",
      name: "two.pdf",
      sizeBytes: 20,
    });
    cloudAttachmentsStore.add({
      path: "reports/one.pdf",
      name: "one-new.pdf",
      sizeBytes: 30,
    });

    expect(cloudAttachmentsStore.getSnapshot()).toEqual([
      { path: "reports/two.pdf", name: "two.pdf", sizeBytes: 20 },
      { path: "reports/one.pdf", name: "one-new.pdf", sizeBytes: 30 },
    ]);
  });

  test("notifies subscribers and writes addressable drive paths into prompts", () => {
    let calls = 0;
    const unsubscribe = cloudAttachmentsStore.subscribe(() => {
      calls += 1;
    });
    cloudAttachmentsStore.add({
      path: "images/chart.png",
      name: "chart.png",
      sizeBytes: 100,
    });

    expect(calls).toBe(1);
    expect(
      withAttachmentPreamble(
        "Analyze this",
        cloudAttachmentsStore.getSnapshot(),
      ),
    ).toBe("Analyze this\n\nAttached in my drive:\n- images/chart.png");
    unsubscribe();
  });
});
