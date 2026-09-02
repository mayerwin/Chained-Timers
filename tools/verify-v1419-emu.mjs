// v1.4.19 — on-device evidence for the three beta-tester reports.
//
//   1. A ring-until-dismissed hold must RING AND BUZZ, over and over,
//      until it is dismissed. Three separate faults made it a silent
//      Dismiss bar: nothing ever vibrated (the JS Alarm's haptic is
//      deliberately skipped on native, and the service had none of its
//      own); the burst loop was cancelled by the very next JS update,
//      because every update ends in cancelTickFor; and the plugin never
//      forwarded ringThroughDnd, so the whole cue pool was built as
//      USAGE_MEDIA — the one usage Do Not Disturb silences.
//   2. Finishing or stopping a run must leave NO gate state behind. The
//      service keys it by runId — which is the chain id, reused by the
//      next run — so a leftover entry fast-forwarded the next run onto a
//      finished segment: "00" on the clock and a dead Play button.
//   3. Under a minute the clock shows seconds only, and the last ten
//      seconds a single digit, like the stock Android timer. Once a gate
//      rings, it keeps counting in negative time.
//
// Requires: emulator running WITH audio, current debug APK installed,
// app foregrounded, CDP on localhost:9222, POST_NOTIFICATIONS granted.
// Launch it all with: publishing\android\LAUNCH.ps1 -Devtools

import { execSync } from 'node:child_process';

const ADB = process.env.ADB || 'C:\\Users\\erwin\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe';
const OUT = process.env.OUT_DIR || 'screenshots';
const PKG = 'com.github.chainedtimers';

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
const sh   = (cmd) => execSync(`"${ADB}" ${cmd}`, { encoding: 'utf8' });
const shot = (name) => {
  execSync(`"${ADB}" exec-out screencap -p > ${OUT}/${name}`, { shell: 'cmd.exe', stdio: ['ignore','ignore','ignore'] });
  console.log('  📸', `${OUT}/${name}`);
};
const tap = async (sel) => {
  const p = await evalJs(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};
const startedPlayers = () => {
  try { return (sh('shell dumpsys audio').match(/state:started/g) || []).length; } catch { return 0; }
};
// The live vibration, with the caller attached — so "something buzzed"
// can be pinned on this app rather than on a system haptic.
const currentVibration = () => {
  try {
    const d = sh('shell dumpsys vibrator_manager');
    const m = d.match(/mCurrentVibration:\s*\n\s*(.+)/);
    return m && !/^null/.test(m[1]) ? m[1] : '';
  } catch { return ''; }
};
// Bursts are ~570ms of vibration inside each 1.5s ring interval, so poll
// fast across several intervals instead of betting on one sample.
const sampleVibration = async (ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = currentVibration();
    if (v.includes(`opPkg=${PKG}`)) return v;
    await wait(120);
  }
  return '';
};
const sampleAudio = async (ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (startedPlayers() > 0) return true;
    await wait(200);
  }
  return false;
};

const seed = async (json) => {
  await evalJs(`
    Object.keys(localStorage).filter(k => k.startsWith('chained-timers/run/')).forEach(k => localStorage.removeItem(k));
    localStorage.setItem('chained-timers/v1', JSON.stringify(${json})); true;
  `);
  try { sh('shell cmd statusbar collapse'); } catch {}
  await send('Page.reload');
  await wait(2500);
};

console.log('Report 1: a hold rings AND buzzes');
{
  await seed(JSON.stringify({
    schemaVersion: 1,
    chains: [{ id: 'c_ring', name: 'Gated', color: 'amber', loops: 1, hasRun: true,
      segments: [
        { id: 's1', kind: 'segment', name: 'Hold', duration: 3, color: 'amber',
          cues: { ringUntilDismissed: true } },
        { id: 's2', kind: 'segment', name: 'Rest', duration: 300, color: 'teal' },
      ] }],
    settings: { sound: true, voice: false, vibrate: true, prestart: false, finalTick: false, ringThroughDnd: true },
  }));
  await evalJs(`(() => { const { Store, UI } = window.ChainedApp; UI.startRunForChain(Store.getChain('c_ring')); return true; })()`);
  await wait(4200);
  const held = await evalJs(`!!window.ChainedApp.Engine._focused?.awaitingDismiss`);
  if (!held) fail('never reached the gate');
  ok('held at the gate');

  if (!await sampleAudio(6000)) fail('the hold is silent — no audio player started');
  ok('the hold is audible (audio player started)');

  const vib = await sampleVibration(8000);
  if (!vib) fail('the hold does not buzz — no vibration attributed to the app');
  ok('the hold buzzes (vibration from this app)');
  if (!/Usage=ALARM/.test(vib)) fail(`buzz is not an alarm-usage vibration: ${vib}`);
  ok('buzz uses ALARM usage, so Do Not Disturb does not swallow it');

  // And it keeps going: the burst loop used to be cancelled by the very
  // next JS update, leaving a Dismiss bar over a silent phone.
  const second = await sampleVibration(6000);
  if (!second) fail('the buzz stopped after the first burst');
  ok('the alarm keeps ringing and buzzing, burst after burst');

  // While it rings, the clock counts overtime in negative time.
  const over = await evalJs(`document.getElementById('run-clock').textContent`);
  if (!/^-\d/.test(over)) fail(`clock is not counting overtime ("${over}")`);
  ok(`clock counts overtime ("${over}")`);
  shot('emu-41-ring-buzz.png');
  await evalJs(`window.ChainedApp.Engine.stopRun('c_ring'); true;`);
  await wait(500);
}

console.log('\nReport 1b: Buzz cues off keeps the hold silent to the hand');
{
  await seed(JSON.stringify({
    schemaVersion: 1,
    chains: [{ id: 'c_ring', name: 'Gated', color: 'amber', loops: 1, hasRun: true,
      segments: [
        { id: 's1', kind: 'segment', name: 'Hold', duration: 3, color: 'amber',
          cues: { ringUntilDismissed: true } },
        { id: 's2', kind: 'segment', name: 'Rest', duration: 300, color: 'teal' },
      ] }],
    settings: { sound: true, voice: false, vibrate: false, prestart: false, finalTick: false, ringThroughDnd: true },
  }));
  await evalJs(`(() => { const { Store, UI } = window.ChainedApp; UI.startRunForChain(Store.getChain('c_ring')); return true; })()`);
  await wait(4200);
  if (!await evalJs(`!!window.ChainedApp.Engine._focused?.awaitingDismiss`)) fail('never reached the gate');
  if (await sampleVibration(5000)) fail('buzzed with Buzz cues switched off');
  ok('no vibration with Buzz cues off');
  if (!await sampleAudio(4000)) fail('sound stopped too — Buzz cues should only govern the haptic');
  ok('still rings — only the haptic follows Buzz cues');
  await evalJs(`window.ChainedApp.Engine.stopRun('c_ring'); true;`);
  await wait(500);
}

console.log('\nReport 2: dismiss at chain end, then run again — a clean run');
{
  await seed(JSON.stringify({
    schemaVersion: 1,
    chains: [{ id: 'c_end', name: 'Ends', color: 'amber', loops: 1, hasRun: true,
      segments: [{ id: 's1', kind: 'segment', name: 'Only', duration: 30, color: 'amber',
        cues: { ringUntilDismissed: true } }] }],
    settings: { sound: true, voice: false, vibrate: true, prestart: false, finalTick: false, ringThroughDnd: true },
  }));
  // Start, then skip straight to the boundary so this doesn't wait 30s.
  await evalJs(`(() => { const { Store, UI, Engine } = window.ChainedApp;
    UI.startRunForChain(Store.getChain('c_end'));
    const run = Engine._focused; run.segmentStartedAtWall -= 29000; return true; })()`);
  await wait(3000);
  if (!await evalJs(`!!window.ChainedApp.Engine._focused?.awaitingDismiss`)) fail('never reached the end gate');
  ok('held at the chain-end gate');

  await tap('#run-dismiss');
  await wait(1500);
  const done = await evalJs(`window.ChainedApp.Engine.activeRuns().length`);
  if (done !== 0) fail(`chain did not finish on Dismiss (${done} still running)`);
  ok('chain finished on Dismiss');

  // The regression, at its source: the service must not still be holding
  // gate state for this chain id once the run is over.
  const gates = await evalJs(`(async () => {
    const CT = window.Capacitor?.Plugins?.ChainTimer;
    if (!CT?.getGateStates) return 'NO-PLUGIN';
    return (await CT.getGateStates()).states || '[]';
  })()`);
  if (gates === 'NO-PLUGIN') fail('ChainTimer plugin not available — not running on device?');
  // Nothing is running at this point, so the service should be holding no
  // gate state at all — not for this chain, and not for the earlier ones
  // either: every stop path has to clear it, or the entry gets handed to
  // the next run of the same chain id.
  if (gates.replace(/\s/g, '') !== '[]') fail(`service kept stale gate state: ${gates}`);
  ok('no gate state left behind by any finished or stopped run');

  // Run it again — the actual user-visible symptom.
  await evalJs(`(() => { const { Store, UI } = window.ChainedApp; UI.hideCompletion(); UI.startRunForChain(Store.getChain('c_end')); return true; })()`);
  await wait(2500);
  const s = await evalJs(`(() => {
    const run = window.ChainedApp.Engine._focused;
    return { running: !!run?.isRunning, paused: !!run?.isPaused, index: run?.currentIndex,
             awaiting: !!run?.awaitingDismiss,
             clock: document.getElementById('run-clock').textContent,
             barHidden: document.getElementById('run-dismiss-bar').hidden };
  })()`);
  if (!s.running || s.awaiting || s.index !== 0) fail(`restart is not a clean run: ${JSON.stringify(s)}`);
  if (/^0?0$/.test(s.clock)) fail(`clock stuck at zero on restart ("${s.clock}")`);
  ok(`restarted cleanly, clock counting from "${s.clock}"`);
  shot('emu-42-restart-after-dismiss.png');

  // And the Play/Pause button responds — the other half of the report.
  await tap('#run-toggle');
  await wait(600);
  const paused = await evalJs(`!!window.ChainedApp.Engine._focused?.isPaused`);
  if (!paused) fail('Pause did nothing');
  await tap('#run-toggle');
  await wait(600);
  const resumed = await evalJs(`!window.ChainedApp.Engine._focused?.isPaused`);
  if (!resumed) fail('Play did nothing');
  ok('Play / Pause responds after the restart');
  await evalJs(`window.ChainedApp.Engine.stopRun('c_end'); true;`);
  await wait(400);
}

console.log('\nReport 3: under a minute the clock drops the leading "00:"');
{
  await seed(JSON.stringify({
    schemaVersion: 1,
    chains: [{ id: 'c_secs', name: 'Short', color: 'amber', loops: 1, hasRun: true,
      segments: [{ id: 's1', kind: 'segment', name: 'Sprint', duration: 45, color: 'amber' },
                 { id: 's2', kind: 'segment', name: 'Long',   duration: 7200, color: 'teal' }] }],
    settings: { sound: false, voice: false, vibrate: false, prestart: false, finalTick: false },
  }));
  await evalJs(`(() => { const { Store, UI } = window.ChainedApp; UI.startRunForChain(Store.getChain('c_secs')); return true; })()`);
  await wait(1500);
  const secs = await evalJs(`(() => ({
    clock: document.getElementById('run-clock').textContent,
    remaining: document.getElementById('run-remaining').textContent,
  }))()`);
  if (!/^\d{2}$/.test(secs.clock)) fail(`clock still shows "${secs.clock}" under a minute`);
  ok(`clock reads "${secs.clock}" (seconds only)`);
  // The last ten seconds drop to a single digit, like the stock timer.
  const single = await evalJs(`(async () => {
    const run = window.ChainedApp.Engine._focused;
    const was = run.segmentStartedAtWall;
    run.segmentStartedAtWall = Date.now() - 38000;   // 7s left
    await new Promise(r => setTimeout(r, 600));
    const text = document.getElementById('run-clock').textContent;
    run.segmentStartedAtWall = was;                  // hand the segment back
    return text;
  })()`);
  if (!/^\d$/.test(single)) fail(`final countdown shows "${single}", expected a single digit`);
  ok(`final countdown is a single digit ("${single}")`);
  // The row below shows the CHAIN's remaining time (this one runs past an
  // hour) and keeps its full padded form — only the big clock is trimmed.
  if (!/^(\d{2}:)?\d{2}:\d{2} remaining$/.test(secs.remaining)) fail(`remaining row changed: "${secs.remaining}"`);
  ok(`the row below keeps MM:SS ("${secs.remaining}")`);
  shot('emu-43-clock-seconds-only.png');

  // The long segment must still render in full, inside the ring.
  await evalJs(`window.ChainedApp.Engine._focused.skipNext(); true;`);
  await wait(1200);
  const long = await evalJs(`(() => {
    const el = document.getElementById('run-clock');
    const ring = document.querySelector('.run-clock-wrap').getBoundingClientRect();
    const b = el.getBoundingClientRect();
    const cx = ring.left + ring.width / 2, cy = ring.top + ring.height / 2;
    const halfDiag = Math.hypot(b.width / 2, b.height / 2);
    return { text: el.textContent, clearance: (ring.width / 2) - halfDiag };
  })()`);
  if (!/^\d{2}:\d{2}:\d{2}$/.test(long.text)) fail(`long form broken: "${long.text}"`);
  if (long.clearance < 4) fail(`"${long.text}" is not clear of the ring (${long.clearance.toFixed(1)}px)`);
  ok(`"${long.text}" still fits inside the ring (${long.clearance.toFixed(1)}px clear)`);
  shot('emu-44-clock-long-form.png');
  await evalJs(`window.ChainedApp.Engine.stopRun('c_secs'); true;`);
}

console.log('\n✅ emulator checks for v1.4.19 passed');
process.exit(0);
