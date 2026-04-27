package com.mayerwin.chainedtimers;

import android.content.Intent;
import android.os.Build;

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

    private void sendIntent(String action, PluginCall call) {
        Intent intent = new Intent(getContext(), ChainTimerService.class);
        intent.setAction(action);
        intent.putExtra(ChainTimerService.EXTRA_TITLE, call.getString("title", "Chain running"));
        intent.putExtra(ChainTimerService.EXTRA_BODY,  call.getString("body", ""));
        String large = call.getString("largeBody", null);
        if (large != null) intent.putExtra(ChainTimerService.EXTRA_LARGE, large);
        String sub   = call.getString("subText", null);
        if (sub   != null) intent.putExtra(ChainTimerService.EXTRA_SUB, sub);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
    }
}
