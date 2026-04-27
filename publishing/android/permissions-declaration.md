# Play Console — Permissions Declaration form

When you upload the AAB to a Play Console release, the Console scans `AndroidManifest.xml` and flags any **restricted permissions**. For Chained Timers, three of them require justification:

- `android.permission.USE_EXACT_ALARM`
- `android.permission.SCHEDULE_EXACT_ALARM`
- `android.permission.FOREGROUND_SERVICE_SPECIAL_USE`

The other restricted-looking permissions (POST_NOTIFICATIONS, RECEIVE_BOOT_COMPLETED, WAKE_LOCK, VIBRATE, FOREGROUND_SERVICE) are **not** restricted — no justification needed for those.

---

## Permission: `USE_EXACT_ALARM` and `SCHEDULE_EXACT_ALARM`

In the Console, the form will ask:

> *Why does your app need to use the SCHEDULE_EXACT_ALARM permission?*

Select the use case: **Calendar app, alarm clock app, or other scheduling app**.

Then paste this declaration:

```
Chained Timers is an interval-timer app. Users compose chains of countdown
timers (e.g. "1 minute 30 seconds plank, then 1 minute side plank L, then ...")
which the app fires sequentially.

To make every segment-end notification arrive at the user's intended exact
moment — even when the screen is locked, the device is in Doze, or the app
has been backgrounded — we use AlarmManager.setExactAndAllowWhileIdle(),
which on Android 12+ requires SCHEDULE_EXACT_ALARM (or USE_EXACT_ALARM for
Android 13+).

Without exact alarms, Doze defers our notifications by 10+ minutes,
breaking the entire purpose of an interval timer (a 30-second interval
notification arriving 12 minutes late is worse than no notification).

This is the canonical alarm-clock / fitness-timer use case for which the
permission was designed.
```

---

## Permission: `FOREGROUND_SERVICE_SPECIAL_USE`

Added in **v1.1.0**. The app runs a foreground service (`ChainTimerService`) for the duration of an active chain, so the OS does not freeze the WebView, throttle the timer engine, or coalesce the segment alarms during Doze. The service displays a persistent low-importance notification showing current segment + position + next-up.

In the Console, the Permissions Declaration form asks for a per-permission justification.

Select the use case: **The app fits other use cases that aren't on this list** (Play does not have a "fitness timer" preset). Then paste:

```
Chained Timers is an interval-timer app for sport, breathwork, cooking and
study. Users build a chain of named timer segments and the app fires the
next segment automatically as the previous one ends.

When the user starts a chain, we run a foreground service (ChainTimerService)
for the duration of that chain. The service:

  1. Acquires a partial wake lock so the OS doesn't freeze the WebView's
     JS engine while the user is mid-workout with the screen off. Without
     this, the on-screen countdown stops advancing in the background and
     the user comes back to a frozen timer.

  2. Exempts the app process from Doze / App Standby so the AlarmManager
     alarms scheduled for each segment boundary fire at the precise
     intended time. Without it, Doze coalesces the alarms and the user
     hears all eight segment-transition tones at the END of the workout
     instead of one per minute.

  3. Posts a persistent low-importance notification showing the current
     segment, position in the chain (e.g. "Segment 4 of 8"), and what's
     coming next. The user can glance at the lock screen / notification
     shade to see chain state without unlocking the device.

The service stops automatically the instant the chain ends, is paused for
more than the chain's natural duration, or the user taps Stop. It does not
continue to run in any other circumstance.

This use case (a user-initiated, time-bounded interval timer that must
fire reliably while the screen is off) does not fit the predefined service
types — it is not media playback, location, camera, microphone, phone call,
data sync, or remote messaging. SPECIAL_USE with the descriptive
PROPERTY_SPECIAL_USE_FGS_SUBTYPE manifest property is the documented
fallback for legitimate use cases not covered by the type list, and is
exactly the pattern Google's foreground-service guidance recommends for
fitness / interval / workout timers.

The app does not run the foreground service when no chain is active.
```

The manifest also ships a `<property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE">` element on the `<service>` declaration, with the same justification text — Play scans this property and confirms it before approving the listing.

---

## What the Console will display after submission

After you save and the form is reviewed (automated, instant), the AAB shows:

```
Restricted permissions: 3 declared
  ✓ USE_EXACT_ALARM                    (use case: Alarm clock or scheduling app)
  ✓ SCHEDULE_EXACT_ALARM               (use case: Alarm clock or scheduling app)
  ✓ FOREGROUND_SERVICE_SPECIAL_USE     (use case: Other; subtype: interval timer)
```

If the Console marks the declarations as "needs review," human review usually clears within 24-48 hours. Exact alarms for fitness timers, and SPECIAL_USE FGS for interval timers, are recognised qualifying use cases — neither has been observed to be rejected for an honest declaration.

---

## If Google rejects a declaration

Unlikely, but if it happens:

1. Open the rejection notice for the specific reason.
2. The most common cause is "use case insufficient detail" — re-paste the declaration with two extra sentences explaining that the chain durations are user-configured (so the alarms / FGS are user-initiated, not background-spam).
3. Resubmit. Almost always cleared on the second try.

If `FOREGROUND_SERVICE_SPECIAL_USE` is repeatedly rejected (very unusual), the fallback is to switch the manifest's `foregroundServiceType` to `mediaPlayback` and add a low-volume tone to chain start (so the audio claim is honest) — fitness timer apps have used this pattern historically. Cuts elegance but unblocks publication.

If `USE_EXACT_ALARM` is repeatedly rejected, drop it from the manifest and keep only `SCHEDULE_EXACT_ALARM`, which on Android 13+ is grantable but no longer auto-granted; document in-app that users may need to grant it via Settings.

---

## Related: future-permission additions

If you ever add a new permission to `android/app/src/main/AndroidManifest.xml`, check Google's restricted permissions list before submitting:

<https://support.google.com/googleplay/android-developer/answer/9888170>

If the new permission is on that list, add a section to this file with the same template (use case + justification + 2-3 paragraphs explaining why the app legitimately needs it).
