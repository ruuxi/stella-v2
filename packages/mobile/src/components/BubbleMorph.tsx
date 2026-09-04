import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Animated,
  Easing,
  View,
  StyleSheet,
  useWindowDimensions,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useReducedMotion } from "react-native-reanimated";
import { useColors } from "../theme/theme-context";

type Source = { width: number; height: number; hide: () => void };
type Morph = { source: Source | null };
const BubbleMorphContext = createContext<Morph | null>(null);

export function BubbleMorphProvider({ children }: { children: ReactNode }) {
  const [morph] = useState<Morph>(() => ({ source: null }));
  return (
    <BubbleMorphContext.Provider value={morph}>
      {children}
    </BubbleMorphContext.Provider>
  );
}
export function useBubbleMorphSource() {
  return useContext(BubbleMorphContext);
}

type Shape = { width: number; height: number; scaleX: number; scaleY: number };
/** The native layout pass sizes markdown once; only the background scales. */
export function MorphingAssistantBubble({
  children,
  style,
  animate,
}: {
  children: ReactNode;
  style: StyleProp<ViewStyle>;
  animate: boolean;
}) {
  const morph = useBubbleMorphSource();
  const colors = useColors();
  const reducedMotion = useReducedMotion();
  const viewport = useWindowDimensions();
  const measured = useRef(false);
  const eligible = useRef(animate).current;
  const [shape, setShape] = useState<Shape | null>(null);
  const progress = useRef(new Animated.Value(0)).current;
  const [settled, setSettled] = useState(!animate || reducedMotion);

  useEffect(() => {
    if (reducedMotion) setSettled(true);
  }, [reducedMotion]);

  const onLayout = ({ nativeEvent: { layout } }: LayoutChangeEvent) => {
    if (measured.current) {
      if (
        shape &&
        (Math.abs(layout.width - shape.width) > 1 ||
          Math.abs(layout.height - shape.height) > 1)
      )
        setSettled(true);
      return;
    }
    if (layout.width <= 0 || layout.height <= 0) return;
    measured.current = true;
    const source = eligible ? morph?.source : null;
    if (source && morph) {
      morph.source = null;
      source.hide();
    }
    if (
      reducedMotion ||
      !source ||
      layout.width <= 0 ||
      layout.height <= 0 ||
      layout.height > viewport.height * 0.65
    ) {
      setSettled(true);
      return;
    }
    setShape({
      width: layout.width,
      height: layout.height,
      scaleX: Math.min(source.width / layout.width, 1),
      scaleY: Math.min(source.height / layout.height, 1),
    });
  };

  useEffect(() => {
    if (!shape || settled) return;
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: 240,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished) setSettled(true);
    });
    return () => animation.stop();
  }, [shape, progress, settled]);

  const fill = (
    <LinearGradient
      pointerEvents="none"
      colors={[colors.assistantBubbleFillTop, colors.assistantBubbleFillBottom]}
      style={StyleSheet.absoluteFill}
    />
  );
  return (
    <View style={style} onLayout={onLayout}>
      {settled ? (
        fill
      ) : shape ? (
        <Animated.View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: shape.width,
            height: shape.height,
            borderRadius: 18,
            borderBottomLeftRadius: 4,
            overflow: "hidden",
            transformOrigin: "top left",
            transform: [
              {
                scaleX: progress.interpolate({
                  inputRange: [0, 1],
                  outputRange: [shape.scaleX, 1],
                }),
              },
              {
                scaleY: progress.interpolate({
                  inputRange: [0, 1],
                  outputRange: [shape.scaleY, 1],
                }),
              },
            ],
          }}
        >
          {fill}
        </Animated.View>
      ) : null}
      <Animated.View
        style={{
          opacity: settled
            ? 1
            : progress.interpolate({
                inputRange: [0, 0.2, 1],
                outputRange: [0, 0, 1],
              }),
        }}
      >
        {children}
      </Animated.View>
    </View>
  );
}
