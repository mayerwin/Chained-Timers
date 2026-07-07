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
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Foreground service kept alive while ANY chain is running.
 *
 * v1.4.1 — per-run multi-chain. The service tracks up to N concurrent
 * chain runs in a {@link #runs} map keyed by runId. Each run has its
 * own state (plan, curIndex, MediaPlayer pool, tick runnable) and its
 * own notification id. One run owns the foreground-service slot (the
 * {@link #fgsOwnerRunId}); the others post regular ongoing notifications
 * carrying the same group key. When the FGS owner ends, another run is
 * promoted into the FGS slot.
 *
 * Two reasons we need this:
 *
 *  1. Doze / App Standby otherwise coalesce our AlarmManager alarms —
 *     even setExactAndAllowWhileIdle() can fire 9+ minutes late on
 *     phones with aggressive battery management. A foreground service
 *     exempts the app from those restrictions, so the per-segment
 *     notifications fire on the second.
 *
 *  2. The Capacitor WebView is paused on activity onPause(), which
 *     freezes the JS engine. We hold a partial wake lock and own the
 *     persistent "now playing" notifications *natively*: the service
 *     stores each run's chain plan in memory and ticks the displayed
 *     remaining time forward once per second from a Handler, advancing
 *     segments and stopping the service automatically at chain end.
 *     JS doesn't have to be alive for any of this — which is what makes
 *     the on-shade time stay correct when the user opens it after the
 *     screen has been off.
 *
 * Notifications:
 *
 *   Each run has its own notification id in the {@link #RUN_NOTIF_BASE}
 *   range. The FGS owner's notification is what Android's
 *   FOREGROUND_SERVICE_TYPE_SPECIAL_USE binding refers to; the others
 *   are regular ongoing notifications. All run notifications carry
 *   {@link #GROUP_KEY} so Android stacks them visually, and we post a
 *   {@link #SUMMARY_NOTIFICATION_ID} summary entry whenever 2+ runs
 *   are active so the stacked view has a header.
 *
 *   At chain end the service replaces the FGS row with a one-shot
 *   "✓ Chain complete" entry on a per-run completion id so the system
 *   shows it as heads-up. The persistent notification is removed.
 */
public class ChainTimerService extends Service {

    public static final String ACTION_START    = "com.github.chainedtimers.action.START";
    public static final String ACTION_UPDATE   = "com.github.chainedtimers.action.UPDATE";
    public static final String ACTION_STOP     = "com.github.chainedtimers.action.STOP";
    public static final String ACTION_COMPLETE = "com.github.chainedtimers.action.COMPLETE";
    public static final String ACTION_CMD      = "com.github.chainedtimers.action.CMD";

    public static final String EXTRA_TITLE       = "title";
    public static final String EXTRA_BODY        = "body";
    public static final String EXTRA_LARGE       = "largeBody";
    public static final String EXTRA_SUB         = "subText";
    public static final String EXTRA_PAUSED      = "paused";
    public static final String EXTRA_END_TIME_MS = "endTimeMs";

    public static final String EXTRA_COMMAND      = "chainCommand";
    public static final String COMMAND_PAUSE      = "pause";
    public static final String COMMAND_RESUME     = "resume";
    public static final String COMMAND_STOP       = "stop";
    public static final String COMMAND_SKIP_PREV  = "skip-prev";
    public static final String COMMAND_SKIP_NEXT  = "skip-next";

    public static final String EXTRA_CHAIN_NAME            = "chainName";
    public static final String EXTRA_PLAN_JSON             = "planJson";
    public static final String EXTRA_SEGMENT_INDEX         = "segmentIndex";
    public static final String EXTRA_SEGMENT_TOTAL         = "segmentTotal";
    public static final String EXTRA_SEGMENT_STARTED_AT_MS = "segmentStartedAtMs";
    public static final String EXTRA_PAUSED_REMAINING_MS   = "pausedRemainingMs";
    public static final String EXTRA_HAS_PREV              = "hasPrev";
    public static final String EXTRA_HAS_NEXT              = "hasNext";
    public static final String EXTRA_SILENT                = "silent";
    public static final String EXTRA_TICK_ENABLED          = "tickEnabled";
    public static final String EXTRA_SOUND_ENABLED         = "soundEnabled";
    public static final String EXTRA_VOICE_PATHS_JSON      = "voicePathsJson";
    public static final String EXTRA_VOICE_ENABLED_JSON    = "voiceEnabledJson";
    public static final String EXTRA_AUDIO_ROUTE           = "audioRoute";
    // v1.4.5 — false → MediaPlayer cue pool uses USAGE_MEDIA (media slider,
    // silenced by DND). true → USAGE_ALARM (alarm slider, rings through DND).
    public static final String EXTRA_RING_THROUGH_DND      = "ringThroughDnd";

    /**
     * v1.4.1 — identifies which run this intent applies to. Falls back
     * to a synthetic "__default__" id for back-compat with intents that
     * don't carry one (shouldn't happen in v1.4.1+ JS).
     */
    public static final String EXTRA_RUN_ID = "runId";

    public static final String CHANNEL_ID         = "chain-fg-v2";
    public static final String CHANNEL_FINALE     = "chain-end-v2";
    private static final String[] LEGACY_CHANNELS = {
        "chain-running", "chain-transitions", "chain-status",
        "chain-active", "chain-finale", "chain-fg", "chain-end"
    };

    /** Notification group key — Android stacks all entries with the
     *  same group, and surfaces our {@link #SUMMARY_NOTIFICATION_ID}
     *  summary entry as the stack header when 2+ are present. */
    private static final String GROUP_KEY = "chained-timers";

    /** Reserved id for the auto-bundle summary notification (only
     *  posted when 2+ runs are active). */
    private static final int SUMMARY_NOTIFICATION_ID = 7099;
    /** Per-run notification id pool. Each fresh run gets the next slot
     *  modulo {@link #SLOT_COUNT} — at the cap of 2 concurrent runs
     *  collisions are impossible. */
    private static final int RUN_NOTIF_BASE      = 7100;
    /** Per-run completion notification id pool (separate range so the
     *  heads-up "Chain complete" entry doesn't replace the persistent
     *  one — Android only triggers heads-up on first post per id). */
    private static final int COMPLETION_NOTIF_BASE = 7200;
    /** Number of distinct slots for concurrent runs. Generous so that
     *  rapid stop/restart of the same chain id doesn't reuse a slot
     *  still being rendered. */
    private static final int SLOT_COUNT = 32;

    private static final String WAKELOCK_TAG  = "ChainedTimers::ChainRun";
    private static final long TICK_INTERVAL_MS = 1000L;
    private static final long FINALE_TAIL_MS   = 1500L;

    private static final String DEFAULT_RUN_ID = "__default__";

    /** Set true while ANY run is alive. Static so external probes
     *  (ChainTimerPlugin.isRunning) work as in v1.3.x. */
    private static volatile boolean running = false;
    public static boolean isRunning() { return running; }

    private PowerManager.WakeLock wakeLock;
    private final Handler tickHandler = new Handler(Looper.getMainLooper());

    /** Per-run state, in insertion order so promotion is deterministic
     *  (oldest survivor wins the FGS slot when the current owner ends). */
    private final Map<String, ChainRun> runs = new LinkedHashMap<>();
    /** runId currently bound to startForeground. Tracking explicitly so
     *  we can detect when we need to switch the FGS slot to a survivor. */
    private String fgsOwnerRunId = null;
    /** Tracks which notification-id slot each run was assigned. The
     *  same chain id always gets the same slot for the life of THIS
     *  service instance; reused after the run ends. */
    private final Map<String, Integer> slotByRun = new HashMap<>();
    private int nextSlot = 0;

    /**
     * Per-run state. Each chain run has its own MediaPlayer pool so
     * audio for one run can't interfere with another; its own tick
     * runnable so two runs can fire boundary cues independently; its
     * own notification id (assigned at register-time) so the OS can
     * keep them separate visually.
     */
    static class ChainRun {
        final String runId;
        String chainName = "Chain";
        final List<Segment> plan = new ArrayList<>();
        int curIndex = 0;
        long segStartedAtMs = 0L;
        boolean paused = false;
        long pausedRemainingMs = 0L;
        int prevAlertIndex = -1;
        int finalThreeStartedAtIndex = -1;
        boolean tickEnabled = true;
        boolean soundEnabled = true;
        final List<String> voicePaths = new ArrayList<>();
        final List<Boolean> voiceEnabled = new ArrayList<>();
        String audioRoute = "headset";
        // v1.4.5 — false → USAGE_MEDIA (media-volume slider, silenced by DND).
        // true  → USAGE_ALARM (alarm slider, rings through DND). Read from
        // the "ringThroughDnd" extra on every start/update; a change while
        // a run is live rebuilds the MediaPlayer cue pool (createPreparedPlayer
        // must be called with the desired USAGE BEFORE prepare()).
        boolean ringThroughDnd = false;
        int lastVoicedAtIndex = -1;

        android.media.MediaPlayer chimePlayer;
        android.media.MediaPlayer finalThreePlayer;
        android.media.MediaPlayer finalePlayer;
        // volatile so cross-thread visibility is guaranteed — the
        // MediaPlayer onCompletion/onError callbacks marshal back onto
        // the main thread, but a published-but-not-yet-marshalled write
        // to this field must be visible to releaseVoicePlayer.
        volatile android.media.MediaPlayer voicePlayer;

        Runnable tickRunnable;
        final int notificationId;
        final int completionNotificationId;

        ChainRun(String runId, int slot) {
            this.runId = runId;
            this.notificationId = RUN_NOTIF_BASE + (slot % SLOT_COUNT);
            this.completionNotificationId = COMPLETION_NOTIF_BASE + (slot % SLOT_COUNT);
        }
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            // OS auto-restart with null intent — we never declared
            // START_STICKY but defend anyway.
            stopAllRuns();
            return START_NOT_STICKY;
        }

        final String action = intent.getAction();
        final String runId  = resolveRunId(intent);

        if (ACTION_STOP.equals(action)) {
            // ACTION_STOP without a runId stops every run (back-compat
            // with v1.3.x "stop the service" semantics). With a runId
            // only that specific run is torn down.
            if (intent.hasExtra(EXTRA_RUN_ID)) {
                stopRun(runId, /*alert=*/false);
            } else {
                stopAllRuns();
            }
            return START_NOT_STICKY;
        }

        if (ACTION_CMD.equals(action)) {
            handleNotificationCommand(runId, intent.getStringExtra(EXTRA_COMMAND));
            return START_NOT_STICKY;
        }

        ensureChannel();
        // v1.4.1 — distinguish "service had no record of this run" from
        // a JS-driven UPDATE on an existing run. On cold-restart of the
        // JS layer where the SERVICE process survived (rare but real on
        // quick WebView reloads), JS will send ACTION_START thinking
        // this is a fresh run; the service should treat that as an
        // UPDATE so it doesn't re-fire the current segment's voice cue.
        boolean wasKnown = runs.containsKey(runId);
        ChainRun run = getOrCreateRun(runId);
        ensureMediaPlayers(run);

        // Refresh in-memory state from the intent. JS sends the full
        // plan on every START/UPDATE/COMPLETE so the service can self-
        // advance when the WebView is paused.
        run.chainName = strOr(intent, EXTRA_CHAIN_NAME, "Chain");
        String planJson = intent.getStringExtra(EXTRA_PLAN_JSON);
        if (planJson != null) {
            List<Segment> parsed = parsePlan(planJson);
            if (!parsed.isEmpty()) {
                run.plan.clear();
                run.plan.addAll(parsed);
            }
        }
        run.curIndex = clampIndex(run, intent.getIntExtra(EXTRA_SEGMENT_INDEX, 0));
        run.segStartedAtMs = intent.getLongExtra(EXTRA_SEGMENT_STARTED_AT_MS, System.currentTimeMillis());
        run.paused = intent.getBooleanExtra(EXTRA_PAUSED, false);
        run.pausedRemainingMs = Math.max(0L, intent.getLongExtra(EXTRA_PAUSED_REMAINING_MS, 0L));
        run.tickEnabled  = intent.getBooleanExtra(EXTRA_TICK_ENABLED, true);
        run.soundEnabled = intent.getBooleanExtra(EXTRA_SOUND_ENABLED, true);

        String voicePathsJson = intent.getStringExtra(EXTRA_VOICE_PATHS_JSON);
        if (voicePathsJson != null) {
            List<String> parsedPaths = parseStringArray(voicePathsJson);
            run.voicePaths.clear();
            run.voicePaths.addAll(parsedPaths);
        }
        String voiceEnabledJson = intent.getStringExtra(EXTRA_VOICE_ENABLED_JSON);
        if (voiceEnabledJson != null) {
            List<Boolean> parsedEnabled = parseBoolArray(voiceEnabledJson);
            run.voiceEnabled.clear();
            run.voiceEnabled.addAll(parsedEnabled);
        }
        String routeExtra = intent.getStringExtra(EXTRA_AUDIO_ROUTE);
        if (routeExtra != null && (routeExtra.equals("headset") || routeExtra.equals("both") || routeExtra.equals("speaker"))) {
            String previousRoute = run.audioRoute;
            run.audioRoute = routeExtra;
            if (!previousRoute.equals(run.audioRoute)) applyAudioRouteToCuePool(run);
        }
        // v1.4.5 — media vs alarm stream. AudioAttributes MUST be set
        // before MediaPlayer.prepare(), so a change forces a full rebuild
        // of the cue MediaPlayer pool for this run.
        if (intent.hasExtra(EXTRA_RING_THROUGH_DND)) {
            boolean previousDnd = run.ringThroughDnd;
            run.ringThroughDnd = intent.getBooleanExtra(EXTRA_RING_THROUGH_DND, false);
            if (previousDnd != run.ringThroughDnd) {
                releaseCueMediaPlayers(run);
                ensureMediaPlayers(run);
            }
        }

        if (ACTION_COMPLETE.equals(action)) {
            // Ensure FGS contract is satisfied: startForegroundService
            // delivery obligates us to call startForeground within 5s.
            // post a placeholder for THIS run (will be immediately
            // replaced by the completion entry inside completeRun).
            ensureFgsBinding(run);
            boolean silent = intent.getBooleanExtra(EXTRA_SILENT, false);
            completeRun(run, !silent);
            return START_NOT_STICKY;
        }

        // ACTION_START or ACTION_UPDATE. JS-driven re-posts are silent
        // (the in-app cue path already fired Audio.chime); we sync
        // prevAlertIndex so the next autonomous tick doesn't double-alert.
        run.prevAlertIndex = run.curIndex;

        // "Fresh start" means JS thinks this is a brand-new run AND the
        // service hadn't already tracked it. Without the !wasKnown
        // guard, a JS-side restoreIfActive emitting chain:reschedule
        // (which the bridge calls as ChainTimer.start because the
        // bridge's per-run state is fresh on page load) would re-fire
        // the current segment's voice cue on the surviving service.
        boolean isStart = (ACTION_START.equals(action) || run.plan.isEmpty()) && !wasKnown;
        if (isStart) {
            // Sweep any stale "Chain complete" notification for this
            // run's slot left over from a previous cycle.
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) {
                try { nm.cancel(run.completionNotificationId); } catch (Throwable ignored) {}
            }
            run.lastVoicedAtIndex = -1;
        }

        // Place this run's notification. The FGS owner uses
        // startForeground; everyone else posts via NotificationManager.
        ensureFgsBindingOrPost(run, /*alert=*/false);

        if (ACTION_START.equals(action) || !running) {
            acquireWakeLock();
        }
        running = true;

        tryVoiceForCurrentSegment(run);

        // Schedule this run's next tick. Each run has its own runnable,
        // so two runs tick independently on the shared Handler.
        cancelTickFor(run);
        if (!run.paused && !run.plan.isEmpty()) {
            scheduleNextTick(run);
        }

        // Refresh the summary if 2+ runs are now active.
        refreshSummary();

        return START_NOT_STICKY;
    }

    // --- ChainRun management -------------------------------------

    private String resolveRunId(Intent intent) {
        String id = intent.getStringExtra(EXTRA_RUN_ID);
        return (id == null || id.isEmpty()) ? DEFAULT_RUN_ID : id;
    }

    private ChainRun getOrCreateRun(String runId) {
        ChainRun r = runs.get(runId);
        if (r != null) return r;
        Integer existingSlot = slotByRun.get(runId);
        int slot;
        if (existingSlot != null) {
            slot = existingSlot;
        } else {
            slot = nextSlot++;
            slotByRun.put(runId, slot);
        }
        r = new ChainRun(runId, slot);
        runs.put(runId, r);
        return r;
    }

    private void releaseRun(ChainRun run) {
        cancelTickFor(run);
        releaseVoicePlayer(run);
        releaseCueMediaPlayers(run);
        runs.remove(run.runId);
        // Note: slotByRun entry is kept so a quick restart of the same
        // chain gets the same notification id slot — avoids visual flicker
        // if the user re-runs the chain within seconds.
    }

    private void cancelTickFor(ChainRun run) {
        if (run.tickRunnable != null) tickHandler.removeCallbacks(run.tickRunnable);
    }

    /**
     * v1.4.2 — single source of truth for "should I voice this segment
     * now?" Returns true only when voice playback ACTUALLY happens
     * (or would happen if the per-segment path were available),
     * gated on:
     *
     *   - voicePaths is the same size as the plan (the JS-side TTS
     *     prerender resolved and shipped a complete payload). Empty
     *     voicePaths on the very first ACTION_START is the cold-start
     *     race that left segment 0 silent — this gate makes the service
     *     wait for the chain:fgsupdate that carries the populated paths.
     *
     *   - the segment index actually changed since the last voicing
     *     (regular dedup so a per-second tick UPDATE doesn't re-fire
     *     the same voice cue).
     *
     * Caller is responsible for setting lastVoicedAtIndex; we update
     * here only when the play is committed so a non-ready state retries
     * on the next intent. Returns true if voice was attempted/committed.
     */
    private boolean tryVoiceForCurrentSegment(ChainRun run) {
        if (run.paused) return false;
        if (run.plan.isEmpty()) return false;
        if (run.voicePaths.size() != run.plan.size()) return false;
        if (run.curIndex == run.lastVoicedAtIndex) return false;
        run.lastVoicedAtIndex = run.curIndex;
        maybePlayVoiceForSegment(run, run.curIndex);
        return true;
    }

    // --- per-run tick (formerly the singleton onTick) -------------

    private void onTickForRun(ChainRun run) {
        if (!running || run.paused) return;
        if (!runs.containsValue(run)) return;

        long now = System.currentTimeMillis();
        int idxBefore = run.curIndex;

        while (run.curIndex < run.plan.size()) {
            long segEndMs = run.segStartedAtMs + run.plan.get(run.curIndex).durationSec * 1000L;
            if (now < segEndMs) break;
            run.segStartedAtMs = segEndMs;
            run.curIndex++;
        }

        if (run.curIndex >= run.plan.size()) {
            // Chain naturally ended without JS noticing first.
            completeRun(run, /*alert=*/true);
            return;
        }

        boolean inForeground = isAppForegroundSafe();
        // v1.4.4: FGS is authoritative for chime / final-3 / voice / finale
        // in BOTH foreground and background. Previously we gated these on
        // !inForeground so JS Web Audio owned foreground playback — but
        // Web Audio routes through STREAM_MUSIC while the native voice
        // player rides STREAM_ALARM, so voice ignored the media-volume
        // slider while chimes tracked it (i.e. voice appeared "always max
        // and detached from the beep volume"). Unifying to FGS+ALARM in
        // both states also honours the same setPreferredDevice for cues
        // and voice, so headset routing behaves identically regardless of
        // whether the user is looking at the app. See Audio.* stubs in
        // js/app.js which are no-ops on native to prevent double-firing.
        boolean boundaryAlert = run.curIndex != idxBefore
            && run.curIndex != run.prevAlertIndex;
        // The notification's own channel-sound is still gated by
        // !inForeground so the OS chime doesn't stack with our MediaPlayer
        // cue when the user is watching the run view. The MediaPlayer
        // cue itself fires unconditionally below.
        boolean channelAlert = boundaryAlert && !inForeground;
        run.prevAlertIndex = run.curIndex;

        Notification n = buildNotification(run, null, channelAlert);
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) {
            try { nm.notify(run.notificationId, n); } catch (Throwable ignored) {}
        }

        if (boundaryAlert) playChime(run);

        if (run.curIndex != idxBefore) {
            tryVoiceForCurrentSegment(run);
        }

        Segment cur = run.plan.get(run.curIndex);
        long remainingSec = computeRemainingSec(run, cur);
        if (run.tickEnabled && remainingSec >= 1L && remainingSec <= 3L) {
            if (run.finalThreeStartedAtIndex != run.curIndex) {
                run.finalThreeStartedAtIndex = run.curIndex;
                playFinalThree(run);
            }
        }

        scheduleNextTick(run);
    }

    private boolean isAppForegroundSafe() {
        try { return ChainTimerPlugin.isAppForeground(); }
        catch (Throwable t) { return false; }
    }

    private void scheduleNextTick(ChainRun run) {
        if (run.curIndex >= run.plan.size()) return;
        long now = System.currentTimeMillis();
        long segEndMs = run.segStartedAtMs + run.plan.get(run.curIndex).durationSec * 1000L;
        long msUntilSegEnd = Math.max(0L, segEndMs - now);
        long elapsedInSeg = now - run.segStartedAtMs;
        long msToNextSecond = TICK_INTERVAL_MS - (elapsedInSeg % TICK_INTERVAL_MS);
        if (msToNextSecond <= 0) msToNextSecond = TICK_INTERVAL_MS;
        long delay = Math.min(msToNextSecond, msUntilSegEnd);
        if (delay < 16L) delay = 16L;
        if (run.tickRunnable == null) run.tickRunnable = () -> onTickForRun(run);
        tickHandler.postDelayed(run.tickRunnable, delay);
    }

    // --- Stop / complete ------------------------------------------

    /** User-initiated stop of every run (back-compat with v1.3.x). */
    private void stopAllRuns() {
        for (ChainRun run : new ArrayList<>(runs.values())) {
            cancelTickFor(run);
            releaseVoicePlayer(run);
            releaseCueMediaPlayers(run);
        }
        runs.clear();
        running = false;
        // Clear every run's notification + the summary.
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) {
            try { nm.cancel(SUMMARY_NOTIFICATION_ID); } catch (Throwable ignored) {}
            // Stale per-run + per-completion ids — we don't track all of
            // them in stopAllRuns since the map was already cleared, but
            // the slotByRun map still holds historical assignments.
            for (Integer slot : slotByRun.values()) {
                try { nm.cancel(RUN_NOTIF_BASE + (slot % SLOT_COUNT)); } catch (Throwable ignored) {}
            }
        }
        fgsOwnerRunId = null;
        releaseWakeLock();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    /** Stop a specific run — leaves other runs untouched. */
    private void stopRun(String runId, boolean alert) {
        ChainRun run = runs.get(runId);
        if (run == null) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        boolean wasFgsOwner = runId.equals(fgsOwnerRunId);
        releaseRun(run);
        if (nm != null) {
            try { nm.cancel(run.notificationId); } catch (Throwable ignored) {}
        }
        if (wasFgsOwner) {
            promoteNextFgsOwner();
        }
        finishIfNoRuns();
        refreshSummary();
    }

    /**
     * Natural completion of a single run. Replaces the run's persistent
     * notification with a "✓ Chain complete" heads-up entry on a fresh
     * id (Android only triggers heads-up on first post for a given id,
     * not on updates). If this was the FGS owner, promote another run
     * into the slot. If no runs remain, release wake lock + stopSelf.
     *
     * @param alert when true, the channel sound/vibration/heads-up fire
     *              (autonomous tick path detected the boundary while the
     *              user was away). When false (JS-driven completion in
     *              foreground) the entry is posted silently.
     */
    private void completeRun(ChainRun run, boolean alert) {
        cancelTickFor(run);
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) postCompletionNotification(nm, run, alert);
        // v1.4.4: finale plays via FGS MediaPlayer regardless of foreground
        // state (see boundary-alert block for rationale). alert=false is
        // still respected — it means the JS engine already handled a
        // silent completion path.
        boolean playedFinale = alert;
        if (playedFinale) playFinale(run);

        boolean wasFgsOwner = run.runId.equals(fgsOwnerRunId);

        // Unregister BEFORE promoting so promoteNextFgsOwner can't pick
        // this same run. MediaPlayer cleanup is separate (deferred when
        // a finale is still playing through THIS run's pool).
        runs.remove(run.runId);

        // FGS handoff strategy:
        //   - SURVIVOR EXISTS: immediately rebind FGS to its notification
        //     slot (startForeground with new id). Atomic — no gap.
        //   - NO SURVIVOR + FINALE PLAYING: keep the FGS binding on THIS
        //     run's notification id for the finale tail so the process
        //     stays foreground-protected. Aggressive OEMs (Samsung,
        //     Xiaomi) can otherwise cull a wake-lock-only service in
        //     under 1500ms, truncating the audible arpeggio. The
        //     stopForeground happens in the deferred lambda.
        //   - NO SURVIVOR + NO FINALE: detach FGS immediately.
        final boolean willKeepFgsForFinale = wasFgsOwner && runs.isEmpty() && playedFinale;
        if (wasFgsOwner) {
            ChainRun next = runs.isEmpty() ? null : runs.values().iterator().next();
            if (next != null) {
                ensureFgsBinding(next);
            } else if (!playedFinale) {
                try { stopForeground(STOP_FOREGROUND_REMOVE); } catch (Throwable ignored) {}
                fgsOwnerRunId = null;
            }
            // else: defer stopForeground until the finale tail lambda.
        }

        // Cancel the completing run's persistent notification — but only
        // if FGS handoff already moved away from this id. When we're
        // keeping FGS bound for the finale tail, leaving the notification
        // up briefly is the price of process survival; the deferred
        // lambda tears it down with stopForeground(REMOVE).
        if (nm != null && !willKeepFgsForFinale) {
            try { nm.cancel(run.notificationId); } catch (Throwable ignored) {}
        }

        // Defer MediaPlayer cleanup while the finale arpeggio is still
        // playing through this run's own finalePlayer (per-run pool, so
        // unaffected by promotion of other runs).
        final ChainRun finalRun = run;
        if (playedFinale) {
            tickHandler.postDelayed(() -> {
                cancelTickFor(finalRun);
                releaseVoicePlayer(finalRun);
                releaseCueMediaPlayers(finalRun);
                if (willKeepFgsForFinale) {
                    try { stopForeground(STOP_FOREGROUND_REMOVE); } catch (Throwable ignored) {}
                    fgsOwnerRunId = null;
                }
                finishIfNoRuns();
                refreshSummary();
            }, FINALE_TAIL_MS);
        } else {
            cancelTickFor(finalRun);
            releaseVoicePlayer(finalRun);
            releaseCueMediaPlayers(finalRun);
            finishIfNoRuns();
            refreshSummary();
        }
    }

    private void postCompletionNotification(NotificationManager nm, ChainRun run, boolean alert) {
        String safeName = (run.chainName == null || run.chainName.isEmpty()) ? "Chain" : run.chainName;
        int total = run.plan.size();
        String body = total == 1 ? "1 segment done" : total + " segments done";

        Intent appIntent = new Intent(this, MainActivity.class);
        appIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) piFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(this, 0, appIntent, piFlags);

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_FINALE)
            .setSmallIcon(R.drawable.ic_stat_icon)
            .setColor(0xFFF5B042)
            .setContentTitle("✓ " + safeName + " complete")
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setOngoing(false)
            .setCategory(NotificationCompat.CATEGORY_ALARM);
        // v1.4.1 — only group when other runs are still active (the
        // completing run was just removed from the map; >=1 survivor
        // means the group is meaningful). Single-chain completion
        // matches v1.3.x byte-for-byte.
        if (!runs.isEmpty()) b.setGroup(GROUP_KEY);

        boolean shouldAlert = alert && !isAppForegroundSafe();
        if (shouldAlert) {
            b.setOnlyAlertOnce(false).setPriority(NotificationCompat.PRIORITY_HIGH);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) b.setSilent(false);
        } else {
            b.setOnlyAlertOnce(true).setPriority(NotificationCompat.PRIORITY_LOW);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) b.setSilent(true);
        }

        try {
            nm.notify(run.completionNotificationId, b.build());
        } catch (Throwable ignored) {}
    }

    private void promoteNextFgsOwner() {
        // Pick the oldest survivor (LinkedHashMap insertion order).
        for (Map.Entry<String, ChainRun> e : runs.entrySet()) {
            ChainRun next = e.getValue();
            if (next == null) continue;
            ensureFgsBinding(next);
            return;
        }
    }

    private void finishIfNoRuns() {
        if (!runs.isEmpty()) return;
        running = false;
        fgsOwnerRunId = null;
        releaseWakeLock();
        try { stopForeground(STOP_FOREGROUND_REMOVE); } catch (Throwable ignored) {}
        // Clear summary if any.
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) {
            try { nm.cancel(SUMMARY_NOTIFICATION_ID); } catch (Throwable ignored) {}
        }
        stopSelf();
    }

    // --- Notification posting / FGS slot management ---------------

    /** Post the run's notification; bind to FGS if no owner yet,
     *  otherwise use NotificationManager.notify. */
    private void ensureFgsBindingOrPost(ChainRun run, boolean alert) {
        Notification n = buildNotification(run, null, alert);
        if (fgsOwnerRunId == null) {
            bindForeground(run, n);
        } else if (run.runId.equals(fgsOwnerRunId)) {
            // Re-post FGS notification (replaces in place).
            try {
                if (Build.VERSION.SDK_INT >= 34) {
                    startForeground(run.notificationId, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
                } else {
                    startForeground(run.notificationId, n);
                }
            } catch (Throwable t) {
                NotificationManager nm = getSystemService(NotificationManager.class);
                if (nm != null) { try { nm.notify(run.notificationId, n); } catch (Throwable ignored) {} }
            }
        } else {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) { try { nm.notify(run.notificationId, n); } catch (Throwable ignored) {} }
        }
    }

    /** Force-rebind FGS to this run. Used when the previous owner ended
     *  and we need to keep the foreground commitment alive. */
    private void ensureFgsBinding(ChainRun run) {
        Notification n = buildNotification(run, null, /*alert=*/false);
        bindForeground(run, n);
    }

    private void bindForeground(ChainRun run, Notification n) {
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(run.notificationId, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(run.notificationId, n);
            }
            fgsOwnerRunId = run.runId;
        } catch (Throwable t) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) { try { nm.notify(run.notificationId, n); } catch (Throwable ignored) {} }
        }
    }

    /** Post (or clear) the group summary notification. Required for
     *  Android to render the bundled-notification stack header when
     *  2+ runs are active. */
    private void refreshSummary() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        if (runs.size() < 2) {
            try { nm.cancel(SUMMARY_NOTIFICATION_ID); } catch (Throwable ignored) {}
            return;
        }
        StringBuilder names = new StringBuilder();
        int count = 0;
        for (ChainRun r : runs.values()) {
            if (count++ > 0) names.append(" · ");
            names.append((r.chainName == null || r.chainName.isEmpty()) ? "Chain" : r.chainName);
        }
        Intent appIntent = new Intent(this, MainActivity.class);
        appIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) piFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(this, 0, appIntent, piFlags);

        Notification summary = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_icon)
            .setColor(0xFFF5B042)
            .setContentTitle(runs.size() + " chains running")
            .setContentText(names.toString())
            .setStyle(new NotificationCompat.BigTextStyle().bigText(names.toString()))
            .setContentIntent(pi)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setGroup(GROUP_KEY)
            .setGroupSummary(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .build();
        try { nm.notify(SUMMARY_NOTIFICATION_ID, summary); } catch (Throwable ignored) {}
    }

    // --- Channel setup --------------------------------------------

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;

        for (String legacy : LEGACY_CHANNELS) {
            try { nm.deleteNotificationChannel(legacy); } catch (Throwable ignored) {}
        }

        AudioAttributes alarmAttrs = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();

        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "Chain transitions", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("Persistent chain status + segment-boundary alert");
            ch.setShowBadge(false);
            ch.enableLights(true);
            ch.setLightColor(0xFFF5B042);
            ch.enableVibration(true);
            ch.setSound(null, alarmAttrs);
            ch.setBypassDnd(true);
            nm.createNotificationChannel(ch);
        }
        if (nm.getNotificationChannel(CHANNEL_FINALE) == null) {
            NotificationChannel ch = new NotificationChannel(
                CHANNEL_FINALE, "Chain complete", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("Heads-up entry when a chain naturally ends");
            ch.setShowBadge(false);
            ch.enableLights(true);
            ch.setLightColor(0xFFF5B042);
            ch.enableVibration(true);
            ch.setSound(null, alarmAttrs);
            ch.setBypassDnd(true);
            nm.createNotificationChannel(ch);
        }
    }

    // --- Notification building (per-run) --------------------------

    private Notification buildNotification(ChainRun run, Intent intent, boolean alert) {
        Intent appIntent = new Intent(this, MainActivity.class);
        appIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) piFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(this, 0, appIntent, piFlags);

        Segment cur = (run.curIndex >= 0 && run.curIndex < run.plan.size()) ? run.plan.get(run.curIndex) : null;
        Segment next = (run.curIndex + 1 < run.plan.size()) ? run.plan.get(run.curIndex + 1) : null;
        int total = run.plan.size();

        long remainingSec = computeRemainingSec(run, cur);
        String prefix = run.paused ? "⏸" : "▶";
        String segName = (cur != null && cur.name != null && !cur.name.isEmpty()) ? cur.name : "Segment";
        String title = prefix + " " + segName + " · " + fmtClock(remainingSec);
        String body = "Segment " + (run.curIndex + 1) + " of " + total + " · " + run.chainName;
        String sub  = (run.curIndex + 1) + "/" + total;
        StringBuilder large = new StringBuilder();
        large.append(run.chainName).append(" · Segment ").append(run.curIndex + 1).append(" of ").append(total).append('\n');
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
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE);
        // v1.4.1 — only group the notification when 2+ runs are active.
        // A solo group can render an "expand chevron" on some OEM ROMs
        // even with no siblings; gating preserves byte-for-byte single-
        // chain UX with v1.3.x.
        if (runs.size() >= 2) b.setGroup(GROUP_KEY);

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
            float segFrac = 1f - ((float) remainingSec / (float) cur.durationSec);
            if (segFrac < 0f) segFrac = 0f;
            if (segFrac > 1f) segFrac = 1f;
            int progress = Math.round(100f * (run.curIndex + segFrac) / (float) total);
            b.setProgress(100, Math.max(0, Math.min(100, progress)), false);
        }

        boolean hasPrev = intent != null
            ? intent.getBooleanExtra(EXTRA_HAS_PREV, run.curIndex > 0)
            : (run.curIndex > 0);
        boolean hasNext = intent != null
            ? intent.getBooleanExtra(EXTRA_HAS_NEXT, run.curIndex < total - 1)
            : (run.curIndex < total - 1);

        if (hasPrev) {
            b.addAction(R.drawable.ic_notif_prev, "Previous segment",
                commandPendingIntent(run.runId, COMMAND_SKIP_PREV, 10));
        }
        b.addAction(
            run.paused ? R.drawable.ic_notif_play : R.drawable.ic_notif_pause,
            run.paused ? "Resume" : "Pause",
            commandPendingIntent(run.runId, run.paused ? COMMAND_RESUME : COMMAND_PAUSE, 11));
        if (hasNext) {
            b.addAction(R.drawable.ic_notif_next, "Next segment",
                commandPendingIntent(run.runId, COMMAND_SKIP_NEXT, 13));
        }
        b.addAction(R.drawable.ic_notif_stop, "Stop chain",
            commandPendingIntent(run.runId, COMMAND_STOP, 12));

        return b.build();
    }

    private long computeRemainingSec(ChainRun run, Segment cur) {
        if (cur == null) return 0L;
        if (run.paused) {
            return Math.max(0L, (run.pausedRemainingMs + 999L) / 1000L);
        }
        long now = System.currentTimeMillis();
        long endMs = run.segStartedAtMs + cur.durationSec * 1000L;
        long remMs = endMs - now;
        if (remMs < 0L) return 0L;
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

    private int clampIndex(ChainRun run, int idx) {
        if (idx < 0) return 0;
        if (run.plan.isEmpty()) return 0;
        return Math.min(idx, run.plan.size() - 1);
    }

    // --- Plan parsing --------------------------------------------

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

    // --- Notification action plumbing -----------------------------

    /** Build a PendingIntent for a notification action that delivers a
     *  command to this service, routed by runId. Request code is
     *  derived from the run's notification id slot (unique per active
     *  run — sequential slots, no hash collisions) shifted left by 4
     *  to leave room for a per-command nibble. Avoids the
     *  Math.abs(Integer.MIN_VALUE) negative-modulo hazard and the
     *  pause/resume "both share code 11" collision the v1.3.x code had. */
    private PendingIntent commandPendingIntent(String runId, String command, int unusedRequestCode) {
        Intent intent = new Intent(this, ChainTimerService.class);
        intent.setAction(ACTION_CMD);
        intent.putExtra(EXTRA_COMMAND, command);
        intent.putExtra(EXTRA_RUN_ID, runId);
        ChainRun r = runs.get(runId);
        // Per-run unique base from the run's notification id; fall back
        // to runId hash with the sign bit masked off (never negative).
        int base = (r != null)
            ? r.notificationId
            : ((runId == null ? 0 : (runId.hashCode() & 0x7FFFFFFF) % 1000) + RUN_NOTIF_BASE);
        int code = (base << 4) | commandCode(command);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getService(this, code, intent, flags);
    }

    private static int commandCode(String command) {
        if (COMMAND_PAUSE.equals(command))      return 1;
        if (COMMAND_RESUME.equals(command))     return 2;
        if (COMMAND_STOP.equals(command))       return 3;
        if (COMMAND_SKIP_PREV.equals(command))  return 4;
        if (COMMAND_SKIP_NEXT.equals(command))  return 5;
        return 0;
    }

    private void handleNotificationCommand(String runId, String cmd) {
        if (cmd == null) return;
        ChainRun run = runs.get(runId);
        if (run == null) {
            // Action button on a notification for a run we no longer
            // track — defensively forward to JS for state sync but
            // don't mutate any service state.
            ChainTimerPlugin.deliverChainCommand(cmd, runId);
            return;
        }

        Segment cur = (run.curIndex >= 0 && run.curIndex < run.plan.size()) ? run.plan.get(run.curIndex) : null;
        long now = System.currentTimeMillis();
        boolean updated = false;

        if (COMMAND_STOP.equals(cmd)) {
            ChainTimerPlugin.deliverChainCommand(cmd, runId);
            stopRun(runId, /*alert=*/false);
            return;
        }

        if (COMMAND_PAUSE.equals(cmd)) {
            if (!run.paused && cur != null) {
                long endMs = run.segStartedAtMs + cur.durationSec * 1000L;
                run.pausedRemainingMs = Math.max(0L, endMs - now);
                run.paused = true;
                cancelTickFor(run);
                updated = true;
            }
        } else if (COMMAND_RESUME.equals(cmd)) {
            if (run.paused && cur != null) {
                run.segStartedAtMs = now + run.pausedRemainingMs - cur.durationSec * 1000L;
                run.pausedRemainingMs = 0L;
                run.paused = false;
                scheduleNextTick(run);
                updated = true;
            }
        } else if (COMMAND_SKIP_NEXT.equals(cmd)) {
            if (run.curIndex < run.plan.size() - 1) {
                run.curIndex++;
                run.segStartedAtMs = now;
                run.pausedRemainingMs = 0L;
                run.paused = false;
                run.prevAlertIndex = run.curIndex;
                run.finalThreeStartedAtIndex = -1;
                tryVoiceForCurrentSegment(run);
                cancelTickFor(run);
                scheduleNextTick(run);
                updated = true;
            } else if (cur != null) {
                ChainTimerPlugin.deliverChainCommand(cmd, runId);
                completeRun(run, /*alert=*/false);
                return;
            }
        } else if (COMMAND_SKIP_PREV.equals(cmd)) {
            long elapsedInSeg = run.paused
                ? (cur != null ? cur.durationSec * 1000L - run.pausedRemainingMs : 0L)
                : (now - run.segStartedAtMs);
            if (run.curIndex > 0 && elapsedInSeg <= 2500L) {
                run.curIndex--;
            }
            run.segStartedAtMs = now;
            run.pausedRemainingMs = 0L;
            run.paused = false;
            run.prevAlertIndex = run.curIndex;
            run.finalThreeStartedAtIndex = -1;
            tryVoiceForCurrentSegment(run);
            cancelTickFor(run);
            scheduleNextTick(run);
            updated = true;
        }

        if (updated) {
            Notification n = buildNotification(run, null, false);
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) {
                if (run.runId.equals(fgsOwnerRunId)) {
                    bindForeground(run, n);
                } else {
                    try { nm.notify(run.notificationId, n); } catch (Throwable ignored) {}
                }
            }
        }

        ChainTimerPlugin.deliverChainCommand(cmd, runId);
    }

    // --- Per-run MediaPlayer pool ---------------------------------

    private void ensureMediaPlayers(ChainRun run) {
        if (run.chimePlayer != null) return;
        try {
            // v1.4.5 — USAGE picked per-run from ringThroughDnd:
            //   false → USAGE_MEDIA (default, media slider, silenced by DND)
            //   true  → USAGE_ALARM (alarm slider, rings through DND)
            int usage = run.ringThroughDnd
                ? AudioAttributes.USAGE_ALARM
                : AudioAttributes.USAGE_MEDIA;
            run.chimePlayer      = createPreparedPlayer(R.raw.chime,   usage);
            run.finalThreePlayer = createPreparedPlayer(R.raw.final3,  usage);
            run.finalePlayer     = createPreparedPlayer(R.raw.finale,  usage);
            applyAudioRouteToCuePool(run);
            warmCueMediaPlayers(run);
        } catch (Throwable t) {
            releaseCueMediaPlayers(run);
        }
    }

    private void warmCueMediaPlayers(ChainRun run) {
        warmOneCue(run.chimePlayer);
        warmOneCue(run.finalThreePlayer);
        warmOneCue(run.finalePlayer);
    }

    private void warmOneCue(android.media.MediaPlayer mp) {
        if (mp == null) return;
        try {
            mp.setVolume(0f, 0f);
            mp.start();
            mp.pause();
            mp.seekTo(0);
            mp.setVolume(1f, 1f);
        } catch (Throwable ignored) {}
    }

    private android.media.MediaPlayer createPreparedPlayer(int resId, int usage) throws Exception {
        // NOTE: we deliberately avoid MediaPlayer.create(context, resId) here.
        // That factory calls prepare() internally, and per the docs
        // setAudioAttributes MUST be called before prepare/prepareAsync to
        // take effect. Called after (as we used to), Android silently
        // ignores the attributes and the player falls back to STREAM_MUSIC —
        // meaning the chime/finale/final3 would follow the media-volume
        // slider, while the voice player (built with the fresh-instance
        // pattern below) correctly rides STREAM_ALARM. That mismatch is
        // what the user perceived as "voice is always at max and doesn't
        // follow the beep volume" (v1.4.4).
        //
        // v1.4.5 — usage is passed in per-run: USAGE_MEDIA (default) or
        // USAGE_ALARM (when the user has "Ring through DND" enabled).
        android.media.MediaPlayer mp = new android.media.MediaPlayer();
        AudioAttributes attrs = new AudioAttributes.Builder()
            .setUsage(usage)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
        mp.setAudioAttributes(attrs);
        android.content.res.AssetFileDescriptor afd = null;
        try {
            afd = getResources().openRawResourceFd(resId);
            if (afd == null) throw new Exception("openRawResourceFd returned null for resId=" + resId);
            mp.setDataSource(afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
        } finally {
            if (afd != null) try { afd.close(); } catch (Throwable ignored) {}
        }
        mp.prepare();
        return mp;
    }

    private void applyAudioRouteToCuePool(ChainRun run) {
        android.media.AudioDeviceInfo preferred = pickPreferredOutputDevice(run.audioRoute);
        if (run.chimePlayer      != null) try { run.chimePlayer.setPreferredDevice(preferred); }      catch (Throwable ignored) {}
        if (run.finalThreePlayer != null) try { run.finalThreePlayer.setPreferredDevice(preferred); } catch (Throwable ignored) {}
        if (run.finalePlayer     != null) try { run.finalePlayer.setPreferredDevice(preferred); }     catch (Throwable ignored) {}
    }

    private void playCueSound(ChainRun run, android.media.MediaPlayer mp) {
        if (!run.soundEnabled || mp == null) return;
        try {
            if (mp.isPlaying()) mp.pause();
            mp.seekTo(0);
            mp.start();
        } catch (Throwable ignored) {}
    }

    private void playChime(ChainRun run)      { playCueSound(run, run.chimePlayer); }
    private void playFinale(ChainRun run)     { playCueSound(run, run.finalePlayer); }
    private void playFinalThree(ChainRun run) { playCueSound(run, run.finalThreePlayer); }

    private void releaseCueMediaPlayers(ChainRun run) {
        if (run.chimePlayer != null)      { try { run.chimePlayer.release(); }      catch (Throwable ignored) {} run.chimePlayer = null; }
        if (run.finalThreePlayer != null) { try { run.finalThreePlayer.release(); } catch (Throwable ignored) {} run.finalThreePlayer = null; }
        if (run.finalePlayer != null)     { try { run.finalePlayer.release(); }     catch (Throwable ignored) {} run.finalePlayer = null; }
    }

    private void maybePlayVoiceForSegment(ChainRun run, int segIdx) {
        if (segIdx < 0 || segIdx >= run.voicePaths.size()) return;
        boolean voiceOn = segIdx >= run.voiceEnabled.size() || Boolean.TRUE.equals(run.voiceEnabled.get(segIdx));
        if (!voiceOn) return;
        String path = run.voicePaths.get(segIdx);
        if (path == null) return;
        File f = new File(path);
        if (!f.exists() || f.length() == 0) return;

        releaseVoicePlayer(run);
        try {
            android.media.MediaPlayer mp = new android.media.MediaPlayer();
            // v1.4.5 — same usage policy as the cue MediaPlayer pool.
            int usage = run.ringThroughDnd
                ? android.media.AudioAttributes.USAGE_ALARM
                : android.media.AudioAttributes.USAGE_MEDIA;
            android.media.AudioAttributes attrs = new android.media.AudioAttributes.Builder()
                .setUsage(usage)
                .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH)
                .build();
            mp.setAudioAttributes(attrs);
            mp.setDataSource(path);
            // Marshal completion/error callbacks onto the main thread — the
            // MediaPlayer's internal threads fire these handlers, and they
            // touch run.voicePlayer which is otherwise only written from
            // the main thread (onStartCommand, handleNotificationCommand,
            // completeRun deferred lambda). Without this hop, a concurrent
            // releaseVoicePlayer could double-release the same MediaPlayer.
            mp.setOnCompletionListener(p -> tickHandler.post(() -> {
                try { p.release(); } catch (Throwable ignored) {}
                if (run.voicePlayer == p) run.voicePlayer = null;
            }));
            mp.setOnErrorListener((p, what, extra) -> {
                tickHandler.post(() -> {
                    try { p.release(); } catch (Throwable ignored) {}
                    if (run.voicePlayer == p) run.voicePlayer = null;
                });
                return true;
            });
            mp.prepare();
            android.media.AudioDeviceInfo preferred = pickPreferredOutputDevice(run.audioRoute);
            if (preferred != null) mp.setPreferredDevice(preferred);
            mp.start();
            run.voicePlayer = mp;
        } catch (Throwable t) {
            releaseVoicePlayer(run);
        }
    }

    private android.media.AudioDeviceInfo pickPreferredOutputDevice(String route) {
        try {
            android.media.AudioManager am = (android.media.AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return null;
            android.media.AudioDeviceInfo[] outs = am.getDevices(android.media.AudioManager.GET_DEVICES_OUTPUTS);
            if (outs == null || outs.length == 0) return null;
            if ("speaker".equals(route)) {
                for (android.media.AudioDeviceInfo d : outs) {
                    if (d.getType() == android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) return d;
                }
                return null;
            }
            if ("headset".equals(route)) {
                android.media.AudioDeviceInfo wired = null, bt = null, btSco = null, usb = null;
                for (android.media.AudioDeviceInfo d : outs) {
                    int t = d.getType();
                    if (t == android.media.AudioDeviceInfo.TYPE_USB_HEADSET) usb = d;
                    else if (t == android.media.AudioDeviceInfo.TYPE_WIRED_HEADSET
                          || t == android.media.AudioDeviceInfo.TYPE_WIRED_HEADPHONES) wired = d;
                    else if (t == android.media.AudioDeviceInfo.TYPE_BLUETOOTH_A2DP) bt = d;
                    else if (t == android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO) btSco = d;
                }
                if (usb   != null) return usb;
                if (wired != null) return wired;
                if (bt    != null) return bt;
                if (btSco != null) return btSco;
                return null;
            }
            return null;
        } catch (Throwable t) {
            return null;
        }
    }

    private void releaseVoicePlayer(ChainRun run) {
        android.media.MediaPlayer mp = run.voicePlayer;
        run.voicePlayer = null;
        if (mp == null) return;
        try { if (mp.isPlaying()) mp.stop(); } catch (Throwable ignored) {}
        try { mp.release(); } catch (Throwable ignored) {}
    }

    private static List<String> parseStringArray(String json) {
        List<String> out = new ArrayList<>();
        if (json == null || json.isEmpty()) return out;
        try {
            JSONArray arr = new JSONArray(json);
            for (int i = 0; i < arr.length(); i++) {
                Object v = arr.opt(i);
                out.add((v == null || v == JSONObject.NULL) ? null : v.toString());
            }
        } catch (JSONException ignored) {}
        return out;
    }

    private static List<Boolean> parseBoolArray(String json) {
        List<Boolean> out = new ArrayList<>();
        if (json == null || json.isEmpty()) return out;
        try {
            JSONArray arr = new JSONArray(json);
            for (int i = 0; i < arr.length(); i++) out.add(arr.optBoolean(i, true));
        } catch (JSONException ignored) {}
        return out;
    }

    @SuppressLint("WakelockTimeout")
    private void acquireWakeLock() {
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null) return;
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKELOCK_TAG);
            wakeLock.setReferenceCounted(false);
        }
        if (!wakeLock.isHeld()) wakeLock.acquire();
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            try { wakeLock.release(); } catch (Throwable ignored) {}
        }
    }

    @Override
    public void onDestroy() {
        running = false;
        for (ChainRun run : new ArrayList<>(runs.values())) {
            cancelTickFor(run);
            releaseVoicePlayer(run);
            releaseCueMediaPlayers(run);
        }
        runs.clear();
        releaseWakeLock();
        super.onDestroy();
    }

    private static String strOr(Intent i, String key, String def) {
        if (i == null) return def;
        String v = i.getStringExtra(key);
        return v != null ? v : def;
    }

    static class Segment {
        String name;
        int durationSec;
    }
}
