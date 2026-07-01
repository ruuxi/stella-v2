import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TopSheet } from "./TopSheet";
import { Icon, type IconName } from "./Icon";
import { ConnectHeroAnimation } from "./ConnectHeroAnimation";
import { ComputerSettingsSheet } from "./ComputerSettingsSheet";
import { ArtifactListSheet } from "./ArtifactListSheet";
import { ArtifactViewer } from "./ArtifactViewer";
import { PairPhoneSheet } from "./PairPhoneSheet";
import { type StoredPhoneAccess } from "../lib/phone-access";
import { useComputerModelSettings } from "../lib/use-computer-model-settings";
import { tapLight } from "../lib/haptics";
import { type Colors } from "../theme/colors";
import { useColors } from "../theme/theme-context";
import { fonts } from "../theme/fonts";
import { fadeHex } from "../theme/oklch";
import type { ChatArtifact } from "../types";

type ComputerDeviceSheetProps = {
  visible: boolean;
  onClose: () => void;
  access: StoredPhoneAccess | null;
  platformLabel: string;
  statusLabel: string;
  statusAvailable: boolean | null;
  connecting: boolean;
  /** Show the inline "Wake up" affordance (computer asleep and not waking). */
  showWake: boolean;
  onWake: () => void;
  /** Manually trigger a desktop transcript sync (reconnect-or-pull) on demand. */
  onForceSync: () => void;
  /** A force sync is in flight — disable the row and show progress. */
  syncing: boolean;
  /** Artifacts in the computer conversation, newest first. */
  artifacts: ChatArtifact[];
  /** Bubble a freshly-paired computer up so the chat re-targets it. */
  onRepaired: (access: StoredPhoneAccess) => void;
};

/**
 * The paired computer's device surface — status, wake, view-screen, artifacts,
 * and model settings — presented as a top sheet from the Computer chat's gear
 * button. The conversation itself lives on the Computer tab; this sheet is the
 * "what is my computer doing / how is it configured" panel beside it.
 */
export function ComputerDeviceSheet({
  visible,
  onClose,
  access,
  platformLabel,
  statusLabel,
  statusAvailable,
  connecting,
  showWake,
  onWake,
  onForceSync,
  syncing,
  artifacts,
  onRepaired,
}: ComputerDeviceSheetProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const modelSettings = useComputerModelSettings();

  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [pairSheetOpen, setPairSheetOpen] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState<ChatArtifact | null>(
    null,
  );

  const rows: {
    id: string;
    icon: IconName;
    label: string;
    trailing?: string;
    onPress: () => void;
  }[] = [
    {
      id: "view",
      icon: "monitor",
      label: "View screen",
      onPress: () => {
        tapLight();
        onClose();
        router.push("/stella");
      },
    },
    {
      id: "artifacts",
      icon: "box",
      label: "Artifacts",
      onPress: () => {
        tapLight();
        setArtifactsOpen(true);
      },
    },
    {
      id: "model",
      icon: "cpu",
      label: "Model",
      trailing: modelSettings.selectedModelLabel,
      onPress: () => {
        tapLight();
        setModelSheetOpen(true);
      },
    },
    {
      id: "pair",
      icon: "smartphone",
      label: "Pair another computer",
      onPress: () => {
        tapLight();
        setPairSheetOpen(true);
      },
    },
  ];

  return (
    <TopSheet visible={visible} onClose={onClose}>
      <ScrollView
        style={styles.screen}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: 32 + insets.bottom },
        ]}
      >
        <View style={styles.deviceHero}>
          <ConnectHeroAnimation />
          <Text style={styles.deviceName}>{platformLabel}</Text>
          <View style={styles.statusRow}>
            {connecting ? null : (
              <View
                style={[
                  styles.statusDot,
                  {
                    backgroundColor: statusAvailable
                      ? colors.ok
                      : colors.textMuted,
                  },
                ]}
              />
            )}
            <Text style={styles.statusText}>{statusLabel}</Text>
            {showWake ? (
              <Pressable
                onPress={onWake}
                hitSlop={8}
                accessibilityLabel="Wake your computer"
                style={({ pressed }) => pressed && styles.wakePressed}
              >
                <Text style={styles.wakeText}>Wake up</Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        <View style={styles.rowGroup}>
          {rows.map((row, index) => (
            <Pressable
              key={row.id}
              onPress={row.onPress}
              accessibilityLabel={row.label}
              style={({ pressed }) => [
                styles.row,
                index > 0 && styles.rowDivider,
                pressed && styles.rowPressed,
              ]}
            >
              <Icon
                name={row.icon}
                size={18}
                color={colors.textMuted}
                style={styles.rowIcon}
              />
              <Text style={styles.rowLabel}>{row.label}</Text>
              {row.trailing ? (
                <Text style={styles.rowTrailing} numberOfLines={1}>
                  {row.trailing}
                </Text>
              ) : null}
              <Icon name="chevron-right" size={15} color={colors.textMuted} />
            </Pressable>
          ))}

          <Pressable
            onPress={onForceSync}
            disabled={syncing}
            accessibilityLabel="Force sync"
            accessibilityState={{ disabled: syncing, busy: syncing }}
            style={({ pressed }) => [
              styles.row,
              styles.rowDivider,
              pressed && !syncing && styles.rowPressed,
            ]}
          >
            <Icon
              name="refresh-cw"
              size={18}
              color={colors.textMuted}
              style={styles.rowIcon}
            />
            <Text style={styles.rowLabel}>
              {syncing ? "Syncing…" : "Force sync"}
            </Text>
            {syncing ? (
              <ActivityIndicator size="small" color={colors.textMuted} />
            ) : null}
          </Pressable>
        </View>
      </ScrollView>

      <ComputerSettingsSheet
        visible={modelSheetOpen}
        onClose={() => setModelSheetOpen(false)}
        access={access}
        catalog={modelSettings.catalog}
        onApplied={modelSettings.syncFromSnapshot}
      />
      <ArtifactListSheet
        visible={artifactsOpen}
        artifacts={artifacts}
        onClose={() => setArtifactsOpen(false)}
        onSelect={setSelectedArtifact}
      />
      <ArtifactViewer
        visible={Boolean(selectedArtifact)}
        artifact={selectedArtifact}
        access={access}
        onClose={() => setSelectedArtifact(null)}
      />
      <PairPhoneSheet
        visible={pairSheetOpen}
        onClose={() => setPairSheetOpen(false)}
        onPaired={(next) => {
          setPairSheetOpen(false);
          onRepaired(next);
        }}
      />
    </TopSheet>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    screen: { flex: 1 },
    scrollContent: { paddingTop: 8, paddingHorizontal: 24 },

    deviceHero: {
      alignItems: "center",
      gap: 4,
      marginTop: 24,
    },
    deviceName: {
      color: colors.text,
      fontFamily: fonts.display.regular,
      fontSize: 26,
      letterSpacing: -1,
      marginTop: 4,
    },
    statusRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 6,
      marginTop: 2,
    },
    statusDot: {
      borderRadius: 3,
      height: 6,
      width: 6,
    },
    statusText: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      letterSpacing: -0.2,
    },
    wakeText: {
      color: colors.accent,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
      letterSpacing: -0.2,
      marginLeft: 6,
    },
    wakePressed: {
      opacity: 0.7,
    },

    rowGroup: {
      marginTop: 36,
    },
    row: {
      alignItems: "center",
      flexDirection: "row",
      gap: 14,
      paddingVertical: 15,
    },
    rowDivider: {
      borderTopColor: fadeHex(colors.border, 0.7),
      borderTopWidth: StyleSheet.hairlineWidth,
    },
    rowPressed: {
      opacity: 0.7,
    },
    rowIcon: {
      width: 22,
    },
    rowLabel: {
      color: colors.text,
      flex: 1,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
      letterSpacing: -0.2,
    },
    rowTrailing: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      letterSpacing: -0.1,
      maxWidth: 140,
    },
  } as const);
