import { useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  CameraView,
  useCameraPermissions,
  type BarcodeScanningResult,
} from "expo-camera";
import { Icon } from "./Icon";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type Colors } from "../theme/colors";
import { useColors } from "../theme/theme-context";
import { fonts } from "../theme/fonts";
import { notifySuccess } from "../lib/haptics";

type PairingQrScannerProps = {
  visible: boolean;
  onClose: () => void;
  onCodeScanned: (code: string) => void;
};

/**
 * Pull the pairing code out of a QR payload. The desktop mints QRs that
 * encode `stella-mobile://stella?code=<CODE>`, but we also accept a bare
 * 12-char code in case anyone pastes that in.
 */
function extractPairingCode(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const codeMatch = trimmed.match(/[?&]code=([A-Za-z0-9]+)/);
  if (codeMatch?.[1]) {
    return codeMatch[1].toUpperCase().slice(0, 12);
  }

  if (/^[A-Za-z0-9]{4,12}$/.test(trimmed)) {
    return trimmed.toUpperCase();
  }

  return null;
}

export function PairingQrScanner({
  visible,
  onClose,
  onCodeScanned,
}: PairingQrScannerProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [permission, requestPermission] = useCameraPermissions();
  const handledRef = useRef(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) {
      handledRef.current = false;
      setErrorMessage(null);
      return;
    }
    if (!permission) {
      return;
    }
    if (!permission.granted && permission.canAskAgain) {
      void requestPermission();
    }
  }, [permission, requestPermission, visible]);

  const handleBarcode = (result: BarcodeScanningResult) => {
    if (handledRef.current) {
      return;
    }
    const code = extractPairingCode(result.data);
    if (!code) {
      setErrorMessage("That QR code isn't a Stella pairing code.");
      return;
    }
    handledRef.current = true;
    notifySuccess();
    onCodeScanned(code);
  };

  const renderBody = () => {
    if (!permission) {
      return null;
    }

    if (!permission.granted) {
      return (
        <View style={styles.permissionBlock}>
          <Text style={styles.permissionTitle}>Camera access needed</Text>
          <Text style={styles.permissionBody}>
            Stella uses the camera to scan the pairing QR code shown on your
            computer.
          </Text>
          {permission.canAskAgain ? (
            <Pressable
              style={({ pressed }) => [
                styles.permissionButton,
                pressed && styles.permissionButtonPressed,
              ]}
              onPress={() => void requestPermission()}
            >
              <Text style={styles.permissionButtonText}>Allow camera</Text>
            </Pressable>
          ) : (
            <Text style={styles.permissionHint}>
              Enable camera access for Stella in Settings.
            </Text>
          )}
        </View>
      );
    }

    return (
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={handleBarcode}
      />
    );
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <View style={styles.root}>
        {renderBody()}

        <View
          pointerEvents="none"
          style={[styles.frameOverlay, { top: insets.top + 96 }]}
        >
          <View style={styles.frame} />
          <Text style={styles.frameLabel}>
            Point at the QR code on your computer
          </Text>
          {errorMessage ? (
            <Text style={styles.frameError}>{errorMessage}</Text>
          ) : null}
        </View>

        <Pressable
          style={({ pressed }) => [
            styles.closeButton,
            { top: insets.top + 16 },
            pressed && styles.closeButtonPressed,
          ]}
          hitSlop={12}
          onPress={onClose}
        >
          <Icon name="x" size={22} color="#ffffff" weight="semibold" />
        </Pressable>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    root: {
      backgroundColor: "#000000",
      flex: 1,
    },
    closeButton: {
      alignItems: "center",
      backgroundColor: "rgba(0,0,0,0.45)",
      borderRadius: 22,
      height: 44,
      justifyContent: "center",
      left: 16,
      position: "absolute",
      width: 44,
    },
    closeButtonPressed: {
      opacity: 0.8,
    },
    frameOverlay: {
      alignItems: "center",
      left: 0,
      position: "absolute",
      right: 0,
    },
    frame: {
      borderColor: "rgba(255,255,255,0.9)",
      borderRadius: 24,
      borderWidth: 2,
      height: 260,
      width: 260,
    },
    frameLabel: {
      color: "#ffffff",
      fontFamily: fonts.sans.medium,
      fontSize: 15,
      letterSpacing: -0.2,
      marginTop: 20,
      maxWidth: 280,
      textAlign: "center",
    },
    frameError: {
      color: "#ff8989",
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      marginTop: 8,
      maxWidth: 280,
      textAlign: "center",
    },
    permissionBlock: {
      alignItems: "center",
      flex: 1,
      gap: 12,
      justifyContent: "center",
      paddingHorizontal: 32,
    },
    permissionTitle: {
      color: "#ffffff",
      fontFamily: fonts.display.regular,
      fontSize: 22,
      letterSpacing: -0.6,
      textAlign: "center",
    },
    permissionBody: {
      color: "rgba(255,255,255,0.78)",
      fontFamily: fonts.sans.regular,
      fontSize: 15,
      lineHeight: 22,
      textAlign: "center",
    },
    permissionHint: {
      color: "rgba(255,255,255,0.6)",
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      textAlign: "center",
    },
    permissionButton: {
      backgroundColor: colors.accent,
      borderRadius: 22,
      marginTop: 12,
      minHeight: 44,
      paddingHorizontal: 22,
      paddingVertical: 12,
    },
    permissionButtonPressed: {
      opacity: 0.85,
    },
    permissionButtonText: {
      color: colors.accentForeground,
      fontFamily: fonts.sans.semiBold,
      fontSize: 15,
      letterSpacing: -0.2,
    },
  } as const);
