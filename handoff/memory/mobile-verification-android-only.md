---
name: mobile-verification-android-only
description: On the user's Linux dev machine, mobile changes can be verified on Android only; iOS (and therefore Liquid Glass) needs the stella-mac host and is a valid blocker
metadata:
  type: project
---

As of 2026-09-02 the local environment (Omarchy Linux) has Android available for mobile verification but no iOS. The mobile glass component falls back to a tinted plain view when Liquid Glass is unavailable, so Android exercises exactly the fallback path, never the real glass.

**Why:** avoids claiming iOS behavior was verified when only the Android fallback ran.

**How to apply:** verify shared-token and background parity on Android; report Liquid Glass rendering as unverified locally and hand it to the `stella-mac` path. `adb` was not on PATH in the session shell; ask how the Android device or emulator is reached if needed. Related: [[theme-parity-liquid-glass-exception]].
