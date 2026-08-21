import { useEffect, useMemo, useRef } from "react";
import { Animated } from "react-native";
import { AgentActivityRow } from "./AgentActivityRow";
import type { MobileDisplayPayload } from "../types";
import { deriveAgentActivityRow } from "../lib/agent-activity-presentation";
import type { Colors } from "../theme/colors";

type AgentWorkPayload = Extract<MobileDisplayPayload, { kind: "agent-work" }>;

/**
 * Inline "background work" marker — work the computer kicked off in the
 * background. Mirrors the redesigned desktop `BackgroundWorkCard`: a minimal,
 * chrome-less one-line row (no card surface, no badges, no provider icons)
 * carrying the task DESCRIPTION only. The leading slot doubles as the status
 * tell — static star while the shimmering title carries the running motion,
 * a quiet grey check once done, an arrow for `send_input` follow-ups;
 * failed/canceled rows settle plain with the star. State is live-reconciled,
 * so a running row never fakes "finished" (see `applyLiveAgentWorkState`).
 */
export function AgentWorkCard({
  payload,
  colors,
  onPress,
}: {
  payload: AgentWorkPayload;
  colors: Colors;
  /** Opens the agent detail (activity hub). */
  onPress?: () => void;
}) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(3)).current;
  const row = useMemo(
    () => deriveAgentActivityRow(payload),
    [payload],
  );

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 180,
        useNativeDriver: true,
      }),
      Animated.spring(translateY, {
        toValue: 0,
        damping: 18,
        stiffness: 220,
        mass: 0.7,
        useNativeDriver: true,
      }),
    ]).start();
  }, [opacity, translateY]);

  return (
    <Animated.View style={{ opacity, transform: [{ translateY }] }}>
      <AgentActivityRow
        title={row.title}
        glyph={row.glyph}
        working={row.working}
        colors={colors}
        {...(onPress ? { onPress } : {})}
      />
    </Animated.View>
  );
}
