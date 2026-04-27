# Play Console — Permissions Declaration form

When you upload the AAB to a Play Console release, the Console scans `AndroidManifest.xml` and flags any **restricted permissions**. For Chained Timers, two of them require justification:

- `android.permission.USE_EXACT_ALARM`
- `android.permission.SCHEDULE_EXACT_ALARM`

If your AAB also gets flagged for other permissions (e.g. POST_NOTIFICATIONS, RECEIVE_BOOT_COMPLETED, WAKE_LOCK, VIBRATE), those are **not** restricted — no justification needed for those.

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

## What the Console will display after submission

After you save and the form is reviewed (automated, instant), the AAB shows:

```
Restricted permissions: 2 declared
  ✓ USE_EXACT_ALARM         (use case: Alarm clock or scheduling app)
  ✓ SCHEDULE_EXACT_ALARM    (use case: Alarm clock or scheduling app)
```

If the Console marks the declaration as "needs review," the human review usually clears within 24-48 hours. **It is unlikely to be rejected** — fitness timers are a recognised qualifying use case.

---

## If Google rejects the declaration

Unlikely, but if it happens:

1. Open the rejection notice for the specific reason.
2. The most common cause is "use case insufficient detail" — re-paste the declaration above with two extra sentences explaining that the chain durations are user-configured (so the alarms are user-driven, not background-spam).
3. Resubmit. Almost always cleared on the second try.

If repeatedly rejected (very unusual), the fallback is to remove `USE_EXACT_ALARM` from `android/app/src/main/AndroidManifest.xml`, keep only `SCHEDULE_EXACT_ALARM` (which on Android 13+ is grantable but no longer auto-granted), and document in-app that users may need to grant it via Settings. Cuts UX quality but unblocks Play Store publication.

---

## Related: future-permission additions

If you ever add a new permission to `android/app/src/main/AndroidManifest.xml`, check Google's restricted permissions list before submitting:

<https://support.google.com/googleplay/android-developer/answer/9888170>

If the new permission is on that list, add a section to this file with the same template (use case + justification + 2-3 paragraphs explaining why the app legitimately needs it).
