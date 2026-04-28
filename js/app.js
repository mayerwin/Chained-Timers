/* ==========================================================================
   Chained Timers
   ========================================================================== */

(() => {
'use strict';

// ============================================================
// Constants & utilities
// ============================================================

const STORAGE_KEY = 'chained-timers/v1';

const COLORS = [
  { id: 'amber',  hex: '#F5B042' },
  { id: 'rust',   hex: '#C97847' },
  { id: 'rose',   hex: '#D88BA0' },
  { id: 'violet', hex: '#9D8BD8' },
  { id: 'indigo', hex: '#7B7BC9' },
  { id: 'teal',   hex: '#5DAC9D' },
  { id: 'sage',   hex: '#9BB089' },
  { id: 'bone',   hex: '#D4CDBA' },
];
const COLOR_BY_ID = Object.fromEntries(COLORS.map(c => [c.id, c.hex]));
const colorHex = id => COLOR_BY_ID[id] || COLOR_BY_ID.amber;

const DEFAULT_SETTINGS = {
  sound: true,
  voice: false,
  vibrate: true,
  wake: true,
  prestart: true,
  finalTick: true,
  notifsAsked: false,
};

const TEMPLATES = [
  {
    name: 'Plank Stack',
    desc: '90s front plank, 60s each side, repeated, finished by a 90s hold.',
    color: 'amber',
    loops: 1,
    segments: [
      { kind: 'segment', name: 'Front plank',    duration: 90, color: 'amber' },
      { kind: 'segment', name: 'Side plank — L', duration: 60, color: 'rust'  },
      { kind: 'segment', name: 'Side plank — R', duration: 60, color: 'rust'  },
      { kind: 'segment', name: 'Front plank',    duration: 90, color: 'amber' },
      { kind: 'segment', name: 'Side plank — L', duration: 60, color: 'rust'  },
      { kind: 'segment', name: 'Side plank — R', duration: 60, color: 'rust'  },
      { kind: 'segment', name: 'Final hold',     duration: 90, color: 'sage'  },
    ],
  },
  {
    name: 'Tabata',
    desc: 'Eight 20s sprints, 10s rest. The classic 4-minute conditioning protocol.',
    color: 'rust',
    loops: 8,
    segments: [
      { kind: 'segment', name: 'Work', duration: 20, color: 'rust' },
      { kind: 'segment', name: 'Rest', duration: 10, color: 'sage' },
    ],
  },
  {
    name: 'EMOM 10',
    desc: 'Every Minute on the Minute — ten rounds of one minute. Do your reps, then rest.',
    color: 'indigo',
    loops: 10,
    segments: [
      { kind: 'segment', name: 'Round', duration: 60, color: 'indigo' },
    ],
  },
  {
    name: 'Boxing Rounds',
    desc: 'Three 3-minute rounds, one minute between. Tune up your jab.',
    color: 'rose',
    loops: 1,
    segments: [
      { kind: 'segment', name: 'Round 1', duration: 180, color: 'rose' },
      { kind: 'segment', name: 'Rest',    duration: 60,  color: 'sage' },
      { kind: 'segment', name: 'Round 2', duration: 180, color: 'rose' },
      { kind: 'segment', name: 'Rest',    duration: 60,  color: 'sage' },
      { kind: 'segment', name: 'Round 3', duration: 180, color: 'rose' },
    ],
  },
  {
    name: 'Pomodoro',
    desc: '25 minutes of focused work, then a 5-minute break. Repeat as needed.',
    color: 'teal',
    loops: 1,
    segments: [
      { kind: 'segment', name: 'Focus',  duration: 25 * 60, color: 'teal' },
      { kind: 'segment', name: 'Break',  duration: 5  * 60, color: 'sage' },
    ],
  },
  {
    name: 'Box Breath',
    desc: 'Four-by-four-by-four. Inhale, hold, exhale, hold. Twelve rounds.',
    color: 'violet',
    loops: 12,
    segments: [
      { kind: 'segment', name: 'Inhale', duration: 4, color: 'violet' },
      { kind: 'segment', name: 'Hold',   duration: 4, color: 'bone'   },
      { kind: 'segment', name: 'Exhale', duration: 4, color: 'sage'   },
      { kind: 'segment', name: 'Hold',   duration: 4, color: 'bone'   },
    ],
  },
];

const uid = (prefix = 'id') =>
  prefix + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);

const fmt = (totalSeconds) => {
  totalSeconds = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
};

const fmtLong = (totalSeconds) => {
  totalSeconds = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s || parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
};

// ============================================================
// Store (localStorage)
// ============================================================

const Store = {
  state: { schemaVersion: 1, chains: [], settings: { ...DEFAULT_SETTINGS } },

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (data && Array.isArray(data.chains)) {
          // Skip chains missing required structure rather than letting them
          // crash later in expansion / deletion.
          this.state.chains = data.chains.filter(c =>
            c && typeof c === 'object' && c.id && Array.isArray(c.segments)
          );
          this.state.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
        }
      }
    } catch (e) {
      console.warn('Failed to load:', e);
    }
  },

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch (e) {
      console.warn('Failed to save:', e);
    }
  },

  getChains() { return this.state.chains; },
  getChain(id) { return this.state.chains.find(c => c.id === id); },

  upsertChain(chain) {
    chain.updatedAt = Date.now();
    const idx = this.state.chains.findIndex(c => c.id === chain.id);
    if (idx >= 0) this.state.chains[idx] = chain;
    else { chain.createdAt = Date.now(); this.state.chains.unshift(chain); }
    this.save();
  },

  deleteChain(id) {
    if (!id) return;
    this.state.chains = this.state.chains.filter(c => c.id !== id);
    // also strip references to it from other chains
    this.state.chains.forEach(c => {
      if (Array.isArray(c.segments)) {
        c.segments = c.segments.filter(s => !(s && s.kind === 'subchain' && s.refId === id));
      }
    });
    this.save();
  },

  duplicateChain(id) {
    const c = this.getChain(id);
    if (!c) return null;
    const copy = JSON.parse(JSON.stringify(c));
    copy.id = uid('c');
    copy.name = (c.name || 'Untitled') + ' (copy)';
    copy.segments = Array.isArray(copy.segments)
      ? copy.segments.map(s => ({ ...s, id: uid('s') }))
      : [];
    copy.createdAt = Date.now();
    copy.updatedAt = Date.now();
    this.state.chains.unshift(copy);
    this.save();
    return copy;
  },

  getSettings() { return this.state.settings; },
  setSetting(k, v) { this.state.settings[k] = v; this.save(); },

  exportAll() {
    return JSON.stringify(this.state, null, 2);
  },

  importAll(json) {
    const data = JSON.parse(json);
    if (!data || !Array.isArray(data.chains)) throw new Error('Invalid file');
    this.state.chains = data.chains;
    this.state.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
    this.save();
  },
};

// ============================================================
// Chain expansion (resolve sub-chains, detect cycles)
// ============================================================

function expandChain(rootChain, opts = {}) {
  if (!rootChain || !Array.isArray(rootChain.segments)) return [];
  const visited = opts.visited || new Set();
  if (visited.has(rootChain.id)) return []; // cycle guard
  visited.add(rootChain.id);

  const out = [];
  const loops = Math.max(1, rootChain.loops || 1);

  for (let loop = 0; loop < loops; loop++) {
    rootChain.segments.forEach((seg, segIdx) => {
      if (!seg) return;
      if (seg.kind === 'subchain') {
        const sub = Store.getChain(seg.refId);
        if (!sub) return;
        const subLoops = Math.max(1, seg.loops || 1);
        for (let sl = 0; sl < subLoops; sl++) {
          const expanded = expandChain(sub, { visited: new Set(visited) });
          expanded.forEach(es => {
            out.push({
              ...es,
              path: [`${rootChain.name}${loops > 1 ? ` · ${loop+1}/${loops}` : ''}`, ...es.path],
            });
          });
        }
      } else {
        out.push({
          name: seg.name || 'Segment',
          duration: Math.max(1, seg.duration | 0),
          color: seg.color || rootChain.color || 'amber',
          path: [`${rootChain.name}${loops > 1 ? ` · ${loop+1}/${loops}` : ''}`],
        });
      }
    });
  }

  return out;
}

function chainTotalSeconds(chain) {
  return expandChain(chain).reduce((sum, s) => sum + s.duration, 0);
}

function isAncestorOf(maybeAncestorId, descendantChain, visited = new Set()) {
  if (!descendantChain || !Array.isArray(descendantChain.segments)) return false;
  if (visited.has(descendantChain.id)) return false;
  visited.add(descendantChain.id);
  for (const seg of descendantChain.segments) {
    if (!seg || seg.kind !== 'subchain') continue;
    if (seg.refId === maybeAncestorId) return true;
    const sub = Store.getChain(seg.refId);
    if (sub && isAncestorOf(maybeAncestorId, sub, visited)) return true;
  }
  return false;
}

// ============================================================
// Audio cues (Web Audio API — generated tones, no asset files)
// ============================================================

const Audio = {
  ctx: null,
  unlocked: false,

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  },

  // call inside a user gesture to unlock on iOS
  unlock() {
    this.ensure();
    if (this.ctx && !this.unlocked) {
      const buf = this.ctx.createBuffer(1, 1, 22050);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.ctx.destination);
      src.start(0);
      this.unlocked = true;
    }
  },

  beep({ freq = 880, duration = 0.18, volume = 0.25, type = 'sine', glide = null } = {}) {
    this.ensure();
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (glide) osc.frequency.exponentialRampToValueAtTime(glide, t + duration);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(volume, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(g).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  },

  // distinctive end-of-segment chime: two stacked tones
  chime() {
    this.beep({ freq: 880, duration: 0.18, volume: 0.22, type: 'sine' });
    setTimeout(() => this.beep({ freq: 1320, duration: 0.28, volume: 0.22, type: 'sine' }), 120);
  },

  // final-3-second tick
  tick() {
    this.beep({ freq: 660, duration: 0.08, volume: 0.18, type: 'square' });
  },

  // start chime
  start() {
    this.beep({ freq: 523, duration: 0.10, volume: 0.18, type: 'sine' });
    setTimeout(() => this.beep({ freq: 784, duration: 0.18, volume: 0.20, type: 'sine' }), 100);
  },

  // pre-start countdown beep
  prestart(isFinal = false) {
    if (isFinal) this.beep({ freq: 880, duration: 0.22, volume: 0.24, type: 'sine' });
    else this.beep({ freq: 523, duration: 0.12, volume: 0.18, type: 'sine' });
  },

  // grand finale
  finale() {
    this.beep({ freq: 523, duration: 0.16, volume: 0.22, type: 'sine' });
    setTimeout(() => this.beep({ freq: 659, duration: 0.16, volume: 0.22, type: 'sine' }), 120);
    setTimeout(() => this.beep({ freq: 784, duration: 0.16, volume: 0.22, type: 'sine' }), 240);
    setTimeout(() => this.beep({ freq: 1047, duration: 0.42, volume: 0.24, type: 'sine' }), 360);
  },
};

// ============================================================
// Voice (Web Speech)
// ============================================================

const Voice = {
  speak(text) {
    if (!('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.0;
      u.pitch = 1.0;
      u.volume = 1.0;
      window.speechSynthesis.speak(u);
    } catch (e) { /* noop */ }
  },
};

// ============================================================
// Vibration helpers
// ============================================================

const Vibe = {
  do(pattern) {
    if (!('vibrate' in navigator)) return;
    try { navigator.vibrate(pattern); } catch {}
  },
  segmentEnd() { this.do([60, 60, 60, 60, 200]); },
  finalTick()  { this.do(40); },
  start()      { this.do(120); },
  finale()     { this.do([90, 80, 90, 80, 240]); },
};

// ============================================================
// Wake Lock
// ============================================================

const Wake = {
  sentinel: null,
  async acquire() {
    if (!('wakeLock' in navigator)) return;
    try {
      this.sentinel = await navigator.wakeLock.request('screen');
      this.sentinel.addEventListener('release', () => { this.sentinel = null; });
    } catch (e) { /* user may have denied */ }
  },
  async release() {
    if (this.sentinel) { try { await this.sentinel.release(); } catch {} this.sentinel = null; }
  },
  async reacquireIfNeeded() {
    // browsers release wake lock on visibility change; reacquire on return
    if (document.visibilityState === 'visible' && Engine.isRunning && !this.sentinel) {
      await this.acquire();
    }
  },
};
document.addEventListener('visibilitychange', () => Wake.reacquireIfNeeded());

// ============================================================
// Notifications
// ============================================================

const Notif = {
  perm() { return 'Notification' in window ? Notification.permission : 'unsupported'; },
  async request() {
    if (!('Notification' in window)) return 'unsupported';
    if (Notification.permission === 'default') {
      try { return await Notification.requestPermission(); } catch { return 'denied'; }
    }
    return Notification.permission;
  },
  async show(title, body, opts = {}) {
    // In the native shell, the OS-scheduled LocalNotifications handle every
    // segment transition. Firing a duplicate Web Notification here would
    // either show twice or hang on navigator.serviceWorker.ready (no SW
    // is registered in native builds — see init()).
    if (window.ChainedNative?.isNative) return;
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    try {
      // Prefer SW registration so notifications persist if tab becomes inactive,
      // but never block on it — Promise.race with a short timeout.
      const reg = await Promise.race([
        navigator.serviceWorker?.ready ?? Promise.resolve(null),
        new Promise(resolve => setTimeout(() => resolve(null), 500)),
      ]);
      const options = {
        body,
        icon: './icons/icon-192.png',
        badge: './icons/icon-192.png',
        tag: 'chained-timers',
        renotify: true,
        silent: false,
        ...opts,
      };
      if (reg && reg.showNotification) {
        await reg.showNotification(title, options);
      } else {
        new Notification(title, options);
      }
    } catch (e) { /* noop */ }
  },
};

// ============================================================
// Toast
// ============================================================

const Toast = {
  show(message, kind = '') {
    const stack = document.getElementById('toast-stack');
    const t = document.createElement('div');
    t.className = 'toast' + (kind ? ' is-' + kind : '');
    t.innerHTML = `<span class="t-mark"></span>${escape(message)}`;
    stack.appendChild(t);
    setTimeout(() => {
      t.classList.add('is-out');
      setTimeout(() => t.remove(), 280);
    }, 2400);
  },
};

const escape = (s) => String(s).replace(/[&<>"']/g, c => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[c]));

// ============================================================
// Timer Engine
// ============================================================

// All elapsed-time math is wall-clock (Date.now) because the Capacitor
// Android WebView pauses JS timers + frame callbacks (and may freeze
// performance.now) when the activity is backgrounded or the screen
// locks. Wall-clock is the only source that keeps ticking across freezes,
// so the engine can correctly catch up multiple segments when the user
// returns to the app. performance.now is used only for the rAF cadence.
const Engine = {
  chain: null,
  segments: [],
  currentIndex: 0,
  segmentStartedAtWall: 0,  // Date.now() when current segment "began" (paused-time excluded)
  pausedAtWall: 0,          // Date.now() at moment of pause
  pausedDuration: 0,        // total ms paused within this segment (wall-clock)
  isRunning: false,
  isPaused: false,
  rafId: null,
  onTick: null,
  onSegmentChange: null,
  onComplete: null,
  totalElapsed: 0,          // accumulated elapsed ms across all completed segments
  finalTickedAt: -1,        // segment second at which we last fired final-tick
  warningOn: false,

  startChain(chain) {
    this.chain = chain;
    this.segments = expandChain(chain);
    if (!this.segments.length) {
      Toast.show('Chain has no segments');
      return false;
    }
    this.currentIndex = 0;
    this.totalElapsed = 0;
    this.pausedDuration = 0;
    this.isRunning = true;
    this.isPaused = false;
    const now = Date.now();
    this.segmentStartedAtWall = now;
    this.pausedAtWall = now;
    this.finalTickedAt = -1;
    this.warningOn = false;

    if (Store.getSettings().sound)   { Audio.unlock(); Audio.start(); }
    if (Store.getSettings().vibrate) Vibe.start();
    if (Store.getSettings().wake)    Wake.acquire();
    if (Store.getSettings().voice)   Voice.speak(this.segments[0].name);

    this._persist();
    this._emitChainEvent('chain:start');

    this._loop();
    this.onSegmentChange?.();
    return true;
  },

  // Emit a lifecycle event so the native shell (js/native.js, Capacitor)
  // can pre-schedule local notifications. No-op in plain browsers.
  //
  // segmentStartedAtMs is an "effective" wall-clock time: if the segment
  // had been running continuously without pauses, this is when it would
  // have started. So fireAt = segmentStartedAtMs + segment.duration is
  // always the correct wall-clock fire moment for the *current* segment.
  _emitChainEvent(name) {
    try {
      // segmentStartedAtWall already excludes paused-time (we shift it
      // forward on resume), so fireAt = segmentStartedAtWall + duration
      // is the correct wall-clock moment.
      const segmentStartedAtMs = this.segmentStartedAtWall + this.pausedDuration;
      window.dispatchEvent(new CustomEvent(name, {
        detail: {
          name: this.chain?.name,
          segments: this.segments.map(s => ({ name: s.name, duration: s.duration, color: s.color })),
          currentIndex: this.currentIndex,
          segmentStartedAtMs,
          isPaused: this.isPaused,
        },
      }));
    } catch {}
  },

  // Compute the elapsed wall-clock ms within the current segment, excluding
  // any time the user was paused. Single source of truth for both the rAF
  // tick and the catchup-from-background path.
  _elapsedMs() {
    const ref = this.isPaused ? this.pausedAtWall : Date.now();
    return Math.max(0, ref - this.segmentStartedAtWall - this.pausedDuration);
  },

  // Walk forward through any segments whose wall-clock duration has already
  // elapsed. Called on visibilitychange / app resume, and on cold-start
  // restoration. Uses 'catchup' so we don't replay every missed chime/voice
  // back-to-back (the user wasn't listening) and don't re-issue OS schedules
  // (those were pre-set at chain:start with absolute fire times).
  _catchup() {
    if (!this.isRunning || this.isPaused) return false;
    let advanced = false;
    while (this.isRunning && !this.isPaused) {
      const seg = this.segments[this.currentIndex];
      if (!seg) break;
      if (this._elapsedMs() >= seg.duration * 1000) {
        this._advance('catchup');
        advanced = true;
      } else break;
    }
    return advanced;
  },

  _loop() {
    cancelAnimationFrame(this.rafId);
    const tick = () => {
      if (!this.isRunning) return;

      const seg = this.segments[this.currentIndex];
      if (!seg) { this._complete(); return; }

      const elapsedMs = this._elapsedMs();

      // If the WebView was frozen long enough to span an entire segment
      // boundary, walk forward through every segment whose wall-clock
      // duration has elapsed. Without this, a single tick would only
      // advance one segment and snap the next to "just starting".
      if (!this.isPaused && elapsedMs >= seg.duration * 1000) {
        if (this._catchup()) {
          this.onSegmentChange?.();
          // _advance kicks _loop again, but it cancelled rafId first;
          // bail here so the new loop owns the next frame.
          return;
        }
      }

      const remainingSec = Math.max(0, seg.duration - elapsedMs / 1000);
      const remainingInt = Math.ceil(remainingSec);

      // Final-3-second tick (when not paused)
      if (!this.isPaused && Store.getSettings().finalTick) {
        if (remainingInt <= 3 && remainingInt >= 1 && remainingInt !== this.finalTickedAt) {
          this.finalTickedAt = remainingInt;
          if (Store.getSettings().sound) Audio.tick();
          if (Store.getSettings().vibrate) Vibe.finalTick();
        }
      }

      // Warning state for last 5 seconds
      const shouldWarn = remainingInt <= 5 && !this.isPaused && remainingInt > 0;
      if (shouldWarn !== this.warningOn) {
        this.warningOn = shouldWarn;
        document.querySelector('.view-run')?.classList.toggle('is-warning', shouldWarn);
      }

      this.onTick?.(seg, remainingSec, elapsedMs / 1000);

      if (remainingSec <= 0 && !this.isPaused) {
        this._advance('auto');
        return;
      }

      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  },

  // reason:
  //   'auto'    — timer naturally ran out: OS-scheduled queue is correct, no reschedule needed
  //   'skip'    — user tapped next: must re-schedule the remaining notifications
  //   'catchup' — replaying segments that elapsed while app was backgrounded:
  //               the user wasn't there, so no chime/voice/vibe; OS notifications
  //               already fired for these moments
  _advance(reason = 'auto') {
    const seg = this.segments[this.currentIndex];
    const segDurMs = (seg?.duration || 0) * 1000;
    this.totalElapsed += segDurMs;

    // Compute the next segment's wall-clock start *before* mutating index.
    // For auto/catchup we anchor to the boundary moment of the segment that
    // just ended (= old start + paused-time + duration); this way successive
    // catchup steps preserve the wall-clock advancement instead of snapping
    // each new segment to "now". For skip, the user just tapped Next, so
    // the new segment starts fresh from the current instant.
    const now = Date.now();
    const nextStartWall = (reason === 'skip')
      ? now
      : (this.segmentStartedAtWall + this.pausedDuration + segDurMs);

    this.currentIndex++;

    if (this.currentIndex >= this.segments.length) {
      this._complete(reason);
      return;
    }

    // Segment transition cues — only when the user is actually present.
    if (reason !== 'catchup') {
      if (Store.getSettings().sound)   Audio.chime();
      if (Store.getSettings().vibrate) Vibe.segmentEnd();
      const nextSeg = this.segments[this.currentIndex];
      if (Store.getSettings().voice && nextSeg) Voice.speak(nextSeg.name);
      Notif.show(`Next: ${nextSeg.name}`, `${fmtLong(nextSeg.duration)} · ${this.currentIndex + 1} of ${this.segments.length}`);
    }

    this.segmentStartedAtWall = nextStartWall;
    this.pausedAtWall = now;
    this.pausedDuration = 0;
    this.finalTickedAt = -1;
    this.warningOn = false;
    document.querySelector('.view-run')?.classList.remove('is-warning');

    this._persist();
    this.onSegmentChange?.();
    this._loop();
    // Only manual user-driven skips need to re-issue the OS schedule.
    if (reason === 'skip') this._emitChainEvent('chain:reschedule');
  },

  pause() {
    if (!this.isRunning || this.isPaused) return;
    this.isPaused = true;
    this.pausedAtWall = Date.now();
    document.querySelector('.view-run')?.classList.add('is-paused');
    document.querySelector('.view-run')?.classList.remove('is-warning');
    Wake.release();
    cancelAnimationFrame(this.rafId);
    this.onTick?.(this.segments[this.currentIndex], null, null);
    this._persist();
    // Re-emit so the native bridge cancels future transition alarms
    // (they'd fire at the wrong wall-clock moments while paused) but
    // keeps a sticky "⏸ Paused — segment X" entry in the tray.
    this._emitChainEvent('chain:reschedule');
  },

  resume() {
    if (!this.isRunning || !this.isPaused) return;
    this.pausedDuration += Date.now() - this.pausedAtWall;
    this.isPaused = false;
    document.querySelector('.view-run')?.classList.remove('is-paused');
    if (Store.getSettings().wake) Wake.acquire();
    this._persist();
    this._loop();
    this._emitChainEvent('chain:reschedule');
  },

  toggle() {
    if (this.isPaused) this.resume();
    else this.pause();
  },

  skipNext() {
    if (!this.isRunning) return;
    this._advance('skip');
  },

  skipPrev() {
    if (!this.isRunning) return;
    const restartCurrent = () => {
      const now = Date.now();
      this.segmentStartedAtWall = now;
      this.pausedAtWall = now;
      this.pausedDuration = 0;
      this.finalTickedAt = -1;
    };
    if (this.currentIndex === 0) {
      restartCurrent();
      this._persist();
      this.onSegmentChange?.();
      this._emitChainEvent('chain:reschedule');
      return;
    }
    // if more than 2.5s in, restart current; else go to prev
    if (this._elapsedMs() > 2500) {
      restartCurrent();
    } else {
      this.currentIndex--;
      const prevSeg = this.segments[this.currentIndex];
      this.totalElapsed = Math.max(0, this.totalElapsed - (prevSeg?.duration || 0) * 1000);
      restartCurrent();
    }
    this._persist();
    this.onSegmentChange?.();
    this._emitChainEvent('chain:reschedule');
  },

  // opts.preserveNotifications: when called from _complete, the "Chain
  // complete" tray notification has already fired (or is firing). We must
  // NOT cancel it by ID — that would dismiss it from the tray within ms.
  stop(opts = {}) {
    this.isRunning = false;
    this.isPaused = false;
    cancelAnimationFrame(this.rafId);
    document.querySelector('.view-run')?.classList.remove('is-warning', 'is-paused');
    Wake.release();
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    if (!opts.preserveNotifications) {
      window.dispatchEvent(new CustomEvent('chain:cancel'));
    }
    this._clearPersist();
  },

  _complete(reason = 'auto') {
    const total = this.segments.reduce((s, x) => s + x.duration, 0);
    this.stop({ preserveNotifications: true });
    // The "Chain complete" transition alarm has either just fired or is
    // about to (it was pre-scheduled at chain:start). We keep that one in
    // the tray but the sticky "▶ Now playing" indicator no longer makes
    // sense, so dismiss it.
    window.dispatchEvent(new CustomEvent('chain:complete'));
    // Catchup completion happens silently: the chain ended while the user
    // was away, the OS already fired the "Chain complete" notification at
    // the correct wall-clock moment, and we don't want to replay the
    // finale chime/voice/vibe minutes/hours later when they return — nor
    // unhide the completion overlay (it'd flash on the next run).
    if (reason !== 'catchup') {
      if (Store.getSettings().sound)   Audio.finale();
      if (Store.getSettings().vibrate) Vibe.finale();
      Notif.show(`${this.chain.name} complete`, `${fmtLong(total)} · ${this.segments.length} segments`);
      this.onComplete?.(total);
    }
  },

  totalRemaining() {
    if (!this.segments.length) return 0;
    const cur = this.segments[this.currentIndex];
    if (!cur) return 0;
    let r = Math.max(0, cur.duration - this._elapsedMs() / 1000);
    for (let i = this.currentIndex + 1; i < this.segments.length; i++) {
      r += this.segments[i].duration;
    }
    return r;
  },

  // ----- Crash-safe persistence -----
  // Save running state on every transition so a WebView kill, OS reboot,
  // or app force-stop doesn't lose the chain. Restored on init().
  _persist() {
    try {
      if (!this.isRunning || !this.chain) {
        localStorage.removeItem('chained-timers/run/v1');
        return;
      }
      const snap = {
        v: 1,
        chainId: this.chain.id,
        chainName: this.chain.name,
        segments: this.segments,
        currentIndex: this.currentIndex,
        segmentStartedAtWall: this.segmentStartedAtWall,
        pausedAtWall: this.pausedAtWall,
        pausedDuration: this.pausedDuration,
        isPaused: this.isPaused,
        totalElapsed: this.totalElapsed,
        savedAt: Date.now(),
      };
      localStorage.setItem('chained-timers/run/v1', JSON.stringify(snap));
    } catch {}
  },

  _clearPersist() {
    try { localStorage.removeItem('chained-timers/run/v1'); } catch {}
  },

  // Restore a chain that was running when the app was killed/closed.
  // Returns true if a session was restored (UI should jump to run view).
  restoreIfActive() {
    let snap;
    try {
      const raw = localStorage.getItem('chained-timers/run/v1');
      if (!raw) return false;
      snap = JSON.parse(raw);
    } catch { this._clearPersist(); return false; }

    if (!snap || snap.v !== 1 || !Array.isArray(snap.segments) || !snap.segments.length) {
      this._clearPersist();
      return false;
    }

    // Refuse stale state (>24h old) — almost certainly the user moved on.
    const ageMs = Date.now() - (snap.savedAt || 0);
    if (ageMs > 24 * 3600 * 1000) { this._clearPersist(); return false; }

    // Try to relink to the live chain (renames/edits OK), else use the
    // snapshotted segments so the run can finish even if the chain was
    // deleted.
    const chain = Store.getChain(snap.chainId) || {
      id: snap.chainId,
      name: snap.chainName || 'Restored chain',
      segments: snap.segments,
    };

    this.chain = chain;
    this.segments = snap.segments;
    this.currentIndex = snap.currentIndex | 0;
    this.segmentStartedAtWall = Number(snap.segmentStartedAtWall) || Date.now();
    this.pausedAtWall = Number(snap.pausedAtWall) || Date.now();
    this.pausedDuration = Number(snap.pausedDuration) || 0;
    this.isPaused = !!snap.isPaused;
    this.isRunning = true;
    this.totalElapsed = Number(snap.totalElapsed) || 0;
    this.finalTickedAt = -1;
    this.warningOn = false;

    // Walk past any segments whose duration has already elapsed in real
    // wall-clock time. If the whole chain is past, _catchup -> _complete.
    if (!this.isPaused) this._catchup();
    if (!this.isRunning) return false;

    // Sync the run-view CSS state with the restored engine state. The
    // pause/resume methods normally toggle .is-paused, but we got here
    // by deserialising state — do it explicitly.
    const runView = document.querySelector('.view-run');
    if (runView) {
      runView.classList.toggle('is-paused', this.isPaused);
      runView.classList.remove('is-warning');
    }

    if (Store.getSettings().wake && !this.isPaused) Wake.acquire();
    // Don't replay sounds / OS notifications: the OS notifications were
    // pre-scheduled at chain:start last session; if they hadn't fired
    // they're now stale — re-emit chain:reschedule so the native bridge
    // re-sweeps and re-schedules from the *current* position.
    this._emitChainEvent('chain:reschedule');
    if (!this.isPaused) this._loop();
    // Render the paused/running clock once even when no rAF is running.
    this.onTick?.(this.segments[this.currentIndex], null, null);
    return true;
  },
};

// ============================================================
// Editor state
// ============================================================

const Editor = {
  draftId: null,    // chain id being edited (null = new)
  draft: null,      // working chain object

  newChain() {
    this.draftId = null;
    this.draft = {
      id: uid('c'),
      name: '',
      color: 'amber',
      loops: 1,
      segments: [
        { id: uid('s'), kind: 'segment', name: '', duration: 60, color: 'amber' },
      ],
    };
  },

  loadChain(id) {
    const c = Store.getChain(id);
    if (!c) { this.newChain(); return; }
    this.draftId = id;
    this.draft = JSON.parse(JSON.stringify(c));
  },

  loadFromTemplate(tpl) {
    this.draftId = null;
    this.draft = {
      id: uid('c'),
      name: tpl.name,
      color: tpl.color,
      loops: tpl.loops || 1,
      segments: tpl.segments.map(s => ({ ...s, id: uid('s') })),
    };
  },

  addSegment() {
    this.draft.segments.push({
      id: uid('s'),
      kind: 'segment',
      name: '',
      duration: 60,
      color: this.draft.color,
    });
  },

  addSubchain(refId) {
    this.draft.segments.push({
      id: uid('s'),
      kind: 'subchain',
      refId,
      loops: 1,
    });
  },

  removeSegment(segId) {
    this.draft.segments = this.draft.segments.filter(s => s.id !== segId);
  },

  moveSegment(fromIdx, toIdx) {
    if (toIdx < 0 || toIdx >= this.draft.segments.length) return;
    const [item] = this.draft.segments.splice(fromIdx, 1);
    this.draft.segments.splice(toIdx, 0, item);
  },

  saveDraft() {
    if (!this.draft) return null;
    if (!this.draft.name.trim()) this.draft.name = 'Untitled chain';
    Store.upsertChain(this.draft);
    this.draftId = this.draft.id;
    return this.draft;
  },
};

// ============================================================
// View routing
// ============================================================

const View = {
  current: 'library',
  history: ['library'],

  show(name) {
    document.querySelectorAll('.view').forEach(v => {
      v.hidden = v.dataset.viewName !== name;
    });
    document.body.dataset.view = name;
    if (this.current !== name) {
      this.history.push(name);
      this.current = name;
    }
    if (name === 'library')   UI.renderLibrary();
    if (name === 'templates') UI.renderTemplates();
    if (name === 'editor')    UI.renderEditor();
    if (name === 'run')       UI.renderRun();
  },

  back() {
    // simple: pop history
    if (this.history.length > 1) {
      this.history.pop();
      const prev = this.history[this.history.length - 1];
      this.current = prev;
      this.show(prev);
      // popping show pushes again — fix the duplication:
      this.history.pop();
    } else {
      this.show('library');
    }
  },
};

// ============================================================
// UI rendering
// ============================================================

const UI = {

  // ------- Library -------

  renderLibrary() {
    const list = document.getElementById('chain-list');
    const empty = document.getElementById('empty-state');
    const chains = Store.getChains();

    list.innerHTML = '';
    empty.hidden = chains.length > 0;

    document.getElementById('library-count').textContent =
      `${chains.length} ${chains.length === 1 ? 'chain' : 'chains'}`;
    const totalSecs = chains.reduce((s, c) => s + chainTotalSeconds(c), 0);
    document.getElementById('library-total').textContent =
      chains.length ? `${fmtLong(totalSecs)} stored` : '— total';

    chains.forEach(chain => {
      const total = chainTotalSeconds(chain);
      const expanded = expandChain(chain);
      const li = document.createElement('li');
      li.className = 'chain-card';
      li.dataset.chainId = chain.id;

      const stripe = document.createElement('div');
      stripe.className = 'chain-card-stripe';
      stripe.style.background = colorHex(chain.color);

      const body = document.createElement('div');
      body.className = 'chain-card-body';
      const safeId = String(chain.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
      const loops  = Math.max(1, Number(chain.loops) || 1);
      body.innerHTML = `
        <div class="chain-card-row1">
          <div class="chain-card-name">${escape(chain.name || 'Untitled')}</div>
          <div class="chain-card-total">${escape(fmt(total))}</div>
        </div>
        <div class="chain-card-segments" id="seg-preview-${safeId}"></div>
        <div class="chain-card-meta">
          <span>${expanded.length} ${expanded.length === 1 ? 'segment' : 'segments'}</span>
          ${loops > 1 ? `<span class="dot"></span><span>×${loops} loop${loops > 1 ? 's' : ''}</span>` : ''}
          ${chain.segments.some(s => s && s.kind === 'subchain') ? `<span class="dot"></span><span>nested</span>` : ''}
        </div>
      `;

      const play = document.createElement('button');
      play.className = 'chain-card-play';
      play.setAttribute('aria-label', 'Start chain');
      play.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;

      li.appendChild(stripe);
      li.appendChild(body);
      li.appendChild(play);
      list.appendChild(li);

      // segment preview pills
      const preview = li.querySelector(`#seg-preview-${safeId}`);
      const max = 28;
      const slice = expanded.slice(0, max);
      slice.forEach(s => {
        const chip = document.createElement('span');
        chip.className = 'seg-chip';
        chip.style.background = colorHex(s.color);
        // width proportional to duration (capped)
        const w = Math.min(40, Math.max(6, Math.sqrt(s.duration) * 2.2));
        chip.style.width = w + 'px';
        preview.appendChild(chip);
      });
      if (expanded.length > max) {
        const more = document.createElement('span');
        more.style.cssText = 'font-family: var(--f-mono); font-size: 9px; color: var(--ink-dim); margin-left: 4px; align-self: center;';
        more.textContent = `+${expanded.length - max}`;
        preview.appendChild(more);
      }

      // events
      body.addEventListener('click', () => { Editor.loadChain(chain.id); View.show('editor'); });
      stripe.addEventListener('click', () => { Editor.loadChain(chain.id); View.show('editor'); });
      play.addEventListener('click', e => {
        e.stopPropagation();
        Audio.unlock();
        UI.startRunForChain(chain);
      });
    });
  },

  startRunForChain(chain) {
    // Pre-populate engine state so renderRun has data immediately,
    // even before the prestart countdown finishes.
    Engine.chain = chain;
    Engine.segments = expandChain(chain);
    Engine.currentIndex = 0;
    Engine.totalElapsed = 0;
    if (!Engine.segments.length) {
      Toast.show('Chain has no segments', 'warn');
      return;
    }
    View.show('run');
    if (Store.getSettings().prestart) UI.runPrestart(chain);
    else Engine.startChain(chain);
  },

  prestartIv: null,

  cancelPrestart() {
    if (this.prestartIv) { clearInterval(this.prestartIv); this.prestartIv = null; }
    const overlay = document.getElementById('run-prestart');
    if (overlay) overlay.hidden = true;
  },

  runPrestart(chain) {
    UI.cancelPrestart();
    const overlay = document.getElementById('run-prestart');
    const num = document.getElementById('run-prestart-num');
    overlay.hidden = false;
    let n = 3;
    num.textContent = n;
    if (Store.getSettings().sound)   Audio.prestart(false);
    if (Store.getSettings().vibrate) Vibe.do(50);
    UI.prestartIv = setInterval(() => {
      n--;
      if (n > 0) {
        num.textContent = n;
        if (Store.getSettings().sound)   Audio.prestart(n === 1);
        if (Store.getSettings().vibrate) Vibe.do(n === 1 ? 100 : 50);
      } else {
        UI.cancelPrestart();
        Engine.startChain(chain);
      }
    }, 1000);
  },

  // ------- Templates -------

  renderTemplates() {
    const list = document.getElementById('template-list');
    list.innerHTML = '';
    TEMPLATES.forEach(tpl => {
      const li = document.createElement('li');
      li.className = 'template-card';
      const expandedDur = (tpl.loops || 1) * tpl.segments.reduce((s, x) => s + x.duration, 0);
      li.innerHTML = `
        <div class="template-card-head">
          <div class="template-card-title" style="color: ${colorHex(tpl.color)}">${escape(tpl.name)}</div>
          <div class="template-card-time">${escape(fmt(expandedDur))}</div>
        </div>
        <div class="template-card-desc">${escape(tpl.desc)}</div>
        <div class="template-card-segments"></div>
      `;
      const segWrap = li.querySelector('.template-card-segments');
      tpl.segments.forEach(s => {
        const pill = document.createElement('span');
        pill.className = 'template-pill';
        pill.textContent = `${s.name} · ${fmt(s.duration)}`;
        pill.style.color = colorHex(s.color);
        pill.style.borderColor = colorHex(s.color) + '44';
        segWrap.appendChild(pill);
      });
      if (tpl.loops > 1) {
        const pill = document.createElement('span');
        pill.className = 'template-pill';
        pill.style.borderStyle = 'dashed';
        pill.textContent = `× ${tpl.loops} loops`;
        segWrap.appendChild(pill);
      }
      li.addEventListener('click', () => {
        Editor.loadFromTemplate(tpl);
        View.show('editor');
      });
      list.appendChild(li);
    });
  },

  // ------- Editor -------

  renderEditor() {
    const draft = Editor.draft;
    if (!draft) return;

    document.getElementById('editor-mode-label').textContent = Editor.draftId ? 'Editing' : 'New';
    const nameInput = document.getElementById('editor-name');
    nameInput.value = draft.name;

    // color row
    const colorRow = document.getElementById('editor-color-row');
    colorRow.innerHTML = '';
    COLORS.forEach(c => {
      const dot = document.createElement('button');
      dot.className = 'color-dot' + (c.id === draft.color ? ' is-active' : '');
      dot.style.background = c.hex;
      dot.title = c.id;
      dot.setAttribute('aria-label', `Color ${c.id}`);
      dot.addEventListener('click', () => {
        draft.color = c.id;
        UI.renderEditor();
      });
      colorRow.appendChild(dot);
    });

    // stats
    const total = chainTotalSeconds(draft);
    document.getElementById('editor-total').textContent = fmt(total);
    document.getElementById('editor-count').textContent = expandChain(draft).length;
    document.getElementById('editor-loops').textContent = draft.loops || 1;

    // segments
    const list = document.getElementById('segment-list');
    list.innerHTML = '';
    draft.segments.forEach((seg, idx) => {
      list.appendChild(UI._renderSegmentRow(seg, idx));
    });
  },

  _renderSegmentRow(seg, idx) {
    const li = document.createElement('li');
    li.className = 'segment-row' + (seg.kind === 'subchain' ? ' is-sub' : '');
    li.dataset.segId = seg.id;
    li.dataset.idx = idx;

    const handle = document.createElement('div');
    handle.className = 'segment-handle';
    handle.innerHTML = `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
        <circle cx="9"  cy="6"  r="1.4"/><circle cx="15" cy="6"  r="1.4"/>
        <circle cx="9"  cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/>
        <circle cx="9"  cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>
      </svg>`;
    li.appendChild(handle);

    const body = document.createElement('div');
    body.className = 'segment-body';

    if (seg.kind === 'subchain') {
      const sub = Store.getChain(seg.refId);
      const subName = sub ? sub.name : '(missing)';
      const subDur  = sub ? chainTotalSeconds(sub) : 0;
      body.innerHTML = `
        <div class="segment-num">№ ${idx + 1} · embedded chain</div>
        <div class="segment-sub-name">${escape(subName)}</div>
        <div class="segment-sub-meta">
          ${sub ? `${expandChain(sub).length} segments · ${fmt(subDur)}` : 'Not found'}
        </div>
      `;
      li.appendChild(body);

      // loops control
      const loopsWrap = document.createElement('div');
      loopsWrap.className = 'segment-sub-loops';
      const segLoops = Math.max(1, Number(seg.loops) || 1);
      loopsWrap.innerHTML = `
        <button data-loop="-1" aria-label="Fewer loops">−</button>
        <span>×${segLoops}</span>
        <button data-loop="+1" aria-label="More loops">+</button>
      `;
      loopsWrap.querySelectorAll('button').forEach(b => {
        b.addEventListener('click', () => {
          const d = parseInt(b.dataset.loop, 10);
          seg.loops = Math.max(1, Math.min(99, (seg.loops || 1) + d));
          UI.renderEditor();
        });
      });
      li.appendChild(loopsWrap);
    } else {
      body.innerHTML = `
        <span class="segment-num">№ ${idx + 1}</span>
        <input type="text" class="segment-name-input" value="${escape(seg.name || '')}" placeholder="Segment name" maxlength="48" />
        <div class="segment-meta">
          <button class="seg-color-btn" aria-label="Cycle color" style="background: ${colorHex(seg.color)}"></button>
        </div>`;
      li.appendChild(body);

      const nameInput = body.querySelector('.segment-name-input');
      nameInput.addEventListener('input', () => { seg.name = nameInput.value; });
      nameInput.addEventListener('blur', () => { UI.renderLibraryStatsOnly(); });

      // cycle through palette colors
      const colorBtn = body.querySelector('.segment-color-btn, .seg-color-btn');
      colorBtn.addEventListener('click', () => {
        const i = COLORS.findIndex(c => c.id === seg.color);
        seg.color = COLORS[(i + 1) % COLORS.length].id;
        UI.renderEditor();
      });

      const dur = document.createElement('button');
      dur.className = 'segment-duration';
      dur.textContent = fmt(seg.duration);
      dur.addEventListener('click', () => UI.openDurationPicker(seg));
      li.appendChild(dur);
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'segment-remove';
    removeBtn.setAttribute('aria-label', 'Remove segment');
    removeBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M6 6l1 14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-14"/></svg>`;
    removeBtn.addEventListener('click', () => {
      if (Editor.draft.segments.length <= 1) {
        Toast.show('A chain needs at least one segment', 'warn');
        return;
      }
      Editor.removeSegment(seg.id);
      UI.renderEditor();
    });
    li.appendChild(removeBtn);

    // drag & drop wiring
    UI._wireDrag(li, handle);
    return li;
  },

  renderLibraryStatsOnly() {
    if (!Editor.draft) return;
    const total = chainTotalSeconds(Editor.draft);
    document.getElementById('editor-total').textContent = fmt(total);
    document.getElementById('editor-count').textContent = expandChain(Editor.draft).length;
  },

  // ------- Drag & drop (pointer events, mobile + desktop) -------

  dragState: null,

  _wireDrag(li, handle) {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const startY = e.clientY;
      const list = li.parentElement;
      const fromIdx = parseInt(li.dataset.idx, 10);
      const rowH = li.getBoundingClientRect().height + 8; // gap
      li.classList.add('is-dragging');
      let movedIdx = fromIdx;

      const onMove = (ev) => {
        const dy = ev.clientY - startY;
        li.style.transform = `translateY(${dy}px) scale(0.985)`;
        const newIdx = Math.max(0, Math.min(list.children.length - 1,
          Math.round(fromIdx + dy / rowH)));
        if (newIdx !== movedIdx) {
          movedIdx = newIdx;
          // visually re-order siblings (transient)
          [...list.children].forEach((el, i) => {
            el.classList.remove('is-drop-target');
            if (el === li) return;
            const baseIdx = parseInt(el.dataset.idx, 10);
            let translate = 0;
            if (fromIdx < newIdx) {
              if (baseIdx > fromIdx && baseIdx <= newIdx) translate = -rowH;
            } else {
              if (baseIdx < fromIdx && baseIdx >= newIdx) translate = rowH;
            }
            el.style.transform = `translateY(${translate}px)`;
          });
        }
      };
      const onUp = (ev) => {
        handle.releasePointerCapture(e.pointerId);
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup',   onUp);
        document.removeEventListener('pointercancel', onUp);
        // commit
        if (movedIdx !== fromIdx) {
          Editor.moveSegment(fromIdx, movedIdx);
        }
        // reset all transforms
        [...list.children].forEach(el => { el.style.transform = ''; });
        li.classList.remove('is-dragging');
        UI.renderEditor();
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup',   onUp);
      document.addEventListener('pointercancel', onUp);
    });
  },

  // ------- Duration picker -------

  durationTarget: null,

  openDurationPicker(seg) {
    UI.durationTarget = seg;
    const sheet = document.getElementById('duration-sheet');
    const h = Math.floor(seg.duration / 3600);
    const m = Math.floor((seg.duration % 3600) / 60);
    const s = seg.duration % 60;
    document.getElementById('dpick-h').value = String(h).padStart(2, '0');
    document.getElementById('dpick-m').value = String(m).padStart(2, '0');
    document.getElementById('dpick-s').value = String(s).padStart(2, '0');
    sheet.hidden = false;
    setTimeout(() => document.getElementById('dpick-s').focus(), 100);
  },

  closeDurationPicker() {
    document.getElementById('duration-sheet').hidden = true;
    UI.durationTarget = null;
  },

  commitDurationPicker() {
    if (!UI.durationTarget) return;
    const h = Math.max(0, Math.min(23, parseInt(document.getElementById('dpick-h').value || 0, 10) || 0));
    const m = Math.max(0, Math.min(59, parseInt(document.getElementById('dpick-m').value || 0, 10) || 0));
    const s = Math.max(0, Math.min(59, parseInt(document.getElementById('dpick-s').value || 0, 10) || 0));
    let total = h * 3600 + m * 60 + s;
    if (total < 1) total = 1;
    if (total > 24 * 3600) total = 24 * 3600;
    UI.durationTarget.duration = total;
    UI.closeDurationPicker();
    UI.renderEditor();
  },

  // ------- Subchain picker -------

  openSubchainPicker() {
    if (!Editor.draft) return;
    const list = document.getElementById('picker-list');
    list.innerHTML = '';
    const candidates = Store.getChains().filter(c => {
      if (c.id === Editor.draft.id) return false; // can't embed self
      // disallow if would create a cycle: c's subtree must not contain Editor.draft
      if (isAncestorOf(Editor.draft.id, c)) return false;
      return true;
    });
    if (!candidates.length) {
      list.innerHTML = `<li style="font-family: var(--f-serif); font-style: italic; color: var(--ink-dim); padding: 14px; text-align: center;">No other chains yet. Save this one and create another to embed.</li>`;
    }
    candidates.forEach(c => {
      const li = document.createElement('li');
      li.className = 'picker-item';
      li.innerHTML = `
        <div>
          <div class="picker-item-name" style="color: ${colorHex(c.color)}">${escape(c.name)}</div>
          <div class="picker-item-meta">${expandChain(c).length} segments · ${fmt(chainTotalSeconds(c))}</div>
        </div>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 6l6 6-6 6"/></svg>
      `;
      li.addEventListener('click', () => {
        Editor.addSubchain(c.id);
        UI.closePickerSheet();
        UI.renderEditor();
      });
      list.appendChild(li);
    });
    document.getElementById('picker-sheet').hidden = false;
  },

  closePickerSheet() { document.getElementById('picker-sheet').hidden = true; },

  // ------- Settings sheet -------

  openSettings() {
    const s = Store.getSettings();
    document.getElementById('setting-sound').checked     = !!s.sound;
    document.getElementById('setting-voice').checked     = !!s.voice;
    document.getElementById('setting-vibrate').checked   = !!s.vibrate;
    document.getElementById('setting-wake').checked      = !!s.wake;
    document.getElementById('setting-prestart').checked  = !!s.prestart;
    document.getElementById('setting-finaltick').checked = !!s.finalTick;

    const notifBtn = document.getElementById('enable-notifs');
    const status = document.getElementById('notif-status');
    const perm = Notif.perm();
    if (perm === 'granted') { notifBtn.textContent = 'Enabled'; notifBtn.disabled = true; status.textContent = 'System notifications enabled.'; }
    else if (perm === 'denied') { notifBtn.textContent = 'Blocked'; notifBtn.disabled = true; status.textContent = 'Notifications blocked in browser settings.'; }
    else if (perm === 'unsupported') { notifBtn.textContent = 'N/A'; notifBtn.disabled = true; status.textContent = 'Notifications not supported in this browser.'; }
    else { notifBtn.disabled = false; notifBtn.textContent = 'Enable'; }

    // Native bridge panel — only visible when running inside Capacitor
    const N = window.ChainedNative;
    const panel = document.getElementById('native-panel');
    if (N && N.isNative) {
      panel.hidden = false;
      const st = N.status();
      const dot = document.getElementById('native-dot');
      const badge = document.getElementById('native-badge');
      const body = document.getElementById('native-body');
      const title = document.getElementById('native-title');

      title.textContent = `Native bridge — ${st.platform}`;

      if (st.permission === 'granted' && st.channelReady) {
        dot.className = 'native-dot is-on';
        badge.textContent = 'Active';
        badge.className = 'badge is-on';
      } else if (st.permission === 'denied') {
        dot.className = 'native-dot is-warn';
        badge.textContent = 'Blocked';
        badge.className = 'badge is-warn';
      } else {
        dot.className = 'native-dot';
        badge.textContent = st.permission || 'pending';
        badge.className = 'badge is-off';
      }

      const ls = st.lastSchedule;
      let bodyText = `notifs: ${st.permission} · channel: ${st.channelReady ? 'ready' : '—'} · exact-alarm: ${st.exactAlarm}`;
      if (st.platform === 'android') {
        const fgState = st.fgService ? 'running' : (st.fgServiceAvailable ? 'idle' : 'unavailable');
        bodyText += ` · background service: ${fgState}`;
        if (st.batteryOpt && st.batteryOpt !== 'unsupported' && st.batteryOpt !== 'unknown') {
          bodyText += ` · battery: ${st.batteryOpt}`;
        }
        if (st.notifHealth) {
          const h = st.notifHealth;
          if (!h.appEnabled)              bodyText += '\n⚠ notifications: BLOCKED app-wide';
          else if (!h.statusChannelEnabled)    bodyText += '\n⚠ "Chain status" channel disabled';
          else if (!h.transitionsChannelEnabled) bodyText += '\n⚠ "Chain transitions" channel disabled';
        }
      }
      if (ls) {
        if (ls.error) bodyText += `\nlast schedule: failed (${ls.error})`;
        else if (ls.count > 0) bodyText += `\nlast schedule: ${ls.count} notifications`;
        else bodyText += `\nlast schedule: 0 (no future segments)`;
      }
      body.textContent = bodyText;

      // Show "Fix exact alarms" only when it's actually broken on Android.
      const exactBtn = document.getElementById('native-exact');
      const needsExactFix = (st.exactAlarm === 'denied' || st.exactAlarm === 'prompt');
      exactBtn.hidden = !needsExactFix;

      // Show "Allow background" if the OS has the app under battery
      // optimization. This is the single most common reason a chain goes
      // silent on Samsung / Xiaomi / OPPO / Huawei / Vivo / OnePlus.
      const batteryBtn = document.getElementById('native-battery');
      const needsBatteryFix = (st.batteryOpt === 'optimized');
      batteryBtn.hidden = !needsBatteryFix;

      // Notifications disabled is a CRITICAL failure mode — every alert
      // is silent. Make the badge red and unmissable.
      const notifBlocked = st.notifHealth && !st.notifHealth.ok;

      if (notifBlocked) {
        dot.className = 'native-dot is-warn';
        badge.textContent = 'Notifications blocked';
        badge.className = 'badge is-warn';
      } else if (needsExactFix) {
        dot.className = 'native-dot is-warn';
        badge.textContent = 'Exact alarms denied';
        badge.className = 'badge is-warn';
      } else if (needsBatteryFix) {
        dot.className = 'native-dot is-warn';
        badge.textContent = 'Background restricted';
        badge.className = 'badge is-warn';
      }
    } else {
      panel.hidden = true;
    }

    document.getElementById('settings-sheet').hidden = false;
  },

  closeSettings() { document.getElementById('settings-sheet').hidden = true; },

  // ------- Run view -------

  renderRun() {
    if (!Engine.chain) return;
    document.getElementById('run-chain-name').textContent = Engine.chain.name;
    UI.updateRunSegmentInfo();
    UI.updateRunClock(Engine.segments[Engine.currentIndex], Engine.segments[Engine.currentIndex]?.duration || 0, 0);
  },

  updateRunSegmentInfo() {
    const seg = Engine.segments[Engine.currentIndex];
    if (!seg) return;
    document.getElementById('run-chain-name').textContent = Engine.chain?.name || '—';
    document.getElementById('run-segment-name').textContent = seg.name;
    document.getElementById('run-segment-tag').textContent = `Segment ${Engine.currentIndex + 1}`;
    document.getElementById('run-segment-of').textContent  = `of ${Engine.segments.length}`;
    document.getElementById('run-chain-pos').textContent   = `${Engine.currentIndex + 1} / ${Engine.segments.length}`;

    // chain progression strip
    const strip = document.getElementById('run-chain-strip');
    strip.innerHTML = '';
    Engine.segments.forEach((s, i) => {
      const t = document.createElement('div');
      t.className = 'run-chain-strip-tick';
      if (i < Engine.currentIndex) t.classList.add('is-done');
      else if (i === Engine.currentIndex) t.classList.add('is-active');
      // weight by duration so a 3-min round looks longer than a 10-sec rest
      t.style.flex = `${Math.max(1, Math.sqrt(s.duration))} 1 0`;
      strip.appendChild(t);
    });

    // tint the bg & ring with segment color
    const ring = document.getElementById('run-ring-fill');
    ring.style.stroke = colorHex(seg.color);
    document.getElementById('run-bg').style.background =
      `radial-gradient(ellipse 70% 50% at 50% 25%, ${colorHex(seg.color)}28, transparent 65%)`;

    // next preview
    const nextSeg = Engine.segments[Engine.currentIndex + 1];
    const nextWrap = document.getElementById('run-next');
    if (nextSeg) {
      nextWrap.style.visibility = 'visible';
      document.getElementById('run-next-name').textContent = nextSeg.name;
      document.getElementById('run-next-dur').textContent  = fmt(nextSeg.duration);
    } else {
      nextWrap.style.visibility = 'hidden';
    }

    // play/pause icon
    const ico = document.getElementById('run-toggle-icon');
    ico.innerHTML = Engine.isPaused
      ? `<path d="M8 5v14l11-7z"/>`
      : `<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>`;
  },

  updateRunClock(seg, remainingSec, elapsedSec) {
    if (!seg) return;
    const r = remainingSec == null ? Math.max(0, seg.duration - elapsedSec) : remainingSec;
    document.getElementById('run-clock').textContent = fmt(r);

    // ring (use inline style — CSS class values otherwise override presentation attrs)
    const ring = document.getElementById('run-ring-fill');
    const total = seg.duration;
    const progress = Math.max(0, Math.min(1, 1 - r / total));
    const c = 2 * Math.PI * 92;
    ring.style.strokeDasharray  = `${c.toFixed(2)}`;
    ring.style.strokeDashoffset = `${(c * (1 - progress)).toFixed(2)}`;

    // bottom progress bar = whole chain
    const totalChain = Engine.segments.reduce((s, x) => s + x.duration, 0);
    const totalRem = Engine.totalRemaining();
    const totalElapsed = Math.max(0, totalChain - totalRem);
    document.getElementById('run-progress-fill').style.width = `${(totalElapsed / totalChain * 100).toFixed(1)}%`;
    document.getElementById('run-elapsed').textContent  = `${fmt(totalElapsed)} elapsed`;
    document.getElementById('run-remaining').textContent = `${fmt(totalRem)} remaining`;

    // play/pause icon
    const ico = document.getElementById('run-toggle-icon');
    const target = Engine.isPaused
      ? `<path d="M8 5v14l11-7z"/>`
      : `<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>`;
    if (ico.innerHTML !== target) ico.innerHTML = target;
  },

  showCompletion(totalSeconds) {
    document.getElementById('run-complete').hidden = false;
    document.getElementById('run-complete-time').textContent = fmt(totalSeconds);
    document.getElementById('run-complete-count').textContent = Engine.segments.length;
    document.getElementById('run-complete-title').textContent = 'Well done.';
  },

  hideCompletion() {
    document.getElementById('run-complete').hidden = true;
  },

  // ------- Install hint -------

  deferredInstallPrompt: null,
  showInstallHint() {
    if (sessionStorage.getItem('chained-install-dismissed')) return;
    if (window.matchMedia('(display-mode: standalone)').matches) return;
    document.getElementById('install-hint').hidden = false;
  },
};

// ============================================================
// Wire up DOM events
// ============================================================

function init() {
  Store.load();

  // tabs
  document.querySelectorAll('.tab[data-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('is-active'));
      tab.classList.add('is-active');
      View.show(tab.dataset.tab);
    });
  });

  // FAB new chain
  document.getElementById('new-chain-fab').addEventListener('click', () => {
    Audio.unlock();
    Editor.newChain();
    View.show('editor');
  });
  document.getElementById('empty-new-chain').addEventListener('click', () => {
    Audio.unlock();
    Editor.newChain();
    View.show('editor');
  });
  document.getElementById('empty-templates').addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('is-active'));
    document.querySelector('.tab[data-tab="templates"]').classList.add('is-active');
    View.show('templates');
  });

  // back buttons
  document.querySelectorAll('[data-back]').forEach(b => {
    b.addEventListener('click', () => {
      const target = b.dataset.back;
      // sync tabbar active state
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('is-active'));
      const tab = document.querySelector(`.tab[data-tab="${target}"]`);
      if (tab) tab.classList.add('is-active');
      View.show(target);
    });
  });

  // settings
  document.getElementById('open-settings').addEventListener('click', () => UI.openSettings());
  document.querySelectorAll('[data-close-sheet]').forEach(el => {
    el.addEventListener('click', (e) => {
      const sheet = e.currentTarget.closest('.sheet');
      if (sheet) sheet.hidden = true;
    });
  });
  // settings toggles
  const wireToggle = (id, key) => {
    document.getElementById(id).addEventListener('change', e => {
      Store.setSetting(key, e.target.checked);
      if (key === 'wake' && e.target.checked && Engine.isRunning && !Engine.isPaused) Wake.acquire();
      if (key === 'wake' && !e.target.checked) Wake.release();
    });
  };
  wireToggle('setting-sound', 'sound');
  wireToggle('setting-voice', 'voice');
  wireToggle('setting-vibrate', 'vibrate');
  wireToggle('setting-wake', 'wake');
  wireToggle('setting-prestart', 'prestart');
  wireToggle('setting-finaltick', 'finalTick');

  // notifications enable
  document.getElementById('enable-notifs').addEventListener('click', async () => {
    const r = await Notif.request();
    Store.setSetting('notifsAsked', true);
    UI.openSettings(); // refresh status
    if (r === 'granted') Toast.show('Notifications enabled', 'good');
    else if (r === 'denied') Toast.show('Notifications were blocked', 'warn');
  });

  // Native bridge test buttons (only visible when running inside Capacitor)
  document.getElementById('native-test-10').addEventListener('click', () => {
    window.ChainedNative?.testNotification(10);
  });
  document.getElementById('native-test-30').addEventListener('click', () => {
    window.ChainedNative?.testNotification(30);
  });
  document.getElementById('native-perm').addEventListener('click', async () => {
    const ok = await window.ChainedNative?.requestPermission();
    Toast.show(ok ? 'Permission granted' : 'Permission denied', ok ? 'good' : 'warn');
    UI.openSettings();
  });
  document.getElementById('native-exact').addEventListener('click', async () => {
    Toast.show('Opening system settings — toggle "Allow exact alarms" ON, then come back.', 'good');
    const ok = await window.ChainedNative?.requestExactAlarm();
    setTimeout(() => UI.openSettings(), 500);
  });
  document.getElementById('native-battery').addEventListener('click', async () => {
    Toast.show('Opening battery settings — choose Unrestricted (or Allow), then come back.', 'good');
    await window.ChainedNative?.requestBatteryOpt?.();
    // Re-render once the user comes back (visibilitychange refreshes state).
    setTimeout(() => UI.openSettings(), 500);
  });

  // export / import
  document.getElementById('export-data').addEventListener('click', () => {
    const blob = new Blob([Store.exportAll()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `chained-timers-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    Toast.show('Library exported', 'good');
  });
  document.getElementById('import-data').addEventListener('click', () => {
    document.getElementById('import-file').click();
  });
  document.getElementById('import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      Store.importAll(text);
      UI.renderLibrary();
      Toast.show('Library imported', 'good');
      UI.closeSettings();
    } catch (err) {
      Toast.show('Import failed', 'warn');
    }
    e.target.value = '';
  });

  // editor name / loops
  document.getElementById('editor-name').addEventListener('input', e => {
    if (Editor.draft) Editor.draft.name = e.target.value;
  });
  document.querySelectorAll('[data-loops]').forEach(b => {
    b.addEventListener('click', () => {
      if (!Editor.draft) return;
      const d = parseInt(b.dataset.loops.replace('+', ''), 10);
      Editor.draft.loops = Math.max(1, Math.min(99, (Editor.draft.loops || 1) + d));
      UI.renderEditor();
    });
  });
  document.getElementById('add-segment').addEventListener('click', () => {
    Editor.addSegment();
    UI.renderEditor();
    // focus the new row's name input
    requestAnimationFrame(() => {
      const rows = document.querySelectorAll('.segment-name-input');
      rows[rows.length - 1]?.focus();
    });
  });
  document.getElementById('add-subchain').addEventListener('click', () => UI.openSubchainPicker());

  document.getElementById('editor-save-only').addEventListener('click', () => {
    const c = Editor.saveDraft();
    if (c) Toast.show('Chain saved', 'good');
    View.show('library');
  });
  document.getElementById('editor-start').addEventListener('click', () => {
    Audio.unlock();
    const c = Editor.saveDraft();
    if (c) UI.startRunForChain(c);
  });

  // editor "..." menu — open actions sheet
  document.getElementById('editor-menu-btn').addEventListener('click', () => {
    if (!Editor.draftId) {
      Toast.show('Save first to use this menu');
      return;
    }
    document.getElementById('actions-title').textContent = Editor.draft.name || 'Chain';
    document.getElementById('actions-sheet').hidden = false;
  });
  document.getElementById('action-duplicate').addEventListener('click', () => {
    document.getElementById('actions-sheet').hidden = true;
    const copy = Store.duplicateChain(Editor.draftId);
    if (copy) {
      Editor.loadChain(copy.id);
      UI.renderEditor();
      Toast.show('Duplicated', 'good');
    }
  });
  document.getElementById('action-share').addEventListener('click', () => {
    document.getElementById('actions-sheet').hidden = true;
    const c = Editor.draft;
    const blob = new Blob([JSON.stringify({ schemaVersion: 1, chains: [c] }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(c.name || 'chain').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    Toast.show('Chain exported', 'good');
  });
  document.getElementById('action-delete').addEventListener('click', () => {
    if (!confirm(`Delete "${Editor.draft.name}"? This cannot be undone.`)) return;
    document.getElementById('actions-sheet').hidden = true;
    Store.deleteChain(Editor.draftId);
    Toast.show('Chain deleted', 'warn');
    View.show('library');
  });

  // duration picker
  document.querySelectorAll('[data-dpick]').forEach(btn => {
    btn.addEventListener('click', () => {
      const code = btn.dataset.dpick;
      const dir = code.endsWith('+') ? 1 : -1;
      const part = code[0];
      const id = `dpick-${part}`;
      const input = document.getElementById(id);
      let v = parseInt(input.value || 0, 10) || 0;
      const max = part === 'h' ? 23 : 59;
      v = Math.max(0, Math.min(max, v + dir));
      input.value = String(v).padStart(2, '0');
    });
  });
  document.querySelectorAll('.dpick-input').forEach(inp => {
    inp.addEventListener('focus', () => inp.select());
    inp.addEventListener('blur', () => {
      let v = parseInt(inp.value || 0, 10) || 0;
      const max = inp.id === 'dpick-h' ? 23 : 59;
      v = Math.max(0, Math.min(max, v));
      inp.value = String(v).padStart(2, '0');
    });
    inp.addEventListener('input', () => {
      inp.value = inp.value.replace(/[^0-9]/g, '').slice(0, 2);
    });
  });
  document.querySelectorAll('.chip[data-quick]').forEach(c => {
    c.addEventListener('click', () => {
      const total = parseInt(c.dataset.quick, 10);
      const m = Math.floor(total / 60);
      const s = total % 60;
      document.getElementById('dpick-h').value = '00';
      document.getElementById('dpick-m').value = String(m).padStart(2, '0');
      document.getElementById('dpick-s').value = String(s).padStart(2, '0');
    });
  });
  document.getElementById('dpick-confirm').addEventListener('click', () => UI.commitDurationPicker());

  // run controls
  document.getElementById('run-stop').addEventListener('click', () => {
    if (Engine.isRunning) {
      if (!confirm('Stop this chain?')) return;
    }
    UI.cancelPrestart();           // ← prevent the queued startChain from firing
    Engine.stop();
    UI.hideCompletion();
    View.show('library');
  });
  document.getElementById('run-toggle').addEventListener('click', () => {
    Audio.unlock();
    Engine.toggle();
    UI.updateRunSegmentInfo();
  });
  document.getElementById('run-next-btn').addEventListener('click', () => Engine.skipNext());
  document.getElementById('run-prev').addEventListener('click', () => Engine.skipPrev());
  document.getElementById('run-mute').addEventListener('click', () => {
    const cur = Store.getSettings().sound;
    Store.setSetting('sound', !cur);
    document.getElementById('mute-icon').innerHTML = cur
      ? `<path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M22 9l-6 6M16 9l6 6"/>`
      : `<path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19 12c0-2-1-4-3-5M16 8c1 1 2 2 2 4s-1 3-2 4"/>`;
    Toast.show(cur ? 'Sound muted' : 'Sound on', cur ? 'warn' : 'good');
  });

  // completion overlay actions
  document.getElementById('run-complete-again').addEventListener('click', () => {
    UI.hideCompletion();
    if (Engine.chain) UI.startRunForChain(Engine.chain);
  });
  document.getElementById('run-complete-done').addEventListener('click', () => {
    UI.hideCompletion();
    View.show('library');
  });

  // engine callbacks
  Engine.onTick = (seg, remaining, elapsed) => UI.updateRunClock(seg, remaining, elapsed);
  Engine.onSegmentChange = () => UI.updateRunSegmentInfo();
  Engine.onComplete = (totalSeconds) => UI.showCompletion(totalSeconds);

  // PWA install prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    UI.deferredInstallPrompt = e;
    UI.showInstallHint();
  });
  document.getElementById('install-btn').addEventListener('click', async () => {
    if (UI.deferredInstallPrompt) {
      UI.deferredInstallPrompt.prompt();
      const { outcome } = await UI.deferredInstallPrompt.userChoice;
      UI.deferredInstallPrompt = null;
      document.getElementById('install-hint').hidden = true;
      if (outcome === 'accepted') Toast.show('Installed', 'good');
    }
  });
  document.getElementById('install-dismiss').addEventListener('click', () => {
    document.getElementById('install-hint').hidden = true;
    sessionStorage.setItem('chained-install-dismissed', '1');
  });

  // service worker
  // Service worker is for the PWA path only. In native builds Capacitor serves
  // assets locally and a stale SW cache could mask freshly bundled JS/CSS on
  // app updates.
  if ('serviceWorker' in navigator && !window.ChainedNative?.isNative) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  // Recompute engine state from wall clock whenever the app becomes visible
  // again (also covers `pageshow` for bfcache returns, and Capacitor's
  // `resume` event fired by the native shell).
  //
  // The engine is fully wall-clock driven, so this is purely a "wake the
  // rAF loop and refresh the UI" call. _catchup walks past every segment
  // whose duration elapsed during the freeze.
  function refreshFromWallClock() {
    if (!Engine.isRunning || Engine.isPaused) return;
    Engine._catchup();
    if (Engine.isRunning) {
      Engine._loop();              // re-prime rAF if it was cancelled
      UI.updateRunSegmentInfo();
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshFromWallClock();
  });
  window.addEventListener('pageshow', refreshFromWallClock);
  window.addEventListener('focus',    refreshFromWallClock);
  // Capacitor App resume — the native bridge dispatches this when the
  // activity returns to foreground (more reliable than visibilitychange
  // on some Android skins).
  window.addEventListener('chained:appresume', refreshFromWallClock);

  // Native-bridge heartbeat: every few minutes (and on every visibility
  // change), the bridge asks the engine to re-emit chain:reschedule so
  // the OS-side AlarmManager queue stays fresh. Defends against the long
  // tail of "alarms silently lost" scenarios — force-stop, OEM kill,
  // OS Doze coalescing the inexact-alarm fallback.
  window.addEventListener('chained:nudgereschedule', () => {
    if (Engine.isRunning) Engine._emitChainEvent('chain:reschedule');
  });

  // Native bridge ↔ web bridge: surface native errors as in-app toasts,
  // and re-render Settings when the native status changes.
  window.addEventListener('chained:toast', (e) => {
    Toast.show(e.detail?.message || '', e.detail?.kind || '');
  });
  window.addEventListener('chained:nativestatus', () => {
    if (!document.getElementById('settings-sheet')?.hidden) UI.openSettings();
  });

  // Global Escape — close the topmost open sheet (settings, picker, duration,
  // actions, or the iOS notice). Keyboard users get an obvious dismissal path.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const openSheets = ['actions-sheet', 'duration-sheet', 'picker-sheet', 'settings-sheet']
      .map(id => document.getElementById(id))
      .filter(el => el && !el.hidden);
    if (openSheets.length) {
      openSheets[0].hidden = true;
      e.preventDefault();
      return;
    }
    const ios = document.getElementById('ios-notice');
    if (ios && !ios.hidden) {
      document.getElementById('ios-notice-close')?.click();
      e.preventDefault();
    }
  });

  // initial render
  View.show('library');

  // Restore any in-flight chain from a prior session (WebView kill, OOM,
  // app force-stop, OS reboot…). The engine is wall-clock based, so it
  // walks past any segments that elapsed while the app was gone. Done
  // after View.show('library') so a successful restore lands us straight
  // in the run view with the correct segment.
  if (Engine.restoreIfActive()) {
    View.show('run');
    UI.updateRunSegmentInfo();
  }

  // Show install hint after 30s if installable AND not running natively
  setTimeout(() => {
    if (!window.ChainedNative?.isNative) UI.showInstallHint();
  }, 30000);
}

document.addEventListener('DOMContentLoaded', init);

})();
