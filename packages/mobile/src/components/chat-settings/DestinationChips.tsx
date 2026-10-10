import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type AlertButton,
} from "react-native";
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
} from "../settings/computer-actions";
import {
  buildComputerRows,
  type ComputerRow,
  type ComputerRowStatusKind,
} from "../settings/computer-rows";

/** Live presence goes stale quickly; refresh while the sheet is on screen. */
const EXECUTION_DEVICE_POLL_MS = 15_000;

const STATUS_KEYS: Readonly<Record<ComputerRowStatusKind, string>> = {
  online: "mobile.settings.computer.statusOnline",
  notReady: "mobile.settings.computer.statusNotReady",
  notEnabled: "mobile.settings.computer.statusNotEnabled",
  awaitingConsent: "mobile.settings.computer.statusAwaitingConsent",
  declined: "mobile.settings.computer.statusDeclined",
  offline: "mobile.settings.computer.statusOffline",
};

export type DestinationSummary = {
  /** The picked computer's name, or `null` while turns run in the cloud. */
  deviceLabel: string | null;
};

/**
 * Where the chat's turns run, as one horizontal row of chips: pair, Cloud,
 * then every computer on the account.
 *
 * The list is the account's device list rather than this phone's pairings, so
 * a computer the owner has never paired with this phone still appears. A chip
 * says whether that computer can take work right now; one that can't is not a
 * choice, so tapping it explains why and offers what this phone can do about
 * it (Enable, Forget). Running work on a computer is consent, and only the
 * Enable tap here (or the prompt on that computer's own screen) grants it.
 */
export function DestinationChips({
  control,
  signedIn,
  onSummaryChange,
}: {
  control: ComputerControl | null;
  signedIn: boolean;
  onSummaryChange?: (summary: DestinationSummary) => void;
}) {
  const colors = useColors();
  const t = useT();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const focused = useIsFocused();
  const [pairSheetOpen, setPairSheetOpen] = useState(false);
  const [destinations, setDestinations] = useState<
    ExecutionDeviceDestination[] | undefined
  >(undefined);
  const [pairedDesktops, setPairedDesktops] = useState<StoredPhoneAccess[]>([]);
  const [busy, setBusy] = useState<{
    deviceId: string;
    kind: "connecting" | "enabling" | "forgetting";
  } | null>(null);

  const refreshPaired = useCallback(async () => {
    setPairedDesktops(await listStoredPairedPhoneAccess());
  }, []);
  const chatPaired = control?.pairedDesktops;
  useEffect(() => {
    void refreshPaired();
  }, [refreshPaired, chatPaired]);

  // Presence is a poll while the sheet is on screen, and only ever a read:
  // nothing here may move a computer's consent, however often it runs.
  const canListDevices = control !== null || signedIn;
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
          // A failed read keeps the last good list rather than painting an
          // outage nobody reported.
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

  // A paired computer missing from the owner's device list reads as offline
  // forever. The two id spaces can drift, so log each distinct miss once.
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

  const target = control?.executionTarget ?? { mode: "cloud" as const };
  const rows = buildComputerRows({
    devices: destinations,
    stored: pairedDesktops,
    activeDeviceId: control?.access?.desktopDeviceId ?? null,
  });
  const labelFor = (row: ComputerRow) =>
    row.label?.replace(/\.local$/i, "") ||
    t("mobile.settings.paired.unnamedComputer", {
      id: row.deviceId.slice(0, 4).toUpperCase(),
    });
  const statusTextFor = (row: ComputerRow) => {
    if (busy?.deviceId === row.deviceId) {
      if (busy.kind === "enabling") return t("mobile.settings.computer.enabling");
      if (busy.kind === "connecting") {
        return t("mobile.settings.computer.connecting");
      }
    }
    if (row.preferActiveStatusLabel && control) return control.statusLabel;
    return t(STATUS_KEYS[row.statusKind]);
  };
  // A computer that can't take work isn't a real choice, so Cloud carries
  // the check (and the turn) whenever the picked computer is unavailable.
  const selectedRow =
    target.mode === "device"
      ? rows.find((row) => row.deviceId === target.deviceId && row.available)
      : undefined;
  const selectedLabel = selectedRow ? labelFor(selectedRow) : null;

  const summaryRef = useRef(onSummaryChange);
  summaryRef.current = onSummaryChange;
  useEffect(() => {
    summaryRef.current?.({ deviceLabel: selectedLabel });
  }, [selectedLabel]);

  if (!control && !signedIn) return null;

  const choose = (next: AutomaticExecutionTarget) => {
    if (!control) return;
    tapLight();
    control.onExecutionTargetChange(next);
  };

  /**
   * Pick a computer, attaching this phone to it first when it holds no
   * credential for it. That is a transport credential and nothing else: an
   * unconsented computer is not selectable in the first place.
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

  /** Say yes on this computer's behalf; only ever from a tap. */
  const enableComputer = (row: ComputerRow) => {
    tapLight();
    setBusy({ deviceId: row.deviceId, kind: "enabling" });
    void enableRemoteExecution(row.deviceId)
      .then((result) => {
        setDestinations((current) =>
          applyRemoteExecution(current, row.deviceId, result.remoteExecution),
        );
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

  const confirmForget = (access: StoredPhoneAccess, label: string) => {
    Alert.alert(
      t("mobile.settings.forgetConfirmTitle", { name: label }),
      t("mobile.settings.forgetConfirmBody"),
      [
        { text: t("mobile.common.cancel"), style: "cancel" },
        {
          text: t("mobile.settings.forget"),
          style: "destructive",
          onPress: () => {
            setBusy({ deviceId: access.desktopDeviceId, kind: "forgetting" });
            void clearStoredPhoneAccess(access.desktopDeviceId)
              .then(() => refreshPaired())
              .finally(() => setBusy(null));
          },
        },
      ],
    );
  };

  /** What this phone can do about a computer: Enable, Forget, or nothing. */
  const explain = (row: ComputerRow) => {
    const label = labelFor(row);
    const buttons: AlertButton[] = [];
    if (row.canEnable) {
      buttons.push({
        text: t("mobile.settings.computer.enable"),
        onPress: () => enableComputer(row),
      });
    }
    const access = row.access;
    if (access) {
      buttons.push({
        text: t("mobile.settings.forget"),
        style: "destructive",
        onPress: () => confirmForget(access, label),
      });
    }
    buttons.push({
      text: buttons.length ? t("mobile.common.cancel") : t("mobile.common.done"),
      style: "cancel",
    });
    Alert.alert(label, statusTextFor(row), buttons);
  };

  const cloudSelected = !selectedRow;

  return (
    <>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.scroller}
        contentContainerStyle={styles.row}
      >
        {control ? (
          <Pressable
            onPress={() => {
              tapLight();
              setPairSheetOpen(true);
            }}
            accessibilityRole="button"
            accessibilityLabel={t("mobile.settings.computer.pairingCode")}
            style={({ pressed }) => [
              styles.chip,
              styles.addChip,
              pressed && styles.pressed,
            ]}
          >
            <Icon name="plus" size={18} color={colors.text} />
          </Pressable>
        ) : null}

        <Chip
          icon="globe"
          label={t("mobile.settings.computer.cloud")}
          selected={cloudSelected}
          available
          disabled={!control}
          onPress={() => choose({ mode: "cloud" })}
          styles={styles}
          colors={colors}
        />

        {rows.map((row) => {
          const working = busy?.deviceId === row.deviceId;
          const label = labelFor(row);
          return (
            <Chip
              key={row.deviceId}
              icon="monitor"
              label={label}
              statusText={statusTextFor(row)}
              selected={selectedRow?.deviceId === row.deviceId}
              available={row.available}
              working={working}
              disabled={!control || working}
              onPress={() =>
                row.available ? selectComputer(row) : explain(row)
              }
              onLongPress={() => explain(row)}
              styles={styles}
              colors={colors}
            />
          );
        })}
      </ScrollView>

      {control ? (
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
      ) : null}
    </>
  );
}

function Chip({
  icon,
  label,
  statusText,
  selected,
  available,
  working = false,
  disabled = false,
  onPress,
  onLongPress,
  styles,
  colors,
}: {
  icon: IconName;
  label: string;
  statusText?: string;
  selected: boolean;
  available: boolean;
  working?: boolean;
  disabled?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
  styles: ReturnType<typeof makeStyles>;
  colors: Colors;
}) {
  const tint = selected ? colors.accent : available ? colors.text : colors.textMuted;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={statusText ? `${label}, ${statusText}` : label}
      accessibilityState={{ selected, disabled }}
      style={({ pressed }) => [
        styles.chip,
        selected && styles.chipSelected,
        pressed && styles.pressed,
      ]}
    >
      <Icon name={icon} size={16} color={tint} />
      <Text
        style={[
          styles.chipLabel,
          { color: tint },
          selected && styles.chipLabelSelected,
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
      {working ? (
        <ActivityIndicator size="small" color={colors.textMuted} />
      ) : statusText !== undefined && !selected ? (
        <View
          style={[
            styles.dot,
            { backgroundColor: available ? colors.ok : colors.textWeaker },
          ]}
        />
      ) : null}
    </Pressable>
  );
}

const CHIP_HEIGHT = 40;

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    scroller: {
      flexGrow: 0,
      marginHorizontal: -16,
    },
    row: {
      gap: 8,
      paddingHorizontal: 16,
    },
    chip: {
      alignItems: "center",
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 7,
      height: CHIP_HEIGHT,
      paddingHorizontal: 13,
    },
    addChip: {
      justifyContent: "center",
      paddingHorizontal: 0,
      width: CHIP_HEIGHT,
    },
    chipSelected: {
      backgroundColor: colors.accentSoft,
      borderColor: colors.selectBorder,
    },
    chipLabel: {
      fontFamily: fonts.sans.medium,
      fontSize: 14,
      letterSpacing: -0.2,
      maxWidth: 170,
    },
    chipLabelSelected: {
      fontFamily: fonts.sans.semiBold,
    },
    dot: {
      borderRadius: 3.5,
      height: 7,
      width: 7,
    },
    pressed: {
      opacity: 0.6,
    },
  });
