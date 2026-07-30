import { describe, expect, test } from "bun:test";
import {
  disposeAccountScopedResources,
  withoutAccountScope,
} from "../cloud-account-memory";

describe("cloud conversation account transition cleanup", () => {
  test("disposes only the previous account's stores immediately", () => {
    const disposed: string[] = [];
    const resources = new Map([
      [
        "old:conversation",
        {
          accountScope: "account:old",
          dispose: () => disposed.push("old"),
        },
      ],
      [
        "new:conversation",
        {
          accountScope: "account:new",
          dispose: () => disposed.push("new"),
        },
      ],
    ]);

    disposeAccountScopedResources(resources, "account:old");

    expect(disposed).toEqual(["old"]);
    expect([...resources.keys()]).toEqual(["new:conversation"]);
  });

  test("removes old-account optimistic prompts without touching the next account", () => {
    const values = [
      { accountScope: "account:old", text: "private old prompt" },
      { accountScope: "account:new", text: "new prompt" },
    ];

    expect(withoutAccountScope(values, "account:old")).toEqual([
      { accountScope: "account:new", text: "new prompt" },
    ]);
  });
});
