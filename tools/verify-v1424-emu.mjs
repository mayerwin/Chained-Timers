// v1.4.24 — emulator verification of the gate buttons and the 3-2-1 tick.
//
//   1. A 3s chain: the service starts final3.wav at the very start of the
//      segment (on the 3), not a second in (on the 2, with its last pulse
//      on the 0 over the finale).
//   2. A mid-chain ring gate: the run view and the notification both say
//      Continue, and the notification keeps Stop chain beside it.
//   3. Continue into another 3s segment: its tick starts at once too.
//   4. The chain-end gate: Dismiss, alone — no Stop chain.
//
// Cue timing is read from the service's debug-only ChainTimerCue trace
// (logcat), against device time taken in the WebView. The notification's
// actions are read from dumpsys.
//
// Requires: emulator running, current DEBUG APK installed, app
// foregrounded, CDP on localhost:9222, POST_NOTIFICATIONS granted.
// Launch it all with: publishing\android\LAUNCH.ps1 -Devtools

import { execSync } from 'node:child_process';

const ADB = process.env.ADB || 'C:\\Users\\erwin\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe';
const OUT = process.env.OUT_DIR || 'screenshots';
const PKG = 'com.github.chainedtimers';

const sh   = (cmd) => execSync(`"${ADB}" ${cmd}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const wait = (ms)  => new Promise(r => setTimeout(r, ms));
const shot = (name) => {
  execSync(`"${ADB}" exec-out screencap -p > ${OUT}/${name}`, { shell: 'cmd.exe', stdio: ['ignore', 'ignore', 'ignore'] });
  console.log('  📸', `${OUT}/${name}`);
};

let failures = 0;
const ok  = (m) => console.log('  ✓', m);
const bad = (m) => { console.log('  ✗', m); failures++; };
const eq  = (a, e, label) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  A === E ? ok(`${label} = ${A}`) : bad(`${label} expected ${E} got ${A}`);
};

async function connect() {
  const list = await (await fetch('http://localhost:9222/json/list')).json();
  const target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!target) { console.error('no CDP page'); process.exit(2); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let msgId = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } };
  await new Promise(r => ws.onopen = r);
  const send = (method, params = {}) => { const id = ++msgId; return new Promise((res, rej) => { pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })); }); };
  return async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description || ''));
    return r.result?.value;
  };
}

// Cue trace lines since the last clear, as [{ at: deviceEpochMs, from }].
function cues() {
  const out = sh('logcat -d -v epoch -s ChainTimerCue');
  return out.split(/\r?\n/).map(l => {
    const m = l.match(/^\s*(\d+)\.(\d{3}).*cue run=\S+ sound=true .* from=(\d+)/);
    return m ? { at: Number(m[1]) * 1000 + Number(m[2]), from: Number(m[3]) } : null;
  }).filter(Boolean);
}

function realigns() {
  const out = sh('logcat -d -v epoch -s ChainTimerCue');
  return out.split(/\r?\n/).map(l => {
    const m = l.match(/^\s*(\d+)\.(\d{3}).*realign run=\S+ to=(\d+)/);
    return m ? { at: Number(m[1]) * 1000 + Number(m[2]), to: Number(m[3]) } : null;
  }).filter(Boolean);
}

// Action titles on this app's ongoing chain notification.
function notifActions() {
  const dump = sh('shell dumpsys notification --noredact');
  const blocks = dump.split(/NotificationRecord\(/).filter(b => b.includes(`pkg=${PKG}`) && b.includes('chain-fg'));
  const titles = [];
  for (const b of blocks) {
    const m = b.match(/actions=\{([\s\S]*?)\n\s*\}/);
    if (!m) continue;
    for (const a of m[1].matchAll(/"([^"]+)"\s*->/g)) titles.push(a[1]);
  }
  return titles;
}

let evalJs = await connect();

const SEED = `(() => {
  const seg = (id, name, extra = {}) => ({ id, kind: 'segment', name, duration: 3, color: 'amber', ...extra });
  const seed = {
    schemaVersion: 1,
    chains: [
      { id: 'v_three', name: 'VThree', color: 'amber', loops: 1, hasRun: true,
        cues: { ringUntilDismissed: false },
        segments: [seg('t1', 'Three')], createdAt: 2, updatedAt: 2 },
      { id: 'v_gate', name: 'VGate', color: 'teal', loops: 1, hasRun: true,
        segments: [seg('g1', 'Work', { cues: { ringUntilDismissed: true } }), seg('g2', 'Rest')],
        createdAt: 1, updatedAt: 1 },
    ],
    settings: { sound: true, voice: false, vibrate: true, prestart: false,
                finalTick: true, ringUntilDismissed: true },
  };
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.indexOf('chained-timers/run/') === 0) localStorage.removeItem(k);
  }
  localStorage.setItem('chained-timers/v1', JSON.stringify(seed));
  return true;
})()`;

console.log('Seeding and reloading');
await evalJs(SEED);
await evalJs('location.reload()');
await wait(3000);
evalJs = await connect();
await wait(500);

const START = (id) => `(() => { const t = Date.now(); window.ChainedApp.UI.startRunForChain(window.ChainedApp.Store.getChain('${id}')); return t; })()`;
const BUTTON = `(() => { const b = document.getElementById('run-dismiss'); return { shown: !document.getElementById('run-dismiss-bar').hidden, text: b.textContent }; })()`;

console.log('\nTest 1: a 3s chain ticks from the 3');
{
  sh('logcat -c');
  const t0 = await evalJs(START('v_three'));
  await wait(4500);
  const c = cues();
  const first = c[0];
  if (first && first.at - t0 <= 500 && first.from === 0) ok(`final3 started ${first.at - t0}ms after start, from the pulse on 3`);
  else bad(`first cue: ${JSON.stringify(first)} (t0=${t0})`);
  // A late start is pulled back onto the clock after that first pulse.
  if (first && first.at - t0 >= 150) {
    const re = realigns()[0];
    if (re && Math.abs(re.to - (re.at - t0)) <= 60) ok(`realigned to ${re.to}ms at ${re.at - t0}ms in`);
    else bad(`realign: ${JSON.stringify(re)} (t0=${t0})`);
  }
  const mid = c.filter(x => x.at - t0 > 600 && x.at - t0 < 2700);
  eq(mid.length, 0, 'nothing re-armed a second in');
  const end = c.filter(x => x.at - t0 >= 2700);
  (end.length === 1) ? ok(`one cue at the end (the finale, ${end[0].at - t0}ms)`) : bad(`end cues: ${JSON.stringify(end.map(x => x.at - t0))}`);
}

console.log('\nTest 2: a mid-chain gate says Continue');
{
  await evalJs(`window.ChainedApp.View.show('library')`);
  await wait(500);
  await evalJs(START('v_gate'));
  await wait(4200);
  const b = await evalJs(BUTTON);
  eq(b, { shown: true, text: 'Continue' }, 'run view button');
  eq(notifActions(), ['Continue', 'Stop chain'], 'notification actions');
  shot('v1424-1-mid-gate.png');
  sh('shell cmd statusbar expand-notifications');
  await wait(1200);
  shot('v1424-2-mid-gate-shade.png');
  sh('shell cmd statusbar collapse');
  await wait(600);
}

console.log('\nTest 3: Continue into a 3s segment ticks from the 3');
{
  sh('logcat -c');
  const t0 = await evalJs(`(() => { const t = Date.now(); document.getElementById('run-dismiss').click(); return t; })()`);
  await wait(4200);
  const c = cues();
  const first = c[0];
  if (first && first.at - t0 < 400 && first.from === 0) ok(`final3 started ${first.at - t0}ms after Continue, from the top`);
  else bad(`first cue: ${JSON.stringify(first)} (t0=${t0})`);
  eq(c.filter(x => x.at - t0 > 600 && x.at - t0 < 2700).length, 0, 'nothing re-armed a second in');
}

console.log('\nTest 4: the chain-end gate is a lone Dismiss');
{
  const b = await evalJs(BUTTON);
  eq(b, { shown: true, text: 'Dismiss' }, 'run view button');
  eq(notifActions(), ['Dismiss'], 'notification actions');
  sh('shell cmd statusbar expand-notifications');
  await wait(1200);
  shot('v1424-3-end-gate-shade.png');
  sh('shell cmd statusbar collapse');
  await wait(600);
  await evalJs(`document.getElementById('run-dismiss').click()`);
  await wait(800);
  eq(await evalJs(`window.ChainedApp.Engine.activeRuns().length`), 0, 'Dismiss ended the chain');
}

console.log('');
if (failures) { console.log(`❌ ${failures} check(s) failed`); process.exit(1); }
console.log('✅ all checks passed');
process.exit(0);
