// v1.4.11 — emulator-backed visual check of the inline prestart.
// Drives the installed debug APK over CDP (forwarded to :9222) and
// captures screenshots of: the classic full-screen 3-2-1 (single chain),
// the new inline 3-2-1 while another chain runs, and the final
// two-chains-running state.
//
// Requires: emulator running, current debug APK installed, app in
// foreground, chrome-devtools socket forwarded to localhost:9222.

import { execSync } from 'node:child_process';

const ADB = process.env.ADB || 'C:\\Users\\erwin\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe';
const OUT = process.env.OUT_DIR || 'screenshots';

const list = await (await fetch('http://localhost:9222/json/list')).json();
const target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
if (!target) { console.error('no CDP page'); process.exit(2); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  }
};
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => {
  const id = ++msgId;
  return new Promise((res, rej) => {
    pending.set(id, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
};
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description || ''));
  return r.result?.value;
};
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const ok   = (m) => console.log('  ✓', m);
const fail = (m) => { console.error('  ✗', m); process.exit(1); };
const shot = (name) => {
  execSync(`"${ADB}" exec-out screencap -p > ${OUT}/${name}`, { shell: 'cmd.exe', stdio: ['ignore', 'ignore', 'ignore'] });
  console.log('  📸', `${OUT}/${name}`);
};

// Seed: two chains, prestart ON, everything audible OFF (emulator is mute anyway).
await evalJs(`
  localStorage.setItem('chained-timers/v1', JSON.stringify({
    schemaVersion: 1,
    chains: [
      { id: 'c_a', name: 'Hanging', color: 'amber', loops: 1,
        segments: [{ id: 'a1', kind: 'segment', name: 'Hold', duration: 300, color: 'amber' }],
        createdAt: 1, updatedAt: 1 },
      { id: 'c_b', name: 'Stretch', color: 'teal', loops: 1,
        segments: [{ id: 'b1', kind: 'segment', name: 'Reach', duration: 120, color: 'teal' }],
        createdAt: 1, updatedAt: 1 },
    ],
    settings: { sound: false, voice: false, vibrate: false, prestart: true, finalTick: false },
  }));
  true;
`);
await send('Page.reload');
await wait(2500);

console.log('Phase 1: single-chain start → classic full-screen overlay');
await evalJs(`document.querySelector('li[data-chain-id="c_a"] .chain-card-play').click(); true;`);
await wait(700);
const overlayShown = await evalJs(`!document.getElementById('run-prestart').hidden`);
if (!overlayShown) fail('full-screen overlay missing on single-chain start');
ok('overlay shown');
shot('emu-14-prestart-overlay.png');
await wait(3200);
const aRunning = await evalJs(`window.ChainedApp.Engine.activeRunningCount()`);
if (aRunning !== 1) fail(`expected 1 running chain, got ${aRunning}`);
ok('Hanging running');

console.log('Phase 2: start second chain while first runs → inline 3-2-1');
await evalJs(`document.getElementById('run-back').click(); true;`);
await wait(500);
await evalJs(`document.querySelector('li[data-chain-id="c_b"] .chain-card-play').click(); true;`);
await wait(600);
const s = await evalJs(`(() => {
  const g = id => document.getElementById(id);
  return {
    overlayHidden: g('run-prestart').hidden,
    clock: g('run-clock').textContent,
    inlineClass: g('run-clock').classList.contains('is-prestart'),
    tag: g('run-segment-tag').textContent,
    chipsVisible: !g('run-chips').hidden,
    chips: g('run-chips').children.length,
  };
})()`);
if (!s.overlayHidden) fail('full-screen overlay used in multi-chain start');
if (!s.inlineClass || !/^[123]$/.test(s.clock)) fail(`inline countdown not showing (clock=${s.clock})`);
if (s.tag !== 'Get ready') fail(`eyebrow=${s.tag}`);
if (!s.chipsVisible || s.chips !== 2) fail(`chip strip wrong (visible=${s.chipsVisible}, n=${s.chips})`);
ok(`inline countdown live (clock=${s.clock}, chips=${s.chips})`);
shot('emu-15-inline-prestart.png');

await wait(3200);
const done = await evalJs(`(() => {
  const { Engine } = window.ChainedApp;
  return {
    running: Engine.activeRuns().map(r => r.id).sort(),
    focused: Engine.focusedRunId(),
    clock: document.getElementById('run-clock').textContent,
    inlineClass: document.getElementById('run-clock').classList.contains('is-prestart'),
  };
})()`);
if (done.running.join(',') !== 'c_a,c_b') fail(`expected both running, got ${done.running}`);
if (done.focused !== 'c_b') fail(`expected focus c_b, got ${done.focused}`);
if (done.inlineClass || !/\d{2}:\d{2}/.test(done.clock)) fail(`clock not restored (${done.clock})`);
ok(`both chains running, Stretch focused, clock=${done.clock}`);
shot('emu-16-inline-prestart-done.png');

console.log('\n✅ emulator inline-prestart checks passed');
process.exit(0);
