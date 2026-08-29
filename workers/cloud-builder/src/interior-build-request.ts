import type { TurnBrokerInteriorBuildRequest } from "@stella/contracts/turn-credential-broker";

const MAX_NOTE_LENGTH = 512;

/**
 * The agent's explicit ask for a Stella-interior production build, recorded
 * per turn attempt so the post-turn builder can read it after the executor
 * process is gone.
 */
export type InteriorBuildRequestRecord = {
  schemaVersion: 1;
  turnId: string;
  attemptGeneration: number;
  requestedAt: number;
  note?: string;
};

export const interiorBuildRequestKey = (
  turnId: string,
  attemptGeneration: number,
): string => `interiorBuildRequest:${turnId}:${attemptGeneration}`;

export const parseInteriorBuildRequest = (
  value: unknown,
): TurnBrokerInteriorBuildRequest | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (
    row.schemaVersion !== 1 ||
    keys.some((key) => key !== "schemaVersion" && key !== "note")
  ) {
    return null;
  }
  if (row.note === undefined) return { schemaVersion: 1 };
  if (
    typeof row.note !== "string" ||
    row.note.length > MAX_NOTE_LENGTH ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(row.note)
  ) {
    return null;
  }
  return { schemaVersion: 1, note: row.note };
};

export const interiorBuildRequestRecord = (args: {
  request: TurnBrokerInteriorBuildRequest;
  turnId: string;
  attemptGeneration: number;
  now: number;
}): InteriorBuildRequestRecord => ({
  schemaVersion: 1,
  turnId: args.turnId,
  attemptGeneration: args.attemptGeneration,
  requestedAt: args.now,
  ...(args.request.note ? { note: args.request.note } : {}),
});

export const exactInteriorBuildRequested = (
  record: InteriorBuildRequestRecord | undefined,
  turnId: string,
  attemptGeneration: number,
): boolean =>
  record?.schemaVersion === 1 &&
  record.turnId === turnId &&
  record.attemptGeneration === attemptGeneration;
