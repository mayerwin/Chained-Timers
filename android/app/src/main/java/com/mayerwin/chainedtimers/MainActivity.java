package com.mayerwin.chainedtimers;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ChainTimerPlugin.class);
        super.onCreate(savedInstanceState);
    }

    /**
     * Capacitor's BridgeActivity / Cordova WebView lifecycle pauses JS
     * timers when the activity is sent to onPause / onStop, which freezes
     * the engine that drives the on-screen countdown.
     *
     * While ChainTimerService is alive (it holds a partial wake lock and
     * keeps the process Doze-exempt) we want JS to keep ticking too, so
     * the on-screen segment timer stays accurate to the second across
     * screen-locks and app-switches — no "catch-up hop" the user can
     * notice when they return to the app.
     *
     * We override both onPause and onStop because they're the two points
     * at which the WebView gets suspended:
     *   - onPause: when another activity comes in front (incoming call,
     *     intent picker, partial overlay).
     *   - onStop: when the activity is fully off-screen (home button,
     *     screen lock, recent-tasks switcher). This is the harder freeze
     *     and the one the user actually reported in the bug.
     *
     * WebView.resumeTimers() is static and global — calling it twice is
     * harmless. WebView.onResume() on an instance also no-ops if already
     * resumed. So both overrides are idempotent and safe.
     */
    @Override
    public void onPause() {
        super.onPause();
        keepWebViewRunning();
    }

    @Override
    public void onStop() {
        super.onStop();
        keepWebViewRunning();
    }

    private void keepWebViewRunning() {
        if (!ChainTimerService.isRunning()) return;
        if (bridge == null) return;
        android.webkit.WebView wv = bridge.getWebView();
        if (wv == null) return;
        try {
            wv.resumeTimers();
            wv.onResume();
        } catch (Throwable t) {
            // WebView lifecycle is finicky on some OEM builds; log & swallow.
            android.util.Log.w("ChainedTimers", "keepWebViewRunning failed", t);
        }
    }
}
