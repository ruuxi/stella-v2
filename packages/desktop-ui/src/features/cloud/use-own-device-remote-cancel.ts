import { useEffect, useMemo, useRef, useState } from "react";
import { getDeviceIdOrNull } from "@/platform/electron/device";
import type { JournalRecord, TurnPhase } from "./conversation-protocol";
import { advanceOwnDeviceTurnPhases } from "./cloud-remote-cancel";

const phaseObservations = (
  records: readonly JournalRecord[],
): Array<{ turnId: string; phase: TurnPhase | null }> => {
  const phases = new Map<string, TurnPhase | null>();
  for (const record of records) {
    if (record.kind === "turn") {
      phases.set(record.turnId, record.phase);
    } else if (!phases.has(record.turnId)) {
      phases.set(record.turnId, null);
    }
  }
  return [...phases].map(([turnId, phase]) => ({ turnId, phase }));
};

/**
 * Converts the DO's durable remote-cancel transition back into the desktop
 * provider cancellation that owns the matching `desktop:<deviceId>:` turn.
 * Historical canceled rows only seed state; they never cancel a new run.
 */
export const useOwnDeviceRemoteCancel = ({
  conversationId,
  records,
  enabled,
  onCancel,
}: {
  conversationId: string;
  records: readonly JournalRecord[];
  enabled: boolean;
  onCancel: () => void;
}): string | null => {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const phasesRef = useRef<{
    conversationId: string;
    phases: ReadonlyMap<string, TurnPhase | null>;
  }>({ conversationId: "", phases: new Map() });
  const observations = useMemo(() => phaseObservations(records), [records]);

  useEffect(() => {
    if (!enabled) {
      setDeviceId(null);
      return;
    }
    let cancelled = false;
    void getDeviceIdOrNull().then((nextDeviceId) => {
      if (!cancelled) setDeviceId(nextDeviceId);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !deviceId || !conversationId) return;
    const previous =
      phasesRef.current.conversationId === conversationId
        ? phasesRef.current.phases
        : new Map<string, TurnPhase | null>();
    const next = advanceOwnDeviceTurnPhases(
      previous,
      observations,
      `desktop:${deviceId}:`,
    );
    phasesRef.current = {
      conversationId,
      phases: next.phases,
    };
    if (next.canceledTurnIds.length > 0) onCancelRef.current();
  }, [conversationId, deviceId, enabled, observations]);

  return deviceId;
};
