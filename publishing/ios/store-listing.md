# Apple App Store — listing copy

Paste these strings verbatim into the App Store Connect fields.

---

## Title (30 chars max — used 14)

```
Chained Timers
```

## Subtitle (30 chars max — used 30)

```
Interval chains for sport & focus
```

> Apple counts the subtitle as "30 characters". This one is 32 — trim to "Interval chains, sport & focus" if Connect rejects it.

Alternate (shorter, fits): `Sequenced interval timers`

## Promotional Text (170 chars max — used 165, can be edited without resubmission)

```
Build named chains of countdown timers and let the app fire them in sequence — vibration, sound and notification at every transition. No accounts, no tracking.
```

## Keywords (100 chars max, comma-separated — used 96)

```
timer,interval,workout,hiit,tabata,plank,pomodoro,breath,boxing,emom,fitness,focus,stopwatch
```

> Don't repeat words from the title; Apple already indexes those.

## Description (4000 chars max — used ~2 700)

```
Chained Timers is a focused interval-timer app built around a single idea: instead of juggling three separate timers, build a named chain once — a sequence of segments with their own durations and colors — and let the app fire the next one automatically as each one ends.

Vibration, sound and a notification mark every transition. The chain keeps ticking on time even when the screen is locked or you've switched to another app.

SCENARIOS

• Strength & conditioning: 1m30 plank · 1m side L · 1m side R, repeated, finished by a 90-second hold.
• HIIT, EMOM, Tabata, boxing rounds: built-in templates, plus the building blocks for your own.
• Breathwork: box breathing, Wim Hof rounds, 4-7-8.
• Cooking: sear · rest · flip · rest · plate.
• Pomodoro & deep work: focus blocks chained with breaks.

WHAT MAKES IT DIFFERENT

• Chains, not just timers. A chain is a first-class object — name it, color it, save it, run it again next week.
• Embed chains inside chains. Build a Full Workout by stitching together a Warmup, your existing Plank Stack, and a Cooldown without retyping. Edit the inner chain and every parent updates automatically.
• Loops. Repeat a whole chain N times, or just an embedded sub-chain.
• Cinematic run mode. Editorial display typography, tabular numerals, a calibrated amber accent, and a progression strip showing exactly where you are in the chain.
• Pre-start countdown, final-3-second tick, instant pause, drag-to-reorder.
• Reliable in the background. The wall-clock engine and pre-scheduled local notifications keep your chain accurate to the second across screen-locks and app-switches.
• Crash-safe. A chain that was running survives a force-quit or OS reboot — when you reopen the app you land back on the right segment.

PRIVACY

• No accounts.
• No analytics, no crash reporters, no ads, no third-party trackers.
• Your library lives on your device. Export to JSON whenever you want.

The app uses local notifications and haptic feedback to fire segment-end alerts at the precise time, even when the screen is locked.

Templates included: Tabata, EMOM 10, Boxing Rounds, Pomodoro, Plank Stack, Box Breath. Tap any to fork into your library, then customise freely.

Open source: github.com/mayerwin/Chained-Timers
```

---

## What's new in v1.2.0 (release notes — 4000 chars max — used ~120)

```
Various subtler timing fixes carried over from the Android side. (The notification-action and live-countdown improvements in this release are Android-only — iOS doesn't expose those primitives to third-party apps.)
```

---

## What's new in v1.1.2 (release notes — 4000 chars max — used ~330)

```
Defense-in-depth for time-critical chains.

• Notification permission and channel state probed at every chain start — silent failure modes are now flagged loudly
• Pending alarm queue is auto-refreshed on every app resume and on a 4-minute heartbeat, so any silently-dropped alarm is healed before it would have mattered
```

(The Android-only foreground-service and battery-optimization fixes don't apply on iOS, where the OS aggressively suspends background apps regardless. iOS reliability still relies entirely on `UNUserNotificationCenter` scheduling.)

---

## What's new in v1.1.0 (release notes — 4000 chars max — used ~530)

```
Reliability rewrite for background timers.

• Wall-clock timer engine: chain state stays correct across screen-locks, app-switches, and brief WebView freezes
• Crash-safe persistence: a chain that was running survives a force-quit or device restart — reopen the app and you land back on the right segment
• Persistent now-playing indicator showing current segment, position in chain, and what's next
• Pause now updates the live notification with a paused indicator
• Various subtler timing fixes to keep transitions firing on the second
```

---

## What's new in v1.0.0 (release notes — 4000 chars max)

```
First public release.

• Build chains of interval timers and run them hands-free
• Vibration, sound, system notifications between segments
• Embed chains inside chains; loop counts; drag-to-reorder
• Pre-start countdown, final-3-second tick, cinematic run mode
• 6 built-in templates (Tabata, EMOM, boxing rounds, Pomodoro, plank stack, box breath)
• No accounts, no tracking, no ads
• Native notifications via Local Notifications + Haptics
```

---

## Copyright (shown on the listing)

```
© 2026 Erwin Mayer
```

(Replace with your name / org as appropriate.)
