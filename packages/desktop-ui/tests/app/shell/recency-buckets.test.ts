import { describe, expect, it } from "vitest";
import { bucketByRecency, recencyBucketId } from "@/shared/lib/recency-buckets";

// Wednesday 2026-08-12, 14:00 local.
const NOW = new Date(2026, 7, 12, 14, 0, 0).getTime();
const at = (year: number, month: number, day: number, hour = 12): number =>
  new Date(year, month, day, hour).getTime();

describe("recencyBucketId", () => {
  it("uses calendar boundaries, not rolling 24h windows", () => {
    expect(recencyBucketId(at(2026, 7, 12, 0), NOW)).toBe("today");
    expect(recencyBucketId(at(2026, 7, 11, 23), NOW)).toBe("yesterday");
    // Monday of the current week.
    expect(recencyBucketId(at(2026, 7, 10), NOW)).toBe("thisWeek");
    // Previous week, same month.
    expect(recencyBucketId(at(2026, 7, 4), NOW)).toBe("thisMonth");
    expect(recencyBucketId(at(2026, 6, 30), NOW)).toBe("older");
  });

  it("treats future timestamps as today rather than sorting them last", () => {
    expect(recencyBucketId(NOW + 60 * 60 * 1000, NOW)).toBe("today");
  });
});

describe("bucketByRecency", () => {
  it("groups in fixed order, drops empty buckets, and keeps incoming order", () => {
    const item = (id: string, timestamp: number) => ({ id, timestamp });
    const groups = bucketByRecency(
      [
        item("today-a", at(2026, 7, 12, 13)),
        item("today-b", at(2026, 7, 12, 9)),
        item("week", at(2026, 7, 10)),
        item("old", at(2026, 5, 2)),
      ],
      (entry) => entry.timestamp,
      NOW,
    );

    expect(
      groups.map((group) => [group.id, group.items.map((entry) => entry.id)]),
    ).toEqual([
      ["today", ["today-a", "today-b"]],
      ["thisWeek", ["week"]],
      ["older", ["old"]],
    ]);
  });
});
