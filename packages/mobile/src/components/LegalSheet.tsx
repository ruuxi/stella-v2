import { useMemo } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  LEGAL_TITLES,
  PRIVACY_POLICY,
  TERMS_OF_SERVICE,
  type LegalDocument,
} from "../lib/legal-text";
import { type Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";
import { useColors } from "../theme/theme-context";
import { useT } from "../i18n";

/**
 * The Terms of Service or Privacy Policy in a page sheet. Shared by sign-in
 * and onboarding so the legal copy is presented one way.
 */
export function LegalSheet({
  document,
  onClose,
}: {
  document: LegalDocument | null;
  onClose: () => void;
}) {
  const colors = useColors();
  const t = useT();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <Modal
      visible={document !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.legalModal}>
        <View style={styles.legalModalHeader}>
          <Text style={styles.legalModalTitle}>
            {document ? LEGAL_TITLES[document] : ""}
          </Text>
          <Pressable onPress={onClose} style={styles.legalModalClose}>
            <Text style={styles.legalModalCloseText}>{t("mobile.common.done")}</Text>
          </Pressable>
        </View>
        <ScrollView
          style={styles.legalModalScroll}
          contentContainerStyle={styles.legalModalContent}
        >
          <Text style={styles.legalModalBody}>
            {document === "terms"
              ? TERMS_OF_SERVICE
              : document === "privacy"
                ? PRIVACY_POLICY
                : ""}
          </Text>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    legalModal: {
      flex: 1,
      backgroundColor: colors.background,
      // Soft hairline on the leading (top) edge so the sheet reads against the
      // page beneath, matching the TopSheet primitive's edge treatment.
      borderTopColor: colors.border,
      borderTopWidth: StyleSheet.hairlineWidth,
    },
    legalModalHeader: {
      alignItems: "center",
      borderBottomColor: colors.border,
      borderBottomWidth: 1,
      flexDirection: "row",
      justifyContent: "space-between",
      paddingHorizontal: 20,
      paddingVertical: 14,
    },
    legalModalTitle: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 18,
      letterSpacing: -0.4,
    },
    legalModalClose: {
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    legalModalCloseText: {
      color: colors.accent,
      fontFamily: fonts.sans.semiBold,
      fontSize: 16,
    },
    legalModalScroll: {
      flex: 1,
    },
    legalModalContent: {
      padding: 20,
      paddingBottom: 40,
    },
    legalModalBody: {
      color: colors.text,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      lineHeight: 20,
      opacity: 0.8,
    },
  });
