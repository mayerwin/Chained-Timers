// v1.4.12 — emulator-backed visual check of (a) mid-run segment rename
// and (b) the first-run prestart Skip / Always-skip snackbar.
//
// Drives the installed debug APK over CDP (forwarded to :9222): real
// touches via Input.dispatchTouchEvent, typing via Input.insertText,
// screenshots via adb screencap. Also asserts the FGS notification
// picks up the renamed segment (dumpsys notification), exercising the
// chain:fgsupdate path end-to-end.
//
// Requires: emulator running, current debug APK installed, app in
// foreground, chrome-devtools socket forwarded to localhost:9222,
// POST_NOTIFICATIONS granted.

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
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
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
const tap = async (x, y) => {
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};
const tapEl = async (sel) => {
  const p = await evalJs(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
  await tap(p.x, p.y);
};
const pressEnter = async () => {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
};

// Seed: Sprint has never run (skip-snack test), Hold ditto (rename test
// runs it first via Skip so the countdown doesn't slow the script).
await evalJs(`
  localStorage.setItem('chained-timers/v1', JSON.stringify({
    schemaVersion: 1,
    chains: [
      { id: 'c_run', name: 'Session', color: 'amber', loops: 1,
        segments: [{ id: 's_hold', kind: 'segment', name: 'Hold', duration: 300, color: 'amber' }],
        createdAt: 2, updatedAt: 2 },
    ],
    settings: { sound: false, voice: true, vibrate: false, prestart: true, finalTick: false },
  }));
  true;
`);
await send('Page.reload');
await wait(2500);

console.log('Phase 1: first-run countdown shows the Skip / Always-skip snackbar');
{
  await evalJs(`(() => { const { Store, UI } = window.ChainedApp; UI.startRunForChain(Store.getChain('c_run')); return true; })()`);
  await wait(700);
  const s = await evalJs(`(() => {
    const t = document.querySelector('.toast.has-action');
    return {
      overlay: !document.getElementById('run-prestart').hidden,
      labels: t ? [...t.querySelectorAll('.toast-action-btn')].map(b => b.textContent) : [],
    };
  })()`);
  if (!s.overlay) fail('countdown overlay missing');
  if (s.labels.join(',') !== 'Skip,Always skip') fail(`snack labels wrong: ${s.labels}`);
  ok('countdown + snackbar with both actions');
  shot('emu-22-prestart-skip-snack.png');

  console.log('Phase 2: tap Skip → chain starts immediately, setting untouched');
  const btn = await evalJs(`(() => { const b = [...document.querySelectorAll('.toast-action-btn')].find(x => x.textContent === 'Skip'); const r = b.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
  await tap(btn.x, btn.y);
  await wait(600);
  const s2 = await evalJs(`(() => {
    const { Engine, Store } = window.ChainedApp;
    return { running: Engine.activeRuns().map(r => r.id), overlay: !document.getElementById('run-prestart').hidden, setting: Store.getSettings().prestart };
  })()`);
  if (s2.running.join() !== 'c_run' || s2.overlay) fail(`skip failed: ${JSON.stringify(s2)}`);
  if (s2.setting !== true) fail('Skip changed the setting');
  ok('started instantly; prestart setting preserved');
}

console.log('Phase 3: tap the segment title mid-run → inline rename input');
{
  await tapEl('#run-segment-name');
  await wait(400);
  const editing = await evalJs(`!!document.querySelector('.run-segment-name-input')`);
  if (!editing) fail('rename input did not open');
  ok('input swapped in (keyboard up)');
  shot('emu-23-rename-input.png');

  console.log('Phase 4: type new name + Enter → display, Store, notification');
  await evalJs(`(() => { const i = document.querySelector('.run-segment-name-input'); i.value = ''; return true; })()`);
  await send('Input.insertText', { text: 'Dead Hang' });
  await pressEnter();
  await wait(1200);
  const s = await evalJs(`(() => {
    const { Store, Engine } = window.ChainedApp;
    return {
      title: document.getElementById('run-segment-name')?.textContent,
      store: Store.getChain('c_run').segments[0].name,
      expanded: Engine._runs.get('c_run').segments[0].name,
    };
  })()`);
  if (s.title !== 'Dead Hang') fail(`title=${s.title}`);
  if (s.store !== 'Dead Hang') fail(`store=${s.store}`);
  if (s.expanded !== 'Dead Hang') fail(`expanded=${s.expanded}`);
  ok('title + Store + live run all renamed');
  shot('emu-24-rename-done.png');

  const dump = execSync(`"${ADB}" shell dumpsys notification --noredact`, { encoding: 'utf8' });
  if (dump.includes('Dead Hang')) ok('FGS notification shows the new name (fgsupdate path)');
  else fail('notification still shows the old name');
}

console.log('\n✅ emulator rename + skip-prestart checks passed');
process.exit(0);
