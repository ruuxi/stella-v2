import { useMemo, useRef, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { notifySuccess, tapLight } from "../lib/haptics";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import { fonts } from "../theme/fonts";
import type { Colors } from "../theme/colors";

/**
 * Native text selection for a finished assistant reply, with a custom three-
 * button action row (Copy / Ask Stella / Select All) above the text — replacing
 * the reused user-message menu. The body renders into a read-only, keyboard-
 * suppressed `TextInput` so iOS/Android give real selection handles and a live
 * highlight; the OS callout menu is hidden (`contextMenuHidden`) so only our
 * row shows. Entering selection mode selects the whole message so Copy/Ask act
 * immediately; the user can then drag the handles to narrow it.
 */
export function AssistantTextSelection({
  text,
  colors,
  onAskStella,
  onDismiss,
}: {
  text: string;
  colors: Colors;
  /** Places the current selection into the composer input. */
  onAskStella: (selected: string) => void;
  /** Leave selection mode (back to the rendered markdown). */
  onDismiss: () => void;
}) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const inputRef = useRef<TextInput>(null);
  // Selection is controlled so "Select All" can force the full range; it also
  // mirrors the user's drags via onSelectionChange, so it never fights them.
  const [selection, setSelection] = useState({ start: 0, end: text.length });
  // A tapped action button blurs the TextInput first; guard the blur-dismiss so
  // the button's own handler runs (and owns the dismiss) instead of racing it.
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPendingDismiss = () => {
    if (dismissTimerRef.current !== null) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
  };

  const selectedText = () => {
    const slice = text.slice(selection.start, selection.end);
    return slice.length > 0 ? slice : text;
  };

  const handleSelectionChange = (
    e: NativeSyntheticEvent<TextInputSelectionChangeEventData>,
  ) => {
    setSelection(e.nativeEvent.selection);
  };

  const handleCopy = () => {
    cancelPendingDismiss();
    void Clipboard.setStringAsync(selectedText()).then((ok) => {
      if (ok) notifySuccess();
    });
    onDismiss();
  };

  const handleAsk = () => {
    cancelPendingDismiss();
    tapLight();
    onAskStella(selectedText());
    onDismiss();
  };

  const handleSelectAll = () => {
    cancelPendingDismiss();
    tapLight();
    setSelection({ start: 0, end: text.length });
    inputRef.current?.focus();
  };

  const scheduleDismiss = () => {
    cancelPendingDismiss();
    // Blurred by a tap elsewhere / scroll — leave selection mode, unless an
    // action button claimed the blur (it cancels this first).
    dismissTimerRef.current = setTimeout(onDismiss, 150);
  };

  return (
    <View>
      <View style={styles.toolbar}>
        <ToolbarButton label="Copy" onPress={handleCopy} styles={styles} />
        <View style={styles.divider} />
        <ToolbarButton
          label="Ask Stella"
          onPress={handleAsk}
          styles={styles}
        />
        <View style={styles.divider} />
        <ToolbarButton
          label="Select All"
          onPress={handleSelectAll}
          styles={styles}
        />
      </View>
      <TextInput
        ref={inputRef}
        value={text}
        // Read-only: never mutate the reply. `editable` is required for
        // selection handles on iOS, so edits are neutralised by the fixed
        // `value` + no-op `onChangeText`, and the keyboard is suppressed.
        editable
        onChangeText={() => {}}
        showSoftInputOnFocus={false}
        caretHidden
        contextMenuHidden
        multiline
        scrollEnabled={false}
        autoFocus
        selection={selection}
        onSelectionChange={handleSelectionChange}
        onBlur={scheduleDismiss}
        style={styles.body}
        maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
        accessibilityLabel="Assistant message, selecting text"
      />
    </View>
  );
}

function ToolbarButton({
  label,
  onPress,
  styles,
}: {
  label: string;
  onPress: () => void;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({ pressed }) => [
        styles.button,
        pressed ? styles.buttonPressed : null,
      ]}
    >
      <Text
        style={styles.buttonLabel}
        maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    toolbar: {
      alignSelf: "flex-start",
      flexDirection: "row",
      alignItems: "center",
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.panel,
      marginBottom: 8,
      overflow: "hidden",
    },
    button: {
      paddingHorizontal: 14,
      paddingVertical: 9,
    },
    buttonPressed: {
      backgroundColor: colors.muted,
    },
    buttonLabel: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
      letterSpacing: -0.1,
    },
    divider: {
      width: StyleSheet.hairlineWidth,
      alignSelf: "stretch",
      backgroundColor: colors.border,
    },
    body: {
      margin: 0,
      padding: 0,
      color: colors.text,
      fontFamily: fonts.sans.regular,
      fontSize: 17,
      lineHeight: 24,
    },
  });
