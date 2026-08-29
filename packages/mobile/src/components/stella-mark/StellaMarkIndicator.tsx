import { useEffect, useId, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import Svg, {
  Circle,
  ClipPath,
  Defs,
  Ellipse,
  LinearGradient,
  Path,
  Rect,
  Stop,
} from "react-native-svg";
import { STELLA_STAR_PATH } from "./geometry";
import { MarkLayer } from "./MarkLayer";
import { shouldRunContinuousAnimation } from "../../lib/continuous-animation";
import { useAppVisible } from "../../lib/use-app-visible";
import {
  CELL,
  CX,
  DIAMOND_PATH,
  DOT_EXTRA,
  DOT_VIEW_SPAN,
  INK_RAMP,
  MID_Y,
  MORPH_MS,
  SHEEN_STOPS,
  SHEEN_WIDTH,
  TIP_Y,
  TRAVEL_MS,
  ZOOM_PIVOT_Y,
  computeSpinnerFrame,
  makeDotState,
  type SpinnerFrame,
} from "./top-spinner";

const DEFAULT_SIZE = 34;
const FRAME_DT_CAP = 0.05;
const STOP_GRACE_MS = 120;

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedEllipse = Animated.createAnimatedComponent(Ellipse);
const AnimatedRect = Animated.createAnimatedComponent(Rect);

export type StellaMarkMode = "dots" | "star";

type FrameValue = SharedValue<SpinnerFrame>;

function InkRamp({ id }: { id: string }) {
  return (
    <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      {INK_RAMP.map((color, index) => (
        <Stop
          key={color}
          offset={index / (INK_RAMP.length - 1)}
          stopColor={color}
        />
      ))}
    </LinearGradient>
  );
}

function OrbitDot({
  frame,
  index,
  behind,
  fill,
}: {
  frame: FrameValue;
  index: number;
  behind: boolean;
  fill: string;
}) {
  const animatedProps = useAnimatedProps(() => {
    const f = frame.value;
    return {
      cx: f.dotX[index],
      cy: f.dotY[index],
      r: f.dotR[index],
      opacity: behind ? f.dotBack[index] : f.dotFront[index],
    };
  });
  return <AnimatedCircle animatedProps={animatedProps} fill={fill} />;
}

function OrbitDotLayer({
  frame,
  size,
  gradientId,
  behind,
}: {
  frame: FrameValue;
  size: number;
  gradientId: string;
  behind: boolean;
}) {
  const pxPerUnit = size / CELL;
  const width = DOT_VIEW_SPAN * pxPerUnit;
  const layout = useMemo(
    () => ({
      position: "absolute" as const,
      top: 0,
      left: -DOT_EXTRA * pxPerUnit,
      width,
      height: size,
    }),
    [pxPerUnit, size, width],
  );
  return (
    <View style={layout} pointerEvents="none">
      <Svg
        width={width}
        height={size}
        viewBox={`${-DOT_EXTRA} 0 ${DOT_VIEW_SPAN} ${CELL}`}
      >
        <Defs>
          <InkRamp id={gradientId} />
        </Defs>
        {[0, 1, 2].map((index) => (
          <OrbitDot
            key={index}
            frame={frame}
            index={index}
            behind={behind}
            fill={`url(#${gradientId})`}
          />
        ))}
      </Svg>
    </View>
  );
}

function SpinnerBody({
  frame,
  size,
  uid,
}: {
  frame: FrameValue;
  size: number;
  uid: string;
}) {
  const inkId = `${uid}-ink`;
  const sheenId = `${uid}-sheen`;
  const clipId = `${uid}-clip`;

  const lensProps = useAnimatedProps(() => {
    const f = frame.value;
    return { rx: f.lensRx, ry: f.lensRy, opacity: f.lensOpacity };
  });
  const sheenProps = useAnimatedProps(() => ({ x: frame.value.sheenX }));

  return (
    <Svg width={size} height={size} viewBox={`0 0 ${CELL} ${CELL}`}>
      <Defs>
        <InkRamp id={inkId} />
        <LinearGradient id={sheenId} x1="0" y1="0" x2="1" y2="0">
          {SHEEN_STOPS.map((stop, index) => (
            <Stop
              key={index}
              offset={stop.offset}
              stopColor={stop.color}
              stopOpacity={stop.opacity}
            />
          ))}
        </LinearGradient>
        <ClipPath id={clipId}>
          <Path d={DIAMOND_PATH} />
        </ClipPath>
      </Defs>
      <AnimatedEllipse
        animatedProps={lensProps}
        cx={CX}
        cy={MID_Y}
        fill={`url(#${inkId})`}
      />
      <Path d={DIAMOND_PATH} fill={`url(#${inkId})`} />
      <AnimatedRect
        animatedProps={sheenProps}
        y={0}
        width={SHEEN_WIDTH}
        height={CELL}
        fill={`url(#${sheenId})`}
        clipPath={`url(#${clipId})`}
      />
    </Svg>
  );
}

export function StellaMarkIndicator({
  active,
  size = DEFAULT_SIZE,
  mode = "dots",
}: {
  active: boolean;
  size?: number;
  mode?: StellaMarkMode;
}) {
  const reduceMotion = useReducedMotion();
  const appVisible = useAppVisible();
  const uid = useId().replace(/[^a-zA-Z0-9-]/g, "");
  const pxPerUnit = size / CELL;

  const spinning = active && mode === "dots";
  const morphTarget = spinning ? 0 : 1;

  const phase = useMemo(() => Math.random() * TRAVEL_MS, []);
  const morph = useSharedValue(morphTarget);
  const dotState = useSharedValue<number[]>(makeDotState());
  const frame = useSharedValue<SpinnerFrame>(
    computeSpinnerFrame(0, 0, morphTarget, true, makeDotState()),
  );

  const [running, setRunning] = useState(() =>
    shouldRunContinuousAnimation({
      logicalActive: spinning,
      appVisible,
      reducedMotion: reduceMotion,
    }),
  );

  useEffect(() => {
    if (reduceMotion) {
      morph.value = morphTarget;
      return;
    }
    morph.value = withTiming(morphTarget, {
      duration: MORPH_MS,
      easing: Easing.inOut(Easing.cubic),
    });
  }, [morph, morphTarget, reduceMotion]);

  useEffect(() => {
    if (reduceMotion || !appVisible) {
      setRunning(false);
      return;
    }
    if (spinning) {
      setRunning(true);
      return;
    }
    const timer = setTimeout(
      () => setRunning(false),
      MORPH_MS + STOP_GRACE_MS,
    );
    return () => clearTimeout(timer);
  }, [appVisible, reduceMotion, spinning]);

  useEffect(() => {
    if (running) return;
    const parked = makeDotState();
    frame.value = computeSpinnerFrame(
      0,
      0,
      reduceMotion ? morphTarget : 1,
      true,
      parked,
    );
    dotState.value = parked;
  }, [dotState, frame, morphTarget, reduceMotion, running]);

  const frameCallback = useFrameCallback((info) => {
    const now = info.timeSinceFirstFrame + phase;
    const dtSec = Math.min(
      (info.timeSincePreviousFrame ?? 0) / 1000,
      FRAME_DT_CAP,
    );
    const state = dotState.value;
    frame.value = computeSpinnerFrame(now, dtSec, morph.value, false, state);
    dotState.value = state;
  }, false);

  useEffect(() => {
    frameCallback.setActive(running);
  }, [frameCallback, running]);

  const zoomPivot = (ZOOM_PIVOT_Y - CELL / 2) * pxPerUnit;
  const leanPivot = (TIP_Y - CELL / 2) * pxPerUnit;

  const stageStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: zoomPivot },
      { scale: frame.value.zoom },
      { translateY: -zoomPivot },
    ],
  }));

  const travelStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: frame.value.tx * pxPerUnit },
      { translateY: frame.value.ty * pxPerUnit },
    ],
  }));

  const bodyStyle = useAnimatedStyle(() => {
    const f = frame.value;
    return {
      opacity: f.bodyOpacity,
      transform: [
        { translateY: leanPivot },
        { rotate: `${f.lean}deg` },
        { scaleY: f.bodySy },
        { translateY: -leanPivot },
      ],
    };
  });

  const blobStyle = useAnimatedStyle(() => {
    const f = frame.value;
    return {
      opacity: f.blobOpacity,
      transform: [
        { translateY: f.blobY * pxPerUnit },
        { scale: f.blobScale },
      ],
    };
  });

  const viewport = useMemo(
    () => [styles.viewport, { width: size, height: size }],
    [size],
  );

  return (
    <View style={viewport} pointerEvents="none">
      <Animated.View style={[styles.stage, stageStyle]}>
        <OrbitDotLayer
          frame={frame}
          size={size}
          gradientId={`${uid}-dot-back`}
          behind
        />
        <Animated.View style={[styles.layer, travelStyle]}>
          <Animated.View style={[styles.layer, bodyStyle]}>
            <SpinnerBody frame={frame} size={size} uid={uid} />
          </Animated.View>
          <Animated.View style={[styles.layer, blobStyle]}>
            <MarkLayer
              d={STELLA_STAR_PATH}
              size={size}
              gradientId={`${uid}-blob`}
            />
          </Animated.View>
        </Animated.View>
        <OrbitDotLayer
          frame={frame}
          size={size}
          gradientId={`${uid}-dot-front`}
          behind={false}
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { ...StyleSheet.absoluteFillObject },
  stage: { ...StyleSheet.absoluteFillObject },
  viewport: {
    alignItems: "center",
    justifyContent: "center",
    overflow: "visible",
  },
});
