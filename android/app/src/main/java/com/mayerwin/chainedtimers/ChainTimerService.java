package com.mayerwin.chainedtimers;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;

/**
 * Foreground service kept alive while a chain is running.
 *
 * Two reasons we need this:
 *
 *  1. Doze / App Standby otherwise coalesce our AlarmManager alarms — even
 *     setExactAndAllowWhileIdle() can fire 9+ minutes late on phones with
 *     aggressive battery management. A foreground service exempts the app
 *     from those restrictions, so the per-segment notifications fire on
 *     the second.
 *
 *  2. The Capacitor WebView is paused on activity onPause(), which freezes
 *     the JS engine that drives the on-screen countdown. Holding a partial
 *     wake lock and resuming WebView timers from MainActivity.onPause()
 *     keeps the engine ticking so the user sees the right segment when
 *     they return — no one-second "catchup hop".
 *
 * The notification posted by this service IS the persistent "now playing"
 * row the user asked for. It's flagged ongoing so it can't be swiped, and
 * carries the chain's current segment / next-up info.
 */
public class ChainTimerService extends Service {

    public static final String ACTION_START  = "com.mayerwin.chainedtimers.action.START";
    public static final String ACTION_UPDATE = "com.mayerwin.chainedtimers.action.UPDATE";
    public static final String ACTION_STOP   = "com.mayerwin.chainedtimers.action.STOP";

    public static final String EXTRA_TITLE       = "title";
    public static final String EXTRA_BODY        = "body";
    public static final String EXTRA_LARGE       = "largeBody";
    public static final String EXTRA_SUB         = "subText";
    public static final String EXTRA_PAUSED      = "paused";
    public static final String EXTRA_END_TIME_MS = "endTimeMs";

    // Forwarded by notification action buttons to MainActivity. The
    // ChainTimerPlugin reads the extra in handleOnNewIntent / handleOnStart
    // and notifies JS via the "chainCommand" event.
    public static final String EXTRA_COMMAND = "chainCommand";
    public static final String COMMAND_PAUSE  = "pause";
    public static final String COMMAND_RESUME = "resume";
    public static final String COMMAND_STOP   = "stop";

    public static final String CHANNEL_ID = "chain-running";
    private static final int NOTIFICATION_ID = 7000;
    private static final String WAKELOCK_TAG = "ChainedTimers::ChainRun";

    private static volatile boolean running = false;

    /** Whether a chain run is currently keeping the service alive. */
    public static boolean isRunning() { return running; }

    private PowerManager.WakeLock wakeLock;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        final String action = intent != null ? intent.getAction() : ACTION_START;

        if (ACTION_STOP.equals(action)) {
            stopRun();
            return START_NOT_STICKY;
        }

        // ACTION_START or ACTION_UPDATE — both call startForeground with
        // (potentially new) content. Calling startForeground multiple times
        // with the same notification id replaces the visible notification
        // in place, which is exactly what we want for live updates.
        ensureChannel();

        final String title     = strOr(intent, EXTRA_TITLE, "Chain running");
        final String body      = strOr(intent, EXTRA_BODY,  "");
        final String largeBody = strOr(intent, EXTRA_LARGE, body);
        final String subText   = strOr(intent, EXTRA_SUB,   null);
        final boolean paused   = intent != null && intent.getBooleanExtra(EXTRA_PAUSED, false);
        final long endTimeMs   = intent != null ? intent.getLongExtra(EXTRA_END_TIME_MS, 0L) : 0L;

        Notification n = buildNotification(title, body, largeBody, subText, paused, endTimeMs);

        if (Build.VERSION.SDK_INT >= 34) {
            // API 34 (Android 14)+ requires a foregroundServiceType. We
            // declare specialUse — the timer doesn't fit camera, location,
            // mediaPlayback, etc. — and ship a justification property in
            // the manifest.
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }

        if (ACTION_START.equals(action) || !running) {
            acquireWakeLock();
        }
        running = true;
        return START_STICKY;
    }

    private void stopRun() {
        running = false;
        releaseWakeLock();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(
            CHANNEL_ID,
            "Chain running",
            NotificationManager.IMPORTANCE_LOW   // silent, no heads-up
        );
        ch.setDescription("Persistent indicator while a timer chain is running");
        ch.setShowBadge(false);
        ch.setSound(null, null);
        ch.enableVibration(false);
        ch.enableLights(false);
        nm.createNotificationChannel(ch);
    }

    private Notification buildNotification(
            String title, String body, String largeBody, String subText,
            boolean paused, long endTimeMs) {
        // Tap the notification body itself -> open the app on its current view.
        Intent appIntent = new Intent(this, MainActivity.class);
        appIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) piFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(this, 0, appIntent, piFlags);

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_icon)
            .setColor(0xFFF5B042)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(largeBody))
            .setContentIntent(pi)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_STOPWATCH)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE);
        if (subText != null) b.setSubText(subText);

        // Live countdown: when not paused and we know when the segment
        // ends in wall-clock terms, anchor a chronometer to that moment
        // and let Android tick it down to 0:00. setChronometerCountDown
        // is API 24+; everything else is older. Without an end time
        // (e.g. paused state, or when the JS side hasn't computed it yet)
        // we fall back to no timestamp.
        if (!paused && endTimeMs > 0L) {
            b.setUsesChronometer(true);
            b.setShowWhen(true);
            b.setWhen(endTimeMs);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                b.setChronometerCountDown(true);
            }
        } else {
            b.setUsesChronometer(false);
            b.setShowWhen(false);
        }

        // Action buttons. Tap routes through MainActivity (singleTask) so
        // the JS Engine stays the source of truth for pause/resume/stop;
        // the plugin's handleOnNewIntent picks up the extra and notifies
        // JS via the "chainCommand" event.
        b.addAction(
            paused ? android.R.drawable.ic_media_play : android.R.drawable.ic_media_pause,
            paused ? "Resume" : "Pause",
            commandPendingIntent(paused ? COMMAND_RESUME : COMMAND_PAUSE, 11)
        );
        b.addAction(
            android.R.drawable.ic_menu_close_clear_cancel,
            "Stop",
            commandPendingIntent(COMMAND_STOP, 12)
        );

        return b.build();
    }

    private PendingIntent commandPendingIntent(String command, int requestCode) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        intent.putExtra(EXTRA_COMMAND, command);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, requestCode, intent, flags);
    }

    @SuppressLint("WakelockTimeout")
    private void acquireWakeLock() {
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null) return;
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKELOCK_TAG);
            wakeLock.setReferenceCounted(false);
        }
        if (!wakeLock.isHeld()) {
            // No timeout — chains can be arbitrarily long (multi-hour
            // Pomodoro days, sleep-cycle timers, ultra-endurance sessions).
            // Releasing the lock prematurely would let Doze freeze the
            // process and silently break the timer.
            //
            // Cleanup is handled deterministically by every termination
            // path: ChainTimerService.stopRun() (user stop / chain end),
            // onDestroy() (system kill), and the Android kernel itself
            // on process death — wake locks are tied to the process and
            // released automatically when it dies.
            wakeLock.acquire();
        }
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            try { wakeLock.release(); } catch (Throwable ignored) {}
        }
    }

    @Override
    public void onDestroy() {
        running = false;
        releaseWakeLock();
        super.onDestroy();
    }

    private static String strOr(Intent i, String key, String def) {
        if (i == null) return def;
        String v = i.getStringExtra(key);
        return v != null ? v : def;
    }
}
