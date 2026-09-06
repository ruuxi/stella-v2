import { useEffect, useMemo, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NativeMenu } from "./NativeMenu";
import { TopSheet } from "./TopSheet";
import { Icon, type IconName } from "./Icon";
import { StellaMarkHero } from "./stella-mark/StellaMarkHero";
import { ComputerSettingsSheet } from "./ComputerSettingsSheet";
import { PairPhoneSheet } from "./PairPhoneSheet";
import { type StoredPhoneAccess } from "../lib/phone-access";
import {
  listExecutionDevices,
  type AutomaticExecutionTarget,
  type ExecutionDeviceDestination,
} from "../lib/execution-placement";
import type { ComputerModelSettings } from "../lib/use-computer-model-settings";
import { tapLight } from "../lib/haptics";
import { type Colors } from "../theme/colors";
import { useColors } from "../theme/theme-context";
import { fonts } from "../theme/fonts";
import { fadeHex } from "../theme/oklch";

/** The character at the top of the sheet: the same hero onboarding opens
 *  with, sized to sit above the device name without crowding it. */
const HERO_MARK_SIZE = 96;

/** Live presence goes stale quickly; refresh while the sheet is on screen. */
const EXECUTION_DEVICE_POLL_MS = 15_000;

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
  /** Bubble a freshly-paired computer up so the chat re-targets it. */
  onRepaired: (access: StoredPhoneAccess) => void;
  pairedDesktops: StoredPhoneAccess[];
  executionTarget: AutomaticExecutionTarget;
  onExecutionTargetChange: (target: AutomaticExecutionTarget) => void;
  modelSettings: ComputerModelSettings;
  composerModelPinned: boolean;
  onComposerModelPinnedChange: (next: boolean) => void;
};

/**
 * The paired computer's device surface — status, wake, view-screen, and model
 * settings — presented as a top sheet from the chat's gear button. The
 * conversation itself is the chat; this sheet is the "how is my computer
 * configured" panel beside it. Artifacts moved to the activity hub sheet (the
 * floating pill left of the gear).
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
  onRepaired,
  pairedDesktops,
  executionTarget,
  onExecutionTargetChange,
  modelSettings,
  composerModelPinned,
  onComposerModelPinnedChange,
}: ComputerDeviceSheetProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [rowWidth, setRowWidth] = useState(width - 48);
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const [pairSheetOpen, setPairSheetOpen] = useState(false);
  const [targetSheetOpen, setTargetSheetOpen] = useState(false);
  const [destinations, setDestinations] = useState<
    ExecutionDeviceDestination[] | undefined
  >(undefined);
  // Device presence lives on the owner gate, so this is a poll while the
  // sheet is on screen rather than a Convex subscription.
  useEffect(() => {
    if (!visible) return;
    let active = true;
    const controller = new AbortController();
    const read = () => {
      void listExecutionDevices({ signal: controller.signal })
        .then((devices) => {
          if (active) setDestinations(devices);
        })
        .catch(() => undefined);
    };
    read();
    const timer = setInterval(read, EXECUTION_DEVICE_POLL_MS);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [visible]);
  const selectedDestination =
    executionTarget.mode === "device"
      ? destinations?.find(
          (device) => device.deviceId === executionTarget.deviceId,
        )
      : undefined;
  // Follows the paired desktop's developer-mode flag: only an explicit "off"
  // hides the Model row (and its sheet); unknown/older desktops keep it.
  const modelControlsHidden = modelSettings.developerModeEnabled === false;

  const rows: {
    id: string;
    icon: IconName;
    label: string;
    trailing?: string;
    onPress: () => void;
  }[] = [
    {
      id: "destination",
      icon: "monitor",
      label: "Run on",
      trailing:
        executionTarget.mode === "automatic"
          ? "Automatic"
          : executionTarget.mode === "cloud"
            ? "Cloud"
            : (selectedDestination?.label ??
              `Computer ${executionTarget.deviceId.slice(0, 4).toUpperCase()}`),
      onPress: () => {
        tapLight();
        setTargetSheetOpen(true);
      },
    },
    ...(modelControlsHidden
      ? []
      : [
          {
            id: "model",
            icon: "cpu" as IconName,
            label: "Model",
            trailing: modelSettings.selectedModelLabel,
            onPress: () => {
              tapLight();
              setModelSheetOpen(true);
            },
          },
        ]),
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

  const targetOptions = executionOptions({
    pairedDesktops,
    destinations,
    target: executionTarget,
  });
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
          <View style={styles.heroMark}>
            <StellaMarkHero
              size={HERO_MARK_SIZE}
              faceColor={colors.background}
            />
          </View>
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

        <View
          style={styles.rowGroup}
          onLayout={(event) => setRowWidth(event.nativeEvent.layout.width)}
        >
          {rows.map((row, index) =>
            row.id === "destination" && Platform.OS === "ios" ? (
              <NativeMenu
                key={row.id}
                accessibilityLabel={row.label}
                width={rowWidth}
                height={52}
                onFallbackPress={row.onPress}
                label={
                  <View style={[styles.row, { width: rowWidth - 40 }]}>
                    <Icon name={row.icon} size={18} color={colors.textMuted} />
                    <Text style={styles.rowLabel}>{row.label}</Text>
                    <Text style={styles.rowTrailing} numberOfLines={1}>
                      {row.trailing}
                    </Text>
                    <Icon
                      name="chevron-down"
                      size={15}
                      color={colors.textMuted}
                    />
                  </View>
                }
                items={targetOptions.map((option) => ({
                  id: option.key,
                  title: option.disabled
                    ? `${option.label} (${option.unavailableLabel})`
                    : option.label,
                  selected: option.selected,
                  disabled: option.disabled,
                  systemImage:
                    option.key === "cloud"
                      ? "globe"
                      : option.key === "automatic"
                        ? "sparkles"
                        : "desktopcomputer",
                  onPress: () => {
                    tapLight();
                    onExecutionTargetChange(option.target);
                  },
                }))}
              />
            ) : (
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
            ),
          )}
        </View>
      </ScrollView>

      <ComputerSettingsSheet
        visible={modelSheetOpen && !modelControlsHidden}
        onClose={() => setModelSheetOpen(false)}
        access={access}
        catalog={modelSettings.catalog}
        onApplied={modelSettings.syncFromSnapshot}
        composerModelPinned={composerModelPinned}
        onComposerModelPinnedChange={onComposerModelPinnedChange}
      />
      <ExecutionTargetSheet
        visible={targetSheetOpen}
        onClose={() => setTargetSheetOpen(false)}
        pairedDesktops={pairedDesktops}
        destinations={destinations}
        target={executionTarget}
        onSelect={(next) => {
          onExecutionTargetChange(next);
          setTargetSheetOpen(false);
        }}
      />
      <PairPhoneSheet
        visible={pairSheetOpen}
        onClose={() => setPairSheetOpen(false)}
        onPaired={(next) => {
          setPairSheetOpen(false);
          onRepaired(next);
        }}
        preferredAccess={access}
        pairedDesktops={pairedDesktops}
      />
    </TopSheet>
  );
}

function executionOptions(props: {
  pairedDesktops: StoredPhoneAccess[];
  destinations: ExecutionDeviceDestination[] | undefined;
  target: AutomaticExecutionTarget;
}) {
  const pairedIds = new Set(
    props.pairedDesktops.map((entry) => entry.desktopDeviceId),
  );
  const computers = (props.destinations ?? []).filter(
    (device) =>
      pairedIds.has(device.deviceId) &&
      ((device.online && device.remoteExecutionEnabled) ||
        (props.target.mode === "device" &&
          props.target.deviceId === device.deviceId)),
  );
  const options: {
    key: string;
    icon: IconName;
    label: string;
    selected: boolean;
    disabled?: boolean;
    unavailableLabel?: string;
    target: AutomaticExecutionTarget;
  }[] = [
    {
      key: "automatic",
      icon: "sparkles",
      label: "Automatic",
      selected: props.target.mode === "automatic",
      target: { mode: "automatic" },
    },
    {
      key: "cloud",
      icon: "globe",
      label: "Cloud",
      selected: props.target.mode === "cloud",
      target: { mode: "cloud" },
    },
    ...computers.map((device) => ({
      key: device.deviceId,
      icon: "monitor" as IconName,
      label: device.label ?? "Computer",
      selected:
        props.target.mode === "device" &&
        props.target.deviceId === device.deviceId,
      disabled:
        !device.online ||
        !device.remoteExecutionEnabled ||
        device.availability?.ready !== true ||
        (device.availability?.chatSlots ?? 0) <= 0,
      unavailableLabel: !device.online
        ? "Offline"
        : !device.remoteExecutionEnabled
          ? "Unavailable"
          : "Busy",
      target: { mode: "device" as const, deviceId: device.deviceId },
    })),
  ];

  return options;
}

function ExecutionTargetSheet(props: {
  visible: boolean;
  onClose: () => void;
  pairedDesktops: StoredPhoneAccess[];
  destinations: ExecutionDeviceDestination[] | undefined;
  target: AutomaticExecutionTarget;
  onSelect: (target: AutomaticExecutionTarget) => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const options = executionOptions(props);

  return (
    <TopSheet visible={props.visible} onClose={props.onClose}>
      <View style={styles.targetSheet}>
        {options.map((option, index) => (
          <Pressable
            key={option.key}
            disabled={option.disabled}
            onPress={() => {
              tapLight();
              props.onSelect(option.target);
            }}
            style={({ pressed }) => [
              styles.row,
              index > 0 && styles.rowDivider,
              pressed && styles.rowPressed,
              option.disabled && styles.targetDisabled,
            ]}
          >
            <Icon
              name={option.icon}
              size={18}
              color={colors.textMuted}
              style={styles.rowIcon}
            />
            <Text style={styles.rowLabel}>{option.label}</Text>
            {option.disabled ? (
              <Text style={styles.rowTrailing}>{option.unavailableLabel}</Text>
            ) : option.selected ? (
              <Icon name="check" size={17} color={colors.accent} />
            ) : null}
          </Pressable>
        ))}
      </View>
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
    heroMark: {
      marginBottom: 12,
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
    targetSheet: {
      paddingHorizontal: 24,
      paddingTop: 12,
    },
    targetDisabled: {
      opacity: 0.55,
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
