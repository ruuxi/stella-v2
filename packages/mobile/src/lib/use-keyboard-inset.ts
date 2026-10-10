import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

// ---------------------------------------------------------------------------
// Keyboard inset — keeps the composer and message list above the OS keyboard.
//
// The composer's *motion* is driven separately, on the UI thread, by
// reanimated's `useAnimatedKeyboard` (see `composerKeyboardStyle`), so it stays
// glued to the keyboard frame-for-frame in both directions. This hook only
// tracks the settled height as JS state, used to reserve the message list's
// bottom inset — that reserve doesn't need frame-perfect smoothness (content
// just scrolls under the composer), so no `LayoutAnimation` is needed here.
// ---------------------------------------------------------------------------

export function useKeyboardInset() {
  const bottomInset = useSafeAreaInsets().bottom;
  const [height, setHeight] = useState(0);
  // The height the keyboard is heading to, for the composer's UI-thread lift.
  const targetHeight = useSharedValue(0);

  useEffect(() => {
    const showEvent =
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent =
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const onShow = (e: { endCoordinates: { height: number } }) => {
      targetHeight.value = e.endCoordinates.height;
      setHeight(e.endCoordinates.height);
    };
    const onHide = () => setHeight(0);

    const showSub = Keyboard.addListener(showEvent, onShow);
    const hideSub = Keyboard.addListener(hideEvent, onHide);

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [targetHeight]);

  const open = height > 0;
  // The composer's bottom pad is keyboard-independent: it always reserves the
  // home-indicator safe area. When the keyboard is up the composer is lifted
  // clear of it by `composerKeyboardStyle` (by `keyboardHeight - bottomInset`),
  // so that reserved band lands inside the keyboard region — a constant 6pt
  // gap sits above the keyboard either way, with no per-state padding swap to
  // animate.
  const composerBottomPad = 6 + bottomInset;

  return { height, open, composerBottomPad, targetHeight };
}
