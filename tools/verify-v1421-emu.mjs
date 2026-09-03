// v1.4.21 — on-device evidence for live cue changes.
//
// The browser suite proves the JS side. Only the device can prove the
// part that actually failed for the user: on Android the foreground
// service owns the ring loop and plays from its OWN resolved copy of the
// cues, so muting in the WebView changed nothing at all until the run
// started pushing updates at it.
//
//   1. Mute during a ringing gate stops the chime, and the gate stays
//      held (mute silences, it does not dismiss). Unmuting brings it
//      back.
//   2. Buzz cues off, from the new run-view bell, stops the haptic and
//      leaves the chime alone.
//   3. "Ring until dismissed" off releases the held gate on the spot —
//      the service stops ringing and drops its gate state.
//   4. Voice cues switched ON mid-run get their TTS files rendered; a
//      chain that started with voice off has none.
//
// Requires: emulator running WITH audio, current DEBUG APK installed
// (the cue trace this reads is debug-only), app foregrounded, CDP on
// localhost:9222. Launch it all with:
//   publishing\android\LAUNCH.ps1 -Devtools

import { execSync } from 'node:child_process';

const ADB = process.env.ADB || 'C:\\Users\\erwin\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe';
const OUT = process.env.OUT_DIR || 'screenshots';

const list = await (await fetch('http://localhost:9222/json/list')).json();
const target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
if (!target) { console.error('no CDP page'); process.exit(2); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => { const id = ++msgId; return new Promise((res, rej) => { pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })); }); };
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description || ''));
  return r.result?.value;
};
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const ok   = (m) => console.log('  ✓', m);
const fail = (m) => { console.error('  ✗', m); process.exit(1); };
const sh   = (cmd) => execSync(`"${ADB}" ${cmd}`, { encoding: 'utf8', maxBuffer: 1e8 });
const shot = (name) => {
  execSync(`"${ADB}" exec-out screencap -p > ${OUT}/${name}`, { shell: 'cmd.exe', stdio: ['ignore','ignore','ignore'] });
  console.log('  📸', `${OUT}/${name}`);
};
const tap = async (sel) => {
  // Scroll into view first: the cue sheet scrolls, and a row below the
  // fold would otherwise be tapped at coordinates outside the viewport —
  // which looks exactly like "the setting did nothing".
  const p = await evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) throw new Error('no element for ' + ${JSON.stringify(sel)});
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2 };
  })()`);
  await wait(250);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};

// The service traces every cue decision under ChainTimerCue in debug
// builds (playCueSound / buzzForRing). That trace is the only honest
// view of what it did: dumpsys audio reports the whole app, and the
// WebView keeps a track open the entire time, so from outside a silenced
// chime is indistinguishable from a ringing one — measured, not assumed.
const cueTrace = async (ms) => {
  try { sh('logcat -c'); } catch {}
  await wait(ms);
  const lines = sh('logcat -d -s ChainTimerCue:D')
    .split('\n').filter(l => l.includes('ChainTimerCue'));
  const count = (kind, flag) => lines.filter(l => l.includes(kind) && l.includes(flag)).length;
  return {
    played:   count('cue ',  'sound=true'),
    silenced: count('cue ',  'sound=false'),
    buzzed:   count('buzz ', 'vibrate=true'),
    unbuzzed: count('buzz ', 'vibrate=false'),
  };
};
const gateStates = () => evalJs(`(async () => (await window.Capacitor.Plugins.ChainTimer.getGateStates()).states)()`);

const seed = async (json) => {
  await evalJs(`
    Object.keys(localStorage).filter(k => k.startsWith('chained-timers/run/')).forEach(k => localStorage.removeItem(k));
    localStorage.setItem('chained-timers/v1', JSON.stringify(${json})); true;
  `);
  try { sh('shell cmd statusbar collapse'); } catch {}
  await send('Page.reload');
  await wait(2500);
};

const GATED_CHAIN = {
  schemaVersion: 1,
  chains: [{ id: 'c_ring', name: 'Gated', color: 'amber', loops: 1, hasRun: true,
    segments: [
      { id: 's1', kind: 'segment', name: 'Hold', duration: 3, color: 'amber',
        cues: { ringUntilDismissed: true } },
      { id: 's2', kind: 'segment', name: 'Rest', duration: 300, color: 'teal' },
    ] }],
  settings: { sound: true, voice: false, vibrate: true, prestart: false, finalTick: false, ringThroughDnd: true },
};

const reachGate = async () => {
  await evalJs(`(() => { const { Store, UI } = window.ChainedApp; UI.startRunForChain(Store.getChain('c_ring')); return true; })()`);
  await wait(4200);
  if (!await evalJs(`!!window.ChainedApp.Engine._focused?.awaitingDismiss`)) fail('never reached the gate');
};

console.log('Report 1: mute silences a gate that is already ringing');
{
  await seed(JSON.stringify(GATED_CHAIN));
  await reachGate();
  ok('held at the gate');
  let t = await cueTrace(5000);
  if (t.played < 2) fail(`the gate is not ringing to begin with (${JSON.stringify(t)})`);
  ok(`ringing (${t.played} chimes in 5s)`);

  await tap('#run-mute');
  await wait(1500);                       // let the update land
  t = await cueTrace(6000);
  if (t.played > 0) fail(`STILL chiming after mute — the service never got the news (${JSON.stringify(t)})`);
  if (t.silenced < 2) fail(`the ring loop stopped running altogether (${JSON.stringify(t)}) — expected it to keep looping, silently`);
  ok(`silent after mute (${t.silenced} bursts suppressed, 0 played)`);
  if (t.buzzed < 1) fail('the buzz stopped too — mute is sound-only');
  ok(`still buzzing (${t.buzzed}) — mute governs sound alone`);
  if (!await evalJs(`!!window.ChainedApp.Engine._focused?.awaitingDismiss`)) fail('mute dismissed the gate — it should only silence it');
  ok('the gate is still held (mute silences, it does not dismiss)');
  shot('emu-51-muted-gate.png');

  await tap('#run-mute');
  await wait(1500);
  t = await cueTrace(5000);
  if (t.played < 2) fail(`unmute did not bring the ring back (${JSON.stringify(t)})`);
  ok(`ringing again after unmute (${t.played} chimes)`);
  await evalJs(`window.ChainedApp.Engine.stopRun('c_ring'); true;`);
  await wait(500);
}

console.log('\nReport 2: Buzz cues off, from the run-view bell, stops the buzz');
{
  await seed(JSON.stringify(GATED_CHAIN));
  await reachGate();
  let t = await cueTrace(5000);
  if (t.buzzed < 2) fail(`not buzzing to begin with (${JSON.stringify(t)})`);
  ok(`buzzing at the gate (${t.buzzed} bursts)`);

  await tap('#run-cues-btn');
  await wait(500);
  if (!await evalJs(`!document.getElementById('cues-sheet').hidden`)) fail('the cue sheet did not open from the run view');
  ok('cue sheet opens from the run topbar');
  shot('emu-52-run-cue-sheet.png');
  await tap('.cue-row[data-cue-key="vibrate"] button[data-state="off"]');
  await wait(1500);
  t = await cueTrace(6000);
  if (t.buzzed > 0) fail(`still buzzing after switching Buzz cues off (${JSON.stringify(t)})`);
  ok(`buzz stops on the spot (${t.unbuzzed} suppressed)`);
  if (t.played < 2) fail(`the chime stopped too (${JSON.stringify(t)}) — Buzz cues should only govern the haptic`);
  ok(`still ringing (${t.played} chimes) — only the haptic followed`);
  await evalJs(`window.ChainedApp.Engine.stopRun('c_ring'); document.getElementById('cues-sheet').hidden = true; true;`);
  await wait(500);
}

console.log('\nReport 3: "Ring until dismissed" off releases the held gate');
{
  await seed(JSON.stringify(GATED_CHAIN));
  await reachGate();
  ok('held at the gate');
  await tap('#run-cues-btn');
  await wait(500);
  await tap('.cue-row[data-cue-key="ringUntilDismissed"] button[data-state="off"]');
  await wait(1500);

  const st = await evalJs(`(() => {
    const run = window.ChainedApp.Engine._focused;
    return { awaiting: !!run?.awaitingDismiss, index: run?.currentIndex,
             barHidden: document.getElementById('run-dismiss-bar').hidden };
  })()`);
  if (st.awaiting) fail('the gate is still held after switching the ring off');
  ok(`gate released, chain moved on to segment ${st.index + 1}`);
  if (!st.barHidden) fail('Dismiss bar still on screen');
  ok('Dismiss bar gone');
  const gates = await gateStates();
  if (/"ringing":\s*[0-9]/.test(gates)) fail(`service still holding a ring: ${gates}`);
  ok('the service stopped holding the gate too');
  const t = await cueTrace(5000);
  if (t.played > 0 || t.silenced > 0) fail(`the ring loop is still running (${JSON.stringify(t)})`);
  ok('and the ring loop is gone, not merely muted');
  shot('emu-53-ring-released.png');
  await evalJs(`window.ChainedApp.Engine.stopRun('c_ring'); document.getElementById('cues-sheet').hidden = true; true;`);
  await wait(500);
}

console.log('\nReport 4: Voice cues switched ON mid-run get their files rendered');
{
  // Voice is pre-rendered to WAV before a chain starts, so a chain that
  // began with voice off has NO files: switching it on mid-run has to
  // render them or the setting would silently do nothing.
  await seed(JSON.stringify({
    schemaVersion: 1,
    chains: [{ id: 'c_voice', name: 'Speak', color: 'amber', loops: 1, hasRun: true,
      segments: [{ id: 'v1', kind: 'segment', name: 'Alpha', duration: 300, color: 'amber' },
                 { id: 'v2', kind: 'segment', name: 'Bravo', duration: 300, color: 'teal' }] }],
    settings: { sound: true, voice: false, vibrate: false, prestart: false, finalTick: false },
  }));
  await evalJs(`(() => { const { Store, UI } = window.ChainedApp; UI.startRunForChain(Store.getChain('c_voice')); return true; })()`);
  await wait(1200);
  const before = await evalJs(`(window.ChainedApp.Voice._chainPaths.get('c_voice') || []).length`);
  if (before !== 0) fail(`expected no pre-rendered voice files, found ${before}`);
  ok('chain started with no voice files, as expected');

  await tap('#run-cues-btn');
  await wait(500);
  await tap('.cue-row[data-cue-key="voice"] button[data-state="on"]');
  const rendered = await evalJs(`(async () => {
    for (let i = 0; i < 40; i++) {
      const paths = window.ChainedApp.Voice._chainPaths.get('c_voice') || [];
      if (paths.length === 2 && paths.every(p => p)) return { n: paths.length, ms: i * 250 };
      await new Promise(r => setTimeout(r, 250));
    }
    return { n: (window.ChainedApp.Voice._chainPaths.get('c_voice') || []).length, ms: -1 };
  })()`);
  if (rendered.ms < 0) fail(`voice files never appeared (got ${rendered.n})`);
  ok(`both segment names rendered to WAV within ~${rendered.ms}ms`);
  // And the service is handed them, not just the JS cache: the render
  // is followed by a second emit whose payload carries the paths.
  try { sh('logcat -c'); } catch {}
  await evalJs(`window.ChainedApp.Engine.cuesChanged(); true;`);
  await wait(2500);
  const bridged = sh('logcat -d')
    .split('\n')
    .filter(l => l.includes('methodName: update') || l.includes('methodData'))
    .filter(l => l.includes('voicePathsJson'))
    .pop() || '';
  // The bridge logs the payload with the JSON escaped, so match the whole
  // line rather than trying to unpick the nested string.
  const paths = (bridged.match(/voicePathsJson[^,]*/) || [''])[0];
  if (!paths.includes('.wav')) fail(`the service was handed no voice paths: ${paths.slice(0, 160) || '(no update logged)'}`);
  ok('paths reach the foreground service, not just the JS cache');
  shot('emu-54-voice-on-midrun.png');
  await evalJs(`window.ChainedApp.Engine.stopRun('c_voice'); document.getElementById('cues-sheet').hidden = true; true;`);
}

console.log('\n✅ emulator checks for v1.4.21 passed');
process.exit(0);
