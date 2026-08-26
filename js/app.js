/* ==========================================================================
   Chained Timers
   ========================================================================== */

(() => {
'use strict';

// ============================================================
// Constants & utilities
// ============================================================

const STORAGE_KEY = 'chained-timers/v1';

// Bumped in tools/build-www.mjs at build time to match package.json's
// version field. Kept as a literal here (not injected via <script>) so
// the file is self-contained when opened directly in a browser during
// development. Update by hand if editing this file outside the build.
const APP_VERSION = '1.4.13';

// Where "Update available" points on native. Selection order at run time:
//   1. If the plugin reports the install came from the Play Store, the
//      Play Store URL is used (and if we ever wire the Play In-App Updates
//      API, that native flow supersedes this URL entirely).
//   2. Else if we know it came from the App Store, that URL.
//   3. Else fall back to the GitHub Releases page — this is the sideload
//      path (installed the APK directly, not via any store) which is
//      currently how every user reaches the app; Android doesn't
//      auto-update sideloaded APKs so the manual re-download prompt is
//      what makes updates work at all.
const UPDATE_URLS = {
  play:      'https://play.google.com/store/apps/details?id=com.mayerwin.chainedtimers',
  appstore:  'https://apps.apple.com/app/chained-timers/id0000000000', // TODO: replace after App Store submission
  sideload:  'https://github.com/mayerwin/Chained-Timers/releases/latest',
};
// GitHub Releases API — checked at launch on native to see if a newer
// tag exists than APP_VERSION. This is the mechanism that actually works
// today because most users are on sideload APK installs which the Play
// Store has no record of, so the Play In-App Updates API would return
// UPDATE_NOT_AVAILABLE for them regardless. Set to null to disable.
const UPDATE_CHECK_URL = 'https://api.github.com/repos/mayerwin/Chained-Timers/releases/latest';

// ============================================================
// Updater — "is a newer version out?"
// ============================================================
//
// Two channels, picked by install source on native launch:
//
//   PLAY (com.android.vending) — installed from Google Play Store.
//     ChainTimer.getInstallSource() returns "play". We call the Play
//     In-App Updates SDK (checkPlayUpdate); if it says available, we
//     show our modal, and "Update" launches Play's in-app flow (IMMEDIATE
//     by default — Play's UI takes over, downloads, installs, restarts).
//
//   OTHER (sideload / adb / third-party store) — the Play SDK returns
//     UPDATE_NOT_AVAILABLE here regardless of what's tagged, because the
//     Play Store has no record of this install. We fall back to the
//     GitHub Releases API check and prompt the user to grab the new APK.
//
// PWA (browser) users don't need any of this — the service worker's
// network-first HTML strategy auto-updates the app on the next load.
const Updater = {
  _channel:   'unknown',  // 'play' | 'sideload' | 'other' | 'unknown'
  _installer: null,       // raw installer package name (or null on sideload)
  _play:      null,       // {available, versionCode, priority, immediateAllowed, flexibleAllowed}
  _latest:    null,       // GitHub Releases fallback: {tag, name, html_url}

  // For the settings-panel "↑ vX.Y.Z available" hint. Play-channel updates
  // report a version code, not a name — we fall back to that as a string.
  latestVersion() {
    if (this._channel === 'play' && this._play?.available) {
      const code = this._play.versionCode;
      return code ? `code ${code}` : 'newer';
    }
    return this._latest ? Updater._stripV(this._latest.tag) : null;
  },

  hasUpdate() {
    if (this._channel === 'play') return !!this._play?.available;
    return this._latest && this.isNewer(this.latestVersion(), APP_VERSION);
  },

  isNewer(latest, current) {
    if (!latest || !current) return false;
    // Play-channel "code N" strings compare true whenever _play.available.
    if (String(latest).startsWith('code ') || latest === 'newer') return true;
    const a = Updater._stripV(latest).split('.').map(n => parseInt(n, 10) || 0);
    const b = Updater._stripV(current).split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] || 0, y = b[i] || 0;
      if (x > y) return true;
      if (x < y) return false;
    }
    return false;
  },

  _stripV(tag) { return String(tag || '').replace(/^v/i, ''); },

  storeUrl() {
    const platform = window.Capacitor?.getPlatform?.() || 'web';
    if (this._channel === 'play')    return UPDATE_URLS.play;
    if (platform     === 'ios')      return UPDATE_URLS.appstore;
    return UPDATE_URLS.sideload;
  },

  // The user tapped "Update". Play-channel launches the in-app flow (Play
  // SDK takes over with its own UI and restart-on-completion behavior);
  // sideload / other opens the store URL in the system browser so they
  // can grab the new APK.
  async openStore() {
    // Remember we've prompted this version regardless of outcome so the
    // Settings hint doesn't nag on re-open.
    try {
      const key = this._channel === 'play'
        ? `play-${this._play?.versionCode || 'x'}`
        : (this._latest?.tag || '');
      if (key) localStorage.setItem('chained-updater/lastPrompted', key);
    } catch {}

    if (this._channel === 'play' && this._play?.available) {
      const CT = window.Capacitor?.Plugins?.ChainTimer;
      if (CT && typeof CT.startPlayUpdate === 'function') {
        try {
          // IMMEDIATE by default — Play's UI is opinionated but user-
          // friendly, and download+install+restart happens without
          // leaving the app. If the SDK reports IMMEDIATE not allowed
          // (rare, e.g. on very old Play services), fall through to
          // FLEXIBLE, and then to the store URL.
          const type = this._play.immediateAllowed ? 'immediate'
                     : this._play.flexibleAllowed  ? 'flexible'
                     : null;
          if (type) {
            await CT.startPlayUpdate({ type });
            return;
          }
        } catch (e) { /* fall through */ }
      }
    }
    try {
      window.open(this.storeUrl(), '_blank', 'noopener');
    } catch {}
  },

  async _resolveInstallSource() {
    const CT = window.Capacitor?.Plugins?.ChainTimer;
    if (!CT || typeof CT.getInstallSource !== 'function') return;
    try {
      const r = await CT.getInstallSource();
      this._channel   = r?.source   || 'unknown';
      this._installer = r?.installer || null;
    } catch {
      this._channel   = 'unknown';
      this._installer = null;
    }
  },

  async _checkPlay() {
    const CT = window.Capacitor?.Plugins?.ChainTimer;
    if (!CT || typeof CT.checkPlayUpdate !== 'function') return false;
    try {
      const r = await CT.checkPlayUpdate();
      this._play = r || null;
      return !!(r && r.available);
    } catch {
      this._play = null;
      return false;
    }
  },

  async _checkGithub() {
    if (!UPDATE_CHECK_URL) return null;
    try {
      const cached = JSON.parse(localStorage.getItem('chained-updater/cache') || 'null');
      if (cached && (Date.now() - cached.at) < 6 * 3600 * 1000) {
        this._latest = cached.latest;
      } else {
        const res = await fetch(UPDATE_CHECK_URL, { headers: { Accept: 'application/vnd.github+json' } });
        if (!res.ok) return null;
        const json = await res.json();
        this._latest = { tag: json.tag_name, name: json.name, html_url: json.html_url };
        localStorage.setItem('chained-updater/cache', JSON.stringify({ at: Date.now(), latest: this._latest }));
      }
    } catch {
      return null;
    }
    const latest = this._latest ? Updater._stripV(this._latest.tag) : null;
    if (!latest || !this.isNewer(latest, APP_VERSION)) return null;
    return latest;
  },

  // Populates channel + result, returns a summary the modal can render.
  // Returns null when there's no update to show.
  async checkAsync() {
    // In the PWA no channel applies; skip the check outright.
    if (!window.ChainedNative?.isNative) return null;

    if (this._channel === 'unknown') await this._resolveInstallSource();

    // Play channel: try the SDK; if it says available, we're done. If it
    // says NO (which is what happens for every sideload install), we
    // also try GitHub as a belt-and-braces check for the user who might
    // have both a Play install AND a manual GitHub-APK sideloaded over
    // it — the Play SDK will report NOT_AVAILABLE in that scenario too.
    if (this._channel === 'play') {
      const hasPlay = await this._checkPlay();
      if (hasPlay) return this.latestVersion();
    }

    return await this._checkGithub();
  },

  async maybePromptOnLaunch() {
    if (!window.ChainedNative?.isNative) return;
    // Small deferral so we don't compete with the initial paint + native
    // bridge init messages when the user opens the app.
    setTimeout(async () => {
      const latest = await this.checkAsync();
      if (!latest) return;
      const dismissKey = this._channel === 'play'
        ? `play-${this._play?.versionCode || 'x'}`
        : (this._latest?.tag || '');
      let dismissed = '';
      try { dismissed = localStorage.getItem('chained-updater/lastDismissed') || ''; } catch {}
      if (dismissed && dismissed === dismissKey) return;
      UI.showUpdateModal(latest);
    }, 1500);
  },

  markDismissed() {
    try {
      const key = this._channel === 'play'
        ? `play-${this._play?.versionCode || 'x'}`
        : (this._latest?.tag || '');
      if (key) localStorage.setItem('chained-updater/lastDismissed', key);
    } catch {}
  },
};

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
  // v1.4.5 — sound-stream routing:
  //   false (default) → USAGE_MEDIA + CONTENT_TYPE_SONIFICATION
  //     Follows the everyday "media / music" volume slider users know.
  //     Silenced by Do Not Disturb. Predictable for most people.
  //   true            → USAGE_ALARM + CONTENT_TYPE_SONIFICATION
  //     Follows the (usually louder + hidden) alarm slider. Rings through
  //     silent mode / DND — good for hard workouts where you never want
  //     to miss a segment boundary.
  // The default was USAGE_ALARM in v1.3.3..v1.4.4; users complained that
  // muting the alarm slider unexpectedly killed all sound (the "if my
  // alarm volume is at 0% why can't I hear anything?" bug). v1.4.5
  // defaults to media which matches how competing workout timers behave.
  ringThroughDnd: false,
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

// Always-HH:MM:SS for the editor TOTAL — full three-part zero-padded
// format, e.g. 00:01:30. Used only at the top of the editor stats grid.
const fmtHHMMSS = (totalSeconds) => {
  totalSeconds = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
};

// Right-aligned "01h 05m 30s" / "05m 03s" / "10s" for the segment
// list. Leading zero parts are dropped, remaining parts are
// zero-padded to two digits, and columns line up because every
// non-suppressed part is a fixed width. Returned as an HTML fragment
// so we can style each part with a stable inline-block width — no
// dependency on tabular-nums font support in the display font.
const fmtSegDurationHTML = (totalSeconds) => {
  totalSeconds = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  // Show a slot even when suppressed so all rows align to the right.
  const hSlot = h > 0             ? `${pad(h)}h` : '';
  const mSlot = (h > 0 || m > 0)  ? `${pad(m)}m` : '';
  const sSlot = `${pad(s)}s`;
  return `<span class="sd-h">${hSlot}</span>` +
         `<span class="sd-m">${mSlot}</span>` +
         `<span class="sd-s">${sSlot}</span>`;
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
    else {
      chain.createdAt = Date.now();
      // v1.4.14 — append, don't prepend. The + button lives at the
      // BOTTOM of the library, so that is where users look for what it
      // just made (Android's stock Clock does the same). Prepending
      // also meant a throwaway timer landed above the chains you care
      // about. Callers reveal the new row via UI.revealChain.
      this.state.chains.push(chain);
    }
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

  // v1.4.13 — persist a user-defined chain order. Takes the full list of
  // chain ids in their new order; any id the caller didn't mention keeps
  // its relative position at the end, so a partial/stale list can never
  // drop a chain from the library.
  reorderChains(orderedIds) {
    if (!Array.isArray(orderedIds) || !orderedIds.length) return;
    const byId = new Map(this.state.chains.map(c => [c.id, c]));
    const next = [];
    for (const id of orderedIds) {
      const c = byId.get(id);
      if (c) { next.push(c); byId.delete(id); }
    }
    for (const c of this.state.chains) if (byId.has(c.id)) next.push(c);
    this.state.chains = next;
    this.save();
  },

  duplicateChain(id) {
    const c = this.getChain(id);
    if (!c) return null;
    const copy = JSON.parse(JSON.stringify(c));
    copy.id = uid('c');
    copy.name = (c.name || 'Chain') + ' (copy)';
    copy.segments = Array.isArray(copy.segments)
      ? copy.segments.map(s => ({ ...s, id: uid('s') }))
      : [];
    copy.createdAt = Date.now();
    copy.updatedAt = Date.now();
    // A copy belongs beside the thing it was copied from — sending it
    // to either end of the list makes the user hunt for it.
    const at = this.state.chains.findIndex(x => x.id === id);
    this.state.chains.splice(at < 0 ? this.state.chains.length : at + 1, 0, copy);
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
        // hasName: did the user actually type a name, or are we defaulting?
        // Voice cues gate on this so unnamed segments don't speak the
        // literal word "Segment" — see v1.4.7. Display sites still show
        // the "Segment" fallback so the run view / notification aren't
        // blank.
        const rawName = (seg.name || '').trim();
        const expanded = {
          name: rawName || 'Segment',
          hasName: !!rawName,
          duration: Math.max(1, seg.duration | 0),
          color: seg.color || rootChain.color || 'amber',
          path: [`${rootChain.name}${loops > 1 ? ` · ${loop+1}/${loops}` : ''}`],
          // v1.4.12 — source identity, so a mid-run rename can be mapped
          // back to the owning Store segment (which may live in an
          // embedded subchain) and fanned out to every expanded instance
          // (loops repeat the same source segment N times).
          srcChainId: rootChain.id,
          srcSegId: seg.id,
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

  // v1.4.4: on native the FGS's MediaPlayer pool owns every in-chain cue
  // (chime / final-3 / finale / start) so that all playback rides
  // STREAM_ALARM with the user's setPreferredDevice route honoured. Web
  // Audio is stuck on STREAM_MUSIC and would otherwise fight the alarm
  // stream — that mismatch is what the user perceived as "voice at max,
  // beeps at some other volume". These helpers still exist and are used
  // on the PWA path (and for prestart, which happens before the FGS is
  // even started).
  _skipOnNative() { return !!window.ChainedNative?.isNative; },

  // distinctive end-of-segment chime: two stacked tones
  chime() {
    if (this._skipOnNative()) return;
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
    if (this._skipOnNative()) return;
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
    if (this._skipOnNative()) return;
    this.beep({ freq: 523, duration: 0.10, volume: 0.18, type: 'sine' });
    setTimeout(() => this.beep({ freq: 784, duration: 0.18, volume: 0.20, type: 'sine' }), 100);
  },

  // pre-start countdown beep — intentionally NOT gated on native. Prestart
  // runs before the FGS is started so there's no MediaPlayer pool yet;
  // and it's a UI-timer effect on top of the run screen the user is
  // definitely looking at, so Web Audio latency is fine here.
  prestart(isFinal = false) {
    if (isFinal) this.beep({ freq: 880, duration: 0.22, volume: 0.24, type: 'sine' });
    else this.beep({ freq: 523, duration: 0.12, volume: 0.18, type: 'sine' });
  },

  // grand finale
  finale() {
    if (this._skipOnNative()) return;
    this.beep({ freq: 523, duration: 0.16, volume: 0.22, type: 'sine' });
    setTimeout(() => this.beep({ freq: 659, duration: 0.16, volume: 0.22, type: 'sine' }), 120);
    setTimeout(() => this.beep({ freq: 784, duration: 0.16, volume: 0.22, type: 'sine' }), 240);
    setTimeout(() => this.beep({ freq: 1047, duration: 0.42, volume: 0.24, type: 'sine' }), 360);
  },

  // v1.4.13 — one burst of the ring-until-dismissed alarm. Two rising
  // pairs, deliberately more insistent than chime() (which is a passing
  // hand-off) because this one is asking to be acted on. Repeated by
  // Alarm below until the user dismisses.
  alarmBurst() {
    if (this._skipOnNative()) return;
    this.beep({ freq: 880,  duration: 0.16, volume: 0.26, type: 'square' });
    setTimeout(() => this.beep({ freq: 1174, duration: 0.16, volume: 0.26, type: 'square' }), 200);
    setTimeout(() => this.beep({ freq: 880,  duration: 0.16, volume: 0.26, type: 'square' }), 460);
    setTimeout(() => this.beep({ freq: 1174, duration: 0.26, volume: 0.26, type: 'square' }), 660);
  },
};

// ============================================================
// Alarm — the looping "ring until dismissed" cue (web/PWA path)
// ============================================================
//
// On native this is inert: the foreground service owns every audible
// cue (v1.4.4) and keeps ringing even with the WebView asleep, which is
// the whole point of the feature. On web we loop from JS for as long as
// the page is alive. Either way the loop is bounded by RING_TIMEOUT_MS
// — see the constant's comment for why a cap exists at all.
const Alarm = {
  // Stock Android timers (AOSP DeskClock) ring indefinitely: there is no
  // auto-silence for timers, only for alarms (10 min by default). We
  // honour "until dismissed" but still cap it, because this app can be
  // mid-chain on a phone in a gym bag and a truly unbounded loop is a
  // battery and goodwill hazard. 15 minutes is longer than the stock
  // alarm cap and far longer than anyone waits at a real gate.
  RING_TIMEOUT_MS: 15 * 60 * 1000,
  BURST_INTERVAL_MS: 1500,

  _iv: null,
  _timeout: null,
  _runId: null,

  active() { return !!this._iv; },
  activeRunId() { return this._runId; },

  start(run) {
    this.stop();
    this._runId = run?.id || null;
    const vibrate = effectiveCue(run?.segments?.[run.currentIndex], run?.chain, 'vibrate');
    const burst = () => {
      Audio.alarmBurst();
      if (vibrate) Vibe.do([200, 120, 200]);
    };
    burst();
    this._iv = setInterval(burst, this.BURST_INTERVAL_MS);
    this._timeout = setTimeout(() => {
      // Timed out: stop the noise but LEAVE the gate held. The chain
      // still waits for a real dismissal, so nothing advances unseen —
      // only the sound gives up.
      this.stop();
    }, this.RING_TIMEOUT_MS);
  },

  stop() {
    if (this._iv) { clearInterval(this._iv); this._iv = null; }
    if (this._timeout) { clearTimeout(this._timeout); this._timeout = null; }
    this._runId = null;
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
      // v1.4.13 — speak in the USER'S language, not the document's.
      // Per spec an utterance with no `lang` inherits the document's
      // (<html lang="en">), so every PWA user got an English voice
      // regardless of their browser or OS language — French segment
      // names were read with English pronunciation. Native Android has
      // always followed the device's TTS locale (we never call
      // setLanguage, so the engine default applies), so this is the web
      // path catching up to the native one, not a new policy.
      u.lang = Voice.preferredLang();
      u.rate = 1.0;
      u.pitch = 1.0;
      u.volume = 1.0;
      window.speechSynthesis.speak(u);
    } catch (e) { /* noop */ }
  },

  // v1.4.13 — BCP-47 tag for web speech. navigator.language is the
  // browser's own UI language, which is the closest web equivalent of
  // the device TTS locale that native uses. Falls back through the
  // languages list, then to English, so a browser that exposes neither
  // still speaks rather than throwing.
  preferredLang() {
    try {
      const tag = navigator.language || (navigator.languages || [])[0];
      return (typeof tag === 'string' && tag) ? tag : 'en';
    } catch { return 'en'; }
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
    // v1.4.7: unnamed segments render as empty strings — the plugin
    // treats them as "no voice for this segment" (returns a null path)
    // and the FGS stays silent at that boundary. The old fallback to
    // the literal word "Segment" was gratingly meaningless when the
    // user had left a segment name blank on purpose.
    // Check `hasName` (boolean sourced from raw user input), not
    // `.name` — expandChain sets `.name` to 'Segment' as a display
    // fallback for blank segments (used by the run-view title, notif
    // body, etc). Keying off `.name` here re-introduces the "Segment"
    // TTS bug this fix is trying to kill.
    const texts = segments.map(s => (s && s.hasName) ? s.name : '');
    const key   = texts.join('|');
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

  // v1.4.12 — snackbar variant with an action button (e.g. "Undo" after
  // a swipe-delete). duration defaults to 5s, the Material/HIG standard
  // for undoable actions (long enough to react, short enough to not
  // linger). Only one action toast lives at a time: a new one replaces
  // the previous (whose action is then forfeit — the underlying change
  // was already applied, so this matches Gmail-style stacking).
  action(message, { label, onAction, actions, kind = '', duration = 5000, wrap = false } = {}) {
    const stack = document.getElementById('toast-stack');
    stack.querySelectorAll('.toast.has-action').forEach(t => t.remove());
    const t = document.createElement('div');
    // wrap: multi-line message (e.g. the "used by …" notice, whose chain
    // list won't fit one line). Single-line stays the default so short
    // snackbars keep the tight pill shape.
    t.className = 'toast has-action' + (kind ? ' is-' + kind : '') + (wrap ? ' is-wrap' : '');
    t.innerHTML = `<span class="t-mark"></span><span class="t-msg">${escape(message)}</span>`;
    let timer = null;
    const dismiss = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      t.classList.add('is-out');
      setTimeout(() => t.remove(), 280);
    };
    // v1.4.12 — multi-action support (e.g. Skip / Always skip). The
    // single label/onAction pair remains as sugar for one action.
    const list = Array.isArray(actions) ? actions
      : (label && typeof onAction === 'function') ? [{ label, onAction }] : [];
    for (const a of list) {
      if (!a || !a.label || typeof a.onAction !== 'function') continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast-action-btn';
      btn.textContent = a.label;
      btn.addEventListener('click', () => { dismiss(); a.onAction(); });
      t.appendChild(btn);
    }
    stack.appendChild(t);
    timer = setTimeout(dismiss, duration);
    return { dismiss };
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

// v1.4.13 — segment-only, NON-inheriting cues. These are plain booleans
// (default off) rather than the tri-state default/on/off of CUE_KEYS,
// because there is deliberately no app- or chain-level counterpart: a
// hold-and-ring gate is a property of one specific boundary, never a
// blanket policy. Rendered in the segment cue sheet with two choices.
const SEGMENT_BINARY_CUES = ['ringUntilDismissed'];
// Order the segment sheet renders its rows in (ringUntilDismissed sits
// under sound with finalTick, both being sound sub-options).
const SEGMENT_SHEET_KEYS = ['sound', 'finalTick', 'ringUntilDismissed', 'voice', 'vibrate'];

// True when this (expanded or stored) segment should hold the chain and
// ring until the user dismisses it. Reads the raw flag — no inheritance.
function segmentRingsUntilDismissed(seg) {
  return !!(seg && seg.cues && seg.cues.ringUntilDismissed);
}

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
// v1.4 — the engine supports up to 5 concurrent chain runs. Each
// active chain has its own EngineRun instance with independent state
// (currentIndex, segmentStartedAtWall, paused state, rAF loop,
// persistence key). The Engine coordinator keeps the focused run's
// state surfaced under the old singleton API (Engine.chain, .segments,
// .isRunning, .pause(), .skipNext(), …) so all existing single-chain
// callsites continue to work without modification. When several chains
// are running, UI calls Engine.focus(chainId) to swap which run the
// coordinator's fields point at; the chip strip in the run view + the
// now-playing strip on the library view both drive this on tap.
//
// Why 5 (v1.4.4): raised from 2. Cap is a sanity limit — Android can
// mix unlimited USAGE_ALARM streams and the FGS handles arbitrarily
// many run objects. The user-visible caveat is that simultaneous
// segment-boundary chimes may overlap when several chains finish
// segments at the same instant; keeping the cap small keeps that noise
// manageable.
//
// All elapsed-time math is wall-clock (Date.now) because the Capacitor
// Android WebView pauses JS timers + frame callbacks (and may freeze
// performance.now) when the activity is backgrounded or the screen
// locks. Wall-clock is the only source that keeps ticking across freezes,
// so the engine can correctly catch up multiple segments when the user
// returns to the app. performance.now is used only for the rAF cadence.

const MAX_CONCURRENT_RUNS = 5;
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
    // v1.4.13 — ring-until-dismissed gate state. awaitingDismiss is the
    // "held at a ringing boundary" flag; dismissedAtIndex records the
    // boundary already cleared so it can't immediately re-arm.
    this.awaitingDismiss = false;
    this.dismissedAtIndex = -1;
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
    if (!opts.suppressInAppStart && this.segments[0]
        && this.segments[0].hasName
        && effectiveCue(this.segments[0], this.chain, 'voice')) {
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

    // v1.4.12 — remember that this chain has run at least once. The
    // first-run prestart snackbar (Skip / Always skip) keys off this:
    // it's only offered before a chain's very first start. Stamped here
    // so every start path counts (solo, bulk, post-countdown).
    const storeChain = Store.getChain(this.id);
    if (storeChain && !storeChain.hasRun) {
      storeChain.hasRun = true;
      Store.save();
    }

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
      const audioRoute     = Store.getSettings().audioRoute || 'headset';
      // v1.4.5: media vs alarm stream. See DEFAULT_SETTINGS block for the
      // rationale. Forwarded to the FGS so its MediaPlayer cue pool
      // (chime / final-3 / finale / voice) uses the right USAGE.
      const ringThroughDnd = !!Store.getSettings().ringThroughDnd;
      window.dispatchEvent(new CustomEvent(name, {
        detail: {
          runId: this.id,
          // isFocused was used by the v1.4.0 single-FGS bridge filter;
          // v1.4.1's per-run native renders it dead. Keeping it absent
          // so no future code accidentally branches on it.
          name: this.chain?.name,
          // v1.4.13 — ringUntilDismissed travels per segment so the FGS
          // can hold the gate itself while the WebView is asleep (JS
          // can't detect the boundary in the background at all).
          segments: this.segments.map(s => ({
            name: s.name, duration: s.duration, color: s.color,
            ringUntilDismissed: segmentRingsUntilDismissed(s),
          })),
          currentIndex: this.currentIndex,
          awaitingDismiss: this.awaitingDismiss,
          dismissedAtIndex: this.dismissedAtIndex,
          segmentStartedAtMs,
          pausedAtMs,
          isPaused: this.isPaused,
          tickEnabled,
          soundEnabled,
          voicePaths,
          voiceEnabled,
          audioRoute,
          ringThroughDnd,
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
        // v1.4.13 — a ring-until-dismissed boundary is a hard stop even
        // when we're replaying elapsed time (e.g. the web app was
        // backgrounded across it). Catch-up must not silently step over
        // a gate the user never dismissed: hold and ring instead.
        if (this.dismissedAtIndex !== this.currentIndex && segmentRingsUntilDismissed(seg)) {
          this._beginAlarmHold();
          return true;
        }
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
    // v1.4.13 — "Ring until dismissed": this segment's boundary is a
    // gate, not a hand-off. Freeze here and ring until the user
    // dismisses; dismissAlarm() re-enters with reason 'dismiss', which
    // starts the next segment from the moment of dismissal (the held
    // time is not charged to it). Only natural expiry gates — a user
    // skip means "move on", and catch-up is replaying history where
    // the gate has no live alarm to attach to.
    if (reason === 'auto' && !this.awaitingDismiss
        && this.dismissedAtIndex !== this.currentIndex
        && segmentRingsUntilDismissed(seg)) {
      this._beginAlarmHold();
      return;
    }
    const segDurMs = (seg?.duration || 0) * 1000;
    this.totalElapsed += segDurMs;

    const now = Date.now();
    // 'dismiss' behaves like 'skip' for timing (the next segment starts
    // now, not back when the gate was reached) but fires cues normally.
    const nextStartWall = (reason === 'skip' || reason === 'dismiss')
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
      if (nextSeg && nextSeg.hasName && effectiveCue(nextSeg, this.chain, 'voice')) Voice.speak(nextSeg.name);
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
    if (reason === 'skip' || reason === 'dismiss') this._emit('chain:reschedule');
    else if (reason === 'auto') this._emit('chain:fgsupdate');
  }

  // ---- Ring-until-dismissed gate -------------------------------
  //
  // The run stays on its (now finished) segment with the clock at
  // 00:00 while the alarm loops. We reuse the pause plumbing for the
  // freeze so every existing read-path (clock, chips, persistence,
  // catch-up) already treats the run as not-counting-down; awaitingDismiss
  // is what distinguishes "held at a gate, ringing" from "user paused".
  _beginAlarmHold() {
    if (this.awaitingDismiss) return;
    this.awaitingDismiss = true;
    this.isPaused = true;
    this.pausedAtWall = this.segmentStartedAtWall + this.pausedDuration
      + (this.segments[this.currentIndex]?.duration || 0) * 1000;
    cancelAnimationFrame(this.rafId);
    this.warningOn = false;
    if (this._isFocused()) {
      const view = document.querySelector('.view-run');
      view?.classList.remove('is-warning');
      view?.classList.add('is-alarm');
    }
    this._persist();
    // Native owns the audible loop in both foreground and background
    // (same rule as every other cue since v1.4.4); on web we ring from
    // JS. The FGS learns about the gate from the segment payload, so a
    // plain state emit is enough.
    this._emit('chain:fgsupdate');
    if (!window.ChainedNative?.isNative && this._isFocused()) Alarm.start(this);
    this._cbSegmentChange();
    if (typeof Engine.onAlarmChange === 'function') Engine.onAlarmChange(this);
  }

  /** User dismissed the ringing gate — continue the chain from now. */
  dismissAlarm() {
    if (!this.awaitingDismiss) return false;
    this.awaitingDismiss = false;
    this.isPaused = false;
    this.pausedDuration = 0;
    // Remember which boundary was cleared so re-entering _advance for
    // this same segment doesn't immediately re-arm the gate.
    this.dismissedAtIndex = this.currentIndex;
    Alarm.stop();
    if (this._isFocused()) {
      document.querySelector('.view-run')?.classList.remove('is-alarm', 'is-paused');
    }
    if (typeof Engine.onAlarmChange === 'function') Engine.onAlarmChange(this);
    this._advance('dismiss');
    return true;
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
    if (this.awaitingDismiss) return;   // only dismissAlarm() clears a gate
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

  // While a ring-until-dismissed gate is held, the primary transport
  // button IS the dismiss button (the run view relabels it), so both
  // play/pause and skip-next resolve the gate rather than fighting it —
  // resume() would otherwise un-pause a run whose alarm is still ringing.
  toggle() {
    if (this.awaitingDismiss) { this.dismissAlarm(); return; }
    if (this.isPaused) this.resume(); else this.pause();
  }

  skipNext() {
    if (!this.isRunning) return;
    if (this.awaitingDismiss) { this.dismissAlarm(); return; }
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
        // v1.4.13 — a run held at a ringing gate must come back held,
        // not silently resumed, if the app is killed and restored.
        awaitingDismiss: this.awaitingDismiss,
        dismissedAtIndex: this.dismissedAtIndex,
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
  // v1.4.13 — ring-until-dismissed gate, focused-run facade.
  get awaitingDismiss() { return !!this._focused?.awaitingDismiss; },
  dismissAlarm() { return !!this._focused?.dismissAlarm(); },
  anyAwaitingDismiss() { return [...this._runs.values()].some(r => r.awaitingDismiss); },
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
        run.awaitingDismiss = !!snap.awaitingDismiss;
        run.dismissedAtIndex = Number.isFinite(snap.dismissedAtIndex) ? snap.dismissedAtIndex : -1;
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
      // A run restored mid-gate resumes ringing rather than counting.
      if (run.awaitingDismiss) {
        if (!window.ChainedNative?.isNative && run._isFocused()) Alarm.start(run);
        continue;
      }
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
    // Each brand-new chain gets the duration pointer again — it's a
    // per-chain "where do I start", not a one-time onboarding tip.
    UI.durationHintUsed = false;
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
    // v1.4.13 — nameless chains fall back to the FIRST SEGMENT's name
    // when the user typed one ("Hanging" beats a generic label, and
    // it's the word they already committed to), otherwise a plain
    // "Chain". Subchain refs are skipped: their name belongs to the
    // referenced chain, so borrowing it would produce two chains with
    // the same name for no reason.
    if (!this.draft.name.trim()) {
      const firstNamed = (this.draft.segments || [])
        .find(s => s && s.kind !== 'subchain' && (s.name || '').trim());
      this.draft.name = firstNamed ? firstNamed.name.trim() : 'Chain';
    }
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
    // v1.4.5: library ticker is only useful when the library view is
    // visible AND at least one chain is running (background clocks
    // freeze otherwise because the focused-run rAF loop is what usually
    // drives clock updates).
    if (typeof UI._maybeStartLibraryTicker === 'function') UI._maybeStartLibraryTicker();
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
    const chainsRaw = Store.getChains();

    list.innerHTML = '';
    empty.hidden = chainsRaw.length > 0;

    // v1.4.5: sort chains so running ones bubble to the top of the list.
    // The stable relative order within each group is preserved (running
    // chains keep the order Engine.activeRuns() reports them in — which
    // is insertion order for the run map — and non-running chains keep
    // the Store's own createdAt-descending order). The inline status card
    // (see below) renders directly under each running card, so the two
    // representations of the same chain never appear split across the
    // scroll (the pre-v1.4.5 top strip was confusing on purpose).
    // v1.4.13 — while the user is reordering (select mode), show the
    // stored order verbatim: floating running chains to the top would
    // fight the drag and make the drop land somewhere the user didn't
    // aim for. Outside select mode the running-first sort is restored.
    const runningSet = new Set(Engine.activeRuns().map(r => r.id));
    const chains = UI.selectMode ? chainsRaw.slice() : chainsRaw.slice().sort((a, b) => {
      const ar = runningSet.has(a.id) ? 1 : 0;
      const br = runningSet.has(b.id) ? 1 : 0;
      return br - ar; // running (1) before not-running (0)
    });

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

      // v1.4.13 — reorder grip. Only rendered/visible in select mode
      // (CSS), where it sits left of the colour stripe like the editor's
      // segment handle. Press and drag it to move the chain; a plain
      // press-and-hold elsewhere on the row still toggles selection.
      const grip = document.createElement('div');
      grip.className = 'chain-card-grip';
      grip.setAttribute('aria-label', 'Reorder chain');
      grip.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>`;

      const stripe = document.createElement('div');
      stripe.className = 'chain-card-stripe';
      stripe.style.background = colorHex(chain.color);

      const body = document.createElement('div');
      body.className = 'chain-card-body';
      const safeId = String(chain.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
      const loops  = Math.max(1, Number(chain.loops) || 1);
      body.innerHTML = `
        <div class="chain-card-row1">
          <div class="chain-card-name">${escape(chain.name || 'Chain')}</div>
          <div class="chain-card-total">${escape(fmtLong(total))}</div>
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

      li.appendChild(grip);
      li.appendChild(stripe);
      li.appendChild(body);
      li.appendChild(play);
      li.appendChild(tick);
      list.appendChild(li);
      UI._wireChainReorder(li, grip);

      // v1.4.5: if this chain is running, immediately append the inline
      // status card so the two DOM nodes stay visually attached (same
      // parent list, no siblings between them). The status card mirrors
      // the FGS persistent-notification shape: current segment, position,
      // MM:SS remaining, next segment, play/pause icon, colour stripe.
      // We also arm the swipe-to-stop gesture on BOTH the chain-card
      // itself and the status card, so a horizontal drag anywhere across
      // the combined unit fires the stop-confirm flow.
      const run = Engine.runById(chain.id);
      if (run && run.isRunning) {
        UI._wireSwipeToStop(li, run.id);
        list.appendChild(UI._buildInlineStatusCard(run));
      }

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
      // Selection glyph for the tick column (no-op outside select mode,
      // where CSS hides it) — a fresh render must paint it too, not just
      // the toggle path.
      UI._setTickContent(li, chain.id);
      UI._wireLongPress(li, chain.id);
      // v1.4.12 — swipe-left-to-delete (non-running rows only; its
      // pointerdown gate re-checks running state per gesture, so a card
      // whose run ends without a re-render becomes deletable in place).
      UI._wireSwipeToDelete(li, chain);
    });

    // Reflect the current select-mode + selection set into the topbars.
    UI._syncLibrarySelectionUI();
  },

  // v1.4.13 — drag-to-reorder chains by their grip (select mode only).
  //
  // FLIP rather than the editor's fixed-rowH arithmetic: library rows
  // aren't uniform (a running chain carries an inline status card right
  // beneath it), so offsets are measured, not assumed. On each crossing
  // we reorder the DOM for real, then invert-and-play the siblings from
  // their previous rects — which also means the DOM order at drop IS
  // the new order, so committing is just reading it back.
  _wireChainReorder(li, grip) {
    if (!li || !grip) return;
    grip.addEventListener('pointerdown', (e) => {
      if (!UI.selectMode) return;               // grip is hidden anyway
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();                       // don't arm long-press/swipe
      const list = li.parentElement;
      if (!list) return;
      try { grip.setPointerCapture(e.pointerId); } catch {}
      const startY = e.clientY;
      // A running chain's status card travels with its card as one unit.
      const status = li.nextElementSibling?.classList?.contains('chain-status-card')
        ? li.nextElementSibling : null;
      const unit = [li, status].filter(Boolean);
      unit.forEach(el => el.classList.add('is-reordering'));
      document.body.classList.add('is-reordering-chains');
      // Every DOM reorder moves the dragged row's own layout slot. We
      // accumulate those jumps and subtract them, so the row stays glued
      // to the finger instead of hopping by a row height each swap.
      let shift = 0;

      const cards = () => [...list.querySelectorAll('li.chain-card')];
      // The chain-card immediately before / after the dragged unit,
      // skipping any inline status cards between them.
      const neighbour = (dir) => {
        let el = dir < 0 ? li.previousElementSibling : unit[unit.length - 1].nextElementSibling;
        while (el && !el.classList.contains('chain-card')) {
          el = dir < 0 ? el.previousElementSibling : el.nextElementSibling;
        }
        return el;
      };

      const onMove = (ev) => {
        const dy = ev.clientY - startY - shift;
        unit.forEach(el => { el.style.transform = `translateY(${dy}px)`; });
        // Swap with a DOM neighbour once the dragged row's centre passes
        // that neighbour's midpoint. Direction comes from the neighbour
        // we're testing, not from the raw delta, so a drag that reverses
        // mid-flight settles correctly.
        const dir = dy < 0 ? -1 : 1;
        const target = neighbour(dir);
        if (!target) return;
        const r  = li.getBoundingClientRect();
        const tr = target.getBoundingClientRect();
        const centre = r.top + r.height / 2;
        const mid    = tr.top + tr.height / 2;
        if (dir < 0 ? centre > mid : centre < mid) return;
        // FLIP: First — where is everyone before the reorder?
        const movers = [...list.children];
        const first = new Map(movers.map(el => [el, el.getBoundingClientRect().top]));
        const before = li.getBoundingClientRect().top;
        // Reorder for real; the unit travels together, status card last.
        const anchor = dir < 0
          ? target
          : (target.nextElementSibling?.classList?.contains('chain-status-card')
              ? target.nextElementSibling.nextSibling
              : target.nextSibling);
        unit.forEach(el => list.insertBefore(el, anchor));
        // Absorb the dragged row's own layout jump.
        shift += li.getBoundingClientRect().top - before;
        unit.forEach(el => { el.style.transform = `translateY(${ev.clientY - startY - shift}px)`; });
        // Last + Invert + Play for the displaced rows.
        for (const el of movers) {
          if (unit.includes(el)) continue;
          const prev = first.get(el);
          if (prev == null) continue;
          const delta = prev - el.getBoundingClientRect().top;
          if (!delta) continue;
          el.style.transition = 'none';
          el.style.transform = `translateY(${delta}px)`;
          requestAnimationFrame(() => {
            el.style.transition = 'transform 180ms cubic-bezier(.2,.7,.25,1)';
            el.style.transform = '';
          });
        }
      };

      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        document.body.classList.remove('is-reordering-chains');
        unit.forEach(el => {
          el.classList.remove('is-reordering');
          el.style.transition = '';
          el.style.transform = '';
        });
        [...list.children].forEach(el => { el.style.transition = ''; el.style.transform = ''; });
        // DOM order is the new order — read it straight back.
        Store.reorderChains(cards().map(c => c.dataset.chainId).filter(Boolean));
        Vibe.do(10);
        UI.renderLibrary();
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
    });
    // The grip owns its own gestures; keep taps on it from toggling
    // selection or opening the editor.
    grip.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); });
  },

  // v1.4.14 — scroll a chain into view and flash it. Used right after
  // a chain is created: new rows are appended, so on a long list the
  // new one is off-screen and the library looks unchanged. Scrolling
  // to it (and briefly marking it) answers "where did it go?" without
  // a toast the user has to read.
  revealChain(chainId) {
    if (!chainId) return;
    // Wait for the list to actually exist: callers switch views first,
    // and renderLibrary runs synchronously inside View.show.
    requestAnimationFrame(() => {
      const li = document.querySelector(`li.chain-card[data-chain-id="${CSS.escape(chainId)}"]`);
      if (!li) return;
      try { li.scrollIntoView({ behavior: "smooth", block: "center" }); }
      catch { li.scrollIntoView(); }
      li.classList.add("is-new");
      setTimeout(() => li.classList.remove("is-new"), 1600);
    });
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

  // v1.4.12 — chains that directly embed the given chain as a subchain.
  // Direct references only: a deeper ancestor references the middle
  // chain, not this one, so direct refs are exactly the set that would
  // break if this chain vanished.
  _chainsReferencing(chainId) {
    return Store.getChains().filter(c =>
      c.id !== chainId &&
      Array.isArray(c.segments) &&
      c.segments.some(s => s && s.kind === 'subchain' && s.refId === chainId)
    );
  },

  // Bottom notice for a blocked delete: list up to 3 referencing chains
  // (each name capped at 16 chars with an ellipsis so a 100-chain user
  // with long names still gets one tidy line) and roll the rest up into
  // "+N more".
  _showDeleteBlockedNotice(chain, refs) {
    const cap = (s) => {
      const n = String(s || 'Chain');
      return n.length > 16 ? n.slice(0, 15) + '…' : n;
    };
    const names = refs.slice(0, 3).map(c => cap(c.name)).join(', ');
    const extra = refs.length > 3 ? ` +${refs.length - 3} more` : '';
    Toast.action(`Can't delete "${cap(chain.name)}" — used by ${names}${extra}`,
      { kind: 'warn', duration: 4000, wrap: true });
  },

  // Delete with a 5s undo window. The delete is applied immediately
  // (optimistic, snackbar-style); Undo splices the snapshot back at its
  // original index so the list order is preserved. Swipe-delete is only
  // offered on non-running, non-referenced chains, so Store.deleteChain
  // won't scrub refs or stop runs here — the snapshot alone restores
  // the full state.
  _deleteChainWithUndo(chain) {
    const idx = Store.getChains().findIndex(c => c.id === chain.id);
    if (idx < 0) return;
    const snapshot = Store.getChains()[idx];
    Store.deleteChain(chain.id);
    UI.renderLibrary();
    Toast.action(`"${chain.name || 'Chain'}" deleted`, {
      label: 'Undo',
      kind: 'warn',
      onAction: () => {
        if (Store.getChain(snapshot.id)) return; // already back somehow
        const at = Math.min(idx, Store.getChains().length);
        Store.state.chains.splice(at, 0, snapshot);
        Store.save();
        UI.renderLibrary();
      },
    });
  },

  // v1.4.12 — swipe-left-to-delete on NON-running library cards (running
  // cards keep the v1.4.5 swipe-to-stop gesture; the two are mutually
  // exclusive via the isChainRunning check at pointerdown, re-read per
  // gesture). Mirrors the stock mail-app pattern: the card slides with
  // the finger over a red underlay with a trash icon pinned to the right
  // edge; past the threshold the icon pops (plus a haptic tick) and
  // release commits — the card slides out, the row collapses, and an
  // Undo snackbar appears. Below the threshold it springs back. Mouse
  // drags ride the same pointer pipeline: unusual on desktop but
  // harmless, and it's the only inline delete affordance there.
  //
  // Chains embedded in other chains can't be deleted: the drag meets
  // heavy resistance over a neutral underlay with a link icon (no red,
  // no trash — nothing promises a delete), and letting go past a small
  // distance surfaces the "used by …" notice at the bottom.
  SWIPE_DELETE_THRESHOLD_PX: 96,

  _wireSwipeToDelete(li, chain) {
    let startX = 0, startY = 0;
    let tracking = false;   // pointer is down, watching for intent
    let horizontal = false; // horizontal intent confirmed, card is moving
    let armed = false;      // past the delete threshold
    let blocked = false;    // chain is referenced — resist instead of reveal
    let blockedRefs = [];
    let swiped = false;     // suppress the click that follows a drag
    let underlay = null;
    let pid = null;

    const isInteractive = (n) => !!n.closest('.chain-card-play, button, input, .chain-card-select-tick, .chain-card-grip');

    const makeUnderlay = () => {
      const list = document.getElementById('chain-list');
      const u = document.createElement('div');
      u.className = 'swipe-underlay' + (blocked ? ' is-blocked' : '');
      u.style.top    = li.offsetTop + 'px';
      u.style.height = li.offsetHeight + 'px';
      u.innerHTML = blocked
        ? `<svg class="swipe-underlay-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`
        : `<svg class="swipe-underlay-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/></svg>`;
      list.insertBefore(u, li);
      return u;
    };

    const cleanupVisual = () => {
      li.classList.remove('is-swiping');
      li.style.transform = '';
      li.style.transition = '';
      if (underlay) { underlay.remove(); underlay = null; }
    };

    const reset = () => {
      tracking = false; horizontal = false; armed = false;
      blocked = false; blockedRefs = []; pid = null;
    };

    // Spring the card back to rest, then drop the underlay once the
    // card covers it again (waiting avoids a red flash at rest).
    const springBack = () => {
      li.classList.remove('is-swiping');
      li.style.transition = 'transform 260ms cubic-bezier(.2,.9,.3,1.15)';
      li.style.transform = 'translateX(0px)';
      const u = underlay; underlay = null;
      setTimeout(() => {
        li.style.transition = '';
        li.style.transform = '';
        if (u) u.remove();
      }, 280);
    };

    // Commit: slide fully out, collapse the row (height→0 plus
    // margin-top→-10px to swallow the flex gap so neighbors close up
    // with no snap), then apply the delete + show the Undo snackbar.
    const commitDelete = () => {
      const w = li.offsetWidth;
      li.classList.remove('is-swiping');
      li.style.transition = 'transform 200ms cubic-bezier(.4,0,.7,1)';
      li.style.transform = `translateX(${-(w + 24)}px)`;
      const u = underlay; underlay = null;
      setTimeout(() => {
        const h = li.offsetHeight;
        li.style.height = h + 'px';
        li.style.overflow = 'hidden';
        void li.offsetHeight; // reflow so the height transition animates
        li.style.transition = 'height 200ms ease-in, margin-top 200ms ease-in, opacity 200ms ease-in';
        li.style.height = '0px';
        li.style.marginTop = '-10px';
        li.style.opacity = '0';
        if (u) {
          u.style.transition = 'opacity 180ms ease-in';
          u.style.opacity = '0';
        }
        setTimeout(() => {
          if (u) u.remove();
          UI._deleteChainWithUndo(chain); // re-renders the library
        }, 210);
      }, 200);
    };

    li.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (UI.selectMode) return;
      if (isInteractive(e.target)) return;
      if (Engine.isChainRunning(chain.id)) return; // swipe-to-stop owns running rows
      tracking = true;
      horizontal = false;
      armed = false;
      swiped = false;
      startX = e.clientX;
      startY = e.clientY;
      pid = e.pointerId;
    });

    li.addEventListener('pointermove', (e) => {
      if (!tracking) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!horizontal) {
        // Vertical scroll intent — abandon (same rule as swipe-to-stop).
        if (Math.abs(dy) > 20 && Math.abs(dy) > Math.abs(dx)) { reset(); return; }
        if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.2) {
          horizontal = true;
          swiped = true;
          blockedRefs = UI._chainsReferencing(chain.id);
          blocked = blockedRefs.length > 0;
          underlay = makeUnderlay();
          li.classList.add('is-swiping');
          // Keep receiving moves even when the finger drifts off the row.
          try { li.setPointerCapture(pid); } catch {}
        } else {
          return;
        }
      }
      let shown;
      if (blocked) {
        // Heavy resistance both ways — the row wiggles but clearly
        // refuses. Left is the "tried to delete" direction.
        shown = dx < 0 ? Math.max(-56, dx * 0.3) : Math.min(24, dx * 0.2);
      } else if (dx < 0) {
        shown = dx; // 1:1 with the finger, like the stock gesture
      } else {
        shown = Math.min(28, dx * 0.22); // right swipe has no action — rubber-band
      }
      li.style.transform = `translateX(${shown}px)`;
      if (!blocked) {
        const nowArmed = dx < -UI.SWIPE_DELETE_THRESHOLD_PX;
        if (nowArmed !== armed) {
          armed = nowArmed;
          if (underlay) underlay.classList.toggle('is-armed', armed);
          if (armed) Vibe.do(10); // haptic tick at the point of no return
        }
      }
    });

    const endSwipe = () => {
      if (!tracking) return;
      const wasHorizontal = horizontal, wasArmed = armed, wasBlocked = blocked;
      const refs = blockedRefs;
      const moved = wasHorizontal ? Math.abs(parseFloat(li.style.transform.replace(/[^-\d.]/g, '')) || 0) : 0;
      tracking = false; horizontal = false; armed = false; blocked = false; blockedRefs = []; pid = null;
      if (!wasHorizontal) return;
      if (wasBlocked) {
        springBack();
        // Only surface the notice when the drag was a real attempt, not
        // a stray wiggle.
        if (moved > 24) UI._showDeleteBlockedNotice(chain, refs);
      } else if (wasArmed) {
        commitDelete();
      } else {
        springBack();
      }
    };
    li.addEventListener('pointerup',     endSwipe);
    li.addEventListener('pointercancel', () => { if (horizontal) { cleanupVisual(); } reset(); });
    // Without pointer capture (old WebViews) the pointer can leave the
    // row mid-drag; treat it like a release so nothing sticks.
    li.addEventListener('pointerleave', endSwipe);

    // Swallow the click that Chrome synthesizes after a drag so the
    // card doesn't open in the editor as a side effect of a swipe.
    li.addEventListener('click', (e) => {
      if (swiped) { e.stopPropagation(); e.preventDefault(); swiped = false; }
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
      UI._setTickContent(li, id);
    });
  },

  // v1.4.13 — fill the select-mode tick column. The CSS has always
  // described this glyph but the function it named never existed, so
  // the column rendered as an empty 64px gutter. Unselected rows get a
  // dim plus ("tap to add"); selected rows get a check plus their
  // position in the selection, because that order decides which chain
  // is focused when the batch starts (first = focused, rest run in the
  // background).
  _setTickContent(li, chainId) {
    const tick = li.querySelector?.('.chain-card-select-tick');
    if (!tick) return;
    const order = [...UI.selectedIds];
    const idx = order.indexOf(chainId);
    if (idx < 0) {
      tick.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`;
      return;
    }
    const label = idx === 0 ? 'Focus' : String(idx + 1);
    tick.innerHTML =
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5l5.5 5.5L20 7"/></svg>` +
      `<span class="chain-card-select-tick-lbl">${escape(label)}</span>`;
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
      // v1.4.9 — bulk-delete follows the same enable rule as bulk-start.
      const deleteBtn = document.getElementById('library-select-delete');
      if (deleteBtn) deleteBtn.disabled = (n === 0);
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

  // v1.4.9 — bulk delete every selected chain. Irreversible, so we
  // always confirm; the confirm names how many will go and (for a
  // single selection) which one, so the user isn't guessing what they
  // hit. Store.deleteChain internally stops any running run for that
  // chain id and scrubs subchain references from other chains, so a
  // chain currently mid-run is safe to include in the bulk delete.
  deleteSelected() {
    const ids = [...UI.selectedIds];
    if (!ids.length) return;
    const chains = ids.map(id => Store.getChain(id)).filter(Boolean);
    if (!chains.length) { UI.exitSelectMode(); return; }
    const prompt = chains.length === 1
      ? `Delete "${chains[0].name || 'Chain'}"? This cannot be undone.`
      : `Delete ${chains.length} chains? This cannot be undone.`;
    if (!confirm(prompt)) return;
    for (const c of chains) Store.deleteChain(c.id);
    UI.exitSelectMode();
    UI.renderLibrary();
    Toast.show(chains.length === 1 ? 'Chain deleted' : `${chains.length} chains deleted`, 'warn');
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
    // v1.4.11 — the prestart cue is honored even when another chain is
    // already running, but INLINE: the 3-2-1 counts down in the new
    // chain's own clock area and the chip strip stays visible, so the
    // user keeps a path back to the running chain. (Previously the
    // countdown was skipped entirely here because the full-screen
    // overlay would have clobbered the running chain's UI — which users
    // reported as "the 3-2-1 didn't happen".) Single-chain starts keep
    // the full-screen overlay. Explicit bulk multi-start (startSelected)
    // still means "begin now" and skips the countdown.
    const hasOtherRunning = Engine.activeRunningCount() > 0;
    if (effectiveCue(null, chain, 'prestart')) {
      UI._renderRunForChain(chain, segments);
      if (hasOtherRunning) {
        // runPrestart(inline) sets the pending state BEFORE View.show so
        // renderRun's gate keeps the focused run from repainting over
        // this preview.
        UI.runPrestart(chain, { inline: true });
        View.show('run');
      } else {
        View.show('run');
        UI.runPrestart(chain);
      }
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
    UI._setRunChainName(chain.name);
    UI._setRunSegmentName(seg0.name);
    document.getElementById('run-segment-tag').textContent  = 'Segment 1';
    document.getElementById('run-segment-of').textContent   = `of ${segments.length}`;
    document.getElementById('run-chain-pos').textContent    = `1 / ${segments.length}`;
    document.getElementById('run-clock').textContent        = fmt(seg0.duration);
    const ring = document.getElementById('run-ring-fill');
    ring.style.stroke = colorHex(seg0.color);
    // Reset the ring to empty — when another chain is running its last
    // painted dashoffset would otherwise bleed into this preview.
    const circ = (2 * Math.PI * 92).toFixed(2);
    ring.style.strokeDasharray  = circ;
    ring.style.strokeDashoffset = circ;
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
    // Chip strip: delegate to renderRunChips — it hides the strip when
    // nothing else is running (classic single-chain prestart) and keeps
    // it visible during an inline prestart over an active session.
    UI.renderRunChips();
  },

  prestartIv: null,
  // v1.4.11 — inline prestart state. prestartPendingChain is the chain
  // counting down inline (another chain already running); while set and
  // not "yielded", the run view shows the pending chain's preview and
  // the focused run's repaints are gated off. prestartYielded flips true
  // when the user taps a running chain's chip mid-countdown — the view
  // returns to that run and the pending chain will start in the
  // background when the countdown fires.
  prestartPendingChain: null,
  prestartYielded: false,
  prestartN: 3,

  cancelPrestart() {
    if (this.prestartIv) { clearInterval(this.prestartIv); this.prestartIv = null; }
    // Retire the first-run Skip snackbar along with the countdown it
    // belongs to (natural completion, abort, or a superseding start).
    if (this._prestartSnack) { this._prestartSnack.dismiss(); this._prestartSnack = null; }
    const overlay = document.getElementById('run-prestart');
    if (overlay) overlay.hidden = true;
    if (this.prestartPendingChain) {
      this.prestartPendingChain = null;
      this.prestartYielded = false;
      const clock = document.getElementById('run-clock');
      if (clock) clock.classList.remove('is-prestart');
      // Drop the pending chip. If the chain is about to actually start,
      // onRunsChange re-renders right after with its real chip.
      this.renderRunChips();
    }
  },

  // Paint one inline-countdown frame. The pending chip's clock always
  // updates (it stays visible even when the user yields focus back to a
  // running chain); the big clock / eyebrow only while the pending
  // chain's preview is what's displayed.
  _paintInlinePrestart(n) {
    const chipClock = document.getElementById('run-chip-pending-clock');
    if (chipClock) chipClock.textContent = fmt(n);
    if (UI.prestartYielded) return;
    const clock = document.getElementById('run-clock');
    clock.classList.add('is-prestart');
    clock.textContent = n;
    document.getElementById('run-segment-tag').textContent = 'Get ready';
    document.getElementById('run-segment-of').textContent  = '';
  },

  runPrestart(chain, opts = {}) {
    UI.cancelPrestart();
    const inline = !!opts.inline;
    let n = 3;
    if (inline) {
      UI.prestartPendingChain = chain;
      UI.prestartYielded = false;
      UI.prestartN = n;
      UI.renderRunChips();
      UI._paintInlinePrestart(n);
    } else {
      const overlay = document.getElementById('run-prestart');
      overlay.hidden = false;
      document.getElementById('run-prestart-num').textContent = n;
    }
    // Prestart's own audible/vibration ticks resolve at chain level
    // (segment hasn't started yet), so they ride on chain.cues.sound /
    // chain.cues.vibrate. Captured once at countdown start — the user
    // can't realistically toggle settings mid-countdown.
    const sound   = effectiveCue(null, chain, 'sound');
    const vibrate = effectiveCue(null, chain, 'vibrate');
    if (sound)   Audio.prestart(false);
    if (vibrate) Vibe.do(50);
    // End of the countdown — shared by the interval firing naturally
    // and the first-run "Skip" actions below. If the user hopped back
    // to a running chain mid-countdown, start this one in the
    // background instead of yanking focus.
    const finish = () => {
      const yielded = UI.prestartYielded;
      UI.cancelPrestart();
      Engine.startChain(chain, { focus: !yielded });
    };
    // v1.4.12 — before a chain's VERY FIRST start, offer to skip the
    // countdown (once now, or always — the latter records the same
    // app-level preference as the settings toggle). Chains that have
    // run before don't get the offer, so a stray tap can't change
    // settings on a chain the user already knows.
    if (!Store.getChain(chain.id)?.hasRun) {
      UI._prestartSnack = Toast.action('Pre-start countdown', {
        duration: 4000,
        actions: [
          { label: 'Skip', onAction: () => finish() },
          { label: 'Always skip', onAction: () => {
              Store.setSetting('prestart', false);
              finish();
            } },
        ],
      });
    }
    UI.prestartIv = setInterval(() => {
      n--;
      if (n > 0) {
        UI.prestartN = n;
        if (inline) UI._paintInlinePrestart(n);
        else document.getElementById('run-prestart-num').textContent = n;
        if (sound)   Audio.prestart(n === 1);
        if (vibrate) Vibe.do(n === 1 ? 100 : 50);
      } else {
        finish();
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
          <div class="template-card-time">${escape(fmtLong(expandedDur))}</div>
        </div>
        <div class="template-card-desc">${escape(tpl.desc)}</div>
        <div class="template-card-segments"></div>
      `;
      const segWrap = li.querySelector('.template-card-segments');
      tpl.segments.forEach(s => {
        const pill = document.createElement('span');
        pill.className = 'template-pill';
        pill.textContent = `${s.name} · ${fmtLong(s.duration)}`;
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
    // v1.4.7 — chain NAME stays editable even while running. It's a
    // pure display label; changing it doesn't touch the segment array,
    // the voice cache, or the elapsed-time bookkeeping. The rest of
    // the editor still locks (see [data-locked=true] rules in CSS) so
    // segments / loops / colors can't be swapped mid-run.
    nameInput.disabled = false;

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
    // Editor TOTAL is always three-part HH:MM:SS so an at-a-glance
    // comparison across chains has a fixed shape. Segment durations,
    // the chain-card total, and the run-view clock keep their own
    // (compact / no-zero-parts) formats.
    document.getElementById('editor-total').textContent = fmtHHMMSS(total);
    document.getElementById('editor-count').textContent = expandChain(draft).length;
    document.getElementById('editor-loops').textContent = draft.loops || 1;

    // segments
    const list = document.getElementById('segment-list');
    list.innerHTML = '';
    draft.segments.forEach((seg, idx) => {
      list.appendChild(UI._renderSegmentRow(seg, idx));
    });
    UI._syncEditorHint();
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
        <input type="text" class="segment-name-input" value="${escape(seg.name || '')}" placeholder="Name" maxlength="48" />
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
      // v1.4.13 — first-run affordance. A brand-new chain opens on a
      // dozen controls, but the one thing everybody wants first is the
      // duration; beta feedback was that finding it costs a beat of
      // thought. So we POINT at it rather than auto-opening the picker
      // (which would cover the segment list some users want to build
      // out first). Only on a never-saved chain whose first segment is
      // still untouched, and it stops as soon as the picker is opened.
      if (UI._shouldHintDuration(idx, seg)) dur.classList.add('is-hinted');
      // v1.4.8 — same "1h 5m 30s" no-zero-padding format used across
      // the rest of the app. The previous fmtSegDurationHTML style
      // ("01m 00s") wasted characters on unused units and read as
      // strangely formal for a plain button label.
      dur.textContent = fmtLong(seg.duration);
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

  // v1.4.13 — should the first-run "set the duration" pointer show on
  // this row? Only for the FIRST segment of a chain that has never been
  // saved and is still exactly as newChain() created it (default
  // duration, no name). Editing an existing chain never hints: those
  // users already know where the control is.
  durationHintUsed: false,
  DEFAULT_SEGMENT_SECONDS: 60,

  _shouldHintDuration(idx, seg) {
    if (UI.durationHintUsed) return false;
    if (idx !== 0 || !seg || seg.kind === 'subchain') return false;
    if (Editor.draftId) return false;                       // existing chain
    if ((seg.name || '').trim()) return false;              // already customised
    return seg.duration === UI.DEFAULT_SEGMENT_SECONDS;
  },

  /** Point the editor's tip line at the duration while the hint is up. */
  _syncEditorHint() {
    const el = document.getElementById('editor-hint');
    if (!el) return;
    const seg = Editor.draft?.segments?.[0];
    const hinting = !!seg && UI._shouldHintDuration(0, seg);
    el.classList.toggle('is-pointing', hinting);
    el.textContent = hinting
      ? 'Start here: tap the highlighted duration to set how long this segment runs.'
      : 'Tip: drag the handle to reorder segments. Tap the color dot to change hue, or the bell to override cues.';
  },

  renderLibraryStatsOnly() {
    if (!Editor.draft) return;
    const total = chainTotalSeconds(Editor.draft);
    document.getElementById('editor-total').textContent = fmtHHMMSS(total);
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

  // ------- Duration picker (v1.4.7 Pixel-Clock numpad) -------
  //
  // State: dpickDigits is a 6-character string of decimal digits in
  // HHMMSS order — "000030" = 30 seconds, "013000" = 1h 30m 00s. Digit
  // keypresses shift the string left and append the new digit in the
  // ones slot. Backspace shifts right and prepends a 0. Presets and
  // "seed from existing segment" write directly to a total-seconds
  // value which we then re-encode into the 6-digit string.
  //
  // Why HHMMSS and not just a total-seconds int? Because Pixel Clock's
  // model *is* digit-based — typing 999 gives you 0h 09m 99s, not
  // 10m 39s. Users know that model. If we normalised on every keypress
  // the display would jump around unhelpfully as digits push through.
  // We normalise ONLY at commit time (99s → 1m 39s).

  durationTarget: null,
  dpickDigits: '000000',
  dpickPristine: true,  // first keypress replaces the seed value entirely

  openDurationPicker(seg) {
    // The user has found the duration control — retire the first-run
    // hint for the rest of this session, whatever value they end up
    // committing (including leaving it at the default).
    UI.durationHintUsed = true;
    UI.durationTarget  = seg;
    UI.dpickPristine   = true;
    UI._setDpickFromSeconds(Math.max(0, seg.duration | 0));
    document.getElementById('duration-sheet').hidden = false;
  },

  closeDurationPicker() {
    document.getElementById('duration-sheet').hidden = true;
    UI.durationTarget = null;
  },

  // Encode a seconds count back into the 6-digit HHMMSS string.
  // Overflow of the hour tens digit (100h+) clamps to 9 — the numpad
  // can't type more than 9h anyway (single-digit hours in the display).
  // For editing existing segments we want to show the true value, so
  // we do allow the h-tens position to hold >0 briefly here — the
  // display formatter handles multi-digit hours.
  _setDpickFromSeconds(total) {
    total = Math.max(0, Math.min(99 * 3600 + 59 * 60 + 59, total));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad2 = (n) => String(Math.min(99, n)).padStart(2, '0');
    UI.dpickDigits = pad2(h) + pad2(m) + pad2(s);
    UI._renderDpick();
  },

  // Read the 6-digit string as HH*3600 + MM*60 + SS. Doesn't clamp
  // MM/SS to 59 — Pixel Clock accepts "0h 90m 90s" as literal
  // 90m + 90s = 91.5m; we mirror that on commit.
  _getDpickSeconds() {
    const d = UI.dpickDigits.padStart(6, '0');
    const h = parseInt(d.slice(0, 2), 10) || 0;
    const m = parseInt(d.slice(2, 4), 10) || 0;
    const s = parseInt(d.slice(4, 6), 10) || 0;
    return h * 3600 + m * 60 + s;
  },

  _renderDpick() {
    const d = UI.dpickDigits.padStart(6, '0');
    const h  = parseInt(d.slice(0, 2), 10) || 0;
    const mm = d.slice(2, 4);
    const ss = d.slice(4, 6);
    // Display: hours as 1-2 digits (drop leading zero), minutes/seconds
    // always 2 digits. Matches Pixel Clock's shape.
    const hStr = String(h);
    document.getElementById('dpick-disp-h').textContent = hStr;
    document.getElementById('dpick-disp-m').textContent = mm;
    document.getElementById('dpick-disp-s').textContent = ss;

    // Dim zero-parts; brighten the "cursor" part (rightmost non-zero,
    // or seconds if all zero). Purely visual.
    const parts = document.querySelectorAll('#dpick-display .dpick-part');
    parts.forEach(p => p.classList.remove('is-zero', 'is-cursor'));
    const [pH, pM, pS] = parts;
    const secsV = parseInt(ss, 10) || 0;
    const minsV = parseInt(mm, 10) || 0;
    if (h === 0)                        pH.classList.add('is-zero');
    if (h === 0 && minsV === 0)         pM.classList.add('is-zero');
    // cursor lights up on the highest-order populated slot
    if (h > 0)                          pH.classList.add('is-cursor');
    else if (minsV > 0)                 pM.classList.add('is-cursor');
    else                                pS.classList.add('is-cursor');
  },

  // Digit keypress — Pixel-Clock shift-left model. If this is the FIRST
  // press after opening the picker (dpickPristine), clear the seed
  // value first so the user retypes from scratch. Presets bypass this
  // and add on top.
  dpickPressDigit(digit) {
    if (UI.dpickPristine) {
      UI.dpickDigits = '000000';
      UI.dpickPristine = false;
    }
    const d = UI.dpickDigits.padStart(6, '0');
    // Shift left by 1; append the new digit. If we're already at
    // 6 non-zero digits, the leading digit falls off — that's the
    // Pixel behaviour and matches the "you can't overflow the display"
    // mental model. Cap at 99h 59m 59s at commit.
    UI.dpickDigits = (d.slice(1) + digit);
    UI._renderDpick();
  },

  // "00" key — two shifts, appending two zeros. Same overflow rule.
  dpickPressDoubleZero() {
    if (UI.dpickPristine) {
      UI.dpickDigits = '000000';
      UI.dpickPristine = false;
    }
    const d = UI.dpickDigits.padStart(6, '0');
    UI.dpickDigits = (d.slice(2) + '00');
    UI._renderDpick();
  },

  // Backspace — shift right, prepend a zero. Also marks non-pristine
  // so a subsequent digit doesn't clobber the (deliberately-shortened)
  // value.
  dpickPressBack() {
    UI.dpickPristine = false;
    const d = UI.dpickDigits.padStart(6, '0');
    UI.dpickDigits = ('0' + d.slice(0, 5));
    UI._renderDpick();
  },

  // Preset chip — ADD `secs` to whatever's currently entered. Presets
  // don't respect the "pristine" flag: we want tapping "+1m" after
  // opening a 30s segment to actually give 1m 30s, not clobber the
  // seed. But mark non-pristine so a subsequent digit-key press
  // extends the value instead of replacing it.
  dpickAddPreset(secs) {
    UI.dpickPristine = false;
    const total = Math.min(99 * 3600 + 59 * 60 + 59, UI._getDpickSeconds() + secs);
    UI._setDpickFromSeconds(total);
  },

  commitDurationPicker() {
    if (!UI.durationTarget) return;
    let total = UI._getDpickSeconds();
    if (total < 1) total = 1;
    // Cap at 24h - 1 for safety even though numpad can't type that
    // via digit-shift alone (max 99h 59m 59s).
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
    const ringDndEl = document.getElementById('setting-ring-through-dnd');
    if (ringDndEl) ringDndEl.checked = !!s.ringThroughDnd;
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

    // v1.4.4: version footer above the credit line. If a newer release
    // is known (Updater has run and cached a "newer" verdict), append a
    // tappable "Update available" pill that opens the store URL / Play
    // in-app flow.
    const verEl = document.getElementById('setting-version');
    if (verEl) {
      let html = `Version ${escape(APP_VERSION)}`;
      if (Updater.hasUpdate()) {
        // "Update available" instead of a version number when the Play
        // channel doesn't give us a name — spelling out "code N" is more
        // confusing than useful.
        const label = Updater._channel === 'play' ? 'Update available' :
                      `↑ ${escape(Updater.latestVersion() || 'newer')} available`;
        html += ` <a class="setting-version-update" href="#" data-open-update="1">${label}</a>`;
      }
      verEl.innerHTML = html;
      const updateLink = verEl.querySelector('[data-open-update]');
      if (updateLink) {
        updateLink.addEventListener('click', (e) => {
          e.preventDefault();
          Updater.openStore();
        });
      }
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
    const keys = isChain ? CUE_KEYS : SEGMENT_SHEET_KEYS;

    // Copy is scope-aware. A chain-level override governs every segment
    // AND the chain's own start/end cues, so its wording talks about
    // boundaries in the plural. A SEGMENT-level override can only ever
    // affect that one segment — mentioning "chain start/end" there was
    // describing behaviour the row couldn't control. Same for the
    // vibrate row: it is "Buzz cues" at every scope now (it used to be
    // "When a segment ends" at chain/app level, which read as a scope
    // selector rather than a cue name). Only the hint differs — chain
    // and app scope cover every boundary, a segment covers just itself.
    const CUE_META = isChain ? {
      sound:     { title: 'Sound cues',           hint: 'Chime when a segment ends and at chain start/end.' },
      finalTick: { title: 'Final 3 seconds tick', hint: 'Three quick tones counting down the last 3s.', requires: 'sound' },
      voice:     { title: 'Voice cues',           hint: 'Speak each segment name aloud as it begins.' },
      vibrate:   { title: 'Buzz cues',            hint: 'Buzz at every segment boundary and at chain end.' },
      prestart:  { title: 'Pre-start countdown',  hint: '3-2-1 before the chain starts.' },
    } : {
      sound:     { title: 'Sound cue',            hint: 'Chime when this segment ends.' },
      finalTick: { title: 'Final 3 seconds tick', hint: "Three quick tones counting down this segment's last 3s.", requires: 'sound' },
      ringUntilDismissed: {
        title: 'Ring until dismissed',
        hint: 'Keep ringing at the end of this segment; the chain waits here until you tap Dismiss.',
        requires: 'sound',
        binary: true,
      },
      voice:     { title: 'Voice cue',            hint: "Speak this segment's name aloud as it begins." },
      vibrate:   { title: 'Buzz cue',             hint: 'Vibrate when this segment ends.' },
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
      pill.className = 'cue-pill' + (meta.binary ? ' is-binary' : '');
      pill.setAttribute('role', 'radiogroup');
      pill.setAttribute('aria-label', meta.title);
      // Binary cues have no inherited state, so "selected" is just the
      // stored boolean (absent = off) rather than the tri-state.
      const selectedState = meta.binary
        ? (current ? 'on' : 'off')
        : (current == null ? 'default' : current ? 'on' : 'off');
      const mkBtn = (state, label, subLabel) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.state = state;
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-pressed', String(state === selectedState));
        b.innerHTML = subLabel
          ? `${escape(label)}<span class="pill-default-inherit">${escape(subLabel)}</span>`
          : escape(label);
        b.addEventListener('click', () => {
          // Binary: store true, or clear the key entirely for off — an
          // absent key is the default, so chains stay clean on export.
          if (meta.binary)         setCueOverride(holder, key, state === 'on' ? true : null);
          else if (state === 'default') setCueOverride(holder, key, null);
          else                     setCueOverride(holder, key, state === 'on');
          // Refresh just this row's pill states (cheap full re-render keeps
          // it simple; the dependent finalTick sub-row's visibility may
          // also change if `sound` was just toggled).
          UI._openCueSheet(scope, holder, chainContext, onChange);
          if (onChange) onChange();
        });
        return b;
      };
      if (!meta.binary) pill.appendChild(mkBtn('default', 'Default', inheritedLabel));
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

  // Safe setter for the run-view topbar chain-name label. The label is
  // a <button> by default (v1.4.9 inline rename), but is briefly
  // replaced by an <input> while the user is renaming. Any refresh
  // that lands during editing must NOT clobber their in-flight value.
  _setRunChainName(text) {
    const el = document.getElementById('run-chain-name');
    if (!el) return;             // input has no ID during rename
    if (el.tagName === 'INPUT') return; // don't stomp user typing
    el.textContent = text || '—';
  },

  // v1.4.13 — reflect the ring-until-dismissed gate in the run view:
  // swap the transport row for a Dismiss bar, pin the clock at 00:00,
  // and tint the view. Called from renderRun / updateRunSegmentInfo and
  // whenever a run enters or leaves the gate.
  _syncAlarmUI() {
    const run = Engine._focused;
    const held = !!run?.awaitingDismiss;
    const bar = document.getElementById('run-dismiss-bar');
    const controls = document.querySelector('.run-controls');
    const view = document.querySelector('.view-run');
    if (bar) bar.hidden = !held;
    if (controls) controls.hidden = held;
    if (view) view.classList.toggle('is-alarm', held);
    if (held) {
      const seg = run.segments[run.currentIndex];
      const isLast = run.currentIndex >= run.segments.length - 1;
      const label = document.getElementById('run-dismiss-label');
      if (label) {
        label.textContent = isLast
          ? `${run.chain?.name || 'Chain'} complete`
          : `${seg?.name || 'Segment'} done`;
      }
      const clock = document.getElementById('run-clock');
      if (clock) clock.textContent = fmt(0);
    }
  },

  // Same contract for the big segment title (a <button> since v1.4.12,
  // briefly an <input> during inline rename).
  _setRunSegmentName(text) {
    const el = document.getElementById('run-segment-name');
    if (!el || el.tagName === 'INPUT') return;
    el.textContent = text || '—';
  },

  // v1.4.12 — commit a segment rename from the run view. The expanded
  // segment carries srcChainId/srcSegId (see expandChain), so the write
  // targets the OWNING Store segment — which for an embedded subchain is
  // the subchain's own segment, exactly what the editor would edit. The
  // new name then fans out to every expanded instance in every live run
  // (loops repeat the source segment; two concurrent runs can share it),
  // each of which re-persists its snapshot and, on native, re-renders
  // its voice files + refreshes the FGS notification. The immediate
  // fgsupdate carries the new name to the notification right away; the
  // second one (after prerenderForChain resolves) swaps in the new TTS
  // paths — mirroring the start() sequence.
  _renameSegmentEverywhere(srcChainId, srcSegId, newName) {
    const srcChain = Store.getChain(srcChainId);
    const srcSeg = srcChain?.segments?.find(s => s && s.id === srcSegId);
    if (!srcSeg) return false;
    srcSeg.name = newName;
    srcChain.updatedAt = Date.now();
    Store.save();
    for (const run of Engine._runs.values()) {
      let touched = false;
      run.segments.forEach(es => {
        if (es.srcChainId === srcChainId && es.srcSegId === srcSegId) {
          es.name = newName;
          es.hasName = true;
          touched = true;
        }
      });
      if (!touched) continue;
      run._persist();
      if (run.isRunning && window.ChainedNative?.isNative) {
        run._emit('chain:fgsupdate');
        const willAnyVoiceFire = run.segments.some(s => effectiveCue(s, run.chain, 'voice'));
        if (willAnyVoiceFire) {
          Voice.prerenderForChain(run.segments, run.id).then(() => {
            if (run.isRunning) run._emit('chain:fgsupdate');
          });
        }
      }
    }
    return true;
  },

  renderRun() {
    // v1.4.11 — while an inline prestart preview is displayed, the run
    // view belongs to the pending chain; don't repaint the focused run
    // over it. (Yielding focus via a chip tap clears the gate.)
    if (UI.prestartPendingChain && !UI.prestartYielded) {
      UI.renderRunChips();
      return;
    }
    if (!Engine.chain) return;
    UI._setRunChainName(Engine.chain.name);
    UI.updateRunSegmentInfo();
    // v1.4.8 — seed the clock with the REAL current-segment remaining
    // time, not the full segment duration. Previously we always passed
    // `duration, 0` here, which meant that leaving the run view (chain
    // paused, or ticking in the background) and coming back would
    // paint the clock at its initial value for a frame; on a paused
    // chain that stale frame was permanent because the tick loop
    // doesn't run while paused. Compute it the same way the chip strip
    // and the library inline status do.
    const run = Engine._focused;
    const cur = Engine.segments[Engine.currentIndex];
    if (run && cur) {
      const remaining = Math.max(0, cur.duration - run._elapsedMs() / 1000);
      const elapsed   = Math.max(0, cur.duration - remaining);
      UI.updateRunClock(cur, remaining, elapsed);
    } else if (cur) {
      UI.updateRunClock(cur, cur.duration, 0);
    }
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
    // v1.4.11 — a chain counting down inline gets a "pending" chip, so
    // the strip shows during an inline prestart even with one real run.
    const pending = UI.prestartPendingChain;
    if (runs.length + (pending ? 1 : 0) <= 1) {
      wrap.hidden = true;
      wrap.innerHTML = '';
      return;
    }
    wrap.hidden = false;
    wrap.innerHTML = '';
    const focusedId = Engine.focusedRunId();
    // While the pending chain's preview is displayed, no running chip is
    // "focused" — the pending chip carries the highlight instead.
    const previewShown = !!pending && !UI.prestartYielded;
    runs.forEach(run => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'run-chip'
        + (run.id === focusedId && !previewShown ? ' is-focused' : '')
        + (run.isPaused                          ? ' is-paused'  : '');
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
      chip.addEventListener('click', () => {
        if (UI.prestartPendingChain && !UI.prestartYielded) {
          // Hopping back to a running chain mid-countdown: the pending
          // chain still starts when the countdown fires, but in the
          // background. Engine.focus may no-op (the run never lost
          // engine focus), so repaint explicitly.
          UI.prestartYielded = true;
          Engine.focus(run.id);
          UI.renderRun();
        } else {
          Engine.focus(run.id);
        }
      });
      // Long-press a chip to stop that specific run.
      UI._wireChipLongPress(chip, run);
      wrap.appendChild(chip);
    });
    if (pending) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'run-chip is-pending' + (previewShown ? ' is-focused' : '');
      const dot   = document.createElement('span'); dot.className = 'run-chip-dot';
      const name  = document.createElement('span'); name.className = 'run-chip-name';
      name.textContent = pending.name || 'Chain';
      const clock = document.createElement('span'); clock.className = 'run-chip-clock';
      clock.id = 'run-chip-pending-clock';
      clock.textContent = fmt(UI.prestartN);
      chip.appendChild(dot);
      chip.appendChild(name);
      chip.appendChild(clock);
      // Tapping the pending chip after yielding returns to its preview.
      chip.addEventListener('click', () => {
        if (!UI.prestartPendingChain || !UI.prestartYielded) return;
        UI.prestartYielded = false;
        UI._renderRunForChain(UI.prestartPendingChain);
        UI._paintInlinePrestart(UI.prestartN);
      });
      wrap.appendChild(chip);
    }
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
    // Gated during an inline prestart preview — see renderRun.
    if (UI.prestartPendingChain && !UI.prestartYielded) return;
    const seg = Engine.segments[Engine.currentIndex];
    if (!seg) return;
    UI._setRunChainName(Engine.chain?.name);
    UI._setRunSegmentName(seg.name);
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

    UI._syncAlarmUI();
  },

  updateRunClock(seg, remainingSec, elapsedSec) {
    if (!seg) return;
    // Gated during an inline prestart preview: the focused run keeps
    // ticking behind it, so still ride its tick to keep the background
    // chip clocks live — but don't let it repaint the main clock/ring.
    if (UI.prestartPendingChain && !UI.prestartYielded) {
      UI._updateRunChipClocks();
      return;
    }
    // A run held at a ringing gate is finished with this segment: pin
    // the clock at zero rather than letting a stray tick paint a stale
    // remaining time behind the Dismiss bar.
    const r = Engine._focused?.awaitingDismiss
      ? 0
      : (remainingSec == null ? Math.max(0, seg.duration - elapsedSec) : remainingSec);
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
    // Same CEILING convention as the main clock above — fmt() rounds, so
    // passing the raw fractional remaining here made the two labels
    // disagree by one second half the time (clock 04:36 vs "04:35
    // remaining" on a single-segment chain). Elapsed is derived as the
    // complement so elapsed + remaining always sums to the chain total.
    const totalRemDisplay = Math.ceil(totalRem);
    document.getElementById('run-elapsed').textContent  = `${fmt(Math.max(0, totalChain - totalRemDisplay))} elapsed`;
    document.getElementById('run-remaining').textContent = `${fmt(totalRemDisplay)} remaining`;

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
    // to redraw. (During an inline prestart the strip shows even with a
    // single run — the pending chip makes two — so update then too.)
    if (Engine._runs.size > 1 || UI.prestartPendingChain) UI._updateRunChipClocks();
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
    // v1.4.5: same piggyback for the library's inline status cards.
    // Guarded internally against the library view being hidden.
    UI._refreshRunningCards();
  },

  // v1.4.5: build one inline status card for a running chain. Appended
  // as a sibling <li> immediately after the parent chain-card by
  // renderLibrary. Structural rebuild only — the mutable text (clock,
  // paused icon, segment counter, next label) is refreshed in place by
  // _refreshRunningCards on both the focused-run tick AND a 500ms
  // interval that runs while the library view is visible with any
  // running chain (fixes the "frozen countdown" bug where background
  // runs' clocks stopped updating).
  _buildInlineStatusCard(run) {
    const li = document.createElement('li');
    li.className = 'chain-status-card' + (run.isPaused ? ' is-paused' : '');
    li.dataset.chainId = run.id;

    const stripe = document.createElement('div');
    stripe.className = 'chain-status-stripe';
    stripe.style.background = colorHex(run.chain?.color) || 'var(--accent)';

    const body = document.createElement('div');
    body.className = 'chain-status-body';

    const cur     = run.segments[run.currentIndex];
    const next    = run.segments[run.currentIndex + 1];
    const curName = cur?.name || 'Segment';
    const nextName = next?.name || null;

    const line1 = document.createElement('div');
    line1.className = 'chain-status-line1';
    line1.innerHTML =
      `<span class="status-icon">${run.isPaused ? '⏸' : '▶'}</span>` +
      `<span class="status-seg">${escape(curName)}</span>`;
    body.appendChild(line1);

    const line2 = document.createElement('div');
    line2.className = 'chain-status-line2';
    line2.innerHTML =
      `<span class="status-pos">Segment ${run.currentIndex + 1} of ${run.segments.length}</span>` +
      (nextName ? `<span class="status-sep">·</span><span class="status-next">next: ${escape(nextName)}</span>` : '');
    body.appendChild(line2);

    const clock = document.createElement('div');
    clock.className = 'status-clock';
    const remaining = cur ? Math.max(0, cur.duration - run._elapsedMs() / 1000) : 0;
    clock.textContent = fmt(Math.ceil(remaining));

    li.appendChild(stripe);
    li.appendChild(body);
    li.appendChild(clock);

    // Tap → focus that run and open its run view.
    li.addEventListener('click', () => {
      Engine.focus(run.id);
      View.show('run');
    });
    // Swipe-to-stop wiring lives in _wireSwipeToStop; called for both
    // the chain card and the status card below to catch either target.
    UI._wireSwipeToStop(li, run.id);
    return li;
  },

  // Refresh mutable text on every inline status card. Cheap: text-only.
  // Called from three paths:
  //   - The focused run's per-tick _updateRunChipClocks (kept live like before)
  //   - The 500ms interval started/stopped by _startLibraryTicker
  //   - Engine.onRunsChange (structural change — but that triggers a full
  //     renderLibrary anyway; this one is defensive).
  _refreshRunningCards() {
    const list = document.getElementById('chain-list');
    if (!list) return;
    // Only walk the DOM if the library view is currently visible (saves
    // some layout when the user is deep in a run view).
    const libView = document.querySelector('.view-library');
    if (libView && libView.hidden) return;
    const cards = list.querySelectorAll('.chain-status-card');
    cards.forEach(card => {
      const id  = card.dataset.chainId;
      const run = Engine.runById(id);
      if (!run) return;
      const cur = run.segments[run.currentIndex];
      const remaining = cur ? Math.max(0, cur.duration - run._elapsedMs() / 1000) : 0;
      const clock = card.querySelector('.status-clock');
      if (clock) clock.textContent = fmt(Math.ceil(remaining));
      card.classList.toggle('is-paused', !!run.isPaused);
      const icon = card.querySelector('.status-icon');
      if (icon) icon.textContent = run.isPaused ? '⏸' : '▶';
      // Cover auto-advance while user is on library: segment name +
      // position + next-label update in place. A structural change
      // (run added / removed) re-renders the whole library via
      // Engine.onRunsChange.
      const seg = card.querySelector('.status-seg');
      if (seg && cur) seg.textContent = cur.name || 'Segment';
      const pos = card.querySelector('.status-pos');
      if (pos) pos.textContent = `Segment ${run.currentIndex + 1} of ${run.segments.length}`;
      const nxt = card.querySelector('.status-next');
      const nextSeg = run.segments[run.currentIndex + 1];
      if (nxt) nxt.textContent = nextSeg ? `next: ${nextSeg.name || 'segment'}` : '';
    });
  },

  // 500ms interval refresher — starts when the library view becomes
  // visible AND at least one chain is running; stops as soon as either
  // condition flips false. Cheap self-terminating polling avoids the
  // rAF-only path (which only ticks for the focused run — background
  // runs' clocks used to freeze on the library view).
  _libraryTickIv: null,
  _startLibraryTicker() {
    if (UI._libraryTickIv) return;
    UI._libraryTickIv = setInterval(() => {
      const libHidden = document.querySelector('.view-library')?.hidden;
      if (libHidden || Engine.activeRunningCount() === 0) {
        UI._stopLibraryTicker();
        return;
      }
      UI._refreshRunningCards();
    }, 500);
  },
  _stopLibraryTicker() {
    if (UI._libraryTickIv) { clearInterval(UI._libraryTickIv); UI._libraryTickIv = null; }
  },
  _maybeStartLibraryTicker() {
    const libHidden = document.querySelector('.view-library')?.hidden;
    if (!libHidden && Engine.activeRunningCount() > 0) UI._startLibraryTicker();
    else UI._stopLibraryTicker();
  },

  // v1.4.5 — swipe-to-stop gesture on running-chain rows (Task 4).
  //
  // Horizontal drag > SWIPE_STOP_THRESHOLD_PX in either direction on a
  // running chain card (or its inline status card) triggers a confirm
  // dialog and stops that chain. Feels like the email-swipe-to-delete
  // pattern users know. Only armed on RUNNING chains; on non-running
  // ones the gesture is inert so the swipe doesn't fight the vertical
  // scroll or the long-press for select mode.
  SWIPE_STOP_THRESHOLD_PX: 100,

  _wireSwipeToStop(el, runId) {
    if (!el || !runId) return;
    let startX = 0, startY = 0, tracking = false, armed = false, dragged = 0;
    // Only respond to primary button (not right-click) and skip when the
    // pointer starts on an interactive descendant (play button, etc.) so
    // the swipe doesn't steal the tap target.
    const isInteractive = (n) => !!n.closest('button:not(.chain-status-card):not(.chain-card), input, .chain-card-select-tick');
    // Card we visually drag (parent chain-card + its status card slide
    // together, so we grab both and translate them as one unit).
    const parentCard = el.classList.contains('chain-card')
      ? el
      : el.previousElementSibling;
    const statusCard = el.classList.contains('chain-status-card')
      ? el
      : el.nextElementSibling?.classList?.contains('chain-status-card') ? el.nextElementSibling : null;
    const dragTargets = [parentCard, statusCard].filter(Boolean);

    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (isInteractive(e.target)) return;
      // Only chains that are currently running are swipe-stoppable.
      if (!Engine.isChainRunning(runId)) return;
      tracking = true;
      armed = false;
      dragged = 0;
      startX = e.clientX;
      startY = e.clientY;
    });
    el.addEventListener('pointermove', (e) => {
      if (!tracking) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      // Vertical scroll intent — abandon swipe.
      if (Math.abs(dy) > 20 && Math.abs(dy) > Math.abs(dx)) {
        tracking = false; armed = false; dragged = 0;
        dragTargets.forEach(t => { t.style.transform = ''; t.classList.remove('is-swiping', 'is-swipe-stop-armed'); });
        return;
      }
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        dragged = dx;
        // Clamp visual translation so it's obviously a gesture, not a full slide-out.
        const shown = Math.max(-160, Math.min(160, dx));
        dragTargets.forEach(t => {
          t.classList.add('is-swiping');
          t.style.transform = `translateX(${shown}px)`;
        });
        const nowArmed = Math.abs(dx) > UI.SWIPE_STOP_THRESHOLD_PX;
        if (nowArmed !== armed) {
          armed = nowArmed;
          dragTargets.forEach(t => t.classList.toggle('is-swipe-stop-armed', armed));
        }
      }
    });
    const endSwipe = () => {
      const commit = tracking && armed;
      tracking = false;
      armed = false;
      dragTargets.forEach(t => {
        t.style.transform = '';
        t.classList.remove('is-swiping', 'is-swipe-stop-armed');
      });
      const dxAbs = Math.abs(dragged);
      dragged = 0;
      if (!commit) return;
      const run = Engine.runById(runId);
      if (!run) return;
      const name = run.chain?.name || 'this chain';
      if (confirm(`Stop "${name}"?`)) {
        Engine.stopRun(runId);
      }
      // Suppress the click event Chrome fires after a long pointerdown/up
      // when we've decided the gesture was a swipe. Not strictly needed
      // (isInteractive gate on the click handler would kick in) but
      // defensive so the tap-to-focus doesn't fire concurrently.
      void dxAbs;
    };
    el.addEventListener('pointerup',     endSwipe);
    el.addEventListener('pointercancel', endSwipe);
    el.addEventListener('pointerleave',  endSwipe);
  },

  // ------- Update modal -------
  //
  // Called from Updater.maybePromptOnLaunch (native only, deferred a bit
  // so it doesn't compete with the first paint / native bridge init).
  // Also usable directly from Settings if the user taps the "↑ vX.Y.Z"
  // hint (though we route that to openStore() directly for a shorter
  // flow — the modal is the "first time we tell them" moment).
  showUpdateModal(latestVersion) {
    const modal = document.getElementById('update-modal');
    if (!modal) return;
    const versEl = document.getElementById('update-modal-versions');
    if (versEl) {
      // Play channel doesn't hand us a semver — just an internal version
      // code — so we show "v1.4.4 → newer version" instead of "v1.4.4 →
      // code 25". Sideload/GitHub channel keeps the semver-both-sides shape.
      const toLabel = Updater._channel === 'play' ? 'newer version' : `v${escape(latestVersion)}`;
      versEl.innerHTML =
        `<span class="from">v${escape(APP_VERSION)}</span>` +
        `<span class="arrow">→</span>` +
        `<span class="to">${toLabel}</span>`;
    }
    // Contextual hint reflects the update channel we actually resolved:
    //   play     → Play in-app flow launches (no page navigation)
    //   ios      → App Store listing
    //   other/   → GitHub Releases APK re-download
    //   sideload
    const hintEl = document.getElementById('update-modal-hint');
    if (hintEl) {
      const platform = window.Capacitor?.getPlatform?.() || 'web';
      if (Updater._channel === 'play') {
        hintEl.textContent = 'Downloads and installs the update in-app via the Play Store.';
      } else if (platform === 'ios') {
        hintEl.textContent = 'Opens the App Store listing.';
      } else {
        hintEl.textContent = 'Opens the GitHub Releases page — download the new APK and install it over the current one (your chains are preserved).';
      }
    }
    modal.hidden = false;
  },

  hideUpdateModal() {
    const modal = document.getElementById('update-modal');
    if (modal) modal.hidden = true;
  },

  showCompletion(totalSeconds) {
    document.getElementById('run-complete').hidden = false;
    document.getElementById('run-complete-time').textContent = fmtLong(totalSeconds);
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
  // v1.4.5 — Ring through DND toggle. Changing this while a chain is
  // running triggers a rebuild of the FGS MediaPlayer cue pool via the
  // next chain:fgsupdate emit (see EXTRA_RING_THROUGH_DND in the Java
  // service). If no chain is running, the setting just persists.
  const ringDndEl = document.getElementById('setting-ring-through-dnd');
  if (ringDndEl) {
    ringDndEl.addEventListener('change', () => {
      Store.setSetting('ringThroughDnd', !!ringDndEl.checked);
      // Refresh every active run so the change propagates immediately.
      Engine.activeRuns().forEach(r => { try { r._emit('chain:fgsupdate'); } catch {} });
    });
  }

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
    Toast.show('Chains exported', 'good');
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
      Toast.show('Chains imported', 'good');
      UI.closeSettings();
    } catch (err) {
      Toast.show('Import failed', 'warn');
    }
    e.target.value = '';
  });

  // editor name / loops
  document.getElementById('editor-name').addEventListener('input', e => {
    if (!Editor.draft) return;
    const v = e.target.value;
    Editor.draft.name = v;
    // v1.4.7 — when the chain is running, propagate the name change
    // immediately to the Store's chain object AND to the live run's
    // chain reference. We mutate in place (not upsertChain — that
    // would REPLACE the object and sever the run's reference), then
    // Store.save() persists. Refresh the topbar + chip strip so the
    // new name shows without waiting for the next tick.
    const draftId = Editor.draftId;
    if (draftId && Engine.isChainRunning(draftId)) {
      const storeChain = Store.getChain(draftId);
      if (storeChain) { storeChain.name = v; Store.save(); }
      const run = Engine._runs.get(draftId);
      if (run && run.chain) run.chain.name = v;
      UI._setRunChainName(v);
      UI.renderRunChips();
    }
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
    // Capture "was this a brand-new chain?" BEFORE saving — saveDraft
    // sets draftId, so afterwards every save looks like an edit.
    const wasNew = !Editor.draftId;
    const c = Editor.saveDraft();
    if (c) Toast.show('Chain saved', 'good');
    View.show('library');
    // New chains are appended, so on a long list the new row is below
    // the fold; scroll to it rather than leaving the library looking
    // untouched. Edits stay put — the user knows where that chain was.
    if (c && wasNew) UI.revealChain(c.id);
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

  // Duration picker (v1.4.7 Pixel-Clock numpad)
  // Digit / 00 / backspace keypad — all three route through the
  // UI.dpick* state helpers. See UI.openDurationPicker for the state
  // model rationale (why we hold HHMMSS as a 6-digit string rather
  // than a normalised total-seconds int).
  document.querySelectorAll('[data-dpick-key]').forEach(btn => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.dpickKey;
      if (k === 'back')       UI.dpickPressBack();
      else if (k === '00')    UI.dpickPressDoubleZero();
      else                    UI.dpickPressDigit(k);
    });
  });
  // Preset chips — ADD to current value (not replace). Prefix "+" on
  // the labels makes the behaviour explicit for the user.
  document.querySelectorAll('.chip[data-quick-add]').forEach(c => {
    c.addEventListener('click', () => {
      const n = parseInt(c.dataset.quickAdd, 10) || 0;
      if (n > 0) UI.dpickAddPreset(n);
    });
  });
  document.getElementById('dpick-confirm').addEventListener('click', () => UI.commitDurationPicker());

  // Back arrow in run topbar + left-swipe gesture on the run view: return
  // to the library, KEEPING every active chain running. The library now-
  // playing strip re-mounts on show so the user can jump back into a run
  // by tapping it. Symmetric with the way the browser's back button feels.
  //
  // v1.4.5: intentionally does NOT cancel a running prestart. If the user
  // tapped Start (which triggered the 3-2-1 overlay) and then decides to
  // go back to launch a second chain, the prestart interval keeps
  // counting down invisibly and Engine.startChain fires at the end just
  // like it would have. The user lands on the library and can start
  // additional chains immediately; when the prestart interval completes,
  // the running chain shows up in the now-playing list. run-stop (X)
  // still cancels the prestart because there the user's intent is
  // "abort this chain" not "navigate elsewhere".
  const goBackToLibraryKeepRunning = () => {
    if (View.current === 'library') return;
    UI.hideCompletion();
    // Hide the prestart overlay visually (the timer keeps running); we
    // don't want to see the '3-2-1' when we're navigating away.
    const preOv = document.getElementById('run-prestart');
    if (preOv && !preOv.hidden) preOv.hidden = true;
    View.show('library');
  };
  document.getElementById('run-back').addEventListener('click', goBackToLibraryKeepRunning);

  // v1.4.9 — inline rename of the FOCUSED chain from the run view.
  // Click the chain-name title (or the wrapping meta area) to swap it
  // for a text input; on Enter (or blur) we commit, on Escape we cancel.
  // Rename is safe mid-run: the segment plan / voice cache are keyed
  // by segment identity, not by chain name, so only the display label
  // changes. Update path:
  //
  //   1. Store's chain object — MUTATED IN PLACE (not upsertChain,
  //      which would replace the reference and orphan the running run's
  //      chain pointer). Then Store.save() persists.
  //   2. The running EngineRun's chain reference — same object usually,
  //      but set explicitly in case it isn't.
  //   3. Re-render the topbar text + chip strip so the change is
  //      visible immediately.
  //
  // We DELEGATE the click on .run-chain-meta rather than binding to the
  // button directly, because the click handler needs to survive the
  // button being replaceWith()-ed to the input and back.
  (() => {
    const meta = document.querySelector('.run-chain-meta');
    if (!meta) return;
    let editing = false;
    meta.addEventListener('click', (e) => {
      if (editing) return;
      const btn = e.target.closest('.run-chain-name');
      if (!btn || btn.tagName !== 'BUTTON') return;
      const chainId = Engine._focusedId;
      if (!chainId) return;
      const chain = Store.getChain(chainId);
      if (!chain) return;
      editing = true;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'run-chain-name-input';
      input.maxLength = 48;
      input.value = chain.name || '';
      input.setAttribute('aria-label', 'Chain name');
      btn.replaceWith(input);
      // requestAnimationFrame so focus + select land after the DOM swap.
      requestAnimationFrame(() => { input.focus(); input.select(); });

      const restore = (nextName) => {
        if (!editing) return; // already restored (e.g. double Enter)
        editing = false;
        const trimmed = (nextName || '').trim();
        // Only commit if the name actually changed AND isn't empty.
        // Empty names would leave the chain nameless in the library
        // ribbon; refuse them silently and keep the previous name.
        if (trimmed && trimmed !== chain.name) {
          chain.name = trimmed;
          Store.save();
          const run = Engine._runs.get(chainId);
          if (run && run.chain) run.chain.name = trimmed;
        }
        // Rebuild the button, exactly as index.html declares it.
        const nb = document.createElement('button');
        nb.className = 'run-chain-name';
        nb.id = 'run-chain-name';
        nb.type = 'button';
        nb.setAttribute('aria-label', 'Rename chain');
        nb.textContent = chain.name || '—';
        input.replaceWith(nb);
        UI.renderRunChips();
        if (View.current === 'library') UI.renderLibrary();
      };

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); input.value = chain.name || ''; input.blur(); }
      });
      input.addEventListener('blur', () => restore(input.value));
    });
  })();

  // v1.4.12 — inline rename of the CURRENT SEGMENT from the run view,
  // mirroring the chain rename above: tap the big segment title to swap
  // it for an input; Enter/blur commits, Escape cancels, empty is
  // refused. The run, index, and source ids are captured at edit start,
  // so a segment boundary crossing mid-edit can't retarget the commit
  // to the wrong segment (the display just catches up on the next
  // repaint — _setRunSegmentName skips while the input is up). The
  // write path is UI._renameSegmentEverywhere: Store (possibly a
  // subchain's segment) + every live run's expanded instances + native
  // notification/voice refresh. DELEGATED on the parent container
  // because the button is replaceWith()-ed to the input and back.
  (() => {
    const host = document.getElementById('run-segment-name')?.parentElement;
    if (!host) return;
    let editing = false;
    host.addEventListener('click', (e) => {
      if (editing) return;
      const btn = e.target.closest('.run-segment-name');
      if (!btn || btn.tagName !== 'BUTTON') return;
      // During an inline prestart preview the displayed segment belongs
      // to the pending chain while Engine focus is still elsewhere —
      // renaming through that mismatch would hit the wrong segment.
      // It's a 3-second window; just ignore taps.
      if (UI.prestartPendingChain && !UI.prestartYielded) return;
      const run = Engine._focused;
      const seg = run?.segments?.[run.currentIndex];
      if (!seg) return;
      if (!seg.srcChainId || !seg.srcSegId) {
        // Run restored from a pre-v1.4.12 snapshot — no source mapping.
        Toast.show('Rename unavailable for this run', 'warn');
        return;
      }
      const { srcChainId, srcSegId } = seg;
      const srcName = Store.getChain(srcChainId)?.segments?.find(s => s && s.id === srcSegId)?.name || '';
      editing = true;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'run-segment-name-input';
      input.maxLength = 48;
      input.value = srcName;
      input.placeholder = 'Segment name';
      input.setAttribute('aria-label', 'Segment name');
      btn.replaceWith(input);
      requestAnimationFrame(() => { input.focus(); input.select(); });

      const restore = (nextName) => {
        if (!editing) return;
        editing = false;
        const trimmed = (nextName || '').trim();
        if (trimmed && trimmed !== srcName) {
          UI._renameSegmentEverywhere(srcChainId, srcSegId, trimmed);
        }
        // Rebuild the button as index.html declares it, showing whatever
        // segment is CURRENT now (it may have advanced mid-edit).
        const nb = document.createElement('button');
        nb.className = 'run-segment-name';
        nb.id = 'run-segment-name';
        nb.type = 'button';
        nb.setAttribute('aria-label', 'Rename segment');
        const cur = Engine._focused?.segments?.[Engine._focused.currentIndex];
        nb.textContent = cur?.name || '—';
        input.replaceWith(nb);
      };

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); input.value = srcName; input.blur(); }
      });
      input.addEventListener('blur', () => restore(input.value));
    });
  })();

  // Android hardware / gesture back button.
  //
  // MainActivity.onBackPressed dispatches a "chainBack" event on window.
  // We handle it here, deciding what "back" means depending on what the
  // user is currently looking at:
  //
  //   1. Any sheet open (settings, cue overrides, duration picker,
  //      chain-picker, actions, update modal) → close the topmost sheet.
  //   2. Selection mode active in the library → exit selection mode.
  //   3. Any view other than library (run / editor / templates) →
  //      navigate to library. Run view keeps its chain(s) running.
  //   4. Library view with nothing else to do → actually exit the app
  //      via ChainTimerPlugin.exitApp.
  //
  // Any earlier stop short of exitApp is treated as "handled" — Android
  // never sees the press.
  window.addEventListener('chainBack', () => {
    // 1. Topmost sheet or modal.
    const sheetIds = [
      'update-modal',
      'actions-sheet',
      'duration-sheet',
      'picker-sheet',
      // v1.4.13 — was 'cue-sheet', which matches no element: the cue
      // sheet is #cues-sheet, so Android back fell through it to the
      // view-level handler and left the sheet open on screen.
      'cues-sheet',
      'settings-sheet',
    ];
    for (const id of sheetIds) {
      const el = document.getElementById(id);
      if (el && !el.hidden) { el.hidden = true; return; }
    }
    // 2. Library selection mode.
    if (UI.selectMode) { UI.exitSelectMode(); return; }
    // 3. Non-library view → go home, keep any chain running.
    if (View.current && View.current !== 'library') {
      goBackToLibraryKeepRunning();
      return;
    }
    // 4. On library with nothing to close → exit the app.
    const CT = window.Capacitor?.Plugins?.ChainTimer;
    if (CT && typeof CT.exitApp === 'function') {
      try { CT.exitApp(); } catch {}
    }
  });

  // Swipe-to-go-back gesture on the run view. Works in BOTH directions
  // (left OR right) — users have different mental models: iOS-style
  // "swipe right from left edge = back", vs "swipe left to push the
  // current page away". Either way, they end up in the library with
  // the chain still running.
  //
  // v1.4.9 — rewritten to use TOUCH events (touchstart/move/end) rather
  // than pointer events. On the Android WebView, pointer events reliably
  // failed to fire for horizontal drags: `touch-action: auto` (the
  // default) lets the browser start a scroll/navigation gesture before
  // the first pointermove reaches JS. The result was that v1.4.8's
  // add-left-direction fix was NEVER actually invoked on device — the
  // handler was correct, the event just never arrived. `touch-action:
  // pan-y` on .view-run (see styles.css) frees horizontal touches, and
  // touch events fire pre-navigation. Threshold: 60px horizontal AND
  // horizontal must exceed vertical by 1.2x. Pointer events kept as a
  // fallback for desktop mouse-drag testing.
  (() => {
    const view = document.querySelector('.view-run');
    if (!view) return;
    let startX = 0, startY = 0, tracking = false, dragged = 0, decided = false;
    // Ignore drags that start on interactive controls — control buttons,
    // sheets, the chip strip (which has its own long-press), overlays.
    // NOTE: the chain name span is intentionally NOT in this list; a
    // tap on it opens an inline rename (see below), a horizontal swipe
    // across it still counts as a page swipe.
    const isInteractive = (el) => !!el.closest('button, input, textarea, select, .run-chip, .sheet, .run-overlay');
    const begin = (x, y, target) => {
      if (isInteractive(target)) { tracking = false; return; }
      tracking = true;
      decided = false;
      startX = x; startY = y; dragged = 0;
    };
    const move = (x, y, ev) => {
      if (!tracking) return;
      const dx = x - startX;
      const dy = y - startY;
      // Lock the axis on the first move that clears the noise floor —
      // once we decide "this is a vertical scroll" we stop tracking for
      // this gesture, so we don't briefly hijack a diagonal drag.
      if (!decided) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return; // still noise
        decided = true;
        if (Math.abs(dy) > Math.abs(dx)) {
          // vertical intent — abandon, let the browser have the scroll
          tracking = false;
          view.classList.remove('is-swiping');
          view.style.transform = '';
          return;
        }
      }
      dragged = dx;
      view.classList.add('is-swiping');
      // Follow the finger in either direction, clamped to +/-120px so
      // the drag can't fly off the screen visually.
      const clamped = Math.max(-120, Math.min(120, dx));
      view.style.transform = `translateX(${clamped}px)`;
      // Once axis-locked to horizontal, stop the browser from also
      // scrolling / initiating its own back gesture on this touch.
      if (ev && ev.cancelable) ev.preventDefault();
    };
    const endSwipe = (commit) => {
      tracking = false;
      decided = false;
      view.style.transform = '';
      view.classList.remove('is-swiping');
      if (commit) goBackToLibraryKeepRunning();
      dragged = 0;
    };

    // Touch path (primary on device).
    view.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      if (!t) return;
      begin(t.clientX, t.clientY, e.target);
    }, { passive: true });
    // MUST be passive:false so preventDefault() can actually work once
    // we've decided this is a horizontal swipe.
    view.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      if (!t) return;
      move(t.clientX, t.clientY, e);
    }, { passive: false });
    view.addEventListener('touchend',    () => endSwipe(Math.abs(dragged) > 60));
    view.addEventListener('touchcancel', () => endSwipe(false));

    // Pointer path — desktop mouse-drag fallback for browser testing.
    view.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse') return;
      if (e.button !== 0) return;
      begin(e.clientX, e.clientY, e.target);
    });
    view.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      move(e.clientX, e.clientY, null);
    });
    view.addEventListener('pointerup',     (e) => {
      if (e.pointerType !== 'mouse') return;
      endSwipe(Math.abs(dragged) > 60);
    });
    view.addEventListener('pointercancel', (e) => {
      if (e.pointerType !== 'mouse') return;
      endSwipe(false);
    });
  })();

  // run controls
  document.getElementById('run-stop').addEventListener('click', () => {
    // v1.4.11 — X while an inline prestart preview is showing means
    // "abort this launch", not "stop the chain running behind it".
    // Fall back to the focused running chain's view.
    if (UI.prestartPendingChain && !UI.prestartYielded) {
      UI.cancelPrestart();
      if (Engine.activeRunningCount() > 0) UI.renderRun();
      else View.show('library');
      return;
    }
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
  // v1.4.13 — dismiss a ring-until-dismissed gate: silence the alarm
  // and let the chain continue from this moment.
  document.getElementById('run-dismiss').addEventListener('click', () => {
    Audio.unlock();
    Engine.dismissAlarm();
    UI.updateRunSegmentInfo();
    UI._syncAlarmUI();
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
  // Gate entered/left — refresh the Dismiss bar and the chip strip (a
  // held background run shows as ringing there too).
  Engine.onAlarmChange = () => { UI._syncAlarmUI(); UI.renderRunChips(); };
  Engine.onComplete = (totalSeconds) => UI.showCompletion(totalSeconds);
  // v1.4 — chip strip wakes up whenever a run is added/removed/focused.
  // The chip clocks themselves redraw on every focused-run tick (see
  // updateRunClock) so background clocks stay live.
  Engine.onRunsChange = () => {
    UI.renderRunChips();
    // v1.4.5: re-render the whole library so running chains re-sort to
    // the top (or drop back down when they end) and inline status cards
    // are added / removed. Also (re)start the 500ms library ticker so
    // background runs' clocks stay live while the user is on library.
    if (View.current === 'library') {
      UI.renderLibrary();
      UI._maybeStartLibraryTicker();
    }
  };

  // v1.4 — selection-mode topbar buttons.
  document.getElementById('library-select-cancel')?.addEventListener('click', () => UI.exitSelectMode());
  document.getElementById('library-select-start')?.addEventListener('click', () => UI.startSelected());
  document.getElementById('library-select-delete')?.addEventListener('click', () => UI.deleteSelected());
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

  // Update-available modal wiring.
  document.querySelectorAll('[data-update-dismiss]').forEach(el => {
    el.addEventListener('click', () => {
      UI.hideUpdateModal();
      Updater.markDismissed();
    });
  });
  document.getElementById('update-modal-open').addEventListener('click', () => {
    UI.hideUpdateModal();
    Updater.openStore();
  });
  // Fire the check on launch. Native only; deferred inside maybePromptOnLaunch
  // so it doesn't compete with the initial render + native bridge init.
  Updater.maybePromptOnLaunch();

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
  // v1.4.13 — reconcile ring-until-dismissed gates with the foreground
  // service BEFORE catching up to the wall clock. While the WebView was
  // asleep the service may have held a gate (JS knows nothing about it)
  // or the user may have cleared one from the notification (JS would
  // otherwise catch up and re-arm the gate they just dismissed). The
  // service is authoritative for anything that happened in the
  // background, so its answer wins here.
  async function reconcileGatesWithService() {
    const CT = window.Capacitor?.Plugins?.ChainTimer;
    if (!CT || typeof CT.getGateStates !== 'function') return;
    let states;
    try {
      const res = await CT.getGateStates();
      states = JSON.parse(res?.states || '[]');
    } catch { return; }
    if (!Array.isArray(states)) return;
    for (const st of states) {
      const run = Engine.runById(st?.id);
      if (!run || !run.isRunning) continue;
      if (st.ringing >= 0) {
        // Service is holding a gate JS hasn't noticed yet.
        run.currentIndex = Math.min(st.ringing, run.segments.length - 1);
        run.dismissedAtIndex = st.dismissed;
        if (!run.awaitingDismiss) run._beginAlarmHold();
      } else {
        // Service says no gate is held. Adopt its cleared boundary so a
        // later catch-up doesn't re-arm it, and drop any stale hold.
        run.dismissedAtIndex = st.dismissed;
        if (run.awaitingDismiss) {
          run.awaitingDismiss = false;
          run.isPaused = false;
          Alarm.stop();
          document.querySelector('.view-run')?.classList.remove('is-alarm');
        }
        if (Number.isFinite(st.index) && st.index > run.currentIndex) {
          run.currentIndex = Math.min(st.index, run.segments.length - 1);
          // Adopt the service's start time for that segment too — ours
          // predates the gate, so catch-up would expire it instantly.
          if (Number.isFinite(st.segStartedAtMs) && st.segStartedAtMs > 0) {
            run.segmentStartedAtWall = st.segStartedAtMs;
            run.pausedDuration = 0;
          }
          run._loop();
        }
      }
    }
    UI._syncAlarmUI();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      reconcileGatesWithService().then(refreshFromWallClock, refreshFromWallClock);
    }
  });
  window.addEventListener('pageshow', refreshFromWallClock);
  window.addEventListener('focus',    refreshFromWallClock);
  // Capacitor App resume — the native bridge dispatches this when the
  // activity returns to foreground (more reliable than visibilitychange
  // on some Android skins).
  window.addEventListener('chained:appresume', () => {
    reconcileGatesWithService().then(refreshFromWallClock, refreshFromWallClock);
  });

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
    } else if (cmd === 'dismiss') {
      // v1.4.13 — the notification's Dismiss cleared a ring gate the
      // SERVICE was holding (background). Mirror it in JS so the two
      // agree; if JS never noticed the boundary (WebView was asleep),
      // catch up to it first so the dismissal lands on the same segment.
      if (!targetRun.awaitingDismiss) targetRun._catchup({ silent: true });
      targetRun.dismissAlarm();
      UI._syncAlarmUI();
    } else if (cmd === 'ringing') {
      // Service hit a gate while JS was asleep. Sync into the held state
      // so the run view shows the Dismiss bar when the user opens the app.
      if (!targetRun.awaitingDismiss) targetRun._catchup({ silent: true });
      UI._syncAlarmUI();
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
  window.ChainedApp = { Audio, Voice, Alarm, Engine, Store, UI, View, Editor };
}

})();
