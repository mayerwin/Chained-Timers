package com.mayerwin.chainedtimers;

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

        // endTimeMs: wall-clock moment when the current segment ends.
        // Capacitor PluginCall.getLong handles JS numbers cleanly within
        // the safe integer range (Date.now() values are ~1.8e12 << 2^53).
        Long endTimeMs = call.getLong("endTimeMs");
        if (endTimeMs != null && endTimeMs > 0L) {
            intent.putExtra(ChainTimerService.EXTRA_END_TIME_MS, endTimeMs.longValue());
        }

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
