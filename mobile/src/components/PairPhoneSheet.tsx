import { useCallback, useState } from "react";
import {
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  completePhonePairing,
  setPreferredDesktopDeviceId,
  type StoredPhoneAccess,
} from "../lib/phone-access";
import { notifyError, notifySuccess } from "../lib/haptics";
import { userFacingError } from "../lib/user-facing-error";
import { type Colors } from "../theme/colors";
import { useColors } from "../theme/theme-context";
import { fadeHex } from "../theme/oklch";
import { fonts } from "../theme/fonts";
import { GlassCard } from "./glass";
import { PairingQrScanner } from "./PairingQrScanner";

const PAIRING_CODE_LENGTH = 8;

const normalizePairingCode = (value: string) =>
  value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, PAIRING_CODE_LENGTH);

const shortDesktopId = (id: string) => id.slice(0, 4).toUpperCase();

const desktopChipLabel = (
  access: StoredPhoneAccess,
  platform: string | null | undefined,
  showSuffix: boolean,
): string => {
  const base = platform?.trim() || "Computer";
  return showSuffix ? `${base} · ${shortDesktopId(access.desktopDeviceId)}` : base;
};

type Props = {
  visible: boolean;
  onClose: () => void;
  /** Called with the new access once pairing succeeds. */
  onPaired: (access: StoredPhoneAccess) => void;
  /** When set, the sheet frames the flow as adding another computer. */
  preferredAccess?: StoredPhoneAccess | null;
  /** Other already-paired computers, for switching between them. */
  pairedDesktops?: StoredPhoneAccess[];
  desktopPlatforms?: Record<string, string | null>;
  onSwitchDesktop?: (access: StoredPhoneAccess) => void;
};

/**
 * Self-contained phone↔desktop pairing sheet (QR scan + manual code), shared
 * by the Computer chat and the desktop (View computer) screen so neither has
 * to bounce the user to a separate pairing screen.
 */
export function PairPhoneSheet({
  visible,
  onClose,
  onPaired,
  preferredAccess,
  pairedDesktops = [],
  desktopPlatforms = {},
  onSwitchDesktop,
}: Props) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [pairingCode, setPairingCode] = useState("");
  const [isPairing, setIsPairing] = useState(false);
  const [isScanningQr, setIsScanningQr] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pair = useCallback(
    async (value?: string) => {
      const code = normalizePairingCode(value ?? pairingCode);
      if (!code) {
        setError("Enter the code shown on your computer.");
        return;
      }
      setError(null);
      setIsPairing(true);
      try {
        const access = await completePhonePairing({ pairingCode: code });
        notifySuccess();
        setPairingCode("");
        onPaired(access);
      } catch (e) {
        notifyError();
        setError(userFacingError(e));
      } finally {
        setIsPairing(false);
      }
    },
    [onPaired, pairingCode],
  );

  return (
    <>
      <Modal
        visible={visible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={onClose}
      >
        <SafeAreaView style={styles.sheetSafe}>
          <View style={styles.sheetHandle} />
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>
              {preferredAccess ? "Pair another computer" : "Pair your phone"}
            </Text>
            <Pressable
              onPress={onClose}
              accessibilityLabel="Close pair sheet"
              style={styles.sheetClose}
            >
              <Text style={styles.sheetCloseText}>Done</Text>
            </Pressable>
          </View>
          <ScrollView
            contentContainerStyle={styles.sheetContent}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.sheetBody}>
              Open Stella on your computer and scan the QR code shown on the
              Pair phone screen. After this, your phone reconnects on its own.
            </Text>

            {error ? <Text style={styles.errorText}>{error}</Text> : null}

            {pairedDesktops.length > 1 && onSwitchDesktop ? (
              <View style={styles.switchDesktopRow}>
                <Text style={styles.inputLabel}>Paired computers</Text>
                <View style={styles.switchDesktopChips}>
                  {pairedDesktops.map((d) => {
                    const platform = desktopPlatforms[d.desktopDeviceId] ?? null;
                    const samePlatformCount = pairedDesktops.filter(
                      (other) =>
                        (desktopPlatforms[other.desktopDeviceId] ?? null) ===
                        platform,
                    ).length;
                    return (
                      <Pressable
                        key={d.desktopDeviceId}
                        onPress={() => {
                          void setPreferredDesktopDeviceId(d.desktopDeviceId);
                          onSwitchDesktop(d);
                        }}
                        accessibilityLabel={`Switch to ${desktopChipLabel(d, platform, true)}`}
                        style={({ pressed }) => [
                          styles.desktopChip,
                          pressed && styles.desktopChipPressed,
                          preferredAccess?.desktopDeviceId === d.desktopDeviceId
                            ? styles.desktopChipActive
                            : null,
                        ]}
                      >
                        <Text style={styles.desktopChipText}>
                          {desktopChipLabel(d, platform, samePlatformCount > 1)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ) : null}

            <Pressable
              onPress={() => setIsScanningQr(true)}
              disabled={isPairing}
              accessibilityLabel="Scan pairing QR code"
              style={({ pressed }) => [
                styles.actionButton,
                pressed && styles.actionButtonPressed,
                isPairing && styles.actionButtonDisabled,
              ]}
            >
              <Text style={styles.actionButtonText}>Scan QR code</Text>
            </Pressable>

            <View style={styles.manualCodeBlock}>
              <Text style={styles.manualCodeLabel}>or enter code manually</Text>
              <GlassCard radius={14} ringed legible>
                <TextInput
                  autoCapitalize="characters"
                  autoCorrect={false}
                  keyboardType="ascii-capable"
                  maxFontSizeMultiplier={1.2}
                  maxLength={PAIRING_CODE_LENGTH}
                  onChangeText={(value) =>
                    setPairingCode(normalizePairingCode(value))
                  }
                  onSubmitEditing={() => void pair()}
                  placeholder="ABCDEFGH"
                  placeholderTextColor={fadeHex(colors.textMuted, 0.3)}
                  returnKeyType="go"
                  style={styles.manualCodeInput}
                  textContentType="oneTimeCode"
                  value={pairingCode}
                />
              </GlassCard>
              <Pressable
                onPress={() => void pair()}
                disabled={isPairing || pairingCode.length === 0}
                accessibilityLabel="Submit pairing code"
                style={({ pressed }) => [
                  styles.manualCodeSubmit,
                  pressed && styles.manualCodeSubmitPressed,
                  (isPairing || pairingCode.length === 0) &&
                    styles.manualCodeSubmitDisabled,
                ]}
              >
                <Text style={styles.manualCodeSubmitText}>
                  {isPairing ? "Pairing\u2026" : "Pair with code"}
                </Text>
              </Pressable>
            </View>
          </ScrollView>
        </SafeAreaView>

        {/*
          The scanner must be nested inside this Modal, not rendered as a
          sibling: on iOS a sibling Modal can't present while the pageSheet
          is already up, so its content mounts (and the camera even scans)
          without any visible preview. Nesting makes iOS present the
          full-screen scanner from the sheet's view controller.
        */}
        <PairingQrScanner
          visible={isScanningQr}
          onClose={() => setIsScanningQr(false)}
          onCodeScanned={(code) => {
            setIsScanningQr(false);
            // Scanning is unambiguous — pair immediately rather than dropping
            // the code into the manual field for a second confirmation tap.
            void pair(code);
          }}
        />
      </Modal>
    </>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    sheetSafe: {
      backgroundColor: colors.background,
      // Soft hairline on the leading (top) edge so the sheet reads against
      // the page beneath, matching the TopSheet primitive's edge treatment.
      borderTopColor: colors.border,
      borderTopWidth: StyleSheet.hairlineWidth,
      flex: 1,
    },
    sheetHandle: {
      alignSelf: "center",
      backgroundColor: colors.border,
      borderRadius: 3,
      height: 5,
      marginTop: 8,
      width: 40,
    },
    sheetHeader: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
      paddingHorizontal: 20,
      paddingTop: 12,
    },
    sheetTitle: {
      color: colors.text,
      flex: 1,
      fontFamily: fonts.sans.semiBold,
      fontSize: 18,
      letterSpacing: -0.4,
    },
    sheetClose: {
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    sheetCloseText: {
      color: colors.accent,
      fontFamily: fonts.sans.semiBold,
      fontSize: 16,
    },
    sheetContent: {
      gap: 18,
      paddingBottom: 36,
      paddingHorizontal: 24,
      paddingTop: 16,
    },
    sheetBody: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 15,
      letterSpacing: -0.2,
      lineHeight: 22,
    },
    errorText: {
      color: colors.danger,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      lineHeight: 20,
    },
    switchDesktopRow: {
      gap: 8,
      paddingHorizontal: 4,
    },
    switchDesktopChips: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
    },
    desktopChip: {
      borderColor: colors.border,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    desktopChipPressed: {
      opacity: 0.85,
    },
    desktopChipActive: {
      borderColor: colors.accent,
      backgroundColor: colors.panel,
    },
    desktopChipText: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
    },
    inputLabel: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
      letterSpacing: 0.2,
      textAlign: "center",
    },
    actionButton: {
      alignItems: "center",
      backgroundColor: colors.accent,
      borderRadius: 22,
      justifyContent: "center",
      minHeight: 44,
      paddingHorizontal: 24,
      paddingVertical: 12,
    },
    actionButtonPressed: {
      opacity: 0.8,
    },
    actionButtonDisabled: {
      opacity: 0.65,
    },
    actionButtonText: {
      color: colors.accentForeground,
      fontFamily: fonts.sans.semiBold,
      fontSize: 15,
      letterSpacing: -0.3,
    },
    manualCodeBlock: {
      alignItems: "stretch",
      gap: 10,
      marginTop: 24,
    },
    manualCodeLabel: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      letterSpacing: -0.1,
      textAlign: "center",
    },
    manualCodeInput: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 22,
      letterSpacing: 6,
      paddingHorizontal: 14,
      paddingVertical: 16,
      textAlign: "center",
    },
    manualCodeSubmit: {
      alignItems: "center",
      borderColor: colors.border,
      borderRadius: 22,
      borderWidth: StyleSheet.hairlineWidth,
      justifyContent: "center",
      minHeight: 44,
      paddingHorizontal: 20,
      paddingVertical: 12,
    },
    manualCodeSubmitPressed: {
      opacity: 0.8,
    },
    manualCodeSubmitDisabled: {
      opacity: 0.45,
    },
    manualCodeSubmitText: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
      letterSpacing: -0.2,
    },
  });
