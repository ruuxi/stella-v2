import { View } from "react-native";
import { AgentActivityRow } from "./AgentActivityRow";
import type { AgentWorkCardSection } from "../lib/agent-artifact-consolidation";
import type { Colors } from "../theme/colors";

/**
 * The settled presentation of a spawn-anchored card — the mobile analogue of
 * the redesigned desktop `AgentCompletionCard`. Deliberately minimal,
 * matching the running row: no card chrome, no file pills, no provider
 * icons, no completion excerpt. Each completed agent renders as one quiet
 * line — grey check, the task DESCRIPTION, trailing chevron — and several
 * agents completing at the same slot stack as sibling rows. The full result
 * and produced files stay reachable through the activity hub.
 */
export function AgentCompletionCard({
  sections,
  colors,
  onPress,
}: {
  /** Per-agent completion rollups (title = the agent's task description). */
  sections: AgentWorkCardSection[];
  colors: Colors;
  /** Opens the agent detail (activity hub). */
  onPress?: () => void;
}) {
  if (sections.length === 0) return null;
  return (
    <View>
      {sections.map((section) => (
        <AgentActivityRow
          key={section.key}
          title={section.title || "Finished"}
          glyph="check"
          working={false}
          colors={colors}
          {...(onPress ? { onPress } : {})}
        />
      ))}
    </View>
  );
}
