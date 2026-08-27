import { describe, expect, test } from "bun:test";
import {
  failedMobileCloudMemoryPreference,
  loadingMobileCloudMemoryPreference,
  savingMobileCloudMemoryPreference,
  syncedMobileCloudMemoryPreference,
} from "../cloud-memory-preference-ui-state";

const preference = {
  ownerGeneration: "generation:1",
  memoryEnabled: true,
  revision: 3,
  updatedAt: 10,
};

describe("mobile cloud memory preference UI state", () => {
  test("loads disabled until authoritative state arrives", () => {
    expect(loadingMobileCloudMemoryPreference()).toEqual({
      status: "loading",
      preference: null,
      memoryEnabled: true,
      issue: null,
    });
    expect(syncedMobileCloudMemoryPreference(preference)).toMatchObject({
      status: "synced",
      memoryEnabled: true,
      issue: null,
    });
  });

  test("shows the optimistic value only while the CAS write is pending", () => {
    expect(savingMobileCloudMemoryPreference(preference, false)).toMatchObject({
      status: "saving",
      preference,
      memoryEnabled: false,
      issue: null,
    });
  });

  test("a failed save visibly rolls back to server authority", () => {
    expect(failedMobileCloudMemoryPreference(preference, "save")).toMatchObject(
      {
        status: "error",
        preference,
        memoryEnabled: true,
        issue: "save",
      },
    );
  });

  test("a failed initial load has no adoptable local value", () => {
    expect(failedMobileCloudMemoryPreference(null, "load")).toEqual({
      status: "error",
      preference: null,
      memoryEnabled: true,
      issue: "load",
    });
  });
});
