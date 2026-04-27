/* ==========================================================================
   Chained Timers — Native bridge (Capacitor)

   Loaded by index.html on every page load. No-op in regular browsers.
   When running inside the Capacitor native shell (iOS / Android binary),
   pre-schedules native local notifications at each segment-end timestamp
   so the chain stays accurate even when the app is fully backgrounded,
   the screen is locked, or the OS has killed the WebView's JS.

   The web Engine drives the bridge via three CustomEvents:
     - chain:start       → schedule all upcoming segment-end notifications
     - chain:reschedule  → cancel + re-schedule (after skip / resume)
     - chain:cancel      → cancel all (after pause / stop)
   ========================================================================== */

(() => {
  'use strict';

  if (typeof window === 'undefined') return;

  function isNative() {
    const C = window.Capacitor;
    return !!(C && typeof C.isNativePlatform === 'function' && C.isNativePlatform());
  }

  // Expose status to the web app so Settings can render it.
  window.ChainedNativeStatus = {
    available: false,
    platform: isNative() ? (window.Capacitor.getPlatform?.() || 'native') : 'web',
    permission: 'unknown',
    exactAlarm: 'unknown',     // 'granted' | 'denied' | 'prompt' | 'unknown' (Android 12+ only)
    channelReady: false,
    lastSchedule: null,        // { count, error, when }
  };

  if (!isNative()) {
    log('browser context — native bridge inactive');
    notifyStatusChanged();
    return;
  }

  const Plugins = window.Capacitor.Plugins || {};
  const { LocalNotifications, Haptics, StatusBar } = Plugins;

  if (!LocalNotifications) {
    log('LocalNotifications plugin not available');
    toast('Native plugin not loaded', 'warn');
    notifyStatusChanged();
    return;
  }

  window.ChainedNativeStatus.available = true;
  log(`native bridge live (${window.ChainedNativeStatus.platform})`);

  // ---------- Status bar (cosmetic) ----------
  // Style.LIGHT = light icons/text (use on dark backgrounds). Our app is dark.
  StatusBar?.setStyle?.({ style: 'LIGHT' }).catch(() => {});
  StatusBar?.setBackgroundColor?.({ color: '#0E0D0B' }).catch(() => {});
  StatusBar?.setOverlaysWebView?.({ overlay: false }).catch(() => {});

  // ---------- Vibration polyfill (iOS WKWebView lacks navigator.vibrate) ----------
  if (!('vibrate' in navigator) && Haptics) {
    navigator.vibrate = (pattern) => {
      const arr = Array.isArray(pattern) ? pattern : [pattern];
      const total = arr.reduce((s, n) => s + (Number(n) || 0), 0);
      try {
        if (total > 250)      Haptics.notification({ type: 'SUCCESS' });
        else if (total > 80)  Haptics.impact({ style: 'HEAVY' });
        else                  Haptics.impact({ style: 'LIGHT' });
      } catch {}
      return true;
    };
  }

  // ---------- Notification setup ----------
  const CHANNEL_ID  = 'chain-transitions';
  const NOTIF_BASE  = 9_000;
  let scheduledIds  = [];

  async function ensurePermission() {
    try {
      const cur = await LocalNotifications.checkPermissions();
      if (cur?.display === 'granted') {
        window.ChainedNativeStatus.permission = 'granted';
        return true;
      }
      const req = await LocalNotifications.requestPermissions();
      window.ChainedNativeStatus.permission = req?.display || 'denied';
      notifyStatusChanged();
      return req?.display === 'granted';
    } catch (e) {
      window.ChainedNativeStatus.permission = 'error';
      notifyStatusChanged();
      log('checkPermissions failed:', e);
      return false;
    }
  }

  async function checkExactAlarm() {
    if (window.Capacitor.getPlatform?.() !== 'android') {
      window.ChainedNativeStatus.exactAlarm = 'n/a';
      return true;
    }
    if (typeof LocalNotifications.checkExactNotificationSetting !== 'function') {
      window.ChainedNativeStatus.exactAlarm = 'n/a';
      return true;
    }
    try {
      const r = await LocalNotifications.checkExactNotificationSetting();
      window.ChainedNativeStatus.exactAlarm = r?.exact_alarm || 'unknown';
      notifyStatusChanged();
      return r?.exact_alarm === 'granted';
    } catch (e) {
      log('checkExactNotificationSetting failed:', e);
      window.ChainedNativeStatus.exactAlarm = 'unknown';
      return false;
    }
  }

  async function requestExactAlarm() {
    try {
      const r = await LocalNotifications.changeExactNotificationSetting();
      window.ChainedNativeStatus.exactAlarm = r?.exact_alarm || 'unknown';
      notifyStatusChanged();
      return r?.exact_alarm === 'granted';
    } catch (e) {
      log('changeExactNotificationSetting failed:', e);
      return false;
    }
  }

  async function ensureChannel() {
    if (window.ChainedNativeStatus.channelReady) return true;
    if (window.Capacitor.getPlatform?.() !== 'android') {
      window.ChainedNativeStatus.channelReady = true;
      return true; // iOS does not use channels
    }
    try {
      await LocalNotifications.createChannel({
        id:           CHANNEL_ID,
        name:         'Chain transitions',
        description:  'Fires when one segment ends and the next begins',
        importance:   5,            // IMPORTANCE_HIGH — heads-up + sound
        visibility:   1,            // VISIBILITY_PUBLIC — show on lock screen
        vibration:    true,
        lights:       true,
        lightColor:   '#F5B042',
        sound:        undefined,    // default channel sound
      });
      window.ChainedNativeStatus.channelReady = true;
      notifyStatusChanged();
      return true;
    } catch (e) {
      log('createChannel failed:', e);
      // Channel creation is idempotent; failure usually means already exists.
      window.ChainedNativeStatus.channelReady = true;
      return true;
    }
  }

  function fmtDur(s) {
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), r = s % 60;
    return r ? `${m}m ${r}s` : `${m}m`;
  }

  async function cancelAll() {
    if (!scheduledIds.length) return;
    try {
      await LocalNotifications.cancel({
        notifications: scheduledIds.map(id => ({ id })),
      });
      log(`cancelled ${scheduledIds.length} pending notifications`);
    } catch (e) {
      log('cancel failed:', e);
    }
    scheduledIds = [];
  }

  // Sweep notifications scheduled by us in a previous app session.
  // scheduledIds is in-memory only and resets on every page load, so
  // without this any leftover notifications would fire at random later.
  async function sweepOrphans() {
    if (typeof LocalNotifications.getPending !== 'function') return;
    try {
      const pending = await LocalNotifications.getPending();
      const ours = (pending?.notifications || []).filter(n => {
        const id = Number(n.id);
        return id >= NOTIF_BASE && id < 99_000;
      });
      if (ours.length) {
        await LocalNotifications.cancel({ notifications: ours.map(n => ({ id: Number(n.id) })) });
        log(`swept ${ours.length} orphan notification(s) from prior session`);
      }
    } catch (e) {
      log('sweepOrphans failed:', e);
    }
  }

  async function scheduleAll(detail) {
    if (!await ensurePermission()) {
      toast('Notifications denied — background alerts disabled', 'warn');
      window.ChainedNativeStatus.lastSchedule = { count: 0, error: 'permission denied', when: Date.now() };
      notifyStatusChanged();
      return;
    }
    await ensureChannel();
    await cancelAll();

    const { name, segments, currentIndex = 0, segmentStartedAtMs } = detail;
    const startWall = segmentStartedAtMs || Date.now();
    const notifs = [];
    let cumMs = 0;

    for (let i = currentIndex; i < segments.length; i++) {
      cumMs += (segments[i].duration || 0) * 1000;
      const fireAt = new Date(startWall + cumMs);
      // Skip notifications whose fire time has already passed (safety margin)
      if (fireAt.getTime() < Date.now() + 500) continue;

      const isLast = i === segments.length - 1;
      const next = segments[i + 1];
      notifs.push({
        id:        NOTIF_BASE + i,
        title:     isLast ? '✓ Chain complete' : `Next: ${next.name || 'segment'}`,
        body:      isLast
          ? `${name || 'Chain'} · ${segments.length} segments done`
          : `${fmtDur(next.duration)} · segment ${i + 2} of ${segments.length}`,
        schedule:  { at: fireAt, allowWhileIdle: true },
        smallIcon: 'ic_stat_icon',
        iconColor: '#F5B042',
        channelId: CHANNEL_ID,
        ongoing:   false,
        autoCancel: true,
      });
    }

    if (!notifs.length) {
      window.ChainedNativeStatus.lastSchedule = { count: 0, error: null, when: Date.now() };
      notifyStatusChanged();
      return;
    }

    try {
      await LocalNotifications.schedule({ notifications: notifs });
      scheduledIds = notifs.map(n => n.id);
      window.ChainedNativeStatus.lastSchedule = { count: notifs.length, error: null, when: Date.now() };
      log(`scheduled ${notifs.length} notifications, first @ ${notifs[0].schedule.at.toISOString()}`);
      // Re-check exact-alarm grant now that notifications are queued — if denied,
      // the schedule call succeeded but the alarms will be inexact (10+ min delay).
      const exact = await checkExactAlarm();
      if (window.Capacitor.getPlatform?.() === 'android' && !exact && window.ChainedNativeStatus.exactAlarm === 'denied') {
        toast('Exact-alarm permission denied — notifications may be late. Tap Settings to fix.', 'warn');
      }
      notifyStatusChanged();
    } catch (e) {
      const msg = (e && (e.message || String(e))) || 'unknown error';
      window.ChainedNativeStatus.lastSchedule = { count: 0, error: msg, when: Date.now() };
      log('schedule failed:', msg);
      toast('Background scheduling failed: ' + msg, 'warn');
      notifyStatusChanged();
    }
  }

  // ---------- Wired API for the rest of the app ----------
  window.ChainedNative = {
    isNative:   true,
    platform:   window.ChainedNativeStatus.platform,
    status:     () => ({ ...window.ChainedNativeStatus }),
    requestPermission: ensurePermission,
    requestExactAlarm,

    // Manual test from Settings: schedule one notification N seconds from now.
    async testNotification(seconds = 10) {
      if (!await ensurePermission()) {
        toast('Notifications denied — grant in OS settings', 'warn');
        return false;
      }
      await ensureChannel();
      const fireAt = new Date(Date.now() + seconds * 1000);
      try {
        await LocalNotifications.schedule({
          notifications: [{
            id: 99_000,
            title: 'Chained Timers test',
            body: `If you can see this, background notifications are working. Scheduled ${seconds}s ago.`,
            schedule: { at: fireAt, allowWhileIdle: true },
            smallIcon: 'ic_stat_icon',
            iconColor: '#F5B042',
            channelId: CHANNEL_ID,
            autoCancel: true,
          }],
        });
        toast(`Test notification scheduled for ${seconds}s. Lock the screen.`, 'good');
        return true;
      } catch (e) {
        const msg = (e && (e.message || String(e))) || 'unknown error';
        toast('Test failed: ' + msg, 'warn');
        return false;
      }
    },
  };

  // ---------- Lifecycle wiring ----------
  // All schedule / cancel operations run through a single FIFO mutex so
  // overlapping events (rapid skip taps, drain-during-fresh-event,
  // pause-then-resume-quickly) can't interleave plugin calls and end up
  // with mismatched scheduledIds vs. actual OS state.
  let bgOpChain = Promise.resolve();
  function serialize(fn) {
    const next = bgOpChain.then(fn).catch(e => { log('serialized op failed:', e); });
    bgOpChain = next;
    return next;
  }

  // Register listeners immediately so events aren't lost, but queue any
  // events that arrive before pre-warm finishes — otherwise a fast
  // chain:start could race with sweepOrphans and cancel its own freshly
  // scheduled notifications (same ID range).
  let preWarmDone = false;
  const queuedEvents = [];

  function dispatch(type, detail) {
    if (type === 'schedule') return serialize(() => scheduleAll(detail));
    if (type === 'cancel')   return serialize(() => cancelAll());
  }

  window.addEventListener('chain:start',      e => preWarmDone ? dispatch('schedule', e.detail) : queuedEvents.push({ type: 'schedule', detail: e.detail }));
  window.addEventListener('chain:reschedule', e => preWarmDone ? dispatch('schedule', e.detail) : queuedEvents.push({ type: 'schedule', detail: e.detail }));
  window.addEventListener('chain:cancel',     ()  => preWarmDone ? dispatch('cancel')           : queuedEvents.push({ type: 'cancel' }));

  // Pre-warm: request permission + create channel + check exact-alarm
  // grant up front, before any chain starts, so the OS dialog isn't
  // competing with the running countdown and the user sees the real state
  // in Settings before relying on it. Sweep orphan notifications from any
  // previous app session so they don't fire at random later.
  (async () => {
    await ensurePermission();
    await ensureChannel();
    await checkExactAlarm();
    await sweepOrphans();
    // Snapshot + clear the queue *before* flipping the flag. New events
    // arriving from this point on go straight to dispatch() (serialised
    // after the drained ops by virtue of the same bgOpChain mutex).
    const drain = queuedEvents.splice(0);
    preWarmDone = true;
    for (const ev of drain) dispatch(ev.type, ev.detail);
    notifyStatusChanged();
  })();

  // ---------- helpers ----------
  function log(...args) {
    try { console.log('[native]', ...args); } catch {}
  }

  function toast(message, kind = '') {
    log('toast:', message);
    try {
      window.dispatchEvent(new CustomEvent('chained:toast', { detail: { message, kind } }));
    } catch {}
  }

  function notifyStatusChanged() {
    try {
      window.dispatchEvent(new CustomEvent('chained:nativestatus', {
        detail: { ...window.ChainedNativeStatus },
      }));
    } catch {}
  }
})();
