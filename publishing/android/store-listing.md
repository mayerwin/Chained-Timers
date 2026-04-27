# Google Play Store — listing copy

Paste these strings verbatim into the Play Console fields.

---

## Title (30 chars max)

```
Chained Timers
```

## Short description (80 chars max — used 79)

```
Chain interval timers for sport, breath, cooking and study. No ads, no tracking.
```

## Full description (4000 chars max — used ~2 600)

```
Chained Timers is a focused interval-timer app built around a single idea: instead of juggling three separate timers, build a named chain once — a sequence of segments with their own durations and colors — and let the app fire the next one automatically as each one ends.

Vibration, sound and a system notification mark every transition. The chain keeps ticking on time even when the screen is locked, the phone is in your pocket, or you've switched to another app.

— SCENARIOS —

• Strength & conditioning: 1m30 plank · 1m side L · 1m side R, repeated, finished by a 90-second hold.
• HIIT, EMOM, Tabata, boxing rounds: built-in templates, plus the building blocks for your own.
• Breathwork: box breathing, Wim Hof rounds, 4-7-8.
• Cooking: sear · rest · flip · rest · plate.
• Pomodoro & deep work: focus blocks chained with breaks.

— WHAT MAKES IT DIFFERENT —

• Chains, not just timers. A chain is a first-class object — name it, color it, save it, run it again next week.
• Embed chains inside chains. Build a Full Workout by stitching together a Warmup, your existing Plank Stack, and a Cooldown without retyping. Edit the inner chain and every parent updates automatically.
• Loops. Repeat a whole chain N times, or just an embedded sub-chain.
• Cinematic run mode. Editorial display typography, tabular numerals, a calibrated amber accent, and a progression strip showing exactly where you are in the chain.
• Pre-start countdown, final-3-second tick, instant pause, drag-to-reorder.
• Reliable in the background. A foreground service holds a wake lock and exempts the app from Doze for the duration of the chain — segment alerts fire on the second, not bunched up at the end.
• Persistent now-playing notification. Glance at the lock screen to see the current segment, position (e.g. "Segment 4 of 8"), and what's coming next.

— PRIVACY —

• No accounts.
• No analytics, no crash reporters, no ads, no third-party trackers.
• Your library lives on your device. Export to JSON whenever you want.

The app requests three permissions: notifications, exact alarms, and a foreground-service slot. All three exist for the same reason — to fire your segment-end alerts at the precise time even with the screen off. See the in-app Settings → Native bridge panel for status and one-tap fixes.

Templates included: Tabata, EMOM 10, Boxing Rounds, Pomodoro, Plank Stack, Box Breath. Tap any to fork into your library, then customise freely.

Open source: github.com/mayerwin/Chained-Timers
```

---

## What's new in v1.1.0 (release notes — 500 chars max — used ~470)

```
Reliability rewrite for background timers.

• Foreground service holds a wake lock for the chain run — segment alerts now fire on the second, not bunched up at the end of a workout
• Persistent "▶ Now playing" notification shows current segment, position, and what's next
• Wall-clock engine: timer state stays correct across screen-locks, app-switches, and even WebView kills
• Crash-safe: a chain that was running survives a force-stop, OS reboot, or out-of-memory kill
```

---

## What's new in v1.0.0 (release notes — 500 chars max)

```
First public release.

• Build chains of interval timers and run them hands-free
• Vibration, sound, system notifications between segments
• Embed chains inside chains; loop counts; drag-to-reorder
• Pre-start countdown, final-3s tick, cinematic run mode
• 6 built-in templates (Tabata, EMOM, boxing, Pomodoro, plank, box breath)
• No accounts, no tracking, no ads
```

---

## Tags (Play Console will suggest tags from the description; pick up to 5)

Recommended:
- Workout
- Fitness
- Habit
- Productivity
- Stopwatch
