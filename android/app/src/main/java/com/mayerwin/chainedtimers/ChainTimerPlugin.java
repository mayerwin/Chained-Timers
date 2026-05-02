package com.github.chainedtimers;

import android.annotation.SuppressLint;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

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
        ChainTimerPlugin p = instance;
        if (p == null || command == null) return;
        try {
            JSObject payload = new JSObject();
            payload.put("command", command);
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
     *   - statusChannelEnabled: our persistent "now playing" channel ON
     *   - transitionsChannelEnabled: our segment-end channel ON
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

        boolean statusOn = true;
        boolean transitionsOn = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            if (nm != null) {
                statusOn      = isChannelOn(nm, ChainTimerService.CHANNEL_ID);
                transitionsOn = isChannelOn(nm, "chain-transitions");
            }
        }
        ret.put("statusChannelEnabled",      statusOn);
        ret.put("transitionsChannelEnabled", transitionsOn);
        ret.put("ok", appEnabled && statusOn && transitionsOn);
        call.resolve(ret);
    }

    private static boolean isChannelOn(NotificationManager nm, String id) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        NotificationChannel ch = nm.getNotificationChannel(id);
        // null = channel not yet created (treat as enabled — first run).
        // IMPORTANCE_NONE = user explicitly disabled in OS settings.
        return ch == null || ch.getImportance() != NotificationManager.IMPORTANCE_NONE;
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
        // Consume so the same command doesn't fire on every subsequent
        // lifecycle event with the same intent attached.
        intent.removeExtra(ChainTimerService.EXTRA_COMMAND);

        JSObject payload = new JSObject();
        payload.put("command", cmd);
        notifyListeners("chainCommand", payload, true);
    }
}
