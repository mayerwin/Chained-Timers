// v1.4.23 — emulator verification of the two-chain background-gate report.
//
// Steps from the report: start a short chain, start a longer one, leave
// the app, wait for the short one to end.
//
//   1. It rings — and the app must come back ON the chain that rang,
//      with its Dismiss. Before this, the run view stayed on the chain
//      still counting: the alarm sounded and nothing on screen said
//      which timer was up.
//   2. Opening the longer, still-counting chain must look like a chain
//      that is still counting — no leftover "finished" red.
//   3. Dismiss in the SHORT chain's notification must clear the short
//      chain. The bridge used to drop the whole 'dismiss' command, and
//      to drop runId from the ones it did forward — so with two chains
//      up, notification buttons acted on whichever chain was focused.
//
// Only the pieces that need a device are here: the WebView actually
// freezing while backgrounded (so the boundary is discovered on resume,
// via the service's gate state), and the real notification PendingIntent
// reaching the service. The DOM-level contract is in
// tools/smoke-bg-gate-focus.mjs.
//
// Requires: emulator running, current debug APK installed, app
// foregrounded, CDP on localhost:9222, POST_NOTIFICATIONS granted.
// Step 3 sends the notification's own service intent, which needs an
// `adb root` shell on the emulator (the service is not exported).
// Launch it all with: publishing\android\LAUNCH.ps1 -Devtools

import { execSync } from 'node:child_process';

const ADB = process.env.ADB || 'C:\\Users\\erwin\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe';
const OUT = process.env.OUT_DIR || 'screenshots';
const PKG = 'com.github.chainedtimers';

const sh   = (cmd) => execSync(`"${ADB}" ${cmd}`, { encoding: 'utf8' });
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

// The WebView target dies and respawns across a reload, so connecting is
// a function, not a one-off.
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

let evalJs = await connect();

const STATE = `(() => {
  const { Engine } = window.ChainedApp;
  const view = document.querySelector('.view-run');
  const clock = document.getElementById('run-clock');
  return {
    view: document.body.dataset.view,
    tints: [...view.classList].filter(c => c === 'is-alarm' || c === 'is-warning' || c === 'is-paused').sort(),
    chain: document.getElementById('run-chain-name').textContent,
    clock: clock.textContent,
    clockRed: getComputedStyle(clock).color === 'rgb(226, 72, 58)',
    dismissBar: !document.getElementById('run-dismiss-bar').hidden,
    focused: Engine.focusedRunId(),
    held: Engine.activeRuns().filter(r => r.awaitingDismiss).map(r => r.id).sort(),
    running: Engine.activeRuns().map(r => r.id).sort(),
  };
})()`;

// 20s for the short chain: long enough to background the app before it
// ends, short enough not to pad the run.
const SEED = `(() => {
  const seed = {
    schemaVersion: 1,
    chains: [
      { id: 'v_short', name: 'VShort', color: 'amber', loops: 1, hasRun: true,
        segments: [{ id: 'vs1', kind: 'segment', name: 'Short seg', duration: 20, color: 'amber' }],
        createdAt: 1, updatedAt: 1 },
      { id: 'v_long', name: 'VLong', color: 'teal', loops: 1, hasRun: true,
        segments: [{ id: 'vl1', kind: 'segment', name: 'Long seg', duration: 180, color: 'teal' }],
        createdAt: 2, updatedAt: 2 },
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

console.log('Seeding two chains and reloading');
await evalJs(SEED);
await evalJs('location.reload()');
await wait(3000);
evalJs = await connect();
await wait(500);

console.log('\nStarting the short chain, then the long one');
await evalJs(`window.ChainedApp.UI.startRunForChain(window.ChainedApp.Store.getChain('v_short'))`);
await wait(1000);
await evalJs(`window.ChainedApp.View.show('library')`);
await evalJs(`window.ChainedApp.UI.startRunForChain(window.ChainedApp.Store.getChain('v_long'))`);
await wait(1000);
{
  const s = await evalJs(STATE);
  eq(s.running, ['v_long', 'v_short'], 'both chains running');
  eq(s.focused, 'v_long',              'the chain started last is focused');
}

console.log('\nTest 1: home, let the short chain ring, come back');
sh('shell input keyevent KEYCODE_HOME');
await wait(26000);
sh(`shell am start -n ${PKG}/.MainActivity`);
await wait(3000);
try { evalJs = await connect(); } catch (e) { bad('reconnect failed: ' + e.message); }
{
  const s = await evalJs(STATE);
  eq(s.held,       ['v_short'],  'the short chain is held at its gate');
  eq(s.focused,    'v_short',    'and it owns the run view');
  eq(s.view,       'run',        'which is what the app came back to');
  eq(s.chain,      'VShort',     'showing the chain that rang');
  eq(s.tints,      ['is-alarm'], 'read as ringing');
  eq(s.dismissBar, true,         'Dismiss offered');
  eq(s.clockRed,   true,         'clock in warn red');
  (s.clock.startsWith('-')) ? ok(`clock counting past zero = ${s.clock}`)
                            : bad(`clock should count past zero, got ${s.clock}`);
  shot('v1423-1-ringing-chain-opened.png');
}

console.log('\nTest 2: open the longer chain — still counting, no finished red');
await evalJs(`window.ChainedApp.Engine.focus('v_long')`);
await wait(600);
{
  const s = await evalJs(STATE);
  eq(s.chain,      'VLong', 'run view shows the long chain');
  eq(s.tints,      [],      'no leftover tint');
  eq(s.dismissBar, false,   'no leftover Dismiss bar');
  eq(s.clockRed,   false,   'clock in its normal colour');
  shot('v1423-2-long-chain-clean.png');
  const first = s.clock;
  await wait(2000);
  const s2 = await evalJs(STATE);
  (s2.clock !== first && s2.tints.length === 0)
    ? ok(`still counting down and still clean = ${first} -> ${s2.clock}`)
    : bad(`expected a clean ticking clock, got ${first} -> ${s2.clock} tints=${JSON.stringify(s2.tints)}`);
}

console.log('\nTest 3: Dismiss in the short chain\'s notification clears THAT chain');
try {
  sh(`shell am start-foreground-service -n ${PKG}/.ChainTimerService `
     + `-a com.github.chainedtimers.action.CMD --es chainCommand dismiss --es runId v_short`);
  await wait(1500);
  const s = await evalJs(STATE);
  eq(s.running, ['v_long'], 'the chain named in the command ended');
  eq(s.held,    [],         'no gate left held');
  eq(s.focused, 'v_long',   'the focused chain was not touched');
  eq(s.tints,   [],         'and carries no tint from the one that rang');
} catch (e) {
  bad('could not deliver the notification command (needs `adb root`): ' + e.message);
}

console.log('');
if (failures) { console.log(`❌ ${failures} check(s) failed`); process.exit(1); }
console.log('✅ all checks passed');
process.exit(0);
