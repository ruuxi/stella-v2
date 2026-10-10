import { useEffect, useState } from "react";
import { Keyboard } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

// ---------------------------------------------------------------------------
// Keyboard inset — keeps the composer and message list above the OS keyboard.
//
// The *motion* of the composer and the message list is driven on the UI thread
// from one value, the keyboard's height as react-native-keyboard-controller
// reads it from the keyboard's own animation every frame (see `keyboardLift`),
// so both move with the keyboard frame for frame and together. Nothing here
// may re-render or re-lay-out the chat while the keyboard animates: the
// keyboard moves in the render server regardless, and any main-thread layout
// work left the composer frozen behind it while the list jumped ahead. So this
// hook only publishes the settled height as JS state after the animation ends.
// ---------------------------------------------------------------------------

export function useKeyboardInset() {
  const bottomInset = useSafeAreaInsets().bottom;
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const onDidShow = (e: { endCoordinates: { height: number } }) => {
      setHeight(e.endCoordinates.height);
    };
    const onDidHide = () => setHeight(0);

    const subs = [
      Keyboard.addListener("keyboardDidShow", onDidShow),
      Keyboard.addListener("keyboardDidHide", onDidHide),
    ];

    return () => {
      for (const sub of subs) sub.remove();
    };
  }, []);

  const open = height > 0;
  // The composer's bottom pad is keyboard-independent: it always reserves the
  // home-indicator safe area. When the keyboard is up the composer is lifted
  // clear of it by `composerKeyboardStyle` (by `keyboardHeight - bottomInset`),
  // so that reserved band lands inside the keyboard region — a constant 6pt
  // gap sits above the keyboard either way, with no per-state padding swap to
  // animate.
  const composerBottomPad = 6 + bottomInset;

  return { height, open, composerBottomPad };
}
