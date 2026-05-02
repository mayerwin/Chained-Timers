package com.github.chainedtimers;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

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
 *     the JS engine. We hold a partial wake lock and own the persistent
 *     "now playing" notification *natively*: the service stores the chain
 *     plan in memory and ticks the displayed remaining time forward once
 *     per second from a Handler, advancing segments and stopping the
 *     service automatically at chain end. JS doesn't have to be alive for
 *     any of this — which is what makes the on-shade time stay correct
 *     when the user opens it after the screen has been off.
 *
 * Notification UX (single-row):
 *
 *   The persistent FGS notification (id 7000) lives on a HIGH-importance
 *   channel so it CAN play sound, but every per-second tick re-post is
 *   marked silent (setOnlyAlertOnce(true) + setSilent(true)). The only
 *   tick that's allowed to make sound is one where the *service itself*
 *   detects a segment boundary — i.e. the WebView was suspended and JS
 *   couldn't fire its in-app chime. JS-driven UPDATE intents always
 *   re-sync prevTickIndex so the next tick won't double-alert for a
 *   boundary the foreground side already chimed for.
 *
 *   At chain end the service replaces the FGS notification with a
 *   one-shot "✓ Chain complete" entry on a separate id (7001) so the
 *   system shows it as heads-up, removes the FGS row, and stops itself.
 *   The user is left with exactly one notification per chain end, no
 *   stack of "Next: …" entries from pre-scheduled alarms (we dropped
 *   those — scheduleAll in js/native.js gates them on !fgsActive so
 *   they only run on the OS-fallback path).
 *
 * Drop-in flow:
 *   ACTION_START / ACTION_UPDATE  — JS sends plan + currentIndex +
 *                                   segmentStartedAtMs + paused. We
 *                                   refresh the in-memory state and
 *                                   the notification (silently), and
 *                                   (if running) schedule the next tick.
 *   ACTION_STOP                   — silent user stop: release wake lock,
 *                                   dismiss notification, stop service.
 *   ACTION_COMPLETE               — natural chain end: post the
 *                                   "✓ Chain complete" heads-up, dismiss
 *                                   the FGS row, stop service.
 *   internal tick                 — advance segments based on wall clock,
 *                                   re-post notification (alerting only
 *                                   if a boundary was detected here),
 *                                   schedule next.
 */
public class ChainTimerService extends Service {

    public static final String ACTION_START    = "com.github.chainedtimers.action.START";
    public static final String ACTION_UPDATE   = "com.github.chainedtimers.action.UPDATE";
    public static final String ACTION_STOP     = "com.github.chainedtimers.action.STOP";
    public static final String ACTION_COMPLETE = "com.github.chainedtimers.action.COMPLETE";
    // Notification action buttons (Pause / Resume / Skip / Stop) PendingIntent
    // here directly via getService() so they DON'T launch MainActivity into
    // the foreground when tapped. The service mutates its own state for
    // immediate notification feedback and forwards the command to JS via
    // the plugin's static deliverChainCommand so the engine stays in sync.
    public static final String ACTION_CMD      = "com.github.chainedtimers.action.CMD";

    public static final String EXTRA_TITLE       = "title";
    public static final String EXTRA_BODY        = "body";
    public static final String EXTRA_LARGE       = "largeBody";
    public static final String EXTRA_SUB         = "subText";
    public static final String EXTRA_PAUSED      = "paused";
    public static final String EXTRA_END_TIME_MS = "endTimeMs";

    // Forwarded by notification action buttons to MainActivity. The
    // ChainTimerPlugin reads the extra in handleOnNewIntent / handleOnStart
    // and notifies JS via the "chainCommand" event.
    public static final String EXTRA_COMMAND      = "chainCommand";
    public static final String COMMAND_PAUSE      = "pause";
    public static final String COMMAND_RESUME     = "resume";
    public static final String COMMAND_STOP       = "stop";
    public static final String COMMAND_SKIP_PREV  = "skip-prev";
    public static final String COMMAND_SKIP_NEXT  = "skip-next";

    public static final String EXTRA_CHAIN_NAME            = "chainName";
    // Compact JSON: [{"n":"Inhale","d":4},{"n":"Hold","d":4},…]
    public static final String EXTRA_PLAN_JSON             = "planJson";
    public static final String EXTRA_SEGMENT_INDEX         = "segmentIndex";    // 0-based
    public static final String EXTRA_SEGMENT_TOTAL         = "segmentTotal";    // count
    public static final String EXTRA_SEGMENT_STARTED_AT_MS = "segmentStartedAtMs";
    // Pre-computed remaining at the moment of pause — authoritative while
    // paused so the notification doesn't drift if anything re-renders it
    // between pause and resume.
    public static final String EXTRA_PAUSED_REMAINING_MS   = "pausedRemainingMs";
    public static final String EXTRA_HAS_PREV              = "hasPrev";
    public static final String EXTRA_HAS_NEXT              = "hasNext";
    // Suppresses the channel sound/vibration on the "✓ Chain complete"
    // notification when JS dispatched ACTION_COMPLETE — JS only does so
    // from the foreground rAF path, where Audio.finale() already played
    // through Web Audio and the tray entry is just a visual record.
    public static final String EXTRA_SILENT                = "silent";
    // User's "play tick on last 3 seconds" preference (sound && finalTick).
    // The service plays tick.wav via SoundPool in the background since
    // the WebView's Audio.tick() can't play once the WebView is paused;
    // gating on this respects the same Settings toggle the in-app cue
    // honours.
    public static final String EXTRA_TICK_ENABLED          = "tickEnabled";
    // User's master "Sound" preference. Mirrors Store.getSettings().sound
    // and gates ALL SoundPool playback (chime, finale, tick) so the
    // service respects the same toggle the in-app Web Audio path does.
    public static final String EXTRA_SOUND_ENABLED         = "soundEnabled";

    // The persistent run notification lives on a HIGH-importance channel
    // so the OS shows heads-up + vibration when the service detects a
    // segment boundary autonomously. The channel itself has NO sound:
    // chime / finale / tick are all played through SoundPool (R.raw.*)
    // for low-latency, in-sync audio. The notification-channel pipeline
    // adds 200–500ms before the channel sound starts, which makes the
    // chain-end finale lag visibly behind the last 3-second tick.
    public static final String CHANNEL_ID         = "chain-fg";
    // Separate channel for chain-end so the heads-up popup is freshly
    // triggered on a new id (Android only fires heads-up on first post
    // for an id, not on updates). Also silent at the channel level.
    public static final String CHANNEL_FINALE     = "chain-end";
    // Pre-v1.3 + pre-SoundPool channels we delete on first run so users
    // don't end up with multiple overlapping entries in System Settings
    // → Notifications. Safe from the service's path because if we're
    // running here the FGS plugin is alive and js/native.js no longer
    // recreates the LocalNotifications-fallback channels.
    private static final String[] LEGACY_CHANNELS = {
        "chain-running",       // v1.2 LOW persistent FGS channel
        "chain-transitions",   // v1.2 HIGH boundary-alert channel (LocalNotifications)
        "chain-status",        // v1.2 LOW persistent indicator (LocalNotifications)
        "chain-active",        // v1.3.0 had chime.wav as channel sound — now via SoundPool
        "chain-finale"         // v1.3.0 had finale.wav as channel sound — now via SoundPool
    };

    private static final int NOTIFICATION_ID          = 7000;
    private static final int NOTIFICATION_ID_COMPLETE = 7001;
    private static final String WAKELOCK_TAG = "ChainedTimers::ChainRun";
    private static final long TICK_INTERVAL_MS = 1000L;

    private static volatile boolean running = false;

    /** Whether a chain run is currently keeping the service alive. */
    public static boolean isRunning() { return running; }

    private PowerManager.WakeLock wakeLock;

    // In-memory chain plan, owned and self-advanced by the service so the
    // notification keeps ticking even when the JS engine is suspended.
    private final List<Segment> plan = new ArrayList<>();
    private String chainName = "Chain";
    private int curIndex = 0;
    // Effective wall-clock moment the *current* segment started, with
    // paused-time excluded. (segmentStartedAtMs + duration*1000) is always
    // the segment's wall-clock end while not paused.
    private long segStartedAtMs = 0L;
    private boolean paused = false;
    // Authoritative remaining ms while paused — captured from JS at the
    // pause transition and held verbatim until resume.
    private long pausedRemainingMs = 0L;
    // Last segment index posted in the notification — if onTick advances
    // beyond this we know it's a service-detected boundary (i.e. a real
    // background segment crossing JS missed) and we let the post chime.
    // JS-driven UPDATEs sync this back to curIndex so they don't trigger
    // a duplicate alert in foreground.
    private int prevAlertIndex = -1;
    // Last segment-remaining-second we played a tick.wav for, scoped to
    // a (curIndex, secondsRemaining) pair so each of the last 3 seconds
    // of every segment ticks at most once.
    private int lastTickedAtIndex     = -1;
    private long lastTickedRemaining  = -1L;
    // User's "play tick in last 3 seconds" preference, mirrored from JS.
    private boolean tickEnabled = true;

    private final Handler tickHandler = new Handler(Looper.getMainLooper());
    private final Runnable tickRunnable = this::onTick;
    // SoundPool plays chime / finale / tick directly through the Media
    // stream with ~10–50 ms latency. The notification-channel sound
    // pipeline takes 200–500 ms (more on emulators) which makes the
    // chain-end finale visibly lag behind the SoundPool-played 3-second
    // ticks; routing all three through SoundPool keeps the cadence tight.
    private android.media.SoundPool soundPool;
    private int tickSoundId   = 0;
    private int chimeSoundId  = 0;
    private int finaleSoundId = 0;
    // Mirrors the user's master "Sound" toggle. Gates SoundPool playback
    // so the service respects the same Settings switch as the in-app
    // Web Audio path.
    private boolean soundEnabled = true;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Defensive: a null intent here means the OS is auto-restarting us
        // (only possible with START_STICKY, which we don't return). If it
        // ever happens we have no chain content to display and JS is gone,
        // so the right move is to bail out cleanly rather than post a
        // stale "Chain running" notification with the wake lock attached.
        if (intent == null) {
            stopRun();
            return START_NOT_STICKY;
        }

        final String action = intent.getAction();

        if (ACTION_STOP.equals(action)) {
            stopRun();
            return START_NOT_STICKY;
        }

        if (ACTION_CMD.equals(action)) {
            // Notification action button tapped — handle in-process so
            // the activity isn't dragged into the foreground. Service
            // mutates its own state for immediate notification feedback,
            // then forwards to JS so the engine stays in sync.
            handleNotificationCommand(intent.getStringExtra(EXTRA_COMMAND));
            return START_NOT_STICKY;
        }

        ensureChannel();
        ensureSoundPool();

        // Refresh in-memory state from the intent. JS sends the full plan
        // on every START/UPDATE/COMPLETE so the service can self-advance
        // when the WebView is paused, and so the COMPLETE post has the
        // chain name + total segments to show.
        chainName = strOr(intent, EXTRA_CHAIN_NAME, "Chain");
        String planJson = intent.getStringExtra(EXTRA_PLAN_JSON);
        if (planJson != null) {
            List<Segment> parsed = parsePlan(planJson);
            if (!parsed.isEmpty()) {
                plan.clear();
                plan.addAll(parsed);
            }
        }
        curIndex = clampIndex(intent.getIntExtra(EXTRA_SEGMENT_INDEX, 0));
        segStartedAtMs = intent.getLongExtra(EXTRA_SEGMENT_STARTED_AT_MS, System.currentTimeMillis());
        paused = intent.getBooleanExtra(EXTRA_PAUSED, false);
        pausedRemainingMs = Math.max(0L, intent.getLongExtra(EXTRA_PAUSED_REMAINING_MS, 0L));
        tickEnabled  = intent.getBooleanExtra(EXTRA_TICK_ENABLED, true);
        soundEnabled = intent.getBooleanExtra(EXTRA_SOUND_ENABLED, true);

        if (ACTION_COMPLETE.equals(action)) {
            // JS-driven completion (foreground rAF reached chain end).
            // The in-app finale chime has already played through Web
            // Audio, so post the tray entry silently — alerting again
            // would just stack a louder Notification-stream sound on
            // top of what the user just heard from Media stream.
            //
            // CRITICAL: the plugin delivers ACTION_COMPLETE via
            // startForegroundService(), which on Android 8+ obligates
            // us to call startForeground() within 5 seconds OR the
            // system crashes the app with ForegroundServiceDidNot-
            // StartInTimeException. completeChain() ultimately removes
            // the FGS, so we satisfy the contract by posting the run
            // notification once here first; completeChain immediately
            // replaces it with the chain-end entry on id 7001 and
            // detaches via stopForeground(REMOVE).
            Notification placeholder = buildNotification(intent, /*alert=*/false);
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIFICATION_ID, placeholder, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(NOTIFICATION_ID, placeholder);
            }
            boolean silent = intent.getBooleanExtra(EXTRA_SILENT, false);
            completeChain(!silent);
            return START_NOT_STICKY;
        }

        // ACTION_START or ACTION_UPDATE — both call startForeground with
        // (potentially new) content. Calling startForeground multiple times
        // with the same notification id replaces the visible notification
        // in place, which is exactly what we want for live updates.
        //
        // Re-posts driven by JS (segment advance, skip, pause, resume) are
        // ALWAYS silent: JS already played the in-app chime on foreground
        // boundaries, so we'd just double-sound here. Sync prevAlertIndex
        // to the new curIndex so the next autonomous tick doesn't either.
        prevAlertIndex = curIndex;

        Notification n = buildNotification(intent, /*alert=*/false);

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
            // Sweep any stale "✓ Chain complete" notification left in the
            // tray from the previous run. The user explicitly chose to
            // start again — leaving the old completion entry around is
            // visual clutter that competes with the persistent FGS row.
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) {
                try { nm.cancel(NOTIFICATION_ID_COMPLETE); } catch (Throwable ignored) {}
            }
        }
        running = true;

        // Schedule the next tick — only when actively counting down. While
        // paused we leave the static notification in place; the chain
        // doesn't move until JS sends a resume UPDATE.
        tickHandler.removeCallbacks(tickRunnable);
        if (!paused && !plan.isEmpty()) {
            scheduleNextTick();
        }

        // START_NOT_STICKY: if the OS kills us under memory pressure, do
        // NOT auto-restart with a null intent. JS state is lost too at
        // that point; the right path back is the user reopening the app,
        // which calls Engine.restoreIfActive -> chain:reschedule and
        // re-establishes the FGS with current chain content.
        return START_NOT_STICKY;
    }

    /**
     * Tick driven by Handler.postDelayed. Walks past any segments whose
     * wall-clock duration has fully elapsed (cheap when we're up-to-date,
     * but bulletproof if the device just woke from a Doze nap or a missed
     * tick), re-posts the notification with the current remaining time,
     * and schedules the next tick. When the chain naturally ends we hand
     * off to {@link #completeChain()} which replaces the FGS row with a
     * "✓ Chain complete" heads-up entry, releases the wake lock, and stops.
     */
    private void onTick() {
        if (!running || paused) return;
        long now = System.currentTimeMillis();
        int idxBefore = curIndex;

        while (curIndex < plan.size()) {
            long segEndMs = segStartedAtMs + plan.get(curIndex).durationSec * 1000L;
            if (now < segEndMs) break;
            // Anchor the next segment to the precise boundary so multi-skip
            // catch-up doesn't drift relative to where the JS engine would
            // place segmentStartedAtMs after _advance.
            segStartedAtMs = segEndMs;
            curIndex++;
        }

        if (curIndex >= plan.size()) {
            // Chain naturally ended without JS noticing first (WebView was
            // asleep). The notification is the user's only chain-end cue
            // here, so alert: sound + vibration + heads-up.
            completeChain(/*alert=*/true);
            return;
        }

        // Boundary-alert gating:
        //   - we crossed a segment boundary in *this* tick (idxBefore != curIndex), AND
        //   - JS-driven UPDATEs haven't already synced prevAlertIndex to curIndex
        //     (i.e. the foreground rAF tick handled it first), AND
        //   - the app isn't currently in the foreground — when the user is
        //     looking at the app, in-app Audio.chime() plays through the
        //     Media stream and a Notification-stream ding on top would just
        //     feel like a second, louder sound for the same event.
        boolean inForeground = isAppForegroundSafe();
        boolean boundaryAlert = curIndex != idxBefore
            && curIndex != prevAlertIndex
            && !inForeground;
        prevAlertIndex = curIndex;

        Notification n = buildNotification(null, boundaryAlert);
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) {
            try { nm.notify(NOTIFICATION_ID, n); } catch (Throwable ignored) {}
        }

        // Play the chime through SoundPool in lockstep with the
        // notification post — channel sound is null, so this is the
        // only audio cue at the boundary in background.
        if (boundaryAlert) playChime();

        // Last-3-second tick. The JS engine plays Audio.tick() on each of
        // remaining = 3, 2, 1 in foreground; we mirror that here when the
        // app isn't visible so the user hears the same cue with the screen
        // off. SoundPool plays directly without re-posting the persistent
        // notification.
        Segment cur = plan.get(curIndex);
        long remainingSec = computeRemainingSec(cur);
        if (tickEnabled && !inForeground && remainingSec >= 1L && remainingSec <= 3L) {
            if (curIndex != lastTickedAtIndex || remainingSec != lastTickedRemaining) {
                lastTickedAtIndex    = curIndex;
                lastTickedRemaining  = remainingSec;
                playTick();
            }
        }

        scheduleNextTick();
    }

    /** Best-effort foreground probe — defaults to "background" if the
     *  plugin static reference isn't reachable. */
    private boolean isAppForegroundSafe() {
        try { return ChainTimerPlugin.isAppForeground(); }
        catch (Throwable t) { return false; }
    }

    /**
     * Pick the next tick delay: either the next 1-second wall clock boundary
     * within the current segment, or the segment-end moment if it's sooner.
     * Aligning to wall-clock seconds keeps the displayed MM:SS in sync with
     * what the user perceives — a 1000ms postDelayed isn't enough on its
     * own because Handler latency drifts the tick relative to the second
     * boundary the JS engine is using on-screen.
     */
    private void scheduleNextTick() {
        if (curIndex >= plan.size()) return;
        long now = System.currentTimeMillis();
        long segEndMs = segStartedAtMs + plan.get(curIndex).durationSec * 1000L;
        long msUntilSegEnd = Math.max(0L, segEndMs - now);
        // Time to the next whole-second boundary (relative to segStartedAtMs
        // so the displayed seconds line up with where the JS engine is).
        long elapsedInSeg = now - segStartedAtMs;
        long msToNextSecond = TICK_INTERVAL_MS - (elapsedInSeg % TICK_INTERVAL_MS);
        if (msToNextSecond <= 0) msToNextSecond = TICK_INTERVAL_MS;
        long delay = Math.min(msToNextSecond, msUntilSegEnd);
        if (delay < 16L) delay = 16L; // never < 1 frame to avoid tight loops
        tickHandler.postDelayed(tickRunnable, delay);
    }

    /** User-initiated stop, or any path that should leave no trace. */
    private void stopRun() {
        running = false;
        tickHandler.removeCallbacks(tickRunnable);
        releaseWakeLock();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    /**
     * Natural chain completion. Replaces the FGS row with a single
     * "✓ Chain complete" entry on a fresh id so it shows heads-up
     * (Android only triggers heads-up on first post for a given id, not
     * on updates). The FGS notification is removed in the same step so
     * the user is left with exactly one notification.
     *
     * @param alert when true, the channel sound/vibration/heads-up fire
     *              — used by the autonomous service-tick path so a user
     *              who's away from the device gets an actual cue. When
     *              false (JS-driven foreground completion) the entry is
     *              posted silently because Audio.finale() in the WebView
     *              has already played the cue through the Media stream
     *              and a second sound on the Notification stream just
     *              feels louder and tackier.
     */
    private void completeChain(boolean alert) {
        running = false;
        tickHandler.removeCallbacks(tickRunnable);

        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) {
            String safeName = (chainName == null || chainName.isEmpty()) ? "Chain" : chainName;
            int total = plan.size();
            String body = total == 1
                ? "1 segment done"
                : total + " segments done";

            Intent appIntent = new Intent(this, MainActivity.class);
            appIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) piFlags |= PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pi = PendingIntent.getActivity(this, 0, appIntent, piFlags);

            // Use the dedicated finale channel so the rendered finale.wav
            // arpeggio plays — same waveform as Audio.finale() in the
            // WebView. The chain-active channel (with chime.wav) would
            // otherwise play a 2-note chime instead, which doesn't match
            // what the in-app sound does on chain end.
            NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_FINALE)
                .setSmallIcon(R.drawable.ic_stat_icon)
                .setColor(0xFFF5B042)
                .setContentTitle("✓ " + safeName + " complete")
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setContentIntent(pi)
                .setAutoCancel(true)
                .setOngoing(false)
                .setCategory(NotificationCompat.CATEGORY_STATUS);

            // Even on the autonomous service-tick path (where alert=true)
            // we suppress the channel sound if the app turned out to be
            // in the foreground: in-app Audio.finale() will play through
            // the Media stream and a Notification-stream sound on top
            // doubles the cue. The tray entry itself stays — only the
            // alert decoration changes.
            boolean shouldAlert = alert && !isAppForegroundSafe();
            if (shouldAlert) {
                b.setOnlyAlertOnce(false)
                 .setPriority(NotificationCompat.PRIORITY_HIGH);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) b.setSilent(false);
            } else {
                b.setOnlyAlertOnce(true)
                 .setPriority(NotificationCompat.PRIORITY_LOW);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) b.setSilent(true);
            }

            try {
                nm.notify(NOTIFICATION_ID_COMPLETE, b.build());
            } catch (Throwable ignored) {}
        }

        // Play the finale through SoundPool in lockstep with the
        // notification post (channel sound is null). Same gating as the
        // notification: we only alert at all when the user isn't already
        // hearing Audio.finale through the in-app Web Audio path.
        if (alert && !isAppForegroundSafe()) playFinale();

        releaseWakeLock();
        // Removes the FGS notification (id 7000); the chain-complete entry
        // (id 7001) we just posted persists independently.
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;

        // One-time cleanup of pre-v1.3 + pre-SoundPool channels. Safe to
        // call repeatedly: Android no-ops if the channel doesn't exist
        // or was already deleted.
        for (String legacy : LEGACY_CHANNELS) {
            try { nm.deleteNotificationChannel(legacy); } catch (Throwable ignored) {}
        }

        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID,
                "Chain transitions",
                NotificationManager.IMPORTANCE_HIGH
            );
            ch.setDescription("Persistent chain status + segment-boundary alert");
            ch.setShowBadge(false);
            ch.enableLights(true);
            ch.setLightColor(0xFFF5B042);
            ch.enableVibration(true);
            // No channel sound — chime is played via SoundPool from R.raw.chime
            // for low-latency, in-sync audio (the OS notification pipeline
            // adds 200–500ms which lags behind the SoundPool-played ticks).
            ch.setSound(null, null);
            nm.createNotificationChannel(ch);
        }

        if (nm.getNotificationChannel(CHANNEL_FINALE) == null) {
            NotificationChannel ch = new NotificationChannel(
                CHANNEL_FINALE,
                "Chain complete",
                NotificationManager.IMPORTANCE_HIGH
            );
            ch.setDescription("Heads-up entry when a chain naturally ends");
            ch.setShowBadge(false);
            ch.enableLights(true);
            ch.setLightColor(0xFFF5B042);
            ch.enableVibration(true);
            // No channel sound — finale is played via SoundPool from
            // R.raw.finale so it lands immediately after the last tick
            // instead of trailing the channel-pipeline latency.
            ch.setSound(null, null);
            nm.createNotificationChannel(ch);
        }
    }

    /**
     * Build the persistent notification.
     *
     * @param intent the intent that triggered this build, or null when called
     *               from an internal tick. Used only for hasPrev/hasNext
     *               action button gating.
     * @param alert  if true, allow the channel to sound/vibrate this update
     *               (used for service-detected segment boundaries while the
     *               WebView is suspended). False for every per-second tick
     *               and every JS-driven UPDATE so we never double-sound.
     */
    private Notification buildNotification(Intent intent, boolean alert) {
        // Tap the notification body itself -> open the app on its current view.
        Intent appIntent = new Intent(this, MainActivity.class);
        appIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) piFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(this, 0, appIntent, piFlags);

        Segment cur = (curIndex >= 0 && curIndex < plan.size()) ? plan.get(curIndex) : null;
        Segment next = (curIndex + 1 < plan.size()) ? plan.get(curIndex + 1) : null;
        int total = plan.size();

        long remainingSec = computeRemainingSec(cur);
        String prefix = paused ? "⏸" : "▶"; // ⏸ / ▶
        String segName = (cur != null && cur.name != null && !cur.name.isEmpty()) ? cur.name : "Segment";
        String title = prefix + " " + segName + " · " + fmtClock(remainingSec);
        String body = "Segment " + (curIndex + 1) + " of " + total + " · " + chainName;
        String sub  = (curIndex + 1) + "/" + total;
        StringBuilder large = new StringBuilder();
        large.append(chainName).append(" · Segment ").append(curIndex + 1).append(" of ").append(total).append('\n');
        if (cur != null) large.append(segName).append(" — ").append(fmtDur(cur.durationSec)).append('\n');
        if (next != null) {
            String nextName = (next.name != null && !next.name.isEmpty()) ? next.name : "segment";
            large.append("Next: ").append(nextName).append(" (").append(fmtDur(next.durationSec)).append(")");
        } else {
            large.append("Last segment");
        }

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_icon)
            .setColor(0xFFF5B042)
            .setColorized(true)
            .setContentTitle(title)
            .setContentText(body)
            .setSubText(sub)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(large.toString()))
            .setContentIntent(pi)
            .setOngoing(true)
            .setShowWhen(false)
            .setUsesChronometer(false)
            .setCategory(NotificationCompat.CATEGORY_STOPWATCH)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE);

        // Per-tick re-posts must NEVER alert: the channel is HIGH so the
        // first post would otherwise sound, and every subsequent update
        // would re-sound without setOnlyAlertOnce. Boundary alerts pass
        // alert=true to clear both flags so the channel sound plays once.
        if (alert) {
            b.setOnlyAlertOnce(false);
            b.setPriority(NotificationCompat.PRIORITY_HIGH);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) b.setSilent(false);
        } else {
            b.setOnlyAlertOnce(true);
            b.setPriority(NotificationCompat.PRIORITY_LOW);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) b.setSilent(true);
        }

        if (total > 0 && cur != null && cur.durationSec > 0) {
            // Per-chain progress = completed segments + fraction-of-current.
            // Smooth across boundaries so the bar ticks in lockstep with
            // the on-screen ring rather than snapping segment-by-segment.
            float segFrac = 1f - ((float) remainingSec / (float) cur.durationSec);
            if (segFrac < 0f) segFrac = 0f;
            if (segFrac > 1f) segFrac = 1f;
            int progress = Math.round(100f * (curIndex + segFrac) / (float) total);
            b.setProgress(100, Math.max(0, Math.min(100, progress)), false);
        }

        boolean hasPrev = intent != null
            ? intent.getBooleanExtra(EXTRA_HAS_PREV, curIndex > 0)
            : (curIndex > 0);
        boolean hasNext = intent != null
            ? intent.getBooleanExtra(EXTRA_HAS_NEXT, curIndex < total - 1)
            : (curIndex < total - 1);

        // Action order matters — Android's compact (collapsed) view shows
        // the first ~3 actions only. We put the most-used media-style trio
        // (skip-prev / pause / skip-next) up front so they're always
        // reachable without expanding the notification, like YouTube
        // Music. Stop trails as a 4th, only visible when expanded.
        if (hasPrev) {
            b.addAction(R.drawable.ic_notif_prev, "Previous segment",
                commandPendingIntent(COMMAND_SKIP_PREV, 10));
        }
        b.addAction(
            paused ? R.drawable.ic_notif_play : R.drawable.ic_notif_pause,
            paused ? "Resume" : "Pause",
            commandPendingIntent(paused ? COMMAND_RESUME : COMMAND_PAUSE, 11));
        if (hasNext) {
            b.addAction(R.drawable.ic_notif_next, "Next segment",
                commandPendingIntent(COMMAND_SKIP_NEXT, 13));
        }
        b.addAction(R.drawable.ic_notif_stop, "Stop chain",
            commandPendingIntent(COMMAND_STOP, 12));

        return b.build();
    }

    private long computeRemainingSec(Segment cur) {
        if (cur == null) return 0L;
        if (paused) {
            // While paused, JS captured the authoritative remaining at the
            // pause transition. Use it verbatim — anything else would let
            // the displayed value drift if the notification is re-rendered
            // at any point before resume.
            return Math.max(0L, (pausedRemainingMs + 999L) / 1000L);
        }
        long now = System.currentTimeMillis();
        long endMs = segStartedAtMs + cur.durationSec * 1000L;
        long remMs = endMs - now;
        if (remMs < 0L) return 0L;
        // Round up so a "0.4s remaining" still reads as "1" until it
        // actually crosses zero — feels less laggy than truncating to 0.
        return (remMs + 999L) / 1000L;
    }

    private static String fmtClock(long secs) {
        if (secs < 0L) secs = 0L;
        long m = secs / 60L;
        long s = secs % 60L;
        return String.format(java.util.Locale.US, "%02d:%02d", m, s);
    }

    private static String fmtDur(int secs) {
        if (secs < 60) return secs + "s";
        int m = secs / 60, r = secs % 60;
        return r == 0 ? (m + "m") : (m + "m " + r + "s");
    }

    private int clampIndex(int idx) {
        if (idx < 0) return 0;
        if (plan.isEmpty()) return 0;
        return Math.min(idx, plan.size() - 1);
    }

    private static List<Segment> parsePlan(String json) {
        List<Segment> result = new ArrayList<>();
        if (json == null || json.isEmpty()) return result;
        try {
            JSONArray arr = new JSONArray(json);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                Segment s = new Segment();
                s.name = o.optString("n", "Segment");
                s.durationSec = Math.max(0, o.optInt("d", 0));
                result.add(s);
            }
        } catch (JSONException ignored) {}
        return result;
    }

    private PendingIntent commandPendingIntent(String command, int requestCode) {
        // Critically NOT getActivity: the action-button PendingIntents would
        // otherwise launch MainActivity into the foreground every time the
        // user taps Pause / Resume / Skip / Stop. With getService the
        // intent is delivered straight to onStartCommand → handleNotification-
        // Command, which mutates service state in place and forwards the
        // command to JS via the plugin. The user stays where they were.
        Intent intent = new Intent(this, ChainTimerService.class);
        intent.setAction(ACTION_CMD);
        intent.putExtra(EXTRA_COMMAND, command);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getService(this, requestCode, intent, flags);
    }

    /**
     * Handle a notification-action button tap. The service mutates its own
     * state synchronously so the persistent notification reflects the
     * change immediately (pause icon flips, time freezes, etc.) regardless
     * of whether the WebView is awake. The command is also forwarded to
     * JS via the plugin so the engine state stays in sync; if the
     * WebView is fully torn down the JS side will reconcile on next
     * cold start via Engine.restoreIfActive.
     */
    private void handleNotificationCommand(String cmd) {
        if (cmd == null) return;

        Segment cur = (curIndex >= 0 && curIndex < plan.size()) ? plan.get(curIndex) : null;
        long now = System.currentTimeMillis();
        boolean updated = false;

        if (COMMAND_STOP.equals(cmd)) {
            // Forward first so JS can hide the run view + clear persistence,
            // then tear down the service ourselves so the wake lock is
            // released even if the WebView never picks up the command.
            ChainTimerPlugin.deliverChainCommand(cmd);
            stopRun();
            return;
        }

        if (COMMAND_PAUSE.equals(cmd)) {
            if (!paused && cur != null) {
                long endMs = segStartedAtMs + cur.durationSec * 1000L;
                pausedRemainingMs = Math.max(0L, endMs - now);
                paused = true;
                tickHandler.removeCallbacks(tickRunnable);
                updated = true;
            }
        } else if (COMMAND_RESUME.equals(cmd)) {
            if (paused && cur != null) {
                // Shift segStartedAtMs so that "now + pausedRemainingMs"
                // hits the segment-end exactly — i.e. the notification
                // continues from where it froze instead of jumping back
                // to the value it would have shown without the pause.
                segStartedAtMs = now + pausedRemainingMs - cur.durationSec * 1000L;
                pausedRemainingMs = 0L;
                paused = false;
                scheduleNextTick();
                updated = true;
            }
        } else if (COMMAND_SKIP_NEXT.equals(cmd)) {
            if (curIndex < plan.size() - 1) {
                curIndex++;
                segStartedAtMs = now;
                pausedRemainingMs = 0L;
                paused = false;
                prevAlertIndex = curIndex;        // user-driven, no boundary alert
                lastTickedAtIndex = -1;
                lastTickedRemaining = -1L;
                tickHandler.removeCallbacks(tickRunnable);
                scheduleNextTick();
                updated = true;
            } else if (cur != null) {
                // Skip past the last segment → chain complete (no alert
                // because user-driven, foreground in-app cue or visible
                // notification update is enough).
                ChainTimerPlugin.deliverChainCommand(cmd);
                completeChain(/*alert=*/false);
                return;
            }
        } else if (COMMAND_SKIP_PREV.equals(cmd)) {
            // Mirror Engine.skipPrev: if elapsed > 2.5s in the current
            // segment OR we're already at index 0, restart current;
            // otherwise jump to the previous segment.
            long elapsedInSeg = paused
                ? (cur != null ? cur.durationSec * 1000L - pausedRemainingMs : 0L)
                : (now - segStartedAtMs);
            if (curIndex > 0 && elapsedInSeg <= 2500L) {
                curIndex--;
            }
            segStartedAtMs = now;
            pausedRemainingMs = 0L;
            paused = false;
            prevAlertIndex = curIndex;
            lastTickedAtIndex = -1;
            lastTickedRemaining = -1L;
            tickHandler.removeCallbacks(tickRunnable);
            scheduleNextTick();
            updated = true;
        }

        if (updated) {
            Notification n = buildNotification(null, /*alert=*/false);
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) {
                try { nm.notify(NOTIFICATION_ID, n); } catch (Throwable ignored) {}
            }
        }

        // Forward to JS so the engine syncs (no-op if the WebView is gone).
        ChainTimerPlugin.deliverChainCommand(cmd);
    }

    private void ensureSoundPool() {
        if (soundPool != null) return;
        try {
            AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
            soundPool = new android.media.SoundPool.Builder()
                .setMaxStreams(2)
                .setAudioAttributes(attrs)
                .build();
            tickSoundId   = soundPool.load(this, R.raw.tick,   1);
            chimeSoundId  = soundPool.load(this, R.raw.chime,  1);
            finaleSoundId = soundPool.load(this, R.raw.finale, 1);
        } catch (Throwable ignored) {
            soundPool = null;
            tickSoundId = chimeSoundId = finaleSoundId = 0;
        }
    }

    private void playSample(int soundId) {
        if (!soundEnabled || soundPool == null || soundId == 0) return;
        try { soundPool.play(soundId, 1f, 1f, 1, 0, 1f); } catch (Throwable ignored) {}
    }

    private void playTick()   { playSample(tickSoundId); }
    private void playChime()  { playSample(chimeSoundId); }
    private void playFinale() { playSample(finaleSoundId); }

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
            // path: stopRun(), completeChain(), onDestroy(), and the
            // Android kernel itself on process death — wake locks are
            // tied to the process and released automatically when it dies.
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
        tickHandler.removeCallbacks(tickRunnable);
        releaseWakeLock();
        if (soundPool != null) {
            try { soundPool.release(); } catch (Throwable ignored) {}
            soundPool = null;
            tickSoundId = 0;
        }
        super.onDestroy();
    }

    private static String strOr(Intent i, String key, String def) {
        if (i == null) return def;
        String v = i.getStringExtra(key);
        return v != null ? v : def;
    }

    private static class Segment {
        String name;
        int durationSec;
    }
}
