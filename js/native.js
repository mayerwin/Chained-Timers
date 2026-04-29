/* ==========================================================================
   Chained Timers — Native bridge (Capacitor)

   Loaded by index.html on every page load. No-op in regular browsers.
   When running inside the Capacitor native shell (iOS / Android binary),
   pre-schedules native local notifications at each segment-end timestamp
   so the chain stays accurate even when the app is fully backgrounded,
   the screen is locked, or the OS has killed the WebView's JS.

   In addition to the per-segment alarms, a sticky low-importance "now
   playing" notification is posted on a silent channel so the user can
   always see (without a sound ping) what segment is running and what's
   coming next.

   The web Engine drives the bridge via four CustomEvents:
     - chain:start       → schedule all upcoming segment-end notifications
                            and post the sticky now-playing row
     - chain:reschedule  → cancel + re-schedule (after skip / resume /
                            pause / restored from persistence)
     - chain:cancel      → cancel everything (after stop)
     - chain:complete    → clear only the now-playing row (chain ended
                            naturally; the just-fired "✓ Chain complete"
                            alarm stays in the user's tray)
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
    fgService: false,          // true while the Android foreground service holds the wake lock
    fgServiceAvailable: false, // false on older APK builds without the ChainTimerPlugin
    batteryOpt: 'unknown',     // 'exempt' | 'optimized' | 'unsupported' | 'unknown'
    notifHealth: null,         // { appEnabled, statusChannelEnabled, transitionsChannelEnabled, ok }
  };

  if (!isNative()) {
    log('browser context — native bridge inactive');
    notifyStatusChanged();
    return;
  }

  const Plugins = window.Capacitor.Plugins || {};
  const { LocalNotifications, Haptics, StatusBar } = Plugins;
  const isAndroid = window.Capacitor.getPlatform?.() === 'android';

  if (!LocalNotifications) {
    log('LocalNotifications plugin not available');
    toast('Native plugin not loaded', 'warn');
    notifyStatusChanged();
    return;
  }

  // Register the custom Android foreground-service plugin. Capacitor's
  // registerPlugin returns a proxy whose method calls dispatch through
  // the JS↔native bridge; if no native implementation is registered (e.g.
  // an older APK installed before this build, or running on iOS) every
  // call rejects — we wrap each one in try/catch and treat unavailability
  // as a clean fallback to the LocalNotifications status row.
  let ChainTimer = null;
  if (isAndroid && typeof window.Capacitor.registerPlugin === 'function') {
    try { ChainTimer = window.Capacitor.registerPlugin('ChainTimer'); }
    catch (e) { log('registerPlugin(ChainTimer) failed:', e); }
  }
  // Probe availability so we can quickly fall back without paying for a
  // full bridge round-trip on every action.
  let chainTimerAvailable = false;
  if (ChainTimer && typeof window.Capacitor.isPluginAvailable === 'function') {
    chainTimerAvailable = !!window.Capacitor.isPluginAvailable('ChainTimer');
    if (!chainTimerAvailable) {
      log('ChainTimer plugin not registered natively (rebuild the APK)');
    }
  }
  window.ChainedNativeStatus.fgServiceAvailable = chainTimerAvailable;

  // Notification-action -> JS plumbing. When the user taps Pause/Resume/Stop
  // in the persistent notification, ChainTimerPlugin.handleOnNewIntent
  // fires a "chainCommand" event with { command: 'pause' | 'resume' | 'stop' }.
  // We re-emit it as a plain DOM event so the engine in app.js can react
  // without taking a hard dependency on Capacitor.
  if (chainTimerAvailable) {
    try {
      ChainTimer.addListener('chainCommand', (event) => {
        const cmd = event && event.command;
        if (cmd !== 'pause' && cmd !== 'resume' && cmd !== 'stop') return;
        log('chainCommand from notification:', cmd);
        try {
          window.dispatchEvent(new CustomEvent('chained:enginecommand', {
            detail: { command: cmd, source: 'notification' },
          }));
        } catch (e) { log('dispatch chained:enginecommand failed:', e); }
      });
    } catch (e) {
      log('ChainTimer.addListener(chainCommand) failed:', e);
    }
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
  // Two channels:
  //   chain-transitions — high importance, sound + vibration + heads-up.
  //                       Fires once per segment boundary so the user
  //                       hears/feels the cue even with the screen off.
  //   chain-status      — low importance, silent. Used for the persistent
  //                       "▶ now playing" notification so the user always
  //                       sees current segment / progress in the tray
  //                       without an extra ping for every status update.
  const CHANNEL_ID         = 'chain-transitions';
  const STATUS_CHANNEL_ID  = 'chain-status';
  const NOTIF_BASE         = 9_000;   // transitions: 9000..9000+N-1
  const STATUS_ID          = 8_999;   // single sticky "now playing" entry
  let scheduledIds  = [];
  let statusActive  = false;

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
    const tasks = [
      LocalNotifications.createChannel({
        id:           CHANNEL_ID,
        name:         'Chain transitions',
        description:  'Fires when one segment ends and the next begins',
        importance:   5,            // IMPORTANCE_HIGH — heads-up + sound
        visibility:   1,            // VISIBILITY_PUBLIC — show on lock screen
        vibration:    true,
        lights:       true,
        lightColor:   '#F5B042',
        sound:        undefined,    // default channel sound
      }).catch(e => log('createChannel transitions failed:', e)),
      LocalNotifications.createChannel({
        id:           STATUS_CHANNEL_ID,
        name:         'Chain status',
        description:  'Persistent indicator of the currently-running segment',
        importance:   2,            // IMPORTANCE_LOW — silent, no heads-up
        visibility:   1,
        vibration:    false,
        lights:       false,
        sound:        undefined,
      }).catch(e => log('createChannel status failed:', e)),
    ];
    await Promise.all(tasks);
    window.ChainedNativeStatus.channelReady = true;
    notifyStatusChanged();
    return true;
  }

  function fmtDur(s) {
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), r = s % 60;
    return r ? `${m}m ${r}s` : `${m}m`;
  }

  async function cancelAll() {
    await stopService();
    const ids = [...scheduledIds];
    if (statusActive) ids.push(STATUS_ID);
    if (!ids.length) return;
    try {
      await LocalNotifications.cancel({
        notifications: ids.map(id => ({ id })),
      });
      log(`cancelled ${ids.length} notifications`);
    } catch (e) {
      log('cancel failed:', e);
    }
    scheduledIds = [];
    statusActive = false;
  }

  // Post (or replace) the persistent "▶ now playing" notification on the
  // silent status channel. Capacitor's schedule() with no `at` field fires
  // immediately. Same id every time means the new content replaces the old
  // entry in place — exactly what the user asked for: a single tray row
  // showing what's currently running, updating whenever JS is awake (chain
  // start, reschedule after skip, app resume).
  async function postStatus(detail) {
    if (!detail || !Array.isArray(detail.segments)) return;
    const { name, segments, currentIndex = 0, isPaused } = detail;
    const cur = segments[currentIndex];
    if (!cur) return;
    const next = segments[currentIndex + 1];
    const total = segments.length;

    const titlePrefix = isPaused ? '⏸' : '▶';
    const title  = `${titlePrefix} ${cur.name || 'Segment'} · ${fmtDur(cur.duration)}`;
    const body   = `Segment ${currentIndex + 1} of ${total} · ${name || 'Chain'}`;
    const lines  = [
      `${name || 'Chain'} · Segment ${currentIndex + 1} of ${total}`,
      `${cur.name || 'Segment'} — ${fmtDur(cur.duration)}`,
      next ? `Next: ${next.name || 'segment'} (${fmtDur(next.duration)})` : 'Last segment',
    ];

    try {
      await LocalNotifications.schedule({
        notifications: [{
          id:         STATUS_ID,
          title,
          body,
          largeBody:  lines.join('\n'),
          summaryText: `${currentIndex + 1}/${total}`,
          // No `schedule` field → posts immediately.
          smallIcon:  'ic_stat_icon',
          iconColor:  '#F5B042',
          channelId:  STATUS_CHANNEL_ID,
          ongoing:    true,           // sticky — non-swipeable
          autoCancel: false,
        }],
      });
      statusActive = true;
    } catch (e) {
      log('postStatus failed:', e);
    }
  }

  // Clear the persistent "now playing" indicator after a chain ends
  // naturally — both the foreground service (so the wake lock is released
  // and the ongoing notification disappears) and the LocalNotifications
  // fallback row, if either was used. Distinct from cancelAll, which is
  // called on user-initiated stop and also kills pending transition alarms.
  async function cancelStatus() {
    await stopService();
    if (!statusActive) return;
    try {
      await LocalNotifications.cancel({ notifications: [{ id: STATUS_ID }] });
    } catch (e) {
      log('cancelStatus failed:', e);
    }
    statusActive = false;
  }

  // ---------- Foreground service control plane ----------
  // On Android, drive the ChainTimerService so the process holds a
  // partial wake lock and stays Doze-exempt for the full chain run.
  // On iOS this is a no-op (iOS apps can't keep arbitrary code running
  // in the background; we rely on UNUserNotificationCenter scheduling).
  function buildStatusContent(detail) {
    const { name, segments, currentIndex = 0, isPaused, segmentStartedAtMs } = detail;
    const cur = segments[currentIndex] || { name: 'Segment', duration: 0 };
    const next = segments[currentIndex + 1];
    const total = segments.length;
    const titlePrefix = isPaused ? '⏸' : '▶';
    // Wall-clock moment the segment will end. Anchored to the engine's
    // segmentStartedAtMs (already excludes paused-time), so the system
    // chronometer in the notification can tick down to the second
    // without further JS touchpoints. Set to 0 when paused so the
    // notification drops the live timer line.
    const endTimeMs = (!isPaused && segmentStartedAtMs && cur.duration)
      ? segmentStartedAtMs + cur.duration * 1000
      : 0;
    return {
      title:    `${titlePrefix} ${cur.name || 'Segment'}`,
      body:     `Segment ${currentIndex + 1} of ${total} · ${name || 'Chain'}`,
      largeBody: [
        `${name || 'Chain'} · Segment ${currentIndex + 1} of ${total}`,
        `${cur.name || 'Segment'} — ${fmtDur(cur.duration)}`,
        next ? `Next: ${next.name || 'segment'} (${fmtDur(next.duration)})` : 'Last segment',
      ].join('\n'),
      subText:  `${currentIndex + 1}/${total}`,
      paused:   !!isPaused,
      endTimeMs,
    };
  }

  let serviceRunning = false;
  async function startOrUpdateService(detail) {
    if (!chainTimerAvailable) return false;
    const content = buildStatusContent(detail);
    try {
      if (serviceRunning) {
        await ChainTimer.update(content);
      } else {
        await ChainTimer.start(content);
        serviceRunning = true;
      }
      window.ChainedNativeStatus.fgService = true;
      return true;
    } catch (e) {
      log('ChainTimer service call failed:', e);
      return false;
    }
  }

  async function stopService() {
    if (!chainTimerAvailable || !serviceRunning) return;
    try { await ChainTimer.stop(); } catch (e) { log('ChainTimer.stop failed:', e); }
    serviceRunning = false;
    window.ChainedNativeStatus.fgService = false;
  }

  // ---------- Reliability probes ----------
  // For medication-grade use cases the user MUST be exempt from battery
  // optimisation: even with a foreground service + wake lock + exact
  // alarms, OEM ROMs (Samsung One UI, Xiaomi MIUI, OPPO ColorOS, Huawei
  // EMUI, Vivo OriginOS, OnePlus OxygenOS, …) will kill the FGS
  // unconditionally if the app isn't in the unrestricted bucket. The
  // ChainTimerPlugin probes the actual exemption state via
  // PowerManager.isIgnoringBatteryOptimizations().
  async function refreshBatteryOpt() {
    if (!chainTimerAvailable) return null;
    try {
      const r = await ChainTimer.isIgnoringBatteryOptimizations();
      window.ChainedNativeStatus.batteryOpt = r?.supported === false
        ? 'unsupported'
        : (r?.ignoring ? 'exempt' : 'optimized');
      notifyStatusChanged();
      return r;
    } catch (e) {
      log('isIgnoringBatteryOptimizations failed:', e);
      return null;
    }
  }

  async function requestBatteryOpt() {
    if (!chainTimerAvailable) return null;
    try {
      const r = await ChainTimer.requestIgnoreBatteryOptimizations();
      // The settings UI is now open; refresh state once the user comes back.
      // We refresh again from the visibility-change handler too.
      setTimeout(refreshBatteryOpt, 1500);
      return r;
    } catch (e) {
      log('requestIgnoreBatteryOptimizations failed:', e);
      return null;
    }
  }

  // Notification health: app-level + per-channel grant. A user who has
  // toggled either off in OS settings will silently miss every alert,
  // even if our schedule call succeeded — so we surface this loudly at
  // chain start.
  async function refreshNotifHealth() {
    if (!chainTimerAvailable) return null;
    try {
      const r = await ChainTimer.getNotificationHealth();
      window.ChainedNativeStatus.notifHealth = r;
      notifyStatusChanged();
      return r;
    } catch (e) {
      log('getNotificationHealth failed:', e);
      return null;
    }
  }

  // Sweep notifications scheduled by us in a previous app session.
  // scheduledIds is in-memory only and resets on every page load, so
  // without this any leftover notifications would fire at random later.
  // STATUS_ID (8999) is also in-range so the prior session's sticky
  // "now playing" entry gets cleared too.
  async function sweepOrphans() {
    if (typeof LocalNotifications.getPending !== 'function') return;
    try {
      const pending = await LocalNotifications.getPending();
      const ours = (pending?.notifications || []).filter(n => {
        const id = Number(n.id);
        return (id >= NOTIF_BASE && id < 99_000) || id === STATUS_ID;
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

    // Cancel pre-scheduled alarms but don't tear down the foreground
    // service — startOrUpdateService below will replace its notification
    // in place. Stopping the FGS would briefly drop the wake lock and
    // could let Android freeze the process between cancel and re-schedule.
    {
      const ids = [...scheduledIds];
      if (statusActive) ids.push(STATUS_ID);
      if (ids.length) {
        try { await LocalNotifications.cancel({ notifications: ids.map(id => ({ id })) }); }
        catch (e) { log('cancel pending failed:', e); }
      }
      scheduledIds = [];
      statusActive = false;
    }

    const { name, segments, currentIndex = 0, segmentStartedAtMs, isPaused } = detail;

    // Foreground service drives the persistent "now playing" indicator.
    // It also holds the partial wake lock that keeps Doze + WebView pause
    // from freezing the engine. Started here so the wake lock is in place
    // *before* we schedule the alarm queue (which is when timing matters).
    const fgsActive = await startOrUpdateService(detail);

    // Fallback: if the FGS plugin isn't available (older APK build) keep
    // the in-tray sticky LocalNotification so the user still sees status.
    if (!fgsActive) await postStatus(detail);

    // Reliability probes — only for fresh starts (first schedule call;
    // re-schedules during a chain don't need to re-probe).
    if (!isPaused && !scheduledIds.length) {
      // Notification health: any of the three flags being false means
      // the user will miss alerts silently. This is unrecoverable in-app
      // — we can only surface it loudly so they fix it in OS settings.
      const health = await refreshNotifHealth();
      if (health && !health.ok) {
        const parts = [];
        if (!health.appEnabled)              parts.push('app notifications OFF');
        if (!health.statusChannelEnabled)    parts.push('"Chain status" channel OFF');
        if (!health.transitionsChannelEnabled) parts.push('"Chain transitions" channel OFF');
        toast(`⚠ Critical: ${parts.join(' · ')} — open OS Settings → Apps → Chained Timers → Notifications and re-enable.`, 'warn');
      }

      // Battery optimisation: if the OEM has the app in "Optimized", every
      // OEM ROM we've tested will eventually kill the FGS regardless of
      // what we declare. The user has to grant the exemption manually.
      const batt = await refreshBatteryOpt();
      if (batt && batt.supported && !batt.ignoring) {
        toast('⚠ Reliability: this phone may kill the timer when the screen is locked. Tap Settings → Native bridge → Allow background to fix.', 'warn');
      }
    }

    // While paused, don't schedule transition alarms — wall-clock keeps
    // marching during a pause, so any pre-scheduled alarm would fire too
    // early relative to the chain's resumed timeline. They get re-scheduled
    // on resume.
    if (isPaused) {
      window.ChainedNativeStatus.lastSchedule = { count: 0, error: null, when: Date.now(), paused: true };
      notifyStatusChanged();
      return;
    }

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
      const title = isLast
        ? '✓ Chain complete'
        : `▶ ${next.name || 'segment'} · ${fmtDur(next.duration)}`;
      const body = isLast
        ? `${name || 'Chain'} · ${segments.length} segments done`
        : `Segment ${i + 2} of ${segments.length} · ${name || 'Chain'}`;
      const after = !isLast ? segments[i + 2] : null;
      const largeBody = isLast
        ? `${name || 'Chain'} complete\n${segments.length} segments done`
        : [
            `${name || 'Chain'} · Segment ${i + 2} of ${segments.length}`,
            `${next.name || 'segment'} — ${fmtDur(next.duration)}`,
            after ? `Up next: ${after.name || 'segment'} (${fmtDur(after.duration)})` : 'Last segment',
          ].join('\n');

      notifs.push({
        id:         NOTIF_BASE + i,
        title,
        body,
        largeBody,
        summaryText: `${i + 2}/${segments.length}`,
        schedule:   { at: fireAt, allowWhileIdle: true },
        smallIcon:  'ic_stat_icon',
        iconColor:  '#F5B042',
        channelId:  CHANNEL_ID,
        ongoing:    false,
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
    refreshBatteryOpt,
    requestBatteryOpt,
    refreshNotifHealth,

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
    if (type === 'schedule')       return serialize(() => scheduleAll(detail));
    if (type === 'cancel')         return serialize(() => cancelAll());
    if (type === 'cancel-status')  return serialize(() => cancelStatus());
  }

  window.addEventListener('chain:start',      e => preWarmDone ? dispatch('schedule', e.detail) : queuedEvents.push({ type: 'schedule', detail: e.detail }));
  window.addEventListener('chain:reschedule', e => preWarmDone ? dispatch('schedule', e.detail) : queuedEvents.push({ type: 'schedule', detail: e.detail }));
  window.addEventListener('chain:cancel',     ()  => preWarmDone ? dispatch('cancel')           : queuedEvents.push({ type: 'cancel' }));
  // Chain finished naturally: clear only the sticky status row, leave the
  // "✓ Chain complete" alarm that just fired in the tray for the user.
  window.addEventListener('chain:complete',   ()  => preWarmDone ? dispatch('cancel-status')    : queuedEvents.push({ type: 'cancel-status' }));

  // Pre-warm: request permission + create channel + check exact-alarm
  // grant up front, before any chain starts, so the OS dialog isn't
  // competing with the running countdown and the user sees the real state
  // in Settings before relying on it. Sweep orphan notifications from any
  // previous app session so they don't fire at random later.
  (async () => {
    await ensurePermission();
    await ensureChannel();
    await checkExactAlarm();
    await refreshBatteryOpt();
    await refreshNotifHealth();
    await sweepOrphans();
    // Snapshot + clear the queue *before* flipping the flag. New events
    // arriving from this point on go straight to dispatch() (serialised
    // after the drained ops by virtue of the same bgOpChain mutex).
    const drain = queuedEvents.splice(0);
    preWarmDone = true;
    for (const ev of drain) dispatch(ev.type, ev.detail);
    notifyStatusChanged();
  })();

  // ---------- Resume + heartbeat re-scheduling ----------
  // Two scenarios this defends against:
  //
  //  1. The user force-stopped the app and relaunched it. Force-stop
  //     wipes pending AlarmManager alarms. When the engine restores from
  //     localStorage it emits chain:reschedule, which gets us back to a
  //     known-good state — but only if the visibility-change fires before
  //     the next missed segment boundary. Re-scheduling on every resume
  //     closes the window further.
  //
  //  2. The OS killed the FGS during deep Doze (rare on stock Android,
  //     not rare on aggressive OEM ROMs). When the user comes back to
  //     the app, we want to immediately re-take the wake lock and
  //     re-prime the alarm queue.
  //
  // The 4-minute heartbeat covers a third case: if the app is in the
  // background but the FGS is still alive, re-scheduling periodically
  // ensures any alarms that drifted (re-scheduled inexactly by Doze, lost
  // by background Restore Receiver weirdness, etc.) are corrected on the
  // way through.
  function nudgeReschedule() {
    if (!preWarmDone) return;
    if (!serviceRunning && (window.ChainedNativeStatus.lastSchedule?.count ?? 0) === 0) return;
    // The engine owns the truth — ask it to re-emit chain:reschedule
    // with current state. Falls back to a no-op if the engine isn't loaded.
    try {
      window.dispatchEvent(new CustomEvent('chained:nudgereschedule'));
    } catch {}
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // Re-probe permissions & battery state — anything could have
      // changed in OS settings while we were backgrounded.
      refreshNotifHealth();
      refreshBatteryOpt();
      checkExactAlarm();
      nudgeReschedule();
    }
  });
  window.addEventListener('focus',  () => nudgeReschedule());
  window.addEventListener('pageshow', () => nudgeReschedule());

  // 4-minute heartbeat. Chosen below the 5-minute Android JobScheduler
  // boundary and below the 9-minute Doze inexact-alarm window, so any
  // alarm that was about to be coalesced gets re-scheduled before it
  // would fire late.
  const HEARTBEAT_MS = 4 * 60 * 1000;
  setInterval(nudgeReschedule, HEARTBEAT_MS);

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
