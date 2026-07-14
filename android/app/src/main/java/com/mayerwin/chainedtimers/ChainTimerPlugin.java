package com.github.chainedtimers;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

// v1.4.4 — Play In-App Updates (com.google.android.play:app-update).
// The SDK is safe to import unconditionally: it degrades to
// UPDATE_NOT_AVAILABLE on installs the Play Store doesn't recognise
// (sideload, other stores), which is exactly the signal the JS Updater
// uses to fall back to the GitHub Releases check.
import com.google.android.play.core.appupdate.AppUpdateInfo;
import com.google.android.play.core.appupdate.AppUpdateManager;
import com.google.android.play.core.appupdate.AppUpdateManagerFactory;
import com.google.android.play.core.appupdate.AppUpdateOptions;
import com.google.android.play.core.install.InstallState;
import com.google.android.play.core.install.InstallStateUpdatedListener;
import com.google.android.play.core.install.model.AppUpdateType;
import com.google.android.play.core.install.model.InstallStatus;
import com.google.android.play.core.install.model.UpdateAvailability;

import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Bridges JS → ChainTimerService.
 *
 * Three calls:
 *   start({title, body, largeBody, subText})  — begin a chain run, take wake lock
 *   update({…})                                — replace notification content
 *   stop()                                     — end run, release wake lock
 *
 * The plugin is forgiving: callers don't need to await or check the result.
 * It's a fire-and-forget control plane for the foreground service.
 */
@CapacitorPlugin(name = "ChainTimer")
public class ChainTimerPlugin extends Plugin {

    // Lifecycle-tracked "is the activity currently in the foreground" flag,
    // queried by the service to suppress notification sounds + heads-up
    // when the user is already looking at the app (and the WebView's
    // Audio.chime/finale/tick are playing through the Media stream).
    // Defaults to true so we err toward "let the in-app sounds play
    // alone" until we observe an actual onPause.
    private static volatile boolean appForeground = true;
    public static boolean isAppForeground() { return appForeground; }

    // Static reference to the loaded plugin instance so the service
    // (which runs in the same process but isn't owned by Capacitor) can
    // forward notification-button taps to JS via notifyListeners. Cleared
    // on activity destroy so we don't dispatch into a dead WebView.
    private static volatile ChainTimerPlugin instance;

    /**
     * Called by ChainTimerService when a notification action button is
     * tapped. The PendingIntent now goes straight to the service via
     * getService() (so the activity doesn't get launched into the
     * foreground), but the engine still lives in JS, so the service
     * relays the command here. Best-effort: if the WebView has been
     * fully torn down (instance == null) the call is a no-op and the
     * service relies on its own state mutation to keep the chain in
     * the right state.
     */
    public static void deliverChainCommand(String command) {
        deliverChainCommand(command, null);
    }

    /** v1.4.1 — overload carrying runId so the JS engine knows which
     *  run the command applies to. The old no-runId overload is kept
     *  for legacy callers (none expected). */
    public static void deliverChainCommand(String command, String runId) {
        ChainTimerPlugin p = instance;
        if (p == null || command == null) return;
        try {
            JSObject payload = new JSObject();
            payload.put("command", command);
            if (runId != null) payload.put("runId", runId);
            p.notifyListeners("chainCommand", payload, true);
        } catch (Throwable ignored) {}
    }

    @Override
    public void load() {
        super.load();
        instance = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
        appForeground = false;
        super.handleOnDestroy();
    }

    @Override
    public void handleOnResume() {
        super.handleOnResume();
        appForeground = true;
        // v1.4.4 — re-check Play In-App Updates: if the user backgrounded
        // us mid-IMMEDIATE flow the Play SDK contract says we must
        // relaunch it; if a FLEXIBLE update finished downloading while we
        // were away, notify JS so it can prompt for restart.
        try {
            AppUpdateManager mgr = getAppUpdateManager();
            mgr.getAppUpdateInfo().addOnSuccessListener(info -> {
                if (info.updateAvailability() == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS) {
                    Activity activity = getActivity();
                    if (activity != null) {
                        try {
                            mgr.startUpdateFlow(info, activity,
                                AppUpdateOptions.newBuilder(AppUpdateType.IMMEDIATE).build());
                        } catch (Throwable ignored) {}
                    }
                }
                if (info.installStatus() == InstallStatus.DOWNLOADED) {
                    JSObject payload = new JSObject();
                    payload.put("status", "downloaded");
                    notifyListeners("playUpdateStatus", payload, true);
                }
            });
        } catch (Throwable ignored) {}
    }

    @Override
    public void handleOnPause() {
        super.handleOnPause();
        // Pause covers cases like the notification shade overlaying the
        // activity — we still consider that "foreground" because the
        // WebView is alive and Audio.* will play. The transition to a
        // truly-backgrounded state is captured by handleOnStop below.
    }

    @Override
    public void handleOnStop() {
        super.handleOnStop();
        appForeground = false;
    }

    @PluginMethod
    public void start(PluginCall call) {
        sendIntent(ChainTimerService.ACTION_START, call);
        JSObject ret = new JSObject();
        ret.put("started", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void update(PluginCall call) {
        // ACTION_UPDATE is functionally identical to ACTION_START in the
        // service: startForeground(id, n) re-posts/replaces the notification.
        sendIntent(ChainTimerService.ACTION_UPDATE, call);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), ChainTimerService.class);
        intent.setAction(ChainTimerService.ACTION_STOP);
        // startService is fine for STOP — the service handles its own
        // foreground lifecycle.
        try {
            getContext().startService(intent);
        } catch (IllegalStateException ignored) {
            // Stopping a service that was never started — harmless.
        }
        call.resolve();
    }

    /**
     * Called from JS when a chain ends naturally. Routes through the same
     * channel as start/update so the service can replace its persistent
     * notification in place with the "✓ Chain complete" heads-up entry,
     * detach the foreground state, and stop. Distinct from {@link #stop}
     * (which is a silent user-initiated cancel — no completion alert).
     */
    @PluginMethod
    public void complete(PluginCall call) {
        sendIntent(ChainTimerService.ACTION_COMPLETE, call);
        call.resolve();
    }

    @PluginMethod
    public void isRunning(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("running", ChainTimerService.isRunning());
        call.resolve(ret);
    }

    /**
     * Reports whether the app is currently exempt from battery optimization.
     *
     * On Android 6+ (API 23), even foreground services can be killed by
     * the OEM battery saver if the app is in the "Optimized" bucket. For
     * critical timer use cases (medication reminders, sleep cycles), the
     * user MUST add the app to the unrestricted list — without it, the
     * FGS + wake lock + exact alarms can all be overridden by Samsung /
     * Xiaomi / OPPO / Huawei / Vivo / OnePlus battery savers.
     *
     * Returns:
     *   { ignoring: boolean, supported: boolean }
     *
     * `supported = false` on API < 23 (battery optimisation didn't exist).
     */
    @PluginMethod
    public void isIgnoringBatteryOptimizations(PluginCall call) {
        JSObject ret = new JSObject();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            ret.put("supported", false);
            ret.put("ignoring", true);   // pre-M had no Doze
            call.resolve(ret);
            return;
        }
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        boolean exempt = (pm != null) && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
        ret.put("supported", true);
        ret.put("ignoring", exempt);
        call.resolve(ret);
    }

    /**
     * Opens the system "Battery optimization" prompt for our app, asking
     * the user to confirm exemption. This is a Google-restricted intent
     * (BatteryLife lint) but is explicitly permitted for alarm/timer apps —
     * see publishing/android/permissions-declaration.md.
     *
     * Best-effort: if the OEM has stripped the activity, fall back to the
     * regular per-app battery settings page so the user can flip it manually.
     */
    @PluginMethod
    @SuppressLint("BatteryLife")
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            JSObject ret = new JSObject();
            ret.put("ignoring", true);
            ret.put("opened", false);
            call.resolve(ret);
            return;
        }
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        String pkg = getContext().getPackageName();
        if (pm != null && pm.isIgnoringBatteryOptimizations(pkg)) {
            JSObject ret = new JSObject();
            ret.put("ignoring", true);
            ret.put("opened", false);
            call.resolve(ret);
            return;
        }

        Intent direct = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
        direct.setData(Uri.parse("package:" + pkg));
        direct.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (direct.resolveActivity(getContext().getPackageManager()) != null) {
            try {
                getContext().startActivity(direct);
                JSObject ret = new JSObject();
                ret.put("ignoring", false);
                ret.put("opened", true);
                call.resolve(ret);
                return;
            } catch (Exception ignored) { /* fall through */ }
        }

        // Fallback: per-app details so the user can find the toggle manually.
        Intent fallback = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        fallback.setData(Uri.parse("package:" + pkg));
        fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(fallback);
            JSObject ret = new JSObject();
            ret.put("ignoring", false);
            ret.put("opened", true);
            ret.put("fallback", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("could not open battery optimization settings: " + e.getMessage());
        }
    }

    /**
     * Reports whether notifications can actually be delivered.
     *
     * Returns the strongest possible "this will silently fail" signals:
     *   - appEnabled: app-level POST_NOTIFICATIONS grant + global toggle
     *   - transitionsChannelEnabled: persistent + boundary-alert channel ON
     *                                 (CHANNEL_ID — display name "Chain transitions")
     *   - completeChannelEnabled:    chain-end heads-up channel ON
     *                                 (CHANNEL_FINALE — display name "Chain complete")
     *
     * If any of these is false the chain runs but the user gets nothing —
     * essential for medication-grade reliability checks.
     */
    @PluginMethod
    public void getNotificationHealth(PluginCall call) {
        Context ctx = getContext();
        JSObject ret = new JSObject();
        NotificationManagerCompat nmc = NotificationManagerCompat.from(ctx);
        boolean appEnabled = nmc.areNotificationsEnabled();
        ret.put("appEnabled", appEnabled);

        boolean transitionsOn = true;
        boolean completeOn    = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            if (nm != null) {
                transitionsOn = isChannelOn(nm, ChainTimerService.CHANNEL_ID);
                completeOn    = isChannelOn(nm, ChainTimerService.CHANNEL_FINALE);
            }
        }
        ret.put("transitionsChannelEnabled", transitionsOn);
        ret.put("completeChannelEnabled",    completeOn);
        ret.put("ok", appEnabled && transitionsOn && completeOn);
        call.resolve(ret);
    }

    private static boolean isChannelOn(NotificationManager nm, String id) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        NotificationChannel ch = nm.getNotificationChannel(id);
        // null = channel not yet created (treat as enabled — first run).
        // IMPORTANCE_NONE = user explicitly disabled in OS settings.
        return ch == null || ch.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }

    // ------------------------------------------------------------------
    // TTS pre-rendering — Voice cues without per-boundary latency.
    //
    // window.speechSynthesis inside the Capacitor Android WebView is
    // unreliable, and even with @capacitor-community/text-to-speech
    // (which talks to android.speech.tts.TextToSpeech) JS-side speak()
    // calls only fire while the WebView is alive — the moment the user
    // backgrounds the app, the JS engine pauses and no voice fires at
    // segment boundaries.
    //
    // Fix: pre-render every segment name to a WAV file at chain start,
    // hand the file paths to ChainTimerService, and have the service
    // play the right file via MediaPlayer at every boundary. Files are
    // cached in the app's cache dir keyed by SHA-1 of the text, so
    // repeat chain runs are instant. The cache dir is cleared by Android
    // automatically under storage pressure; any missing file falls back
    // to silence (the service checks existence before playing).
    // ------------------------------------------------------------------

    /** Initialized lazily on first prerender call. The Activity context is
     *  retained but cleared in handleOnDestroy via the static reset path. */
    private static volatile TextToSpeech sharedTts;
    private static volatile boolean ttsReady       = false;
    private static volatile boolean ttsInitFailed  = false;
    private static final Object ttsInitLock = new Object();
    /** Latches one per outstanding synthesizeToFile call, keyed by
     *  utteranceId. The shared progress listener counts each one down. */
    private static final ConcurrentHashMap<String, CountDownLatch> ttsLatches = new ConcurrentHashMap<>();

    private static void ensureTtsInit(Context ctx, Runnable onReady) {
        if (ttsReady)      { onReady.run(); return; }
        if (ttsInitFailed) { onReady.run(); return; }
        synchronized (ttsInitLock) {
            if (ttsReady || ttsInitFailed) { onReady.run(); return; }
            if (sharedTts == null) {
                sharedTts = new TextToSpeech(ctx.getApplicationContext(), status -> {
                    if (status == TextToSpeech.SUCCESS) {
                        // Wire a single progress listener that routes by
                        // utteranceId. Each synthesizeToFile call gets its
                        // own latch in ttsLatches; we count it down on done
                        // or error regardless. The waiter on the calling
                        // thread then proceeds.
                        sharedTts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                            @Override public void onStart(String id) { /* no-op */ }
                            @Override public void onDone(String id) {
                                CountDownLatch l = ttsLatches.remove(id);
                                if (l != null) l.countDown();
                            }
                            @Override public void onError(String id) {
                                CountDownLatch l = ttsLatches.remove(id);
                                if (l != null) l.countDown();
                            }
                            @Override public void onError(String id, int errorCode) {
                                CountDownLatch l = ttsLatches.remove(id);
                                if (l != null) l.countDown();
                            }
                        });
                        ttsReady = true;
                    } else {
                        ttsInitFailed = true;
                    }
                    onReady.run();
                });
            }
        }
    }

    /**
     * Pre-render an array of texts to WAV files in the app's cache dir.
     * Returns the file paths under `paths` (parallel to the input array)
     * — entries are null when synthesis fails or the TTS engine is
     * unavailable (the FGS treats null as "no voice for this segment"
     * and falls back to silence).
     *
     * Files are keyed by SHA-1 of the text so repeated names in a chain
     * (e.g. Inhale/Hold/Exhale × 10 in a Box Breath) render exactly
     * once, and subsequent chain runs hit the cache immediately. The
     * whole call blocks until every file is either ready or known
     * failed; total time is dominated by the LONGEST synthesis, since
     * the underlying TextToSpeech queue is per-utterance and ordered
     * but each utterance renders independently.
     */
    @PluginMethod
    public void prerenderVoices(PluginCall call) {
        JSArray texts = call.getArray("texts");
        if (texts == null) { call.reject("texts array required"); return; }
        final int n = texts.length();

        ensureTtsInit(getContext(), () -> {
            JSArray pathsArr = new JSArray();
            if (!ttsReady) {
                // Engine never initialized — return all nulls; the JS side
                // already knows how to fall back gracefully.
                for (int i = 0; i < n; i++) pathsArr.put(JSONObject.NULL);
                JSObject ret = new JSObject();
                ret.put("paths", pathsArr);
                call.resolve(ret);
                return;
            }

            File voicesDir = new File(getContext().getCacheDir(), "voices");
            if (!voicesDir.exists()) voicesDir.mkdirs();

            // v1.4.1 — per-call UUID prefix so concurrent prerender
            // calls from two chains with overlapping (index, text) pairs
            // don't collide in the static ttsLatches map. The Android
            // TTS engine queues its own synthesizeToFile requests, but
            // the latch-routing layer needs uniqueness per outstanding
            // call.
            String callUuid = java.util.UUID.randomUUID().toString().replace("-", "");

            String[] result = new String[n];
            for (int i = 0; i < n; i++) {
                String text;
                try { text = texts.getString(i); }
                catch (JSONException e) { result[i] = null; continue; }
                if (text == null || text.trim().isEmpty()) {
                    result[i] = null;
                    continue;
                }
                String hash = sha1(text);
                File outFile = new File(voicesDir, "tts_" + hash + ".wav");
                result[i] = outFile.getAbsolutePath();

                if (outFile.exists() && outFile.length() > 0) {
                    continue; // cache hit
                }
                String utterId = "u_" + callUuid + "_" + i + "_" + hash;
                CountDownLatch latch = new CountDownLatch(1);
                ttsLatches.put(utterId, latch);
                int rc;
                try {
                    rc = sharedTts.synthesizeToFile(text, null, outFile, utterId);
                } catch (Throwable t) {
                    rc = TextToSpeech.ERROR;
                }
                if (rc != TextToSpeech.SUCCESS) {
                    ttsLatches.remove(utterId);
                    latch.countDown();
                    result[i] = null;
                }
                try {
                    if (!latch.await(8, TimeUnit.SECONDS)) {
                        ttsLatches.remove(utterId);
                        result[i] = null;
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    result[i] = null;
                }
                // Verify the file actually landed (synth may "succeed"
                // but write zero bytes on misconfigured voices).
                if (result[i] != null && (!outFile.exists() || outFile.length() == 0)) {
                    result[i] = null;
                }
            }

            for (String p : result) pathsArr.put(p == null ? JSONObject.NULL : p);
            JSObject ret = new JSObject();
            ret.put("paths", pathsArr);
            call.resolve(ret);
        });
    }

    private static String sha1(String input) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-1");
            byte[] bytes = md.digest(input.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder(bytes.length * 2);
            for (byte b : bytes) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            // Fallback that's stable but lower-quality: input hashCode
            // padded out. Used only when SHA-1 is somehow unavailable
            // (shouldn't happen on any Android we support).
            return "h" + Integer.toHexString(input.hashCode());
        }
    }

    /**
     * Read a JS-side number as Long with a getDouble fallback. Capacitor 8's
     * PluginCall.getLong returns null for some JSON Number variants — we hit
     * it consistently with values like 0 and ~3000 in this codebase. Going
     * through getDouble first preserves the value (everything we send is
     * within the safe-integer range, so no precision loss).
     */
    private static Long longArg(PluginCall call, String name) {
        Long v = call.getLong(name);
        if (v != null) return v;
        Double d = call.getDouble(name);
        return d == null ? null : d.longValue();
    }

    private void sendIntent(String action, PluginCall call) {
        Intent intent = new Intent(getContext(), ChainTimerService.class);
        intent.setAction(action);
        // v1.4.1 — runId routes this intent to a specific ChainRun in
        // the service. Required for multi-chain; legacy single-chain
        // callers without a runId fall through to the service's
        // synthetic "__default__" run id.
        String runId = call.getString("runId", null);
        if (runId != null) intent.putExtra(ChainTimerService.EXTRA_RUN_ID, runId);
        intent.putExtra(ChainTimerService.EXTRA_TITLE, call.getString("title", "Chain running"));
        intent.putExtra(ChainTimerService.EXTRA_BODY,  call.getString("body", ""));
        String large = call.getString("largeBody", null);
        if (large != null) intent.putExtra(ChainTimerService.EXTRA_LARGE, large);
        String sub   = call.getString("subText", null);
        if (sub   != null) intent.putExtra(ChainTimerService.EXTRA_SUB, sub);

        Boolean paused = call.getBoolean("paused", false);
        intent.putExtra(ChainTimerService.EXTRA_PAUSED, paused != null && paused);

        Boolean silent = call.getBoolean("silent", false);
        intent.putExtra(ChainTimerService.EXTRA_SILENT, silent != null && silent);

        Boolean tickEnabled = call.getBoolean("tickEnabled", true);
        intent.putExtra(ChainTimerService.EXTRA_TICK_ENABLED, tickEnabled == null || tickEnabled);

        Boolean soundEnabled = call.getBoolean("soundEnabled", true);
        intent.putExtra(ChainTimerService.EXTRA_SOUND_ENABLED, soundEnabled == null || soundEnabled);

        // Chain plan (compact JSON: [{"n":"…","d":seconds},…]) — gives the
        // service the in-memory plan it needs to self-advance and self-stop
        // when JS is paused/dead. Passed as a String to avoid JSObject
        // round-tripping over the bridge: the service parses it on receipt.
        String chainName = call.getString("chainName", null);
        if (chainName != null) intent.putExtra(ChainTimerService.EXTRA_CHAIN_NAME, chainName);
        String planJson = call.getString("planJson", null);
        if (planJson != null) intent.putExtra(ChainTimerService.EXTRA_PLAN_JSON, planJson);
        // Parallel-to-plan voice arrays (see ChainTimerService for the
        // contract). Both ride as JSON strings to avoid Capacitor 8
        // nested-array bridge quirks. Empty string means "no payload" —
        // the service keeps whatever it had from the previous update.
        String voicePathsJson = call.getString("voicePathsJson", null);
        if (voicePathsJson != null && !voicePathsJson.isEmpty()) {
            intent.putExtra(ChainTimerService.EXTRA_VOICE_PATHS_JSON, voicePathsJson);
        }
        String voiceEnabledJson = call.getString("voiceEnabledJson", null);
        if (voiceEnabledJson != null && !voiceEnabledJson.isEmpty()) {
            intent.putExtra(ChainTimerService.EXTRA_VOICE_ENABLED_JSON, voiceEnabledJson);
        }
        // Per-chain audio routing policy. Defaults to "headset" if
        // omitted — matches the in-app default and the user's mental
        // model of "headphones win when they're plugged in."
        String audioRoute = call.getString("audioRoute", "headset");
        intent.putExtra(ChainTimerService.EXTRA_AUDIO_ROUTE, audioRoute);

        // segmentStartedAtMs: effective wall-clock moment the current
        // segment started, with paused-time excluded. The service derives
        // segment-end from (segmentStartedAtMs + duration*1000). Same
        // getLong → getDouble fallback as below; without it Capacitor 8's
        // PluginCall returns null for the wall-clock long and the service
        // would default to System.currentTimeMillis() at receipt, drifting
        // the displayed remaining by a few hundred ms each update.
        Long segStartedAtMs = longArg(call, "segmentStartedAtMs");
        if (segStartedAtMs != null && segStartedAtMs > 0L) {
            intent.putExtra(ChainTimerService.EXTRA_SEGMENT_STARTED_AT_MS, segStartedAtMs.longValue());
        }

        // endTimeMs kept for back-compat with any caller still sending it.
        Long endTimeMs = longArg(call, "endTimeMs");
        if (endTimeMs != null && endTimeMs > 0L) {
            intent.putExtra(ChainTimerService.EXTRA_END_TIME_MS, endTimeMs.longValue());
        }

        // Authoritative remaining at moment of pause — captured by JS so
        // the service has an exact value to display while paused without
        // having to extrapolate from segmentStartedAtMs (which would drift
        // if the notification is re-rendered between pause and resume).
        // Try getLong first, then fall back to getDouble: Capacitor 8's
        // PluginCall.getLong returns null for some integer JSON values
        // (we hit it consistently with values like 0 and ~3000) and we'd
        // silently lose the field without the fallback.
        Long pausedRemainingMs = longArg(call, "pausedRemainingMs");
        if (pausedRemainingMs != null && pausedRemainingMs > 0L) {
            intent.putExtra(ChainTimerService.EXTRA_PAUSED_REMAINING_MS, pausedRemainingMs.longValue());
        }

        // Position payload — drives the chain progress bar and the
        // skip-prev / skip-next action visibility (we hide whichever
        // arrow has nothing to skip to so the notification doesn't
        // expose a no-op button at chain boundaries).
        Integer segIndex = call.getInt("segmentIndex");
        Integer segTotal = call.getInt("segmentTotal");
        if (segIndex != null) intent.putExtra(ChainTimerService.EXTRA_SEGMENT_INDEX, segIndex.intValue());
        if (segTotal != null) intent.putExtra(ChainTimerService.EXTRA_SEGMENT_TOTAL, segTotal.intValue());
        Boolean hasPrev = call.getBoolean("hasPrev", false);
        Boolean hasNext = call.getBoolean("hasNext", false);
        intent.putExtra(ChainTimerService.EXTRA_HAS_PREV, hasPrev != null && hasPrev);
        intent.putExtra(ChainTimerService.EXTRA_HAS_NEXT, hasNext != null && hasNext);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
    }

    // -----------------------------------------------------------------
    // Notification-action plumbing.
    //
    // The pause/resume/stop buttons in the foreground-service notification
    // each launch MainActivity (singleTask) with EXTRA_COMMAND set. The
    // hooks below run in two scenarios:
    //
    //   - handleOnNewIntent: the activity was already alive (warm reuse).
    //   - handleOnStart    : the activity was killed, this is the cold
    //                        start triggered by the action tap.
    //
    // We forward the command to JS via notifyListeners with retainUntilConsumed
    // so the event waits if the JS listener registers slightly later.
    // -----------------------------------------------------------------

    @Override
    public void handleOnNewIntent(Intent data) {
        super.handleOnNewIntent(data);
        consumeChainCommand(data);
    }

    @Override
    public void handleOnStart() {
        super.handleOnStart();
        appForeground = true;
        if (getActivity() != null) {
            consumeChainCommand(getActivity().getIntent());
        }
    }

    private void consumeChainCommand(Intent intent) {
        if (intent == null) return;
        String cmd = intent.getStringExtra(ChainTimerService.EXTRA_COMMAND);
        if (cmd == null) return;
        String runId = intent.getStringExtra(ChainTimerService.EXTRA_RUN_ID);
        intent.removeExtra(ChainTimerService.EXTRA_COMMAND);
        intent.removeExtra(ChainTimerService.EXTRA_RUN_ID);

        JSObject payload = new JSObject();
        payload.put("command", cmd);
        if (runId != null) payload.put("runId", runId);
        notifyListeners("chainCommand", payload, true);
    }

    // =========================================================
    // v1.4.4 — install-source detection + Play In-App Updates
    // =========================================================

    private static volatile AppUpdateManager cachedAppUpdateManager;
    private static volatile AppUpdateInfo    cachedAppUpdateInfo;

    private AppUpdateManager getAppUpdateManager() {
        if (cachedAppUpdateManager == null) {
            synchronized (ChainTimerPlugin.class) {
                if (cachedAppUpdateManager == null) {
                    cachedAppUpdateManager = AppUpdateManagerFactory.create(getContext().getApplicationContext());
                }
            }
        }
        return cachedAppUpdateManager;
    }

    /**
     * getInstallSource — the JS Updater calls this on native launch to
     * decide whether to check Play In-App Updates or the GitHub API.
     *
     * Returns { source: "play" | "sideload" | "other" | "unknown",
     *          installer: <raw installer package name or null> }.
     *
     * "com.android.vending" is the Play Store. "com.google.android.feedback"
     * shows up on some devices (feedback / testing loop) so we treat it as
     * play too. Anything else (adb, browser, F-Droid, third-party store) is
     * "other"; null / exception is "unknown".
     */
    @PluginMethod
    public void getInstallSource(PluginCall call) {
        JSObject result = new JSObject();
        String installer = null;
        try {
            Context ctx = getContext();
            PackageManager pm = ctx.getPackageManager();
            String pkg = ctx.getPackageName();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                try {
                    installer = pm.getInstallSourceInfo(pkg).getInstallingPackageName();
                } catch (PackageManager.NameNotFoundException nnfe) {
                    installer = null;
                }
            } else {
                installer = pm.getInstallerPackageName(pkg);
            }
        } catch (Throwable t) {
            installer = null;
        }
        String source;
        if (installer == null) {
            source = "sideload";
        } else if ("com.android.vending".equals(installer)
                || "com.google.android.feedback".equals(installer)) {
            source = "play";
        } else {
            source = "other";
        }
        result.put("source", source);
        result.put("installer", installer == null ? JSONObject.NULL : installer);
        call.resolve(result);
    }

    /**
     * checkPlayUpdate — asks the Play Store SDK whether a newer version of
     * this exact installation is published. Returns quickly (network call
     * to Play Services, tens of ms typically); the JS side does its own
     * cache to avoid hammering it on every launch.
     *
     * Returns:
     *   { available: bool,
     *     versionCode: int (0 if unknown),
     *     priority: int (0-5, 5 = highest),
     *     updateAvailability: int (Play SDK code, for logging),
     *     immediateAllowed: bool,
     *     flexibleAllowed: bool }
     *
     * On a sideload install (or anywhere the Play SDK can't reach the
     * Play Store) this returns { available: false } — the JS Updater
     * treats that as "fall back to GitHub".
     */
    @PluginMethod
    public void checkPlayUpdate(PluginCall call) {
        try {
            AppUpdateManager mgr = getAppUpdateManager();
            mgr.getAppUpdateInfo()
                .addOnSuccessListener(info -> {
                    cachedAppUpdateInfo = info; // reused by startPlayUpdate
                    JSObject r = new JSObject();
                    int avail = info.updateAvailability();
                    boolean isAvailable = (avail == UpdateAvailability.UPDATE_AVAILABLE)
                        || (avail == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS);
                    r.put("available", isAvailable);
                    r.put("versionCode", info.availableVersionCode());
                    r.put("priority", info.updatePriority());
                    r.put("updateAvailability", avail);
                    r.put("immediateAllowed", info.isUpdateTypeAllowed(AppUpdateType.IMMEDIATE));
                    r.put("flexibleAllowed",  info.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE));
                    call.resolve(r);
                })
                .addOnFailureListener(err -> {
                    JSObject r = new JSObject();
                    r.put("available", false);
                    r.put("error", err.getMessage() == null ? "unknown" : err.getMessage());
                    call.resolve(r);
                });
        } catch (Throwable t) {
            JSObject r = new JSObject();
            r.put("available", false);
            r.put("error", t.getMessage() == null ? "unknown" : t.getMessage());
            call.resolve(r);
        }
    }

    /**
     * startPlayUpdate — launches the Play in-app update UI. The Play SDK
     * takes over: shows a full-screen (IMMEDIATE) or bottom-sheet
     * (FLEXIBLE) update flow, and if the user accepts, downloads and
     * installs the new version. The app restarts automatically at the
     * end of IMMEDIATE; FLEXIBLE completes silently and we notify JS via
     * "playUpdateInstalled" so it can toast "Update downloaded — restart
     * to apply."
     *
     * options:
     *   { type: "immediate" | "flexible" }
     *
     * Precondition: checkPlayUpdate must have been called at least once
     * in the current process so cachedAppUpdateInfo is populated. If it
     * wasn't, we re-fetch it and then dispatch.
     */
    @PluginMethod
    public void startPlayUpdate(PluginCall call) {
        String type = call.getString("type", "immediate");
        final int updateType = "flexible".equalsIgnoreCase(type)
            ? AppUpdateType.FLEXIBLE : AppUpdateType.IMMEDIATE;

        Runnable dispatch = () -> {
            AppUpdateInfo info = cachedAppUpdateInfo;
            if (info == null) {
                call.reject("no cached AppUpdateInfo — call checkPlayUpdate first");
                return;
            }
            if (!info.isUpdateTypeAllowed(updateType)) {
                call.reject("update type not allowed for this install/version");
                return;
            }
            Activity activity = getActivity();
            if (activity == null) {
                call.reject("no activity to attach flow to");
                return;
            }
            try {
                AppUpdateManager mgr = getAppUpdateManager();
                if (updateType == AppUpdateType.FLEXIBLE) {
                    // Listen for install status changes so we can fire the
                    // "download complete, tap to restart" event to JS.
                    mgr.registerListener(flexibleListener);
                }
                mgr.startUpdateFlow(
                    info,
                    activity,
                    AppUpdateOptions.newBuilder(updateType).build()
                );
                JSObject r = new JSObject();
                r.put("launched", true);
                r.put("type", updateType == AppUpdateType.IMMEDIATE ? "immediate" : "flexible");
                call.resolve(r);
            } catch (Throwable t) {
                call.reject("startUpdateFlow failed: " + t.getMessage());
            }
        };

        if (cachedAppUpdateInfo != null) {
            dispatch.run();
        } else {
            // Fresh fetch then dispatch. If it fails, reject.
            try {
                getAppUpdateManager().getAppUpdateInfo()
                    .addOnSuccessListener(info -> { cachedAppUpdateInfo = info; dispatch.run(); })
                    .addOnFailureListener(err -> call.reject("getAppUpdateInfo failed: " + err.getMessage()));
            } catch (Throwable t) {
                call.reject("plugin init failed: " + t.getMessage());
            }
        }
    }

    /** Complete a FLEXIBLE update after the user accepts the restart. */
    @PluginMethod
    public void completePlayUpdate(PluginCall call) {
        try {
            getAppUpdateManager().completeUpdate();
            call.resolve();
        } catch (Throwable t) {
            call.reject("completeUpdate failed: " + t.getMessage());
        }
    }

    // Fires when a FLEXIBLE update transitions state (downloading, then
    // downloaded, then installed). We forward "downloaded" and "installed"
    // to JS so it can prompt "restart to apply".
    private final InstallStateUpdatedListener flexibleListener = new InstallStateUpdatedListener() {
        @Override public void onStateUpdate(InstallState state) {
            int status = state.installStatus();
            if (status == InstallStatus.DOWNLOADED) {
                JSObject payload = new JSObject();
                payload.put("status", "downloaded");
                notifyListeners("playUpdateStatus", payload, true);
            } else if (status == InstallStatus.INSTALLED) {
                JSObject payload = new JSObject();
                payload.put("status", "installed");
                notifyListeners("playUpdateStatus", payload, true);
                try { getAppUpdateManager().unregisterListener(this); } catch (Throwable ignored) {}
            } else if (status == InstallStatus.FAILED || status == InstallStatus.CANCELED) {
                JSObject payload = new JSObject();
                payload.put("status", status == InstallStatus.FAILED ? "failed" : "canceled");
                notifyListeners("playUpdateStatus", payload, true);
                try { getAppUpdateManager().unregisterListener(this); } catch (Throwable ignored) {}
            }
        }
    };

    // Play-update resume behavior lives in the existing handleOnResume
    // near the top of the class — merged with the appForeground flag.

    /**
     * exitApp — JS-triggered exit for the case where the user hits back
     * from the library view (i.e., nowhere to navigate back to). Called
     * from js/app.js's chainBack handler when there's no sheet to close,
     * no view to pop, and the user genuinely wants to leave.
     */
    @PluginMethod
    public void exitApp(PluginCall call) {
        Activity activity = getActivity();
        if (activity != null) {
            try { activity.finish(); } catch (Throwable ignored) {}
        }
        call.resolve();
    }
}
