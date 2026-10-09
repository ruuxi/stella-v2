import { useMemo, useSyncExternalStore } from "react";
import { Keyboard, useWindowDimensions } from "react-native";
import { Gesture } from "react-native-gesture-handler";
import {
  Easing,
  cancelAnimation,
  makeMutable,
  runOnJS,
  useSharedValue,
  withSpring,
  type WithSpringConfig,
} from "react-native-reanimated";

export const drawerProgress = makeMutable(0);

type DrawerState = { open: boolean; live: boolean };

let state: DrawerState = { open: false, live: false };
const listeners = new Set<() => void>();

function setState(next: Partial<DrawerState>) {
  const merged = { ...state, ...next };
  if (merged.open === state.open && merged.live === state.live) return;
  state = merged;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const readOpen = () => state.open;
const readLive = () => state.live;

export function useDrawerOpen(): boolean {
  return useSyncExternalStore(subscribe, readOpen, readOpen);
}

export function useDrawerLive(): boolean {
  return useSyncExternalStore(subscribe, readLive, readLive);
}

const OPEN: WithSpringConfig = { stiffness: 340, damping: 31, mass: 1 };
const CLOSE: WithSpringConfig = {
  stiffness: 420,
  damping: 42,
  mass: 1,
  overshootClamping: true,
};

let openedAt = 0;

function setOpen(open: boolean) {
  if (open && !state.open) openedAt = Date.now();
  setState({ open, live: open || state.live });
}

export function drawerJustOpened(): boolean {
  return Date.now() - openedAt < 380;
}

function setLive(live: boolean) {
  setState({ live });
}

function rested() {
  if (!state.open) setLive(false);
}

function settleDrawer(open: boolean, velocity = 0) {
  "worklet";
  drawerProgress.value = withSpring(
    open ? 1 : 0,
    { ...(open ? OPEN : CLOSE), velocity },
    (done) => {
      if (done && !open) runOnJS(rested)();
    },
  );
}

export function openDrawer() {
  Keyboard.dismiss();
  setOpen(true);
  settleDrawer(true);
}

export function closeDrawer() {
  setOpen(false);
  settleDrawer(false);
}

export function isDrawerOpen(): boolean {
  return state.open;
}

export function useDrawerMetrics() {
  const { width } = useWindowDimensions();
  const travel = Math.round(Math.min(width * 0.75, 320));
  return { width, travel, scale: 0.9, radius: 40 };
}

export const DRAWER_VEIL = {
  start: 0.05,
  end: 0.75,
  curve: [0.25, 0, 0.6, 0.7] as const,
};

const veilCurve = Easing.bezierFn(...DRAWER_VEIL.curve);

export function drawerVeil(progress: number) {
  "worklet";
  const t =
    (progress - DRAWER_VEIL.start) / (DRAWER_VEIL.end - DRAWER_VEIL.start);
  return t <= 0 ? 0 : t >= 1 ? 1 : veilCurve(t);
}

export const DRAWER_BLUR = { end: 0.9, power: 1.4 };

export function drawerBlur(progress: number) {
  "worklet";
  const t = progress / DRAWER_BLUR.end;
  return t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(t, DRAWER_BLUR.power);
}

function rubber(over: number) {
  "worklet";
  const limit = 0.09;
  return (1 - 1 / ((over * 0.6) / limit + 1)) * limit;
}

const dismissKeyboard = () => Keyboard.dismiss();

export function useDrawerPan(direction: "open" | "close", enabled = true) {
  const { travel } = useDrawerMetrics();
  const origin = useSharedValue(0);
  return useMemo(
    () =>
      Gesture.Pan()
        .enabled(enabled)
        .activeOffsetX(direction === "open" ? 12 : -12)
        .failOffsetY([-14, 14])
        .onStart((e) => {
          cancelAnimation(drawerProgress);
          origin.value = drawerProgress.value - e.translationX / travel;
          runOnJS(setLive)(true);
          if (direction === "open") runOnJS(dismissKeyboard)();
        })
        .onUpdate((e) => {
          const raw = origin.value + e.translationX / travel;
          drawerProgress.value =
            raw < 0 ? 0 : raw > 1 ? 1 + rubber(raw - 1) : raw;
        })
        .onEnd((e) => {
          const v = e.velocityX / travel;
          const open = drawerProgress.value + v * 0.2 > 0.5;
          runOnJS(setOpen)(open);
          settleDrawer(open, v);
        }),
    [direction, enabled, travel, origin],
  );
}
