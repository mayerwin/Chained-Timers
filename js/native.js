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

   The web Engine drives the bridge via five CustomEvents:
     - chain:start       → schedule all upcoming segment-end notifications
                            and post the sticky now-playing row
     - chain:reschedule  → cancel + re-schedule (after skip / resume /
                            pause / restored from persistence)
     - chain:fgsupdate   → refresh the now-playing notification only
                            (after natural segment advance, when the
                            alarm queue is still correct from chain:start
                            and we just want the chronometer / title to
                            track the new segment)
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

  // Register the custom Android foreground-service plugin. The plugin is
  // declared natively via `registerPlugin(ChainTimerPlugin.class)` in
  // MainActivity and gets auto-exposed at `Capacitor.Plugins.ChainTimer`
  // by the bridge. We also call `registerPlugin('ChainTimer')` as a
  // fallback for setups (or stale WebView caches) where the auto-exposed
  // instance hasn't materialised yet — the JS proxy returned by that call
  // dispatches through the same JS↔native bridge.
  //
  // If neither path produces a working object (e.g. an older APK installed
  // before this build, or running on iOS) every call would reject — we
  // wrap each one in try/catch and treat unavailability as a clean
  // fallback to the LocalNotifications status row.
  let ChainTimer = (Plugins && Plugins.ChainTimer) || null;
  if (isAndroid && !ChainTimer && typeof window.Capacitor.registerPlugin === 'function') {
    try { ChainTimer = window.Capacitor.registerPlugin('ChainTimer'); }
    catch (e) { log('registerPlugin(ChainTimer) failed:', e); }
  }
  // Probe availability so we can quickly fall back without paying for a
  // full bridge round-trip on every action.
  let chainTimerAvailable = false;
  if (ChainTimer && typeof window.Capacitor.isPluginAvailable === 'function') {
    chainTimerAvailable = !!window.Capacitor.isPluginAvailable('ChainTimer');
  }
  // Last-resort: if the plugin object exists but isPluginAvailable returns
  // false (Capacitor 8 has surprised us with this when the plugin is
  // registered via @CapacitorPlugin but the registry hasn't flushed), fall
  // through and trust the proxy — the worst case is one rejected bridge
  // call that the catch handler in startOrUpdateService converts to a
  // graceful fallback to postStatus().
  if (!chainTimerAvailable && ChainTimer) chainTimerAvailable = true;
  log(`ChainTimer plugin: available=${chainTimerAvailable} (Plugins.ChainTimer=${!!(Plugins && Plugins.ChainTimer)}, isPluginAvailable=${typeof window.Capacitor.isPluginAvailable === 'function' ? window.Capacitor.isPluginAvailable('ChainTimer') : 'n/a'})`);
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
        if (cmd !== 'pause' && cmd !== 'resume' && cmd !== 'stop'
            && cmd !== 'skip-prev' && cmd !== 'skip-next') return;
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
    const tasks = [];
    // The chain-transitions channel is only used on the OS-fallback path
    // (no ChainTimerPlugin available — older builds, or some other
    // unusual case). On modern Android with the plugin, the FGS service
    // owns its own chain-active + chain-finale channels with the
    // bundled chime / finale sounds; recreating chain-transitions here
    // every launch just leaves a stale entry in System Settings →
    // Notifications until the service's next ensureChannel deletes it
    // again.
    // Both chain-transitions and chain-status are only used by the
    // OS-fallback path (no ChainTimerPlugin available — older builds,
    // or some unusual configuration). On modern Android with the plugin
    // the FGS service owns chain-active + chain-finale with the bundled
    // chime / finale sounds and never schedules a LocalNotifications
    // alarm. Skipping these here keeps System Settings → Notifications
    // limited to the channels actually in use.
    if (!chainTimerAvailable) {
      tasks.push(LocalNotifications.createChannel({
        id:           CHANNEL_ID,
        name:         'Chain transitions',
        description:  'Fires when one segment ends and the next begins',
        importance:   5,            // IMPORTANCE_HIGH — heads-up + sound
        visibility:   1,            // VISIBILITY_PUBLIC — show on lock screen
        vibration:    true,
        lights:       true,
        lightColor:   '#F5B042',
        sound:        undefined,    // default channel sound
      }).catch(e => log('createChannel transitions failed:', e)));
      tasks.push(LocalNotifications.createChannel({
        id:           STATUS_CHANNEL_ID,
        name:         'Chain status',
        description:  'Persistent indicator of the currently-running segment',
        importance:   2,            // IMPORTANCE_LOW — silent, no heads-up
        visibility:   1,
        vibration:    false,
        lights:       false,
        sound:        undefined,
      }).catch(e => log('createChannel status failed:', e)));
    }
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
    // Order matters: cancel pre-scheduled AlarmManager alarms FIRST,
    // THEN stop the foreground service. If we stopped the service first
    // there'd be a brief window where the FGS notification is gone but
    // a transition alarm could still fire and confuse the user with
    // a "Next: X" pop-up while the chain is being cancelled.
    const ids = [...scheduledIds];
    if (statusActive) ids.push(STATUS_ID);
    if (ids.length) {
      try {
        await LocalNotifications.cancel({
          notifications: ids.map(id => ({ id })),
        });
        log(`cancelled ${ids.length} notifications`);
      } catch (e) {
        log('cancel failed:', e);
      }
    }
    scheduledIds = [];
    statusActive = false;
    await stopService();
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

  // Chain ended naturally. Two cleanups, depending on which path posted
  // the persistent indicator:
  //
  //   - FGS path (modern Android with ChainTimerPlugin): hand off to
  //     ChainTimer.complete() so the service replaces its persistent
  //     notification in place with the "✓ Chain complete" heads-up,
  //     releases the wake lock, and stops itself. The user ends up
  //     with exactly ONE notification at chain end.
  //
  //   - Fallback path (older builds, iOS): the persistent row was
  //     posted via LocalNotifications and the per-segment "Chain
  //     complete" alarm has either just fired or is firing now —
  //     just clear the sticky "▶ Now playing" entry.
  //
  // Distinct from cancelAll, which is for user-initiated stop and ALSO
  // cancels pending transition alarms; here the chain ended naturally
  // so any pending alarms for THIS chain are already past their fire
  // time and will be cleaned up in-memory below.
  async function completeStatus(detail) {
    scheduledIds = [];
    if (chainTimerAvailable) {
      // Probe the service's actual state. JS-side serviceRunning is just
      // a hint: when the service self-completed (background tick reached
      // chain end while the WebView was suspended) it stopped silently
      // and posted its "✓ Chain complete" notification — we never got
      // told. Calling ChainTimer.complete() again here would re-post a
      // fresh duplicate the moment the user taps the existing one to
      // open the app (Android auto-cancels the tapped notification, then
      // we'd put another one straight back). Skip it if the service is
      // already gone — the in-tray entry is enough.
      let stillRunning = serviceRunning;
      try {
        const r = await ChainTimer.isRunning();
        stillRunning = !!(r && r.running);
      } catch (e) {
        log('ChainTimer.isRunning failed:', e);
      }
      if (stillRunning) {
        const content = detail ? buildStatusContent(detail) : null;
        // Foreground rAF reached chain end → JS already played
        // Audio.finale() through Web Audio. Tell the service to post
        // the "✓ Chain complete" notification SILENTLY (it's still a
        // tray record, but no second sound on top of the in-app one).
        // The service's autonomous chain-end path (background tick
        // detecting end while the WebView was asleep) keeps alerting
        // — that's the only path where this is the user's only cue.
        const completePayload = Object.assign({}, content || {}, { silent: true });
        try {
          await ChainTimer.complete(completePayload);
        } catch (e) {
          log('ChainTimer.complete failed:', e);
          // Best-effort fallback so the tray doesn't stay sticky.
          try { await ChainTimer.stop(); } catch {}
        }
      }
      serviceRunning = false;
      window.ChainedNativeStatus.fgService = false;
      notifyStatusChanged();
      return;
    }
    if (statusActive) {
      try {
        await LocalNotifications.cancel({ notifications: [{ id: STATUS_ID }] });
      } catch (e) {
        log('completeStatus cancel failed:', e);
      }
      statusActive = false;
    }
    await stopService();
  }

  // ---------- Foreground service control plane ----------
  // On Android, drive the ChainTimerService so the process holds a
  // partial wake lock and stays Doze-exempt for the full chain run.
  // On iOS this is a no-op (iOS apps can't keep arbitrary code running
  // in the background; we rely on UNUserNotificationCenter scheduling).
  function buildStatusContent(detail) {
    const { name, segments, currentIndex = 0, isPaused, segmentStartedAtMs, pausedAtMs = 0, tickEnabled = true, soundEnabled = true } = detail;
    const cur = segments[currentIndex] || { name: 'Segment', duration: 0 };
    const next = segments[currentIndex + 1];
    const total = segments.length;
    const titlePrefix = isPaused ? '⏸' : '▶';
    // Wall-clock moment the segment will end. Anchored to the engine's
    // segmentStartedAtMs (already excludes paused-time). The native
    // service uses this both to render the static MM:SS in its title
    // and to schedule its own per-second tick / segment auto-advance.
    const endTimeMs = (!isPaused && segmentStartedAtMs && cur.duration)
      ? segmentStartedAtMs + cur.duration * 1000
      : 0;
    // Authoritative remaining at the pause transition — given to the
    // service so it can keep displaying the correct frozen value if it
    // re-renders the notification before resume. Reference time is
    // pausedAtMs (frozen at the moment of pause), NOT Date.now() —
    // otherwise the value drifts as wall-clock advances during the
    // pause and silently reaches 0 across e.g. an app restart.
    const refMs = pausedAtMs || Date.now();
    const pausedRemainingMs = (isPaused && segmentStartedAtMs && cur.duration)
      ? Math.max(0, cur.duration * 1000 - (refMs - segmentStartedAtMs))
      : 0;
    // Compact plan payload — { n: name, d: duration in seconds } per
    // segment. The service self-advances through this list so the
    // notification keeps ticking and disappears at chain end even
    // when the WebView (and therefore JS) is paused or killed.
    const planJson = JSON.stringify(segments.map(s => ({
      n: s.name || 'Segment',
      d: Math.max(0, s.duration | 0),
    })));
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
      pausedRemainingMs,
      chainName: name || 'Chain',
      planJson,
      segmentStartedAtMs: segmentStartedAtMs || 0,
      tickEnabled: !!tickEnabled,
      soundEnabled: !!soundEnabled,
      // Chain position — surfaced to the FGS so it can render the
      // overall-chain progress bar and gate the skip-prev / skip-next
      // notification action buttons (we hide whichever has no target).
      segmentIndex: currentIndex,
      segmentTotal: total,
      hasPrev:      currentIndex > 0,
      hasNext:      currentIndex < total - 1,
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
      if (!window.ChainedNativeStatus.fgService) {
        window.ChainedNativeStatus.fgService = true;
        notifyStatusChanged();
      }
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
    notifyStatusChanged();
  }

  // FGS-only update path. Used for natural segment advances where the
  // pre-scheduled alarm queue is still correct (their absolute fire
  // times never moved) and only the persistent "now playing" notification
  // — current title, chronometer end-time, position counter — needs to
  // catch up to the new segment. Skips the cancel + re-schedule round-trip
  // that scheduleAll() does, which is critical for short-segment chains
  // (Box Breath: 4-second segments would otherwise hammer AlarmManager
  // with hundreds of cancel/reschedule pairs over a 13-minute run).
  async function refreshFgsOnly(detail) {
    const fgsActive = await startOrUpdateService(detail);
    if (!fgsActive) await postStatus(detail);
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

    // Snapshot "is this a fresh chain start?" BEFORE the cancel block
    // wipes scheduledIds. Used below to gate the noisy reliability probes
    // (notif-health + battery-opt toasts) so they only fire on the first
    // schedule of a fresh run -- not on every skip / pause / resume /
    // heartbeat. True on initial chain:start, true on cold-start
    // restoreIfActive (no prior scheduledIds, no live service), false on
    // every mid-chain reschedule.
    const wasFreshStart = !scheduledIds.length && !statusActive && !serviceRunning;

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

    // Reliability probes — only on the first schedule of a fresh chain
    // start (or restore after kill). Mid-chain reschedules from skip /
    // pause / resume / heartbeat skip these to avoid toast spam.
    if (!isPaused && wasFreshStart) {
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

    // When the foreground-service plugin is alive, it owns every alert
    // for the run (per-tick text, segment-boundary sound, "✓ Chain
    // complete" final notification). Pre-scheduling parallel
    // LocalNotifications would just clutter the tray with one extra
    // entry per segment. Skip them on this path; only the OS-fallback
    // path (older builds without ChainTimerPlugin, or iOS) still
    // pre-schedules per-segment alarms below.
    if (fgsActive) {
      window.ChainedNativeStatus.lastSchedule = { count: 0, error: null, when: Date.now(), fgsOwned: true };
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
        // Subtext shows "<position>/<total>". For the chain-complete entry
        // (last index), fix the off-by-one that was producing "5/4" by
        // using the chain length on both sides instead of i+2.
        summaryText: isLast
          ? `${segments.length}/${segments.length}`
          : `${i + 2}/${segments.length}`,
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
    if (type === 'complete')       return serialize(() => completeStatus(detail));
    if (type === 'fgs-update')     return serialize(() => refreshFgsOnly(detail));
  }

  window.addEventListener('chain:start',      e => preWarmDone ? dispatch('schedule', e.detail) : queuedEvents.push({ type: 'schedule', detail: e.detail }));
  window.addEventListener('chain:reschedule', e => preWarmDone ? dispatch('schedule', e.detail) : queuedEvents.push({ type: 'schedule', detail: e.detail }));
  // Natural segment advance: alarms still valid, just refresh the FGS
  // notification (title, chronometer, action button). No alarm churn.
  window.addEventListener('chain:fgsupdate',  e => preWarmDone ? dispatch('fgs-update', e.detail) : queuedEvents.push({ type: 'fgs-update', detail: e.detail }));
  window.addEventListener('chain:cancel',     ()  => preWarmDone ? dispatch('cancel')           : queuedEvents.push({ type: 'cancel' }));
  // Chain finished naturally: hand off to the FGS service (or cleanup
  // the LocalNotifications fallback) so a single "✓ Chain complete"
  // notification replaces the persistent row in place.
  window.addEventListener('chain:complete',   e => preWarmDone ? dispatch('complete', e?.detail) : queuedEvents.push({ type: 'complete', detail: e?.detail }));

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
