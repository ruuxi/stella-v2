import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useIsFocused } from "expo-router";
import { ComputerSettingsSheet } from "../ComputerSettingsSheet";
import { Icon, type IconName } from "../Icon";
import { PairPhoneSheet } from "../PairPhoneSheet";
import { clearCachedDesktopBridge } from "../../lib/desktop-bridge-chat";
import {
  listExecutionDevices,
  type AutomaticExecutionTarget,
  type ExecutionDeviceDestination,
} from "../../lib/execution-placement";
import { tapLight } from "../../lib/haptics";
import type { ComputerControl } from "../../lib/main-shell-store";
import {
  clearStoredPhoneAccess,
  listStoredPairedPhoneAccess,
  type StoredPhoneAccess,
} from "../../lib/phone-access";
import { useDesktopPlatforms } from "../../lib/use-desktop-platforms";
import { useT } from "../../i18n";
import type { Colors } from "../../theme/colors";
import { fonts } from "../../theme/fonts";
import { useColors } from "../../theme/theme-context";
import type { SettingsStyles } from "./settings-styles";

/** Live presence goes stale quickly; refresh while Settings is on screen. */
const EXECUTION_DEVICE_POLL_MS = 15_000;

function platformLabelFor(
  t: (key: string, params?: Record<string, string | number>) => string,
  access: StoredPhoneAccess,
  platform: string | null | undefined,
): string {
  const base = platform?.trim();
  if (base) return base;
  return t("mobile.settings.paired.unnamedComputer", {
    id: access.desktopDeviceId.slice(0, 4).toUpperCase(),
  });
}

/**
 * Settings' Computer section: the paired computer's status, where turns run,
 * its model, pairing, and the list of paired computers. The live state
 * belongs to the chat (which stays mounted under every tab) and arrives as
 * `control`; it is `null` until the chat has resolved its pairing, when only
 * the stored paired list shows.
 */
export function ComputerSection({
  control,
  signedIn,
  styles,
}: {
  control: ComputerControl | null;
  signedIn: boolean;
  styles: SettingsStyles;
}) {
  const colors = useColors();
  const t = useT();
  const local = useMemo(() => makeStyles(colors), [colors]);
  const focused = useIsFocused();
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const [pairSheetOpen, setPairSheetOpen] = useState(false);
  const [destinations, setDestinations] = useState<
    ExecutionDeviceDestination[] | undefined
  >(undefined);
  const [pairedDesktops, setPairedDesktops] = useState<StoredPhoneAccess[]>([]);
  const desktopPlatforms = useDesktopPlatforms(pairedDesktops);
  const [removingDesktopId, setRemovingDesktopId] = useState<string | null>(
    null,
  );

  const refreshPaired = useCallback(async () => {
    setPairedDesktops(await listStoredPairedPhoneAccess());
  }, []);
  // Re-read after the chat records a new pairing, too.
  const chatPaired = control?.pairedDesktops;
  useEffect(() => {
    void refreshPaired();
  }, [refreshPaired, chatPaired]);

  // Device presence lives on the owner gate, so this is a poll while
  // Settings is on screen rather than a Convex subscription.
  const hasControl = control !== null;
  useEffect(() => {
    if (!focused || !hasControl) return;
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
  }, [focused, hasControl]);

  const confirmForgetDesktop = (access: StoredPhoneAccess) => {
    const label = platformLabelFor(
      t,
      access,
      desktopPlatforms[access.desktopDeviceId],
    );
    Alert.alert(
      t("mobile.settings.forgetConfirmTitle", { name: label }),
      t("mobile.settings.forgetConfirmBody"),
      [
        { text: t("mobile.common.cancel"), style: "cancel" },
        {
          text: t("mobile.settings.forget"),
          style: "destructive",
          onPress: () => {
            setRemovingDesktopId(access.desktopDeviceId);
            clearCachedDesktopBridge(access.desktopDeviceId);
            void clearStoredPhoneAccess(access.desktopDeviceId)
              .then(() => refreshPaired())
              .finally(() => setRemovingDesktopId(null));
          },
        },
      ],
    );
  };

  // Nothing to show until the chat has resolved pairing (or for a guest).
  if (!control && !signedIn) return null;

  const targetOptions = control
    ? executionOptions({
        pairedDesktops: control.pairedDesktops,
        destinations,
        target: control.executionTarget,
      })
    : [];

  return (
    <>
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>
          {t("mobile.settings.computerSection")}
        </Text>

        {control?.access ? (
          <View style={[styles.group, local.groupBottomGap]}>
            <View style={styles.row}>
              <Icon
                name="monitor"
                size={18}
                color={colors.textMuted}
                style={styles.rowIcon}
              />
              <View style={styles.rowCopy}>
                <Text style={styles.rowLabel}>{control.platformLabel}</Text>
                <View style={local.statusRow}>
                  {control.connecting ? null : (
                    <View
                      style={[
                        local.statusDot,
                        {
                          backgroundColor: control.statusAvailable
                            ? colors.ok
                            : colors.textMuted,
                        },
                      ]}
                    />
                  )}
                  <Text style={styles.rowSub}>{control.statusLabel}</Text>
                </View>
              </View>
              {control.showWake ? (
                <Pressable
                  onPress={control.onWake}
                  hitSlop={8}
                  accessibilityLabel="Wake your computer"
                  style={({ pressed }) => pressed && local.pressed}
                >
                  <Text style={styles.rowAction}>Wake up</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        ) : null}

        {control ? (
          <>
            <Text style={local.subLabel}>Run on</Text>
            <View style={styles.group}>
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
                    control.onExecutionTargetChange(option.target);
                  }}
                  style={({ pressed }) => [
                    styles.row,
                    index > 0 && styles.rowDivider,
                    pressed && styles.rowPressed,
                    option.disabled && styles.rowDisabled,
                  ]}
                >
                  <Icon
                    name={option.icon}
                    size={18}
                    color={colors.textMuted}
                    style={styles.rowIcon}
                  />
                  <Text style={[styles.rowLabel, local.flex]}>
                    {option.label}
                  </Text>
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

            <View style={[styles.group, styles.groupGap]}>
              {control.model ? (
                <NavRow
                  icon="cpu"
                  label="Model"
                  trailing={control.model.label}
                  styles={styles}
                  colors={colors}
                  onPress={() => {
                    tapLight();
                    setModelSheetOpen(true);
                  }}
                />
              ) : null}
              <NavRow
                icon="smartphone"
                label={
                  control.access ? "Pair another computer" : "Pair a computer"
                }
                divided={Boolean(control.model)}
                styles={styles}
                colors={colors}
                onPress={() => {
                  tapLight();
                  setPairSheetOpen(true);
                }}
              />
            </View>
          </>
        ) : null}

        {signedIn ? (
          <>
            <Text style={local.subLabel}>
              {t("mobile.settings.pairedSection")}
            </Text>
            <View style={styles.group}>
              {pairedDesktops.length === 0 ? (
                <Text style={styles.hint}>
                  {t("mobile.settings.pairedEmpty")}
                </Text>
              ) : (
                pairedDesktops.map((access, index) => {
                  const label = platformLabelFor(
                    t,
                    access,
                    desktopPlatforms[access.desktopDeviceId],
                  );
                  const removing =
                    removingDesktopId === access.desktopDeviceId;
                  return (
                    <View
                      key={access.desktopDeviceId}
                      style={[styles.row, index > 0 && styles.rowDivider]}
                    >
                      <View style={styles.rowCopy}>
                        <Text style={styles.rowLabel}>{label}</Text>
                        <Text style={styles.rowSub}>
                          {t("mobile.settings.pairedOn", {
                            date: new Date(
                              access.approvedAt,
                            ).toLocaleDateString(undefined, {
                              month: "short",
                              day: "numeric",
                            }),
                          })}
                        </Text>
                      </View>
                      <Pressable
                        onPress={() => confirmForgetDesktop(access)}
                        disabled={removing}
                        hitSlop={8}
                        accessibilityLabel={t("mobile.settings.forgetLabel", {
                          name: label,
                        })}
                        style={({ pressed }) => [
                          (pressed || removing) && local.pressed,
                        ]}
                      >
                        <Text style={local.forgetText}>
                          {removing ? "…" : t("mobile.settings.forget")}
                        </Text>
                      </Pressable>
                    </View>
                  );
                })
              )}
            </View>
          </>
        ) : null}
      </View>

      {control ? (
        <>
          {control.model ? (
            <ComputerSettingsSheet
              visible={modelSheetOpen}
              onClose={() => setModelSheetOpen(false)}
              access={control.access}
              catalog={control.model.catalog}
              onApplied={control.model.onApplied}
              composerModelPinned={control.composerModelPinned}
              onComposerModelPinnedChange={
                control.onComposerModelPinnedChange
              }
            />
          ) : null}
          <PairPhoneSheet
            visible={pairSheetOpen}
            onClose={() => setPairSheetOpen(false)}
            onPaired={(next) => {
              setPairSheetOpen(false);
              control.onRepaired(next);
            }}
            preferredAccess={control.access}
            pairedDesktops={control.pairedDesktops}
            onSwitchDesktop={control.onRepaired}
          />
        </>
      ) : null}
    </>
  );
}

function NavRow({
  icon,
  label,
  trailing,
  divided = false,
  styles,
  colors,
  onPress,
}: {
  icon: IconName;
  label: string;
  trailing?: string;
  divided?: boolean;
  styles: SettingsStyles;
  colors: Colors;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.row,
        divided && styles.rowDivider,
        pressed && styles.rowPressed,
      ]}
    >
      <Icon
        name={icon}
        size={18}
        color={colors.textMuted}
        style={styles.rowIcon}
      />
      <Text style={[styles.rowLabel, { flex: 1 }]}>{label}</Text>
      {trailing ? (
        <Text style={styles.rowTrailing} numberOfLines={1}>
          {trailing}
        </Text>
      ) : null}
      <Icon name="chevron-right" size={15} color={colors.textMuted} />
    </Pressable>
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
    flex: {
      flex: 1,
    },
    groupBottomGap: {
      marginBottom: 4,
    },
    subLabel: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 12,
      letterSpacing: 0.2,
      marginBottom: 8,
      marginLeft: 4,
      marginTop: 16,
    },
    statusRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 6,
    },
    statusDot: {
      borderRadius: 3,
      height: 6,
      width: 6,
    },
    pressed: {
      opacity: 0.6,
    },
    forgetText: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
      letterSpacing: -0.1,
    },
  });
