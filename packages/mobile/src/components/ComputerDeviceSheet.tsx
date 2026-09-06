import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SettingsContent } from "./SettingsContent";
import { TopSheet } from "./TopSheet";
import { Icon, type IconName } from "./Icon";
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

/** Settings and computer controls share one top-origin sheet above the chat. */
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
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const [pairSheetOpen, setPairSheetOpen] = useState(false);
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
  // Follows the paired desktop's developer-mode flag: only an explicit "off"
  // hides the Model row (and its sheet); unknown/older desktops keep it.
  const modelControlsHidden =
    !access || modelSettings.developerModeEnabled === false;

  const rows: {
    id: string;
    icon: IconName;
    label: string;
    trailing?: string;
    onPress: () => void;
  }[] = [
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
      label: access ? "Pair another computer" : "Pair a computer",
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
    <TopSheet visible={visible} onClose={onClose} glass>
      <SettingsContent onClose={onClose} embedded>
        {access ? (
          <View style={styles.deviceHero}>
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
        ) : null}

        <Text style={styles.sectionLabel}>Run on</Text>
        <View style={styles.rowGroup}>
          {targetOptions.map((option, index) => (
            <Pressable
              key={option.key}
              accessibilityRole="button"
              accessibilityState={{
                selected: option.selected,
                disabled: option.disabled,
              }}
              disabled={option.disabled}
              onPress={() => {
                tapLight();
                onExecutionTargetChange(option.target);
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
              {option.selected ? (
                <Icon name="check" size={17} color={colors.accent} />
              ) : null}
              {option.disabled ? (
                <Text style={styles.rowTrailing}>
                  {option.unavailableLabel}
                </Text>
              ) : null}
            </Pressable>
          ))}
        </View>
        <View style={[styles.rowGroup, { marginTop: 20, marginBottom: 20 }]}>
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
        </View>
      </SettingsContent>

      <ComputerSettingsSheet
        visible={modelSheetOpen && !modelControlsHidden}
        onClose={() => setModelSheetOpen(false)}
        access={access}
        catalog={modelSettings.catalog}
        onApplied={modelSettings.syncFromSnapshot}
        composerModelPinned={composerModelPinned}
        onComposerModelPinnedChange={onComposerModelPinnedChange}
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
        onSwitchDesktop={onRepaired}
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

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    sectionLabel: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
      marginBottom: 10,
      textTransform: "uppercase",
    },
    deviceHero: {
      gap: 4,
      marginBottom: 24,
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
      marginTop: 0,
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
