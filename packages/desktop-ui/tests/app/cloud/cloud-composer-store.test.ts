import { afterEach, describe, expect, test } from "vitest";
import {
  cloudAttachmentsStore,
  withAttachmentPreamble,
} from "../../../src/features/cloud/cloud-composer-store";

afterEach(() => {
  cloudAttachmentsStore.clear();
});

describe("cloud composer attachments", () => {
  test("clears acknowledged outbox copies so the next prompt has no stale files", () => {
    cloudAttachmentsStore.add({
      path: "images/chart.png", name: "chart.png", sizeBytes: 100,
      contentType: "image/png",
    });
    const submitted = structuredClone(cloudAttachmentsStore.getSnapshot());
    expect(cloudAttachmentsStore.clearIfCurrent(submitted)).toBe(true);
    expect(withAttachmentPreamble("Next message", cloudAttachmentsStore.getSnapshot()))
      .toBe("Next message");
  });

  test("preserves a newer attachment while an older submission is acknowledged", () => {
    cloudAttachmentsStore.add({ path: "one.txt", name: "one.txt", sizeBytes: 1 });
    const submitted = structuredClone(cloudAttachmentsStore.getSnapshot());
    cloudAttachmentsStore.add({ path: "two.txt", name: "two.txt", sizeBytes: 2 });
    expect(cloudAttachmentsStore.clearIfCurrent(submitted)).toBe(false);
    expect(cloudAttachmentsStore.getSnapshot()).toHaveLength(2);
  });

  test("preserves a replacement of the submitted drive path", () => {
    cloudAttachmentsStore.add({ path: "one.txt", name: "one.txt", sizeBytes: 1 });
    const submitted = structuredClone(cloudAttachmentsStore.getSnapshot());
    cloudAttachmentsStore.add({ path: "one.txt", name: "one.txt", sizeBytes: 2 });
    expect(cloudAttachmentsStore.clearIfCurrent(submitted)).toBe(false);
    expect(cloudAttachmentsStore.getSnapshot()[0]?.sizeBytes).toBe(2);
  });

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
