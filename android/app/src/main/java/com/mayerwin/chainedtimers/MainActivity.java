package com.github.chainedtimers;

import android.os.Bundle;

import androidx.core.view.WindowCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ChainTimerPlugin.class);
        super.onCreate(savedInstanceState);
        // Android 14/15 (targetSdk 35+) enforces edge-to-edge but the
        // AppCompat decor view still applies a `fitsSystemWindows` inset
        // to its content frame on top of the system bar insets, which
        // pushes the WebView down by another `statusBarHeight` and
        // exposes the activity windowBackground as a band above the
        // WebView. setDecorFitsSystemWindows(false) tells the framework
        // to deliver the raw insets to our WebView (Capacitor's bridge
        // forwards them to CSS via env(safe-area-inset-*)) instead of
        // reserving space for them at the decor level.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        // v1.4.10 — register a predictive-back callback on API 33+.
        //
        // Before this, we relied solely on onBackPressed() (below) to
        // catch back gestures. That worked for the on-screen back
        // button and older Android versions, but on Android 13+ with
        // gesture navigation, an EDGE swipe (from either side, going
        // toward the middle) is dispatched via OnBackInvokedCallback
        // and does NOT fall through to onBackPressed. Result: the JS
        // "chainBack" handler never fired, and the system finished the
        // activity — which minimised the app from anywhere in the SPA.
        //
        // Registering PRIORITY_DEFAULT here tells the platform we want
        // to handle the back gesture; we forward it to JS the same way
        // onBackPressed does, so the SPA-level routing logic (close a
        // sheet → exit select mode → go to library → exitApp) stays in
        // one place.
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            try {
                getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                    this::dispatchBackToJs
                );
            } catch (Throwable t) {
                android.util.Log.w("ChainedTimers", "OnBackInvokedCallback register failed", t);
            }
        }
    }

    /**
     * Shared back-dispatch path used by BOTH onBackPressed (legacy)
     * and OnBackInvokedCallback (Android 13+ predictive back). Fires
     * the "chainBack" event into JS; the JS handler decides what
     * "back" means depending on what the user is looking at. Returns
     * true if JS took ownership (so the caller shouldn't fall through
     * to system back).
     */
    private boolean dispatchBackToJs() {
        if (bridge == null) return false;
        try {
            bridge.triggerJSEvent("chainBack", "window");
            return true;
        } catch (Throwable t) {
            android.util.Log.w("ChainedTimers", "chainBack dispatch failed", t);
            return false;
        }
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

    /**
     * Legacy back-button path — the on-screen 3-button-nav back button,
     * the hardware back button on devices that still have one, and
     * anything else that Android delivers through the old
     * Activity.onBackPressed API instead of OnBackInvokedCallback.
     *
     * As of v1.4.10 the modern predictive-back path is also wired in
     * onCreate() so gesture-nav edge swipes on API 33+ route through
     * dispatchBackToJs() too. Both paths share the same JS "chainBack"
     * event contract.
     */
    @Override
    public void onBackPressed() {
        if (dispatchBackToJs()) return; // JS owns the decision
        super.onBackPressed();
    }
}
