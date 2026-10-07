import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useIsFocused } from "expo-router";
import { Icon, type IconName } from "../Icon";
import { PairPhoneSheet } from "../PairPhoneSheet";
import {
  listExecutionDevices,
  type AutomaticExecutionTarget,
  type ExecutionDeviceDestination,
} from "../../lib/execution-placement";
import { tapLight } from "../../lib/haptics";
import type { ComputerControl } from "../../lib/main-shell-store";
import {
  clearStoredPhoneAccess,
  ensurePhoneAccess,
  listStoredPairedPhoneAccess,
  type StoredPhoneAccess,
} from "../../lib/phone-access";
import { userFacingError } from "../../lib/user-facing-error";
import { useT } from "../../i18n";
import type { Colors } from "../../theme/colors";
import { fonts } from "../../theme/fonts";
import { useColors } from "../../theme/theme-context";
import {
  applyRemoteExecution,
  enableRemoteExecution,
} from "./computer-actions";
import {
  buildComputerRows,
  type ComputerRow,
  type ComputerRowStatusKind,
} from "./computer-rows";
import type { SettingsStyles } from "./settings-styles";

/** Live presence goes stale quickly; refresh while Settings is on screen. */
const EXECUTION_DEVICE_POLL_MS = 15_000;

const STATUS_KEYS: Readonly<Record<ComputerRowStatusKind, string>> = {
  online: "mobile.settings.computer.statusOnline",
  notReady: "mobile.settings.computer.statusNotReady",
  notEnabled: "mobile.settings.computer.statusNotEnabled",
  awaitingConsent: "mobile.settings.computer.statusAwaitingConsent",
  declined: "mobile.settings.computer.statusDeclined",
  offline: "mobile.settings.computer.statusOffline",
};

function fallbackLabelFor(
  t: (key: string, params?: Record<string, string | number>) => string,
  deviceId: string,
): string {
  return t("mobile.settings.paired.unnamedComputer", {
    id: deviceId.slice(0, 4).toUpperCase(),
  });
}

/**
 * Settings' Computer section: where turns run, the model, and every computer
 * signed into this account.
 *
 * The list is the account's device list rather than this phone's pairings, so
 * a computer the owner has never paired with this phone still appears — with
 * what it is doing about dispatched work, which is a separate fact from being
 * listed. Reaching one is a credential this phone attaches on demand; running
 * work there is consent, and only the Enable tap below (or the prompt on that
 * computer's own screen) grants it.
 *
 * The live state belongs to the chat (which stays mounted under every tab) and
 * arrives as `control`; it is `null` until the chat has resolved its access.
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
  const [pairSheetOpen, setPairSheetOpen] = useState(false);
  const [destinations, setDestinations] = useState<
    ExecutionDeviceDestination[] | undefined
  >(undefined);
  const [pairedDesktops, setPairedDesktops] = useState<StoredPhoneAccess[]>([]);
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
  // Settings is on screen rather than a backend subscription. It is a read:
  // nothing here may move a computer's consent, however often it runs.
  const hasControl = control !== null;
  const canListDevices = hasControl || signedIn;
  const [refreshToken, setRefreshToken] = useState(0);
  useEffect(() => {
    if (!focused || !canListDevices) return;
    let active = true;
    const controller = new AbortController();
    const read = () => {
      void listExecutionDevices({ signal: controller.signal })
        .then((devices) => {
          if (active) setDestinations(devices);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          // Deliberately no `setDestinations`: a failed read must not
          // overwrite the last good answer, and must never be rendered as
          // an outage we were not actually told about.
          console.warn(
            "[execution-devices] presence read failed; keeping the last good device list",
            error,
          );
        });
    };
    read();
    const timer = setInterval(read, EXECUTION_DEVICE_POLL_MS);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [focused, canListDevices, refreshToken]);

  // A paired computer that never appears in the owner's device list reads as
  // offline forever, which is silent. The join is between two id spaces (the
  // stored pairing id and the presence id), so if they ever drift nothing
  // would surface it. Log both sides once per distinct miss so the mismatch is
  // greppable instead of invisible.
  const reportedJoinMissRef = useRef("");
  useEffect(() => {
    if (destinations === undefined) return;
    const present = new Set(destinations.map((device) => device.deviceId));
    const missing = pairedDesktops
      .map((access) => access.desktopDeviceId)
      .filter((id) => !present.has(id));
    const signature = missing.join(",");
    if (signature === reportedJoinMissRef.current) return;
    reportedJoinMissRef.current = signature;
    if (missing.length === 0) return;
    console.warn(
      "[execution-devices] paired computer absent from the owner's device list. " +
        `paired=[${missing.join(", ")}] returned=[${destinations
          .map((device) => device.deviceId)
          .join(", ")}]`,
    );
  }, [destinations, pairedDesktops]);

  // One computer at a time is mid-operation, and which operation it is decides
  // the status line while it runs.
  const [busy, setBusy] = useState<{
    deviceId: string;
    kind: "connecting" | "enabling";
  } | null>(null);

  const confirmForgetDesktop = (access: StoredPhoneAccess, label: string) => {
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
            void clearStoredPhoneAccess(access.desktopDeviceId)
              .then(() => refreshPaired())
              .finally(() => setRemovingDesktopId(null));
          },
        },
      ],
    );
  };

  // Nothing to show until the chat has resolved its access (or for a guest).
  if (!control && !signedIn) return null;

  const target = control?.executionTarget ?? { mode: "cloud" as const };
  const rows = buildComputerRows({
    devices: destinations,
    stored: pairedDesktops,
    activeDeviceId: control?.access?.desktopDeviceId ?? null,
  });
  const labelFor = (row: ComputerRow) =>
    row.label ?? fallbackLabelFor(t, row.deviceId);
  const statusTextFor = (row: ComputerRow) => {
    if (busy?.deviceId === row.deviceId) {
      return busy.kind === "enabling"
        ? t("mobile.settings.computer.enabling")
        : t("mobile.settings.computer.connecting");
    }
    if (row.preferActiveStatusLabel && control) return control.statusLabel;
    return t(STATUS_KEYS[row.statusKind]);
  };
  // A computer that can't take work isn't a real choice, so Cloud carries
  // the check (and the turn) whenever the picked computer is unavailable.
  const selectedDeviceId =
    target.mode === "device" &&
    rows.some((row) => row.deviceId === target.deviceId && row.available)
      ? target.deviceId
      : null;
  const choose = (next: AutomaticExecutionTarget) => {
    if (!control) return;
    tapLight();
    control.onExecutionTargetChange(next);
  };
  /**
   * Pick a computer, attaching this phone to it first when it holds no
   * credential for it. That is a transport credential and nothing else: the
   * computer still has to have agreed to run work, which is why an
   * unconsented row is not selectable in the first place.
   */
  const selectComputer = (row: ComputerRow) => {
    if (!control) return;
    if (row.access) {
      choose({ mode: "device", deviceId: row.deviceId });
      return;
    }
    tapLight();
    setBusy({ deviceId: row.deviceId, kind: "connecting" });
    void ensurePhoneAccess(row.deviceId)
      .then(async (access) => {
        control.onRepaired(access);
        control.onExecutionTargetChange({
          mode: "device",
          deviceId: row.deviceId,
        });
        await refreshPaired();
      })
      .catch((error: unknown) => {
        Alert.alert(
          t("mobile.settings.computer.connectFailedTitle"),
          userFacingError(error),
        );
      })
      .finally(() => setBusy(null));
  };
  /**
   * Say yes on this computer's behalf from a session that is already signed
   * into the account, instead of waiting for the prompt on its own screen.
   * This is the only thing on this screen that may change consent, and it
   * only ever runs from a tap.
   */
  const enableComputer = (row: ComputerRow) => {
    tapLight();
    setBusy({ deviceId: row.deviceId, kind: "enabling" });
    void enableRemoteExecution(row.deviceId)
      .then((result) => {
        setDestinations((current) =>
          applyRemoteExecution(current, row.deviceId, result.remoteExecution),
        );
        // Readiness is the device's own report, so re-read rather than guess.
        setRefreshToken((value) => value + 1);
      })
      .catch((error: unknown) => {
        Alert.alert(
          t("mobile.settings.computer.enableFailedTitle"),
          userFacingError(error),
        );
      })
      .finally(() => setBusy(null));
  };

  return (
    <>
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>
          {t("mobile.settings.computer.sectionLabel")}
        </Text>

        <View style={styles.group}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: selectedDeviceId === null }}
            disabled={!control}
            onPress={() => choose({ mode: "cloud" })}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          >
            <Icon
              name="globe"
              size={18}
              color={colors.textMuted}
              style={styles.rowIcon}
            />
            <Text style={[styles.rowLabel, local.flex]}>
              {t("mobile.settings.computer.cloud")}
            </Text>
            {selectedDeviceId === null ? (
              <Icon name="check" size={17} color={colors.accent} />
            ) : null}
          </Pressable>

          {rows.map((row) => {
            const removing = removingDesktopId === row.deviceId;
            const working = busy?.deviceId === row.deviceId;
            const label = labelFor(row);
            const access = row.access;
            return (
              <Pressable
                key={row.deviceId}
                accessibilityRole="button"
                accessibilityState={{
                  selected: selectedDeviceId === row.deviceId,
                  disabled: !row.available,
                }}
                disabled={!control || !row.available || working}
                onPress={() => selectComputer(row)}
                style={({ pressed }) => [
                  styles.row,
                  styles.rowDivider,
                  pressed && styles.rowPressed,
                ]}
              >
                <Icon
                  name="monitor"
                  size={18}
                  color={colors.textMuted}
                  style={styles.rowIcon}
                />
                <View style={[styles.rowCopy, !row.available && local.dim]}>
                  <Text style={styles.rowLabel} numberOfLines={1}>
                    {label}
                  </Text>
                  <Text style={styles.rowSub}>{statusTextFor(row)}</Text>
                </View>
                {row.canEnable ? (
                  <Pressable
                    onPress={() => enableComputer(row)}
                    disabled={working}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t(
                      "mobile.settings.computer.enableLabel",
                      {
                        name: label,
                      },
                    )}
                    style={({ pressed }) =>
                      (pressed || working) && local.pressed
                    }
                  >
                    <Text style={styles.rowAction}>
                      {t("mobile.settings.computer.enable")}
                    </Text>
                  </Pressable>
                ) : null}
                {selectedDeviceId === row.deviceId ? (
                  <Icon name="check" size={17} color={colors.accent} />
                ) : null}
                {access ? (
                  <Pressable
                    onPress={() => confirmForgetDesktop(access, label)}
                    disabled={removing}
                    hitSlop={8}
                    accessibilityLabel={t("mobile.settings.forgetLabel", {
                      name: label,
                    })}
                    style={({ pressed }) => [
                      local.remove,
                      (pressed || removing) && local.pressed,
                    ]}
                  >
                    <Icon name="trash" size={17} color={colors.textMuted} />
                  </Pressable>
                ) : null}
              </Pressable>
            );
          })}
        </View>

        {control ? (
          <View style={[styles.group, styles.groupGap]}>
            <NavRow
              icon="smartphone"
              label={t("mobile.settings.computer.pairingCode")}
              styles={styles}
              colors={colors}
              onPress={() => {
                tapLight();
                setPairSheetOpen(true);
              }}
            />
          </View>
        ) : null}
      </View>

      {control ? (
        <>
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
    pressed: {
      opacity: 0.6,
    },
    dim: {
      opacity: 0.55,
    },
    remove: {
      marginLeft: 14,
    },
    forgetText: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
      letterSpacing: -0.1,
    },
  });
