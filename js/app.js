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
  // Audio routing when a headset is connected:
  //   'headset' (default) — audio plays only on the headset; speaker stays silent
  //   'both'              — audio plays on speaker + headset (alarm-clock style)
  //   'speaker'           — audio plays only on the speaker
  // When no headset is connected all three behave the same (speaker).
  // Currently honored by the FGS voice MediaPlayer; chime/finalThree/finale
  // still route via USAGE_ALARM (system policy = both speakers) because
  // SoundPool has no per-play setPreferredDevice. Native-platform only —
  // browsers route through the system default output, which is what the
  // OS chose when the user plugged in.
  audioRoute: 'headset',
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
    // v1.4 — defend against orphan EngineRuns. If the deleted chain is
    // running, stop the run first so it doesn't keep ticking against a
    // chain that no longer exists in the library. typeof check guards
    // module-load order (Store is defined before Engine).
    if (typeof Engine !== 'undefined' && Engine?.isChainRunning?.(id)) {
      Engine.stopRun(id);
    }
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
        const expanded = {
          name: seg.name || 'Segment',
          duration: Math.max(1, seg.duration | 0),
          color: seg.color || rootChain.color || 'amber',
          path: [`${rootChain.name}${loops > 1 ? ` · ${loop+1}/${loops}` : ''}`],
        };
        // Propagate per-segment cue overrides through expansion so the
        // engine resolver can see them. Both the v1.3.5 `seg.cues` shape
        // and the legacy v1.3.4 `seg.voice = false` (the only field that
        // ever shipped) are forwarded; readSegCue() reads either side.
        if (seg.cues) expanded.cues = { ...seg.cues };
        if (seg.voice === false) expanded.voice = false;
        out.push(expanded);
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

  // 3-2-1 countdown — three 660Hz square pulses scheduled in ONE call
  // via the Web Audio scheduler at the precise audio-clock moments
  // t+0.000, t+1.000, t+2.000. Before v1.3.4 these fired as three
  // separate Audio.tick() calls from the engine's rAF loop, with the
  // spacing depending on whichever rAF frame happened to cross each
  // Math.ceil boundary — and the user reported the spacing felt
  // irregular. Scheduling all three at once moves the timing guarantee
  // out of the JS event loop and into the audio thread, which plays
  // them gap-free at sample-rate precision (same approach as concatenated
  // final3.wav in the native FGS path). Total scheduled length ~2.08s.
  finalThree() {
    this.ensure();
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      const t   = t0 + i;
      const osc = this.ctx.createOscillator();
      const g   = this.ctx.createGain();
      osc.type  = 'square';
      osc.frequency.setValueAtTime(660, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      osc.connect(g).connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + 0.13);
    }
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
  // On Android (Capacitor), the JS engine pauses the moment the user
  // backgrounds the app, so window.speechSynthesis / Voice.speak()
  // never fire at segment boundaries. We pre-render every segment
  // name to a WAV via the ChainTimer plugin BEFORE the chain starts,
  // hand the file paths to the FGS, and let the service play the
  // right file via MediaPlayer at each boundary — runs whether the
  // WebView is alive or asleep, and has zero TTS latency because the
  // audio is already on disk. On non-native (web/PWA) we still use
  // window.speechSynthesis as the synth pathway.
  _chainTimer() {
    return window.Capacitor?.Plugins?.ChainTimer || null;
  },

  // True when voice cues CAN actually fire on this platform. On native
  // the FGS-via-pre-rendered-files path needs the ChainTimer plugin AND
  // the (separate) TextToSpeech plugin used by prerenderVoices. On web
  // we just need window.speechSynthesis.
  supported() {
    if (window.ChainedNative?.isNative) {
      return !!this._chainTimer();
    }
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  },

  // Fire-and-forget speak. On native this is a NO-OP — the FGS service
  // owns voice playback (it has the pre-rendered files and fires them
  // at boundaries autonomously). Letting JS also speak via the plugin
  // would double-speak in foreground. On web (no FGS), this still
  // routes through window.speechSynthesis.
  speak(text) {
    if (!text) return;
    if (window.ChainedNative?.isNative) return;
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

  // Cached pre-rendered voice paths for the most recent chain. Keyed by
  // a stable signature of (chain id + segment name list) so a chain
  // can be re-run without re-rendering. Paths point at files in the
  // app's cache dir; Android may evict them under storage pressure,
  // in which case prerenderForChain will repopulate on next start.
  // v1.4 — per-chain cache (Map keyed by chain id) so concurrent runs
  // don't trash each other's path arrays. Legacy _lastChainKey /
  // _lastChainPaths still exposed as getters for testability hooks.
  _chainPaths: new Map(),
  _chainKeys:  new Map(),
  get _lastChainKey()   { return this._chainKeys.size ? [...this._chainKeys.values()].pop() : null; },
  get _lastChainPaths() { return this._chainPaths.size ? [...this._chainPaths.values()].pop() : []; },

  // Synthesize every segment name to a WAV file ON NATIVE, return the
  // parallel array of paths (one per segment). On non-native this is
  // a no-op — Web Speech can't pre-render to an addressable URL and
  // window.speechSynthesis.speak() is already low-latency enough.
  async prerenderForChain(segments, chainId) {
    if (!window.ChainedNative?.isNative) return [];
    const ct = this._chainTimer();
    if (!ct) return [];
    const texts = segments.map(s => s?.name || 'Segment');
    const key   = texts.join('');
    const id    = chainId || '__default__';
    if (this._chainKeys.get(id) === key && this._chainPaths.get(id)?.length === texts.length) {
      return this._chainPaths.get(id);
    }
    try {
      const result = await ct.prerenderVoices({ texts });
      const paths = Array.isArray(result?.paths) ? result.paths : [];
      this._chainKeys.set(id, key);
      this._chainPaths.set(id, paths);
      return paths;
    } catch (e) {
      return [];
    }
  },

  // First-call warm-up. Browsers (especially Chrome) load the voice
  // list ASYNCHRONOUSLY after first access; the platform TTS engine
  // also incurs a cold-start delay on its first synth. Both are
  // primed here so the very first real speak() (typically at the
  // boundary between segment 1 and segment 2) is instant.
  _warmed: false,
  warmup() {
    if (this._warmed) return;
    this._warmed = true;
    // Native voice playback is now via pre-rendered files (FGS +
    // MediaPlayer) — no warmup needed here. Warm-up only matters for
    // the web/PWA Web Speech path, which is high-latency on first call
    // because Chromium loads the voice list asynchronously.
    if (window.ChainedNative?.isNative) return;
    if (!('speechSynthesis' in window)) return;
    try {
      const voices = window.speechSynthesis.getVoices();
      if (!voices || voices.length === 0) {
        window.speechSynthesis.addEventListener('voiceschanged', () => { /* now ready */ }, { once: true });
      }
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      u.rate   = 10;
      window.speechSynthesis.speak(u);
      window.speechSynthesis.cancel();
    } catch (e) { /* noop */ }
  },

  // Per-chain re-warm. No-op on native (FGS owns playback; pre-render
  // happens via prerenderForChain). On web, kick the Web Speech engine
  // back to life — it can cool off during long idle stretches.
  warmupForChain(/* segments */) {
    if (window.ChainedNative?.isNative) return;
    if (!('speechSynthesis' in window)) return;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      u.rate   = 10;
      window.speechSynthesis.speak(u);
      window.speechSynthesis.cancel();
    } catch (e) { /* noop */ }
  },
};

// Boot-time TTS warmup. Idempotent.
if (typeof window !== 'undefined') {
  // Defer one tick so we don't compete with the app's initial paint.
  setTimeout(() => Voice.warmup(), 0);
}

// ============================================================
// Vibration helpers
// ============================================================

const Vibe = {
  do(pattern) {
    if (!('vibrate' in navigator)) return;
    try { navigator.vibrate(pattern); } catch {}
  },
  segmentEnd() { this.do([60, 60, 60, 60, 200]); },
  // Three 40ms pulses at exact 1-second offsets, matching Audio.finalThree.
  // Pattern: 40ms ON / 960ms OFF / 40ms ON / 960ms OFF / 40ms ON.
  finalTick()  { this.do([40, 960, 40, 960, 40]); },
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
// Cue overrides — 3-level inheritance (app default → chain → segment)
// ============================================================
//
// Five user-facing cues can be overridden: sound, finalTick, voice,
// vibrate, prestart. Segment level supports the first four (prestart
// is meaningless on a single segment — it only fires once at chain
// start). Each level stores its overrides under a `cues` object whose
// keys are tri-state:
//
//   undefined  → inherit from the next level up (or the app default)
//   true       → explicit ON, regardless of inherited value
//   false      → explicit OFF, regardless of inherited value
//
// Resolution walks segment.cues → chain.cues → Store.getSettings().
// Stored explicitly only when the user has flipped away from the
// inherited value, so unmodified chains/segments serialize cleanly
// without dragging along default-redundant cue objects. The legacy
// seg.voice field (v1.3.4) is migrated lazily by readSegCue below so
// users upgrading from v1.3.4 keep their silenced segments silent.
const CUE_KEYS = ['sound', 'finalTick', 'voice', 'vibrate', 'prestart'];
const SEGMENT_CUE_KEYS = ['sound', 'finalTick', 'voice', 'vibrate'];

function readSegCue(seg, key) {
  if (!seg) return undefined;
  // Forward path: new shape.
  if (seg.cues && key in seg.cues) return seg.cues[key];
  // Backward-compat: v1.3.4 stored a top-level seg.voice = false.
  if (key === 'voice' && seg.voice === false) return false;
  return undefined;
}

function readChainCue(chain, key) {
  return chain?.cues?.[key];
}

// Public resolver. Walks segment → chain → app default. Returns a
// concrete boolean — never undefined — so callsites can `if (cue)`
// without extra guards.
function effectiveCue(seg, chain, key) {
  const s = readSegCue(seg, key);
  if (s != null) return !!s;
  const c = readChainCue(chain, key);
  if (c != null) return !!c;
  const settings = Store.getSettings();
  return !!settings[key];
}

// Inherited value at a given level. Used by the chain + segment cue
// sheets to render the "Default (On/Off)" pill so the user can see what
// they'd be inheriting before they tap On/Off.
function inheritedCue(level, chain, key) {
  if (level === 'chain') {
    return !!Store.getSettings()[key];
  }
  if (level === 'segment') {
    const c = readChainCue(chain, key);
    if (c != null) return !!c;
    return !!Store.getSettings()[key];
  }
  return !!Store.getSettings()[key];
}

// Setter — writes only when the user actually overrides, deletes the key
// when they reset to "inherit." Keeps stored JSON minimal.
function setCueOverride(holder, key, value) {
  if (value == null) {
    if (holder.cues) {
      delete holder.cues[key];
      if (Object.keys(holder.cues).length === 0) delete holder.cues;
    }
    return;
  }
  if (!holder.cues) holder.cues = {};
  holder.cues[key] = !!value;
}

// ============================================================
// Timer Engine — multi-run capable
// ============================================================
//
// v1.4 — the engine supports up to 2 concurrent chain runs. Each
// active chain has its own EngineRun instance with independent state
// (currentIndex, segmentStartedAtWall, paused state, rAF loop,
// persistence key). The Engine coordinator keeps the focused run's
// state surfaced under the old singleton API (Engine.chain, .segments,
// .isRunning, .pause(), .skipNext(), …) so all existing single-chain
// callsites continue to work without modification. When 2 chains are
// running, UI calls Engine.focus(chainId) to swap which run the
// coordinator's fields point at; the chip strip in the run view drives
// this on tap.
//
// Why 2 (not N): the user constraint is "no more than 2." Capping at 2
// keeps the UX surface manageable (one chip strip, one focused timer,
// trivial promotion logic when the primary ends) and the audio mixing
// honest (Android can mix unlimited USAGE_ALARM streams but two
// simultaneous cues is the realistic upper bound).
//
// All elapsed-time math is wall-clock (Date.now) because the Capacitor
// Android WebView pauses JS timers + frame callbacks (and may freeze
// performance.now) when the activity is backgrounded or the screen
// locks. Wall-clock is the only source that keeps ticking across freezes,
// so the engine can correctly catch up multiple segments when the user
// returns to the app. performance.now is used only for the rAF cadence.

const MAX_CONCURRENT_RUNS = 2;
const RUN_PERSIST_PREFIX  = 'chained-timers/run/v2/';
const RUN_PERSIST_LEGACY  = 'chained-timers/run/v1';  // single-run v1.3.x snapshot

// A single chain's runtime state. Instantiated by Engine when a chain
// is started; lives until the user stops it or it completes naturally.
// All previously singleton-scoped Engine fields and methods live here.
class EngineRun {
  constructor(chain) {
    this.id           = chain.id;
    this.chain        = chain;
    this.segments     = expandChain(chain);
    this.currentIndex = 0;
    this.segmentStartedAtWall = 0;
    this.pausedAtWall = 0;
    this.pausedDuration = 0;
    this.isRunning = false;
    this.isPaused  = false;
    this.rafId     = null;
    this.totalElapsed = 0;
    this.finalThreeFiredFor = -1;
    this.warningOn = false;
  }

  // ---- bridge helpers ----------------------------------------
  // Fire UI callbacks ONLY when this run is the focused one (the only
  // one drawing the big timer). Background runs still tick autonomously
  // but their state surfaces via the chip strip + native notification,
  // not the big clock — so onTick / onSegmentChange must be silent for
  // them. onComplete fires regardless (a finished background run wants
  // to be cleaned up + announced; the run view promotes another run if
  // possible or returns to the library).
  _isFocused() { return Engine._focusedId === this.id; }
  _cbTick(seg, remaining, elapsed) {
    if (this._isFocused() && typeof Engine.onTick === 'function') {
      Engine.onTick(seg, remaining, elapsed);
    }
  }
  _cbSegmentChange() {
    if (this._isFocused() && typeof Engine.onSegmentChange === 'function') {
      Engine.onSegmentChange();
    }
  }
  _cbComplete(totalSeconds, reason) {
    // Always notify the coordinator so it can promote / clean up. The
    // coordinator itself decides whether to surface a "Well done."
    // overlay (only for the focused run AND only when the user was
    // actually present — catchup-completions stay silent so the overlay
    // doesn't flash on the next chain run).
    Engine._onRunComplete(this, totalSeconds, reason);
  }

  // ---- public lifecycle --------------------------------------
  start(opts = {}) {
    if (!this.segments.length) return false;
    this.currentIndex = 0;
    this.totalElapsed = 0;
    this.pausedDuration = 0;
    this.isRunning = true;
    this.isPaused = false;
    const now = opts.startedAt || Date.now();
    this.segmentStartedAtWall = now;
    this.pausedAtWall = now;
    this.finalThreeFiredFor = -1;
    this.warningOn = false;

    // Chain-start sound/vibration are CHAIN-level events (no segment is
    // "the one being celebrated"), so they resolve through chain.cues
    // and app defaults — segment overrides don't apply. Audio.unlock() is
    // unconditional because the user gesture window closes after this
    // function returns; locking it behind a cue gate would silently break
    // sound on iOS for users who later flip the setting on.
    //
    // Suppress in-app chain-start cues for background runs (this isn't the
    // run the user is watching, and double-chiming when starting 2 chains
    // at the same time would be noisy). The synced bulk-start path passes
    // suppressInAppStart=true for the second-and-later runs.
    if (!opts.suppressInAppStart) {
      Audio.unlock();
      if (effectiveCue(null, this.chain, 'sound'))   Audio.start();
      if (effectiveCue(null, this.chain, 'vibrate')) Vibe.start();
    } else {
      Audio.unlock();
    }
    // Warm-up only if at least one segment is going to speak.
    const willAnyVoiceFire = this.segments.some(s => effectiveCue(s, this.chain, 'voice'));
    if (willAnyVoiceFire && !opts.suppressInAppStart) Voice.warmupForChain(this.segments);
    if (Store.getSettings().wake) Wake.acquire();
    if (!opts.suppressInAppStart && this.segments[0] && effectiveCue(this.segments[0], this.chain, 'voice')) {
      Voice.speak(this.segments[0].name);
    }

    // Pre-render every segment's voice — see the v1.3.6 comment block
    // in Voice.prerenderForChain for the rationale.
    if (window.ChainedNative?.isNative && willAnyVoiceFire) {
      Voice.prerenderForChain(this.segments, this.id).then(() => {
        if (this.isRunning) this._emit('chain:fgsupdate');
      });
    }

    this._persist();
    this._emit('chain:start');

    this._loop();
    this._cbSegmentChange();
    return true;
  }

  // Emit a lifecycle event so the native shell (js/native.js) can drive
  // the FGS / OS-fallback alarm queue. Detail now carries runId so the
  // bridge can route per-run.
  //
  // segmentStartedAtMs is an "effective" wall-clock time: if the segment
  // had been running continuously without pauses, this is when it would
  // have started. So fireAt = segmentStartedAtMs + segment.duration is
  // always the correct wall-clock fire moment for the *current* segment.
  _emit(name) {
    try {
      const segmentStartedAtMs = this.segmentStartedAtWall + this.pausedDuration;
      const pausedAtMs = this.isPaused ? this.pausedAtWall : 0;
      const curSeg = this.segments[this.currentIndex] || null;
      const soundEnabled = effectiveCue(curSeg, this.chain, 'sound');
      const tickEnabled  = soundEnabled && effectiveCue(curSeg, this.chain, 'finalTick');
      const voicePaths = (window.ChainedNative?.isNative
        && Voice._chainPaths.get(this.id)?.length === this.segments.length)
        ? Voice._chainPaths.get(this.id)
        : null;
      const voiceEnabled = this.segments.map(s => effectiveCue(s, this.chain, 'voice'));
      const audioRoute = Store.getSettings().audioRoute || 'headset';
      window.dispatchEvent(new CustomEvent(name, {
        detail: {
          runId: this.id,
          // isFocused was used by the v1.4.0 single-FGS bridge filter;
          // v1.4.1's per-run native renders it dead. Keeping it absent
          // so no future code accidentally branches on it.
          name: this.chain?.name,
          segments: this.segments.map(s => ({ name: s.name, duration: s.duration, color: s.color })),
          currentIndex: this.currentIndex,
          segmentStartedAtMs,
          pausedAtMs,
          isPaused: this.isPaused,
          tickEnabled,
          soundEnabled,
          voicePaths,
          voiceEnabled,
          audioRoute,
        },
      }));
    } catch {}
  }

  _elapsedMs() {
    const ref = this.isPaused ? this.pausedAtWall : Date.now();
    return Math.max(0, ref - this.segmentStartedAtWall - this.pausedDuration);
  }

  // Walk forward through any segments whose wall-clock duration has
  // already elapsed. Same semantics as the v1.3.x singleton, just
  // operating on `this` instead of the global Engine.
  _catchup(opts = {}) {
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
    if (!opts.silent && advanced && this.isRunning) {
      this._emit('chain:fgsupdate');
    }
    return advanced;
  }

  _loop() {
    cancelAnimationFrame(this.rafId);
    const tick = () => {
      if (!this.isRunning) return;

      const seg = this.segments[this.currentIndex];
      if (!seg) { this._complete(); return; }

      const elapsedMs = this._elapsedMs();

      // Multi-boundary catch-up — same logic as the singleton path.
      if (!this.isPaused && elapsedMs >= seg.duration * 1000) {
        const nextSeg = this.segments[this.currentIndex + 1];
        const overshootMs = elapsedMs - seg.duration * 1000;
        const multipleBoundariesPast = nextSeg && overshootMs >= nextSeg.duration * 1000;
        if (multipleBoundariesPast && this._catchup()) {
          this._cbSegmentChange();
          return;
        }
      }

      const remainingSec = Math.max(0, seg.duration - elapsedMs / 1000);
      const remainingInt = Math.ceil(remainingSec);

      // Final-3-second burst — only when focused, AND when not paused.
      // Background runs intentionally don't fire the in-app burst (the
      // FGS plays final3.wav from the service even when the WebView is
      // backgrounded, so the user still hears the cue; firing here for
      // a background run would either be redundant in foreground or
      // silent in background — net zero benefit, net possible doubling).
      if (!this.isPaused && this._isFocused() && effectiveCue(seg, this.chain, 'finalTick')) {
        if (remainingInt <= 3 && remainingInt >= 1 && this.finalThreeFiredFor !== this.currentIndex) {
          this.finalThreeFiredFor = this.currentIndex;
          if (effectiveCue(seg, this.chain, 'sound'))   Audio.finalThree();
          if (effectiveCue(seg, this.chain, 'vibrate')) Vibe.finalTick();
        }
      }

      // Warning state for last 5 seconds — only on the focused run (the
      // background run isn't drawing the ring, no point colouring it).
      const shouldWarn = remainingInt <= 5 && !this.isPaused && remainingInt > 0;
      if (this._isFocused() && shouldWarn !== this.warningOn) {
        this.warningOn = shouldWarn;
        document.querySelector('.view-run')?.classList.toggle('is-warning', shouldWarn);
      }

      this._cbTick(seg, remainingSec, elapsedMs / 1000);

      // v1.4 — keep chip clocks live for background runs. Throttled
      // to integer-second changes (the chip shows whole seconds via
      // Math.ceil) so we don't DOM-thrash 60× per second. Single-chain
      // case short-circuits inside _updateRunChipClocks anyway because
      // the chip strip is hidden.
      if (!this._isFocused() && typeof UI !== 'undefined' && UI?._updateRunChipClocks) {
        const secNow = (Math.ceil(remainingSec) | 0);
        if (this._lastChipSec !== secNow) {
          this._lastChipSec = secNow;
          UI._updateRunChipClocks();
        }
      }

      if (remainingSec <= 0 && !this.isPaused) {
        this._advance('auto');
        return;
      }

      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  _advance(reason = 'auto') {
    const seg = this.segments[this.currentIndex];
    const segDurMs = (seg?.duration || 0) * 1000;
    this.totalElapsed += segDurMs;

    const now = Date.now();
    const nextStartWall = (reason === 'skip')
      ? now
      : (this.segmentStartedAtWall + this.pausedDuration + segDurMs);

    this.currentIndex++;

    if (this.currentIndex >= this.segments.length) {
      this._complete(reason);
      return;
    }

    // Cue ownership rules are unchanged from the singleton path.
    // In-app chime / vibe / voice only fire if this run is the focused
    // one — same reason as final-3: background runs lean on the FGS for
    // audible cues to avoid double-firing when foreground.
    const isUserSkip = reason === 'skip';
    if (reason !== 'catchup' && this._isFocused()) {
      const nextSeg = this.segments[this.currentIndex];
      if (!isUserSkip && effectiveCue(seg,     this.chain, 'sound'))   Audio.chime();
      if (!isUserSkip && effectiveCue(seg,     this.chain, 'vibrate')) Vibe.segmentEnd();
      if (nextSeg && effectiveCue(nextSeg, this.chain, 'voice')) Voice.speak(nextSeg.name);
      if (!isUserSkip && nextSeg) {
        Notif.show(`Next: ${nextSeg.name}`, `${fmtLong(nextSeg.duration)} · ${this.currentIndex + 1} of ${this.segments.length}`);
      }
    }

    this.segmentStartedAtWall = nextStartWall;
    this.pausedAtWall = now;
    this.pausedDuration = 0;
    this.finalThreeFiredFor = -1;
    this.warningOn = false;
    if (this._isFocused()) {
      document.querySelector('.view-run')?.classList.remove('is-warning');
    }

    this._persist();
    this._cbSegmentChange();
    this._loop();
    if (reason === 'skip')      this._emit('chain:reschedule');
    else if (reason === 'auto') this._emit('chain:fgsupdate');
  }

  pause() {
    if (!this.isRunning || this.isPaused) return;
    this._catchup({ silent: true });
    if (!this.isRunning) return;
    this.isPaused = true;
    this.pausedAtWall = Date.now();
    if (this._isFocused()) {
      document.querySelector('.view-run')?.classList.add('is-paused');
      document.querySelector('.view-run')?.classList.remove('is-warning');
    }
    // Only release the wake lock when NO run is still actively
    // counting down. activeRunningCount() includes paused-but-running
    // runs (isRunning stays true while isPaused flips), so for a
    // single-chain user pressing pause we'd otherwise hold the screen
    // awake throughout the pause (v1.3.x released it). Filter to
    // !isPaused so single-chain pause behaves as it did before.
    const anyTicking = [...Engine._runs.values()].some(r => r.isRunning && !r.isPaused && r !== this);
    if (!anyTicking) Wake.release();
    cancelAnimationFrame(this.rafId);
    const seg = this.segments[this.currentIndex];
    if (seg) {
      const elapsedSec = this._elapsedMs() / 1000;
      const remainingSec = Math.max(0, seg.duration - elapsedSec);
      this._cbTick(seg, remainingSec, elapsedSec);
    }
    this._persist();
    this._emit('chain:reschedule');
  }

  resume() {
    if (!this.isRunning || !this.isPaused) return;
    this.pausedDuration += Date.now() - this.pausedAtWall;
    this.isPaused = false;
    if (this._isFocused()) {
      document.querySelector('.view-run')?.classList.remove('is-paused');
    }
    if (Store.getSettings().wake) Wake.acquire();
    this._persist();
    this._loop();
    this._emit('chain:reschedule');
  }

  toggle() { if (this.isPaused) this.resume(); else this.pause(); }

  skipNext() {
    if (!this.isRunning) return;
    if (!this.isPaused) this._catchup({ silent: true });
    if (!this.isRunning) return;
    this._advance('skip');
  }

  skipPrev() {
    if (!this.isRunning) return;
    if (!this.isPaused) this._catchup({ silent: true });
    if (!this.isRunning) return;
    const restartCurrent = () => {
      const now = Date.now();
      this.segmentStartedAtWall = now;
      this.pausedAtWall = now;
      this.pausedDuration = 0;
      this.finalThreeFiredFor = -1;
    };
    if (this.currentIndex === 0) {
      restartCurrent();
      this._persist();
      this._cbSegmentChange();
      this._emit('chain:reschedule');
      return;
    }
    if (this._elapsedMs() > 2500) {
      restartCurrent();
    } else {
      this.currentIndex--;
      const prevSeg = this.segments[this.currentIndex];
      this.totalElapsed = Math.max(0, this.totalElapsed - (prevSeg?.duration || 0) * 1000);
      restartCurrent();
    }
    this._persist();
    this._cbSegmentChange();
    this._emit('chain:reschedule');
  }

  stop(opts = {}) {
    this.isRunning = false;
    this.isPaused = false;
    cancelAnimationFrame(this.rafId);
    if (this._isFocused()) {
      document.querySelector('.view-run')?.classList.remove('is-warning', 'is-paused');
    }
    // Same active-ticking check as in pause() — release the wake lock
    // when no run is actually counting down. A paused-but-running run
    // shouldn't keep the screen awake; v1.3.x semantics.
    const anyTicking = [...Engine._runs.values()].some(r => r.isRunning && !r.isPaused && r !== this);
    if (!anyTicking) {
      Wake.release();
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    }
    if (!opts.preserveNotifications) {
      // v1.4.1 — bridge is per-run now; only this run's slot tears down.
      window.dispatchEvent(new CustomEvent('chain:cancel', {
        detail: { runId: this.id },
      }));
    }
    this._clearPersist();
  }

  _complete(reason = 'auto') {
    const total = this.segments.reduce((s, x) => s + x.duration, 0);
    this.stop({ preserveNotifications: true });
    window.dispatchEvent(new CustomEvent('chain:complete', {
      detail: {
        runId: this.id,
        name: this.chain?.name,
        segments: this.segments.map(s => ({ name: s.name, duration: s.duration, color: s.color })),
        currentIndex: this.segments.length - 1,
        totalSeconds: total,
      },
    }));
    const lastSeg = this.segments[this.segments.length - 1];
    if (reason !== 'catchup' && this._isFocused()) {
      if (effectiveCue(lastSeg, this.chain, 'sound'))   Audio.finale();
      if (effectiveCue(lastSeg, this.chain, 'vibrate')) Vibe.finale();
      Notif.show(`${this.chain.name} complete`, `${fmtLong(total)} · ${this.segments.length} segments`);
    }
    this._cbComplete(total, reason);
  }

  totalRemaining() {
    if (!this.segments.length) return 0;
    const cur = this.segments[this.currentIndex];
    if (!cur) return 0;
    let r = Math.max(0, cur.duration - this._elapsedMs() / 1000);
    for (let i = this.currentIndex + 1; i < this.segments.length; i++) {
      r += this.segments[i].duration;
    }
    return r;
  }

  // ---- per-run persistence ------------------------------------
  _persistKey() { return RUN_PERSIST_PREFIX + this.id; }

  _persist() {
    try {
      if (!this.isRunning || !this.chain) {
        localStorage.removeItem(this._persistKey());
        return;
      }
      const snap = {
        v: 2,
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
      localStorage.setItem(this._persistKey(), JSON.stringify(snap));
    } catch {}
  }

  _clearPersist() {
    try { localStorage.removeItem(this._persistKey()); } catch {}
  }
}

// Coordinator. Tracks active EngineRuns + focused id. Exposes the old
// Engine singleton API (chain, segments, isRunning, pause(), ...) for
// the focused run so existing UI code works untouched.
const Engine = {
  _runs: new Map(),       // chainId → EngineRun
  _focusedId: null,

  // UI callbacks (set by app init). Fire only for the focused run.
  onTick: null,
  onSegmentChange: null,
  onComplete: null,
  // Fires whenever the set of active runs changes (start, stop, complete,
  // focus change). The UI uses this to update the chip strip.
  onRunsChange: null,

  // ---- backward-compat surface (focused run's fields/methods) -----
  get _focused() { return this._focusedId ? this._runs.get(this._focusedId) : null; },
  get chain()        { return this._focused?.chain || null; },
  set chain(v)       { if (this._focused) this._focused.chain = v; },
  get segments()     { return this._focused?.segments || []; },
  set segments(v)    { if (this._focused) this._focused.segments = v; },
  get currentIndex() { return this._focused?.currentIndex ?? 0; },
  set currentIndex(v){ if (this._focused) this._focused.currentIndex = v; },
  get isRunning()    { return this._focused?.isRunning || false; },
  get isPaused()     { return this._focused?.isPaused  || false; },
  get totalElapsed() { return this._focused?.totalElapsed || 0; },
  set totalElapsed(v){ if (this._focused) this._focused.totalElapsed = v; },

  // ---- multi-run accessors ------------------------------------
  activeRuns()           { return [...this._runs.values()].filter(r => r.isRunning); },
  activeRunningCount()   { return this.activeRuns().length; },
  runById(id)            { return this._runs.get(id) || null; },
  isChainRunning(id)     { return !!this._runs.get(id)?.isRunning; },
  focusedRunId()         { return this._focusedId; },

  // Switch which run is the "primary" for the run view. Returns true
  // if focus actually moved. Recomputes the UI's is-warning/is-paused
  // classes against the new focused run.
  focus(chainId) {
    if (!chainId || !this._runs.has(chainId)) return false;
    if (this._focusedId === chainId) return false;
    this._focusedId = chainId;
    const run = this._runs.get(chainId);
    const view = document.querySelector('.view-run');
    if (view) {
      view.classList.toggle('is-paused', !!run.isPaused);
      view.classList.toggle('is-warning', !!run.warningOn);
    }
    this._notifyRunsChange();
    // Re-render the run UI for the newly-focused run.
    if (typeof this.onSegmentChange === 'function') this.onSegmentChange();
    if (run.isRunning) {
      const seg = run.segments[run.currentIndex];
      if (seg && typeof this.onTick === 'function') {
        const elapsedSec = run._elapsedMs() / 1000;
        const remainingSec = Math.max(0, seg.duration - elapsedSec);
        this.onTick(seg, remainingSec, elapsedSec);
      }
    }
    // v1.4.1 — per-run native means the service already has up-to-date
    // state for every run; no need to re-emit on focus change. The
    // bridge state for both runs stays current via their independent
    // tick/advance events. Removed in v1.4.1 to avoid the redundant
    // ChainTimer.update round-trip.
    return true;
  },

  _notifyRunsChange() {
    if (typeof this.onRunsChange === 'function') {
      try { this.onRunsChange(); } catch {}
    }
  },

  // Start a single chain. The new run becomes focused unless caller
  // requests background placement (opts.focus === false). If the chain
  // is already running, re-focus instead of restarting.
  startChain(chain, opts = {}) {
    if (!chain) return false;
    const existing = this._runs.get(chain.id);
    if (existing && existing.isRunning) {
      if (opts.focus !== false) this.focus(chain.id);
      return true;
    }
    if (this.activeRunningCount() >= MAX_CONCURRENT_RUNS) {
      Toast.show(`${MAX_CONCURRENT_RUNS} chains already running — stop one to start another.`, 'warn');
      return false;
    }
    const run = new EngineRun(chain);
    if (!run.segments.length) {
      Toast.show('Chain has no segments', 'warn');
      return false;
    }
    this._runs.set(chain.id, run);
    if (opts.focus !== false || !this._focusedId) this._focusedId = chain.id;
    const ok = run.start(opts);
    if (!ok) {
      this._runs.delete(chain.id);
      if (this._focusedId === chain.id) this._focusedId = null;
      return false;
    }
    this._notifyRunsChange();
    return true;
  },

  // Synced bulk start — every chain begins at the same t=0. The first
  // chain in the array becomes focused. Used by long-press multi-select.
  // Caller passes resolved chain objects.
  startMany(chains) {
    chains = (chains || []).filter(Boolean);
    if (!chains.length) return false;
    // Already-running chains are silently skipped — startChain would
    // refocus them, breaking the synced-t=0 contract. If the caller
    // selected only already-running chains, focus the first one.
    const alreadyRunning = chains.filter(c => this.isChainRunning(c.id));
    let fresh = chains.filter(c => !this.isChainRunning(c.id));
    if (alreadyRunning.length) {
      const names = alreadyRunning.map(c => c.name || 'a chain').join(', ');
      Toast.show(`${names} already running — skipped from synced start.`, 'warn');
    }
    if (!fresh.length) {
      if (chains[0]) this.focus(chains[0].id);
      return !!chains[0];
    }
    const remaining = MAX_CONCURRENT_RUNS - this.activeRunningCount();
    if (remaining <= 0) {
      Toast.show(`${MAX_CONCURRENT_RUNS} chains already running.`, 'warn');
      return false;
    }
    if (fresh.length > remaining) {
      Toast.show(`Up to ${MAX_CONCURRENT_RUNS} chains at once.`, 'warn');
      fresh = fresh.slice(0, remaining);
    }
    const startedAt = Date.now();
    let firstStarted = null;
    fresh.forEach((chain, i) => {
      const opts = {
        startedAt,
        focus: i === 0,
        suppressInAppStart: i > 0,
      };
      if (this.startChain(chain, opts) && !firstStarted) firstStarted = chain.id;
    });
    return !!firstStarted;
  },

  // ---- focused-run-targeted methods ------------------
  pause()    { this._focused?.pause(); },
  resume()   { this._focused?.resume(); },
  toggle()   { this._focused?.toggle(); },
  skipNext() { this._focused?.skipNext(); },
  skipPrev() { this._focused?.skipPrev(); },
  // Stop the focused run. UI's confirm dialog already fired (or wasn't
  // needed); just tear down here.
  stop()     { this._stopRun(this._focusedId); },
  // Stop a specific run by id (used by chip-strip long-press, or by
  // native notification action when there are multiple runs).
  stopRun(chainId) { this._stopRun(chainId); },

  totalRemaining() { return this._focused?.totalRemaining() || 0; },

  _stopRun(chainId) {
    const run = this._runs.get(chainId);
    if (!run) return;
    run.stop();
    this._runs.delete(chainId);
    if (this._focusedId === chainId) {
      const next = this.activeRuns()[0] || null;
      this._focusedId = next ? next.id : null;
      if (next) this._promoteToFocused(next);
    }
    this._notifyRunsChange();
  },

  // Shared post-promotion housekeeping: sync the run-view CSS flags,
  // re-fire onSegmentChange + onTick so the big clock immediately
  // reflects the promoted run's state (no one-frame stale text), and
  // re-emit chain:reschedule so the native bridge re-binds the FGS to
  // the newly-focused run.
  _promoteToFocused(next) {
    const view = document.querySelector('.view-run');
    if (view) {
      view.classList.toggle('is-paused', !!next.isPaused);
      view.classList.toggle('is-warning', !!next.warningOn);
    }
    if (typeof this.onSegmentChange === 'function') this.onSegmentChange();
    if (next.isRunning) {
      const seg = next.segments[next.currentIndex];
      if (seg) {
        const elapsedSec = next._elapsedMs() / 1000;
        const remainingSec = Math.max(0, seg.duration - elapsedSec);
        // Sync the warningOn flag against the run's current remaining so
        // the ring color is correct on the very first frame post-swap.
        next.warningOn = remainingSec <= 5 && remainingSec > 0 && !next.isPaused;
        if (view) view.classList.toggle('is-warning', !!next.warningOn);
        // If we're past the final-3 window, mark it fired so we don't
        // double-fire the burst on the next focused tick.
        if (remainingSec < 0.5) next.finalThreeFiredFor = next.currentIndex;
        if (typeof this.onTick === 'function') {
          this.onTick(seg, remainingSec, elapsedSec);
        }
      }
      // v1.4.1 — per-run native already tracks the survivor's slot
      // (it's been emitting ticks continuously). No re-emit needed
      // on promotion; the service handles FGS owner switching itself.
    }
  },

  // Called by an EngineRun when it naturally completes. `reason` is
  // forwarded from EngineRun._complete — 'catchup' completions stay
  // silent (the user was away; the "✓ Chain complete" notification has
  // already cued them) and don't flash the "Well done." overlay.
  _onRunComplete(run, totalSeconds, reason) {
    const wasFocused = this._focusedId === run.id;
    this._runs.delete(run.id);
    if (wasFocused) {
      const next = this.activeRuns()[0] || null;
      this._focusedId = next ? next.id : null;
      if (next) {
        this._promoteToFocused(next);
      } else if (reason !== 'catchup' && typeof this.onComplete === 'function') {
        // Last run finished; show the completion overlay for it.
        // Snapshot details from the completing run BEFORE the coordinator
        // tries to read Engine.segments — by this point the run is
        // already removed from _runs and Engine.segments resolves to []
        // (or the promoted run if there were 3, but the gate above
        // ensures there isn't a promoted run on this branch).
        this.onComplete(totalSeconds, run.segments.length);
      }
    }
    this._notifyRunsChange();
  },

  // ---- catchup orchestration (UI hooks) -------------------------
  // _catchup / _loop / _emitChainEvent are called from existing UI code
  // (visibilitychange, nudgereschedule). They fan out to every active
  // run so a backgrounded second chain ticks correctly on wake too.
  _catchup() { this._runs.forEach(r => r._catchup()); },
  _loop()    { this._runs.forEach(r => { if (r.isRunning && !r.isPaused) r._loop(); }); },
  _emitChainEvent(name) { this._runs.forEach(r => { if (r.isRunning) r._emit(name); }); },

  // ---- restore from persistence -------------------------
  // Walks the v2 per-run keys + migrates the legacy v1 single-run key.
  // Returns true if any run was restored to the running state.
  restoreIfActive() {
    const keys = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith(RUN_PERSIST_PREFIX) || k === RUN_PERSIST_LEGACY)) keys.push(k);
      }
    } catch {}
    // First pass: parse all snapshots so we can sort deterministically
    // before instantiation. localStorage.key() iteration order is
    // implementation-defined; sorting by savedAt ascending makes the
    // newest snapshot the last-added and (with our focus heuristic)
    // the focused run on cold start — deterministic across reloads.
    const snaps = [];
    for (const key of keys) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const snap = JSON.parse(raw);
        if (!snap || !Array.isArray(snap.segments) || !snap.segments.length) {
          localStorage.removeItem(key);
          continue;
        }
        const ageMs = Date.now() - (snap.savedAt || 0);
        if (ageMs > 24 * 3600 * 1000) { localStorage.removeItem(key); continue; }
        snaps.push({ key, snap });
      } catch {
        try { localStorage.removeItem(key); } catch {}
      }
    }
    // Sort oldest → newest. The last one in iteration order wins the
    // focus slot (set unconditionally below), giving consistent focus
    // on every cold start.
    snaps.sort((a, b) => (a.snap.savedAt || 0) - (b.snap.savedAt || 0));
    const restored = [];
    for (const { key, snap } of snaps) {
      try {
        const chain = Store.getChain(snap.chainId) || {
          id: snap.chainId,
          name: snap.chainName || 'Restored chain',
          segments: snap.segments,
        };
        const run = new EngineRun(chain);
        run.chain = chain;
        run.segments = snap.segments;
        run.currentIndex = snap.currentIndex | 0;
        run.segmentStartedAtWall = Number(snap.segmentStartedAtWall) || Date.now();
        run.pausedAtWall = Number(snap.pausedAtWall) || Date.now();
        run.pausedDuration = Number(snap.pausedDuration) || 0;
        run.isPaused = !!snap.isPaused;
        run.isRunning = true;
        run.totalElapsed = Number(snap.totalElapsed) || 0;
        run.finalThreeFiredFor = -1;
        run.warningOn = false;
        this._runs.set(chain.id, run);
        // Most-recently-saved wins the focus slot. With the sort above
        // this is deterministic (always the last one in iteration).
        this._focusedId = chain.id;
        restored.push(run);
        // Drop the legacy v1 key once read — next _persist writes v2.
        if (key === RUN_PERSIST_LEGACY) localStorage.removeItem(key);
      } catch {
        try { localStorage.removeItem(key); } catch {}
      }
    }
    if (!restored.length) return false;
    if (Store.getSettings().wake && restored.some(r => !r.isPaused)) Wake.acquire();
    for (const run of restored) {
      run._emit('chain:reschedule');
      if (!run.isPaused) run._catchup();
      if (!run.isPaused && run.isRunning) run._loop();
    }
    // Reap any runs that catchup-completed during restore.
    let focusedDied = false;
    for (const run of restored) {
      if (!run.isRunning) {
        this._runs.delete(run.id);
        if (this._focusedId === run.id) { this._focusedId = null; focusedDied = true; }
      }
    }
    if (!this._runs.size) return false;
    if (!this._focusedId) {
      const first = this.activeRuns()[0];
      if (first) this._focusedId = first.id;
    }
    // v1.4.1 — per-run native handles FGS promotion server-side; the
    // survivor's chain:reschedule already fired in the loop above.
    // No extra emit needed on focused-died.
    const focused = this._focused;
    if (focused) {
      const runView = document.querySelector('.view-run');
      if (runView) {
        runView.classList.toggle('is-paused', focused.isPaused);
        runView.classList.remove('is-warning');
      }
      const seg = focused.segments[focused.currentIndex];
      if (seg && typeof this.onTick === 'function') {
        const elapsedSec = focused._elapsedMs() / 1000;
        const remainingSec = Math.max(0, seg.duration - elapsedSec);
        this.onTick(seg, remainingSec, elapsedSec);
      }
    }
    this._notifyRunsChange();
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
      // voice: undefined → treated as ON. Stored explicitly only when the
      // user has toggled the per-segment speaker icon to OFF, so legacy
      // chains saved before this field existed keep their original
      // behaviour (announce names) automatically.
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
    // v1.4 — selection mode is library-only. Navigating away clears it
    // so a back-trip doesn't restore stale state.
    if (name !== 'library' && UI.selectMode) UI.exitSelectMode();
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

  // v1.4 multi-select mode. Activated by long-press on a chain row.
  // While active, the top bar swaps to "N selected" + Start, taps toggle
  // selection instead of opening the editor, and the play button on each
  // card is hidden. Tapping Start fires Engine.startMany() with the
  // currently-selected chain ids — a synced t=0 launch for up to 2
  // chains simultaneously.
  selectMode: false,
  selectedIds: new Set(),

  // Long-press timing — 500ms matches Android's default. Lower and
  // accidental long-presses become a paper cut.
  LONGPRESS_MS: 500,

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

      // Selection-mode tick badge (shown via CSS data-select-mode="true").
      const tick = document.createElement('div');
      tick.className = 'chain-card-select-tick';
      tick.setAttribute('aria-hidden', 'true');

      // Reflect already-running state so the user can tell at a glance.
      if (Engine.isChainRunning(chain.id)) li.classList.add('is-running');
      // Reflect selection state.
      if (UI.selectedIds.has(chain.id))    li.classList.add('is-selected');

      li.appendChild(stripe);
      li.appendChild(body);
      li.appendChild(play);
      li.appendChild(tick);
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

      // Tap behavior depends on mode + chain state:
      //
      //   selection mode → toggle this row's selection (any zone)
      //   already running → open run view focused on this chain
      //   default → open editor
      //
      // The body and stripe share the tap target. The play button is a
      // dedicated start affordance. In selection mode the play button is
      // hidden by CSS so the whole card is one big toggle.
      const onCardTap = () => {
        if (UI.selectMode) { UI.toggleSelected(chain.id); return; }
        if (Engine.isChainRunning(chain.id)) {
          Engine.focus(chain.id);
          View.show('run');
          return;
        }
        Editor.loadChain(chain.id);
        View.show('editor');
      };
      body.addEventListener('click',   onCardTap);
      stripe.addEventListener('click', onCardTap);
      tick.addEventListener('click',   onCardTap);
      play.addEventListener('click', e => {
        e.stopPropagation();
        if (UI.selectMode) { UI.toggleSelected(chain.id); return; }
        Audio.unlock();
        UI.startRunForChain(chain);
      });
      UI._wireLongPress(li, chain.id);
    });

    // Reflect the current select-mode + selection set into the topbars.
    UI._syncLibrarySelectionUI();
  },

  // Long-press enters selection mode and pre-selects this row.
  _wireLongPress(li, chainId) {
    let timer = null;
    let startX = 0, startY = 0;
    let triggered = false;
    const cancel = () => {
      if (timer) { clearTimeout(timer); timer = null; }
    };
    li.addEventListener('pointerdown', (e) => {
      // Only respond to primary button (not e.g. right-click on desktop)
      if (e.button !== undefined && e.button !== 0) return;
      triggered = false;
      startX = e.clientX; startY = e.clientY;
      timer = setTimeout(() => {
        triggered = true;
        timer = null;
        // If already in select mode, treat long-press as a toggle —
        // resetting the selection on every long-press surprises the user.
        if (UI.selectMode) UI.toggleSelected(chainId);
        else UI.enterSelectMode(chainId);
      }, UI.LONGPRESS_MS);
    });
    li.addEventListener('pointermove', (e) => {
      // Cancel on scroll/drag — 8px is the standard touch slop.
      if (!timer) return;
      const dx = Math.abs(e.clientX - startX), dy = Math.abs(e.clientY - startY);
      if (dx > 8 || dy > 8) cancel();
    });
    li.addEventListener('pointerup',     cancel);
    li.addEventListener('pointercancel', cancel);
    li.addEventListener('pointerleave',  cancel);
    // Swallow the synthetic click that follows a long-press so the
    // card's own onTap doesn't immediately undo what enter-select did.
    li.addEventListener('click', (e) => {
      if (triggered) { e.stopPropagation(); e.preventDefault(); triggered = false; }
    }, true);
  },

  enterSelectMode(chainId) {
    UI.selectMode = true;
    UI.selectedIds.clear();
    if (chainId) UI.selectedIds.add(chainId);
    UI._syncLibrarySelectionUI();
    UI._reflectRowSelection();
  },

  exitSelectMode() {
    UI.selectMode = false;
    UI.selectedIds.clear();
    UI._syncLibrarySelectionUI();
    UI._reflectRowSelection();
  },

  // Toggle a row's selection. Caps at MAX_CONCURRENT_RUNS — when the
  // user adds a 3rd, the OLDEST selection is evicted to make room.
  // Insertion order is preserved so the eviction is deterministic.
  toggleSelected(chainId) {
    if (UI.selectedIds.has(chainId)) {
      UI.selectedIds.delete(chainId);
      if (UI.selectedIds.size === 0) {
        // Empty selection auto-exits selection mode.
        UI.exitSelectMode();
        return;
      }
    } else {
      UI.selectedIds.add(chainId);
      while (UI.selectedIds.size > MAX_CONCURRENT_RUNS) {
        // Cap reached — drop the oldest entry to make room. Surface a
        // toast so the user understands why a previous selection
        // suddenly vanished from the row's checkmark.
        const oldest = UI.selectedIds.values().next().value;
        UI.selectedIds.delete(oldest);
        const oldChain = Store.getChain(oldest);
        Toast.show(`Up to ${MAX_CONCURRENT_RUNS} at once — dropped "${oldChain?.name || 'a chain'}".`, 'warn');
      }
    }
    UI._syncLibrarySelectionUI();
    UI._reflectRowSelection();
  },

  // Update the row .is-selected classes without re-rendering the list.
  _reflectRowSelection() {
    const list = document.getElementById('chain-list');
    if (!list) return;
    [...list.children].forEach(li => {
      const id = li.dataset.chainId;
      li.classList.toggle('is-selected', UI.selectedIds.has(id));
    });
  },

  // Mirror selectMode + count into the topbar and view attribute.
  _syncLibrarySelectionUI() {
    const view = document.querySelector('.view-library');
    if (view) view.dataset.selectMode = UI.selectMode ? 'true' : 'false';
    const defBar = document.getElementById('library-topbar-default');
    const selBar = document.getElementById('library-topbar-select');
    if (defBar && selBar) {
      defBar.hidden = UI.selectMode;
      selBar.hidden = !UI.selectMode;
    }
    if (UI.selectMode) {
      const n = UI.selectedIds.size;
      const countEl = document.getElementById('library-select-count');
      if (countEl) countEl.textContent = `${n} selected`;
      const startBtn = document.getElementById('library-select-start');
      if (startBtn) startBtn.disabled = (n === 0);
      const eyebrowEl = document.getElementById('library-select-eyebrow');
      if (eyebrowEl) {
        eyebrowEl.textContent = (n === MAX_CONCURRENT_RUNS)
          ? `Max ${MAX_CONCURRENT_RUNS} at once`
          : 'Select chains';
      }
    }
  },

  // Fire a synced t=0 start for every selected chain.
  startSelected() {
    if (!UI.selectedIds.size) return;
    const chains = [...UI.selectedIds].map(id => Store.getChain(id)).filter(Boolean);
    if (!chains.length) { UI.exitSelectMode(); return; }
    Audio.unlock();
    // Skip the prestart countdown for synced multi-start. Running a
    // 3-2-1 against 2 chains simultaneously would be confusing — the
    // intent of multi-start is "begin now."
    const ok = Engine.startMany(chains);
    UI.exitSelectMode();
    if (ok) View.show('run');
  },

  startRunForChain(chain) {
    if (!chain) return;
    // ALWAYS cancel any in-flight prestart first — defends against the
    // user double-tapping or starting chain B while chain A's prestart
    // is still counting down. Without this, the A-prestart interval
    // would keep ticking and eventually fire Engine.startChain(A) on
    // top of B.
    UI.cancelPrestart();
    const segments = expandChain(chain);
    if (!segments.length) { Toast.show('Chain has no segments', 'warn'); return; }
    // Already running? Just focus + navigate. No prestart, no duplicate
    // run. Matches the "tap a running chain → go to its run view"
    // contract from the v1.4 design conversation.
    if (Engine.isChainRunning(chain.id)) {
      Engine.focus(chain.id);
      View.show('run');
      return;
    }
    // Cap check. The same toast that fires from Engine.startChain when
    // the cap is hit, surfaced here too so the user gets feedback before
    // we even attempt the run.
    if (Engine.activeRunningCount() >= MAX_CONCURRENT_RUNS) {
      Toast.show(`${MAX_CONCURRENT_RUNS} chains already running — stop one to start another.`, 'warn');
      return;
    }
    // Prestart is a chain-level concept (no segment is running yet) — it
    // resolves against chain.cues then app defaults. Segments don't get
    // a prestart override on purpose: it makes no sense to "skip the
    // countdown only for segment 3."
    //
    // SKIP the prestart entirely when another chain is already running:
    // the 3-2-1 overlay would clobber the focused chain's clock display
    // for 3s and hide the chip strip, leaving the user no way back to
    // the running chain. Match the bulk-start (Engine.startMany) policy
    // — "begin now" is the right answer when joining an already-active
    // session. Single-chain users get the countdown as before.
    const hasOtherRunning = Engine.activeRunningCount() > 0;
    if (!hasOtherRunning && effectiveCue(null, chain, 'prestart')) {
      UI._renderRunForChain(chain, segments);
      View.show('run');
      UI.runPrestart(chain);
    } else {
      if (Engine.startChain(chain)) View.show('run');
    }
  },

  // Synthetic render of the run view from a chain that hasn't started
  // yet (used during the pre-start countdown). Mirrors the read-only
  // parts of updateRunSegmentInfo + updateRunClock without touching
  // Engine — there's no focused EngineRun yet.
  _renderRunForChain(chain, segmentsArg) {
    const segments = segmentsArg || expandChain(chain);
    if (!segments.length) return;
    const seg0 = segments[0];
    document.getElementById('run-chain-name').textContent  = chain.name || '—';
    document.getElementById('run-segment-name').textContent = seg0.name;
    document.getElementById('run-segment-tag').textContent  = 'Segment 1';
    document.getElementById('run-segment-of').textContent   = `of ${segments.length}`;
    document.getElementById('run-chain-pos').textContent    = `1 / ${segments.length}`;
    document.getElementById('run-clock').textContent        = fmt(seg0.duration);
    const ring = document.getElementById('run-ring-fill');
    ring.style.stroke = colorHex(seg0.color);
    document.getElementById('run-bg').style.background =
      `radial-gradient(ellipse 70% 50% at 50% 25%, ${colorHex(seg0.color)}28, transparent 65%)`;
    const strip = document.getElementById('run-chain-strip');
    strip.innerHTML = '';
    segments.forEach((s, i) => {
      const t = document.createElement('div');
      t.className = 'run-chain-strip-tick';
      if (i === 0) t.classList.add('is-active');
      t.style.flex = `${Math.max(1, Math.sqrt(s.duration))} 1 0`;
      strip.appendChild(t);
    });
    const nextSeg = segments[1];
    const nextWrap = document.getElementById('run-next');
    if (nextSeg) {
      nextWrap.style.visibility = 'visible';
      document.getElementById('run-next-name').textContent = nextSeg.name;
      document.getElementById('run-next-dur').textContent  = fmt(nextSeg.duration);
    } else {
      nextWrap.style.visibility = 'hidden';
    }
    // Reset progress fill / elapsed during the prestart preview.
    document.getElementById('run-progress-fill').style.width = '0%';
    const totalChain = segments.reduce((s, x) => s + x.duration, 0);
    document.getElementById('run-elapsed').textContent   = `00:00 elapsed`;
    document.getElementById('run-remaining').textContent = `${fmt(totalChain)} remaining`;
    // Hide chip strip during prestart (Engine has no runs yet to chip).
    const chips = document.getElementById('run-chips');
    if (chips) chips.hidden = true;
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
    // Prestart's own audible/vibration ticks resolve at chain level
    // (segment hasn't started yet), so they ride on chain.cues.sound /
    // chain.cues.vibrate. Captured once at countdown start — the user
    // can't realistically toggle settings mid-countdown.
    const sound   = effectiveCue(null, chain, 'sound');
    const vibrate = effectiveCue(null, chain, 'vibrate');
    if (sound)   Audio.prestart(false);
    if (vibrate) Vibe.do(50);
    UI.prestartIv = setInterval(() => {
      n--;
      if (n > 0) {
        num.textContent = n;
        if (sound)   Audio.prestart(n === 1);
        if (vibrate) Vibe.do(n === 1 ? 100 : 50);
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

    // v1.4 — lock the editor if THIS chain (or a chain with the same
    // id, in case Editor.draftId is the persisted id) is currently
    // running. Editing a live chain is unsafe: segment names ripple
    // through the FGS voice cache, segment durations would already be
    // mid-elapse, the chain expansion that drove the run is frozen in
    // memory. Show a stop-banner instead.
    const locked = !!(Editor.draftId && Engine.isChainRunning(Editor.draftId));
    const viewEd = document.querySelector('.view-editor');
    if (viewEd) viewEd.dataset.locked = locked ? 'true' : 'false';
    const banner = document.getElementById('editor-locked-banner');
    if (banner) banner.hidden = !locked;

    document.getElementById('editor-mode-label').textContent = Editor.draftId ? (locked ? 'Running' : 'Editing') : 'New';
    const nameInput = document.getElementById('editor-name');
    nameInput.value = draft.name;
    nameInput.disabled = locked;

    // Chain-level cue bell — dot indicator lights up when any chain-level
    // cue is explicitly overridden. Click opens the chain-scoped cue sheet.
    UI._syncChainCueBell();

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

    // Per-segment cue overrides — bell icon left of trash. Tap opens the
    // cue sheet (4 cues: sound, finalTick, voice, vibrate; prestart is
    // chain-only). The bell's accent dot lights up when at least one
    // cue at this scope is explicitly overridden, giving the user a
    // glance-readable "this segment differs from chain defaults" signal.
    const cuesBtn = document.createElement('button');
    cuesBtn.className = 'cue-bell segment-cues';
    cuesBtn.setAttribute('aria-label', 'Segment cue overrides');
    cuesBtn.setAttribute('title', 'Cue overrides');
    cuesBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2.5h-15L6 16z"/>
        <path d="M10 19a2 2 0 0 0 4 0"/>
        <path d="M12 3v2"/>
      </svg>
      <span class="cue-bell-dot" hidden></span>`;
    const refreshBellDot = () => {
      const has = !!(seg.cues && Object.keys(seg.cues).length) || seg.voice === false;
      cuesBtn.classList.toggle('has-overrides', has);
      cuesBtn.querySelector('.cue-bell-dot').hidden = !has;
    };
    refreshBellDot();
    cuesBtn.addEventListener('click', () => {
      UI._openCueSheet('segment', seg, Editor.draft, refreshBellDot);
    });
    li.appendChild(cuesBtn);

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
    // Final-3 tick depends on the sound channel being on at all — hide
    // the sub-row when sound is off so the user isn't toggling a setting
    // that has no audible effect.
    UI._syncFinalTickRowVisibility();
    UI._syncAudioRoutePill();

    const notifBtn = document.getElementById('enable-notifs');
    const status = document.getElementById('notif-status');
    const notifRow = notifBtn.closest('.setting-row');
    const perm = Notif.perm();
    // The browser Notification API is irrelevant whenever native delivery is
    // available: on Capacitor we route everything through @capacitor/local-
    // notifications + the ChainTimerPlugin FGS, and on a browser without
    // Notification support (Android WebView, some embedded browsers) we'd
    // otherwise show "Notifications not supported in this browser" — which
    // reads to the user as a broken state when it actually doesn't apply.
    // Hide the row entirely in both cases.
    const hideNotifRow = (window.ChainedNative?.isNative) || perm === 'unsupported';
    if (notifRow) notifRow.hidden = hideNotifRow;
    if (!hideNotifRow) {
      if      (perm === 'granted') { notifBtn.textContent = 'Enabled';  notifBtn.disabled = true;  status.textContent = 'System notifications enabled.'; }
      else if (perm === 'denied')  { notifBtn.textContent = 'Blocked';  notifBtn.disabled = true;  status.textContent = 'Notifications blocked in browser settings.'; }
      else                         { notifBtn.disabled = false;         notifBtn.textContent = 'Enable'; }
    }

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
          if (!h.appEnabled)                     bodyText += '\n⚠ notifications: BLOCKED app-wide';
          else if (!h.transitionsChannelEnabled) bodyText += '\n⚠ "Chain transitions" channel disabled';
          else if (!h.completeChannelEnabled)    bodyText += '\n⚠ "Chain complete" channel disabled';
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

  // ------- Cue overrides sheet (chain + segment scopes) -------
  //
  // One shared sheet that re-renders for either scope. The chain scope
  // shows all 5 cues (sound, finalTick, voice, vibrate, prestart). The
  // segment scope shows the first 4 (prestart only makes sense once at
  // chain start, not per-segment). Each cue gets a 3-way pill:
  // Default / On / Off. "Default" displays the inherited value so the
  // user sees what they'd be inheriting before tapping. The sheet
  // mutates the holder (chain or seg) in place; the caller wires a
  // refreshBellDot callback so the bell on the editor / row updates
  // its dot indicator when the user closes the sheet.
  _openCueSheet(scope, holder, chainContext, onChange) {
    const sheet = document.getElementById('cues-sheet');
    const titleEl = document.getElementById('cues-sheet-title');
    const hintEl = document.getElementById('cues-sheet-hint');
    const list  = document.getElementById('cues-list');

    const isChain = scope === 'chain';
    const inheritLevel = isChain ? 'chain' : 'segment';
    const keys = isChain ? CUE_KEYS : SEGMENT_CUE_KEYS;

    const CUE_META = {
      sound:     { title: 'Sound cues',           hint: 'Chime when a segment ends and at chain start/end.' },
      finalTick: { title: 'Final 3 seconds tick', hint: 'Three quick tones counting down the last 3s.', requires: 'sound' },
      voice:     { title: 'Voice cues',           hint: 'Speak each segment name aloud as it begins.' },
      vibrate:   { title: 'When a segment ends',  hint: 'Buzz at every segment boundary and at chain end.' },
      prestart:  { title: 'Pre-start countdown',  hint: '3-2-1 before the chain starts.' },
    };

    titleEl.textContent = isChain ? 'Chain cues' : 'Segment cues';
    hintEl.textContent  = isChain
      ? 'Override the app defaults for this chain. Per-segment overrides win over these.'
      : 'Override the chain defaults for this segment.';

    list.innerHTML = '';
    keys.forEach(key => {
      const meta = CUE_META[key];
      const current = holder.cues?.[key];      // undefined | true | false
      const inheritedFromGlobal = inheritedCue(inheritLevel, chainContext, key);

      const row = document.createElement('div');
      row.className = 'cue-row' + (meta.requires ? ' is-nested' : '');
      row.dataset.cueKey = key;

      const head = document.createElement('div');
      head.className = 'cue-row-head';
      const inheritedLabel = inheritedFromGlobal ? 'On' : 'Off';
      head.innerHTML = `
        <span class="cue-row-title">${escape(meta.title)}</span>
        <span class="cue-row-hint">${escape(meta.hint)}</span>`;
      row.appendChild(head);

      const pill = document.createElement('div');
      pill.className = 'cue-pill';
      pill.setAttribute('role', 'radiogroup');
      pill.setAttribute('aria-label', meta.title);
      const mkBtn = (state, label, subLabel) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.state = state;
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-pressed', String(state === (current == null ? 'default' : current ? 'on' : 'off')));
        b.innerHTML = subLabel
          ? `${escape(label)}<span class="pill-default-inherit">${escape(subLabel)}</span>`
          : escape(label);
        b.addEventListener('click', () => {
          if (state === 'default') setCueOverride(holder, key, null);
          else                     setCueOverride(holder, key, state === 'on');
          // Refresh just this row's pill states (cheap full re-render keeps
          // it simple; the dependent finalTick sub-row's visibility may
          // also change if `sound` was just toggled).
          UI._openCueSheet(scope, holder, chainContext, onChange);
          if (onChange) onChange();
        });
        return b;
      };
      pill.appendChild(mkBtn('default', 'Default', inheritedLabel));
      pill.appendChild(mkBtn('on',  'On'));
      pill.appendChild(mkBtn('off', 'Off'));
      row.appendChild(pill);

      // Hide finalTick row when the EFFECTIVE sound at this scope is off
      // — same logic as the App Settings sub-row. The user can't make
      // finalTick fire when the sound channel it depends on is silent.
      if (meta.requires) {
        const parentEffective = effectiveCue(
          isChain ? null : holder,
          chainContext,
          meta.requires
        );
        if (!parentEffective) row.hidden = true;
      }

      list.appendChild(row);
    });

    sheet.hidden = false;
  },

  _syncChainCueBell() {
    const btn = document.getElementById('editor-cues-btn');
    const dot = document.getElementById('editor-cues-dot');
    if (!btn || !dot) return;
    const has = !!(Editor.draft?.cues && Object.keys(Editor.draft.cues).length);
    btn.classList.toggle('has-overrides', has);
    dot.hidden = !has;
  },

  _syncFinalTickRowVisibility() {
    const row = document.getElementById('setting-row-finaltick');
    if (!row) return;
    row.hidden = !Store.getSettings().sound;
  },

  // Reflect the persisted audio-route value onto the 3-segment pill.
  // Stored value is one of 'headset' | 'both' | 'speaker'; any unknown
  // value collapses to 'headset' (the default). The whole row is hidden
  // on non-native platforms — browsers route through whatever the OS
  // picked as the default output and we don't have the permission scope
  // (setSinkId needs persistent device-selection) to override that.
  // Showing the pill on web would be lying about what the setting does.
  _syncAudioRoutePill() {
    const row = document.getElementById('setting-row-route');
    if (!row) return;
    row.hidden = !window.ChainedNative?.isNative;
    if (row.hidden) return;
    const cur = Store.getSettings().audioRoute || 'headset';
    const validCur = ['headset', 'both', 'speaker'].includes(cur) ? cur : 'headset';
    const pill = document.getElementById('setting-route');
    if (!pill) return;
    pill.querySelectorAll('button[data-route]').forEach(b => {
      b.setAttribute('aria-pressed', String(b.dataset.route === validCur));
    });
  },

  // ------- Run view -------

  renderRun() {
    if (!Engine.chain) return;
    document.getElementById('run-chain-name').textContent = Engine.chain.name;
    UI.updateRunSegmentInfo();
    UI.updateRunClock(Engine.segments[Engine.currentIndex], Engine.segments[Engine.currentIndex]?.duration || 0, 0);
    UI.renderRunChips();
  },

  // v1.4 — multi-chain chip strip. Hidden when ≤1 chain is running so
  // the single-chain UX stays byte-identical. Otherwise renders one
  // chip per active run; the focused chip is highlighted; tapping a
  // background chip swaps focus.
  renderRunChips() {
    const wrap = document.getElementById('run-chips');
    if (!wrap) return;
    const runs = Engine.activeRuns();
    if (runs.length <= 1) {
      wrap.hidden = true;
      wrap.innerHTML = '';
      return;
    }
    wrap.hidden = false;
    wrap.innerHTML = '';
    const focusedId = Engine.focusedRunId();
    runs.forEach(run => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'run-chip'
        + (run.id === focusedId ? ' is-focused' : '')
        + (run.isPaused          ? ' is-paused'  : '');
      chip.dataset.chainId = run.id;
      const dot   = document.createElement('span'); dot.className = 'run-chip-dot';
      const name  = document.createElement('span'); name.className = 'run-chip-name';
      name.textContent = run.chain?.name || 'Chain';
      const clock = document.createElement('span'); clock.className = 'run-chip-clock';
      const cur = run.segments[run.currentIndex];
      const remaining = cur ? Math.max(0, cur.duration - run._elapsedMs() / 1000) : 0;
      clock.textContent = fmt(Math.ceil(remaining));
      chip.appendChild(dot);
      chip.appendChild(name);
      chip.appendChild(clock);
      chip.addEventListener('click', () => Engine.focus(run.id));
      // Long-press a chip to stop that specific run.
      UI._wireChipLongPress(chip, run);
      wrap.appendChild(chip);
    });
  },

  _wireChipLongPress(chip, run) {
    let timer = null;
    let startX = 0, startY = 0;
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    chip.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      startX = e.clientX; startY = e.clientY;
      timer = setTimeout(() => {
        timer = null;
        if (confirm(`Stop "${run.chain?.name || 'this chain'}"?`)) {
          Engine.stopRun(run.id);
        }
      }, UI.LONGPRESS_MS);
    });
    chip.addEventListener('pointermove', (e) => {
      if (!timer) return;
      // Match the chain-row long-press slop — touch jitter and small
      // scroll gestures shouldn't fire the stop-confirm.
      if (Math.abs(e.clientX - startX) > 8 || Math.abs(e.clientY - startY) > 8) cancel();
    });
    chip.addEventListener('pointerup',     cancel);
    chip.addEventListener('pointercancel', cancel);
    chip.addEventListener('pointerleave',  cancel);
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
    // Ceiling the displayed second so the clock flips to "00:03" at the
    // SAME instant Audio.finalThree's first pulse fires (the engine arms
    // the 3-2-1 burst on Math.ceil(remainingSec) == 3 — same calculation).
    // fmt() rounds — it would flip the digit half a second EARLIER than
    // the tick, making the sound feel like it's chasing the visual.
    // The notification path uses ceiling for both the displayed remaining
    // and the tick trigger, so we mirror that here for parity.
    document.getElementById('run-clock').textContent = fmt(Math.ceil(r));

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

    // v1.4 — keep background chip clocks live too. We piggyback on the
    // focused run's rAF tick: the background runs ARE still ticking via
    // their own _loop (their _cbTick is gated to no-op), so we just
    // need to re-read their wall-clock state and update the chip text.
    // Skip when only one run is active — chip strip is hidden, nothing
    // to redraw.
    if (Engine._runs.size > 1) UI._updateRunChipClocks();
  },

  // Update the run-chip clock text in place without rebuilding the
  // chip elements. Called from updateRunClock on every focused tick.
  _updateRunChipClocks() {
    const wrap = document.getElementById('run-chips');
    if (!wrap || wrap.hidden) return;
    [...wrap.children].forEach(chip => {
      const id  = chip.dataset.chainId;
      const run = Engine.runById(id);
      if (!run) return;
      const cur = run.segments[run.currentIndex];
      const remaining = cur ? Math.max(0, cur.duration - run._elapsedMs() / 1000) : 0;
      const clock = chip.querySelector('.run-chip-clock');
      if (clock) clock.textContent = fmt(Math.ceil(remaining));
      chip.classList.toggle('is-paused', !!run.isPaused);
    });
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

  // Chain-level cue overrides — bell in the editor header. The draft is
  // mutated in place; the bell's dot indicator refreshes on each pill
  // tap (via the onChange callback) so the user sees their override
  // land without re-rendering the whole editor.
  document.getElementById('editor-cues-btn').addEventListener('click', () => {
    if (!Editor.draft) return;
    UI._openCueSheet('chain', Editor.draft, Editor.draft, () => UI._syncChainCueBell());
  });
  // settings toggles
  const wireToggle = (id, key) => {
    document.getElementById(id).addEventListener('change', e => {
      Store.setSetting(key, e.target.checked);
      if (key === 'wake' && e.target.checked && Engine.isRunning && !Engine.isPaused) Wake.acquire();
      if (key === 'wake' && !e.target.checked) Wake.release();
      // Sound is the parent of "Final 3 seconds tick" in the Defaults
      // section — hide/show the nested row as the user flips the parent.
      if (key === 'sound') UI._syncFinalTickRowVisibility();
    });
  };
  wireToggle('setting-sound', 'sound');
  wireToggle('setting-voice', 'voice');
  wireToggle('setting-vibrate', 'vibrate');
  wireToggle('setting-wake', 'wake');
  wireToggle('setting-prestart', 'prestart');
  wireToggle('setting-finaltick', 'finalTick');

  // Audio routing pill (Headset only / Both / Speaker only)
  document.querySelectorAll('#setting-route button[data-route]').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.route;
      if (!['headset', 'both', 'speaker'].includes(v)) return;
      Store.setSetting('audioRoute', v);
      UI._syncAudioRoutePill();
      // Live-apply to a running chain: re-emit fgsupdate so the FGS
      // re-binds its voice MediaPlayer to the new preferred device on
      // the NEXT boundary. We don't interrupt whatever's currently
      // playing — that would be jarring for users tapping the pill
      // mid-segment.
      if (Engine.isRunning) Engine._emitChainEvent('chain:fgsupdate');
    });
  });

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
    // v1.4 — block destructive actions while this chain is running.
    // Delete/Duplicate/Share all mutate Store state in ways that would
    // either orphan the live EngineRun or surprise the user mid-workout.
    if (Engine.isChainRunning(Editor.draftId)) {
      Toast.show('Stop this chain to use the more menu', 'warn');
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
      const otherRunning = Engine.activeRunningCount() > 1;
      const focusedName = Engine.chain?.name || 'this chain';
      const prompt = otherRunning
        ? `Stop "${focusedName}"? Another chain will continue.`
        : 'Stop this chain?';
      if (!confirm(prompt)) return;
    }
    UI.cancelPrestart();           // ← prevent the queued startChain from firing
    Engine.stop();
    UI.hideCompletion();
    if (Engine.activeRunningCount() === 0) View.show('library');
    else UI.updateRunSegmentInfo();   // redraw for the newly-promoted run
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
  // v1.4 — chip strip wakes up whenever a run is added/removed/focused.
  // The chip clocks themselves redraw on every focused-run tick (see
  // updateRunClock) so background clocks stay live.
  Engine.onRunsChange = () => UI.renderRunChips();

  // v1.4 — selection-mode topbar buttons.
  document.getElementById('library-select-cancel')?.addEventListener('click', () => UI.exitSelectMode());
  document.getElementById('library-select-start')?.addEventListener('click', () => UI.startSelected());
  // Editor lock — Stop button in the locked banner stops the running
  // chain. Confirm to prevent accidental stops mid-workout.
  document.getElementById('editor-locked-stop')?.addEventListener('click', () => {
    if (!Editor.draftId) return;
    if (!confirm('Stop this chain?')) return;
    Engine.stopRun(Editor.draftId);
    UI.renderEditor();   // banner disappears
  });
  // Native bridge events for a SPECIFIC run id (notification buttons).
  // The existing 'chained:enginecommand' listener is below; we replace it
  // with a runId-aware version inside the same init() — see further down.

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
  // After a wall-clock catchup that ended the chain (e.g. the app was
  // backgrounded across the last segment), get the user off the now-stale
  // run view. Without this they're stuck looking at the segment+remaining
  // values frozen from the moment they backgrounded the app, and every
  // in-app control silently does nothing because isRunning flipped to
  // false — exactly the "pause button doesn't work, timer looks frozen"
  // symptom. The OS-fired "✓ Chain complete" notification already cued
  // the user; no point replaying the in-app overlay now.
  function bailOutOfStaleRunView() {
    // v1.4 — if ANY run is still active (even a background one) the
    // run view is meaningful; keep it. Only bail when there's nothing
    // left to display.
    if (Engine.activeRunningCount() > 0) return;
    if (document.body.dataset.view !== 'run') return;
    UI.hideCompletion();
    View.show('library');
  }

  function refreshFromWallClock() {
    // Wake all runs that need catching up; the coordinator fans out
    // to every active run.
    if (Engine.activeRunningCount() === 0) return;
    Engine._catchup();
    if (Engine.activeRunningCount() > 0) {
      Engine._loop();              // re-prime rAF for any unpaused run
      UI.updateRunSegmentInfo();
    } else {
      bailOutOfStaleRunView();
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
    if (Engine.activeRunningCount() === 0) { bailOutOfStaleRunView(); return; }
    // Catch up to wall clock FIRST. If a chain elapsed past its end
    // while the WebView was paused, _catchup -> _complete removes it
    // from _runs. Engine._catchup fans out to every active run; we
    // re-emit only the runs still alive after the catch-up.
    Engine._catchup();
    if (Engine.activeRunningCount() === 0) { bailOutOfStaleRunView(); return; }
    Engine._emitChainEvent('chain:reschedule');
  });

  // Pause / Resume / Stop tapped in the persistent foreground-service
  // notification. The native bridge (js/native.js) re-fires the
  // ChainTimerPlugin "chainCommand" event as this DOM event so we don't
  // have to tightly couple the engine to Capacitor.
  window.addEventListener('chained:enginecommand', (e) => {
    const cmd = e?.detail?.command;
    if (!cmd) return;
    // v1.4 — when multiple runs exist, the notification command carries
    // a runId so we know which run to act on. Without it, target the
    // focused run (single-chain back-compat).
    const runId = e?.detail?.runId;
    const targetRun = runId ? Engine.runById(runId) : Engine._focused;
    if (!targetRun || !targetRun.isRunning) return;
    if (cmd === 'pause') {
      if (!targetRun.isPaused) targetRun.pause();
    } else if (cmd === 'resume') {
      if (targetRun.isPaused) targetRun.resume();
    } else if (cmd === 'skip-next') {
      targetRun.skipNext();
    } else if (cmd === 'skip-prev') {
      targetRun.skipPrev();
    } else if (cmd === 'stop') {
      UI.cancelPrestart();
      Engine.stopRun(targetRun.id);
      UI.hideCompletion();
      // Only force-navigate when the user was on the run view AND no
      // other run is left to focus on. If a second run is still going
      // we let the coordinator promote it and stay on the run view.
      if (document.body.dataset.view === 'run' && Engine.activeRunningCount() === 0) {
        View.show('library');
      }
    }
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

// Testability hatch — expose the closure-scoped singletons under a single
// namespace so Playwright smoke tests (tools/smoke-audio-voice.mjs) can
// spy on Audio / Voice calls and drive Engine state without having to
// chase every behavior through the DOM. Intentionally NOT frozen so the
// tests can monkey-patch methods. Production code should never read from
// here — it has direct closure references. Picking a namespaced object
// (rather than separate window globals) avoids colliding with the built-in
// browser `window.Audio` (HTMLAudioElement) constructor.
if (typeof window !== 'undefined') {
  window.ChainedApp = { Audio, Voice, Engine, Store };
}

})();
