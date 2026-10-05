import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useIsFocused } from "expo-router";
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
  // Settings is on screen rather than a backend subscription.
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
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          // Deliberately no `setDestinations`: a failed read must not
          // overwrite the last good answer, and must never be rendered as
          // "offline". Rows fall back to `unknown` only while nothing has
          // ever landed.
          console.warn(
            "[execution-devices] presence read failed; reachability stays unknown rather than offline",
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
  }, [focused, hasControl]);

  // A paired computer that never appears in the owner's device list reads as
  // `unknown` forever, which is honest but silent. The join is between two id
  // spaces (the stored pairing id and the presence id), so if they ever drift
  // nothing would surface it. Log both sides once per distinct miss so the
  // mismatch is greppable instead of invisible.
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
      "[execution-devices] paired computer absent from the owner's device list; " +
        "treating reachability as unknown, not offline. " +
        `paired=[${missing.join(", ")}] returned=[${destinations
          .map((device) => device.deviceId)
          .join(", ")}]`,
    );
  }, [destinations, pairedDesktops]);

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

  const target = control?.executionTarget ?? { mode: "cloud" as const };
  const rows = computerRows({
    paired: pairedDesktops,
    destinations,
    labelFor: (access) =>
      platformLabelFor(t, access, desktopPlatforms[access.desktopDeviceId]),
  });
  // A computer known to be unable to take work isn't a real choice, so Cloud
  // carries the check (and the turn). A computer we simply haven't heard about
  // keeps the user's choice: a slow or failed poll must not reassign where
  // their work runs.
  const selectedDeviceId =
    target.mode === "device" &&
    rows.some(
      (row) => row.deviceId === target.deviceId && row.reach !== "unavailable",
    )
      ? target.deviceId
      : null;
  const choose = (next: AutomaticExecutionTarget) => {
    if (!control) return;
    tapLight();
    control.onExecutionTargetChange(next);
  };

  return (
    <>
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Where Stella works</Text>

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
            <Text style={[styles.rowLabel, local.flex]}>Cloud</Text>
            {selectedDeviceId === null ? (
              <Icon name="check" size={17} color={colors.accent} />
            ) : null}
          </Pressable>

          {rows.map((row) => {
            const removing = removingDesktopId === row.deviceId;
            return (
              <Pressable
                key={row.deviceId}
                accessibilityRole="button"
                accessibilityState={{
                  selected: selectedDeviceId === row.deviceId,
                  disabled: row.reach === "unavailable",
                }}
                disabled={!control || row.reach === "unavailable"}
                onPress={() =>
                  choose({ mode: "device", deviceId: row.deviceId })
                }
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
                {/* Ghosting carries reachability, so it only appears for a
                    computer we know can't take work. An unknown one renders
                    at full strength: dimming it would assert an outage we
                    haven't actually been told about. */}
                <View
                  style={[
                    styles.rowCopy,
                    row.reach === "unavailable" && local.dim,
                  ]}
                >
                  <Text style={styles.rowLabel} numberOfLines={1}>
                    {row.label}
                  </Text>
                </View>
                {selectedDeviceId === row.deviceId ? (
                  <Icon name="check" size={17} color={colors.accent} />
                ) : null}
                <Pressable
                  onPress={() => confirmForgetDesktop(row.access)}
                  disabled={removing}
                  hitSlop={8}
                  accessibilityLabel={t("mobile.settings.forgetLabel", {
                    name: row.label,
                  })}
                  style={({ pressed }) => [
                    local.remove,
                    (pressed || removing) && local.pressed,
                  ]}
                >
                  <Icon name="trash" size={17} color={colors.textMuted} />
                </Pressable>
              </Pressable>
            );
          })}
        </View>

        {control ? (
          <View style={[styles.group, styles.groupGap]}>
            <NavRow
              icon="smartphone"
              label={
                rows.length > 0 ? "Pair another computer" : "Pair a computer"
              }
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

/**
 * What this surface knows about a paired computer right now.
 *
 * `unknown` is not a quieter `unavailable`. It means we have no fresh answer:
 * the first presence read hasn't landed, the last one failed, or the computer
 * is absent from the owner's device list. Collapsing it into `unavailable`
 * would state a fact we don't hold — and would quietly move the user's saved
 * choice to Cloud because a request was slow.
 */
type Reachability = "ready" | "unavailable" | "unknown";

type ComputerRow = {
  deviceId: string;
  access: StoredPhoneAccess;
  label: string;
  reach: Reachability;
};

/** Every paired computer, reachable or not, with what it can do right now. */
function computerRows(props: {
  paired: StoredPhoneAccess[];
  destinations: ExecutionDeviceDestination[] | undefined;
  labelFor: (access: StoredPhoneAccess) => string;
}): ComputerRow[] {
  return props.paired.map((access) => {
    const deviceId = access.desktopDeviceId;
    const device = props.destinations?.find((d) => d.deviceId === deviceId);
    // No list yet (or the read failed), or a paired computer the list doesn't
    // mention: both are "we don't know", never "offline".
    const reach: Reachability =
      props.destinations === undefined || device === undefined
        ? "unknown"
        : device.online &&
            device.remoteExecutionEnabled &&
            device.availability?.ready === true
          ? "ready"
          : "unavailable";
    return {
      deviceId,
      access,
      label: device?.label ?? props.labelFor(access),
      reach,
    };
  });
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
