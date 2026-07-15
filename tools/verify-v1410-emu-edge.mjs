// v1.4.10 — verify that EDGE swipes (the Android system back-gesture
// zone) no longer minimize the app. This is the test that v1.4.9's
// verifier missed: CDP Input.dispatchTouchEvent injects touches
// AFTER the WebView's gesture detector, so it didn't exercise the
// path where the system consumed the swipe before our JS handler.
//
// Instead we use `adb shell input swipe`, which routes through the
// Android input manager just like a real finger — the system's
// back-gesture recognizer sees it, and if we haven't registered an
// OnBackInvokedCallback the activity gets finished (= minimize).
//
// Requires: emulator running, current debug APK installed, app in
// foreground, chrome-devtools socket forwarded to localhost:9222.

import { execSync } from 'node:child_process';

const ADB = process.env.ADB || 'C:\\Users\\erwin\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe';

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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result?.value;
};
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const ok    = (m) => console.log('  ✓', m);
const fail  = (m) => { console.error('  ✗', m); process.exit(1); };
const swipeEdge = (side) => {
  // 1080-wide device. Right-edge starts around x=1050+; left-edge <30.
  // These coords land squarely inside the Android system back-gesture zone.
  const [x1, x2] = side === 'right' ? [1075, 200] : [15, 900];
  execSync(`"${ADB}" shell input swipe ${x1} 1200 ${x2} 1200 250`, { stdio: 'ignore' });
};
const foregroundActivity = () => {
  const out = execSync(`"${ADB}" shell dumpsys activity activities`, { encoding: 'utf8' });
  // topResumedActivity=ActivityRecord{HASH u0 PACKAGE/.CLASS TASKID}
  const m = out.match(/topResumedActivity=ActivityRecord\{\S+\s+\S+\s+(\S+\/[.\S]+)/);
  return m ? m[1] : '(unknown)';
};

// Seed one chain, start it (skip prestart via settings), reload.
await evalJs(`
  localStorage.setItem('chained-timers/v1', JSON.stringify({
    schemaVersion: 1,
    chains: [{
      id: 'c_x', name: 'Test', color: 'amber', loops: 1,
      segments: [{ id: 's1', kind: 'segment', name: 'Seg', duration: 300, color: 'amber' }],
      createdAt: 1, updatedAt: 1,
    }],
    settings: { prestart: false },
  }));
  true;
`);
await send('Page.reload');
await wait(2000);
await evalJs(`document.querySelector('li[data-chain-id="c_x"] .chain-card-play').click(); true;`);
// Skip past any prestart.
await wait(4000);

let view = await evalJs(`document.body.dataset.view`);
if (view !== 'run') fail(`expected run view, got ${view}`);
ok('landed on run view');

// ---- Test 1: RIGHT-edge swipe from run view ----
swipeEdge('right');
await wait(600);
view = await evalJs(`document.body.dataset.view`);
if (view !== 'library') fail(`RIGHT edge from run: expected library, got ${view}`);
const fg1 = foregroundActivity();
if (!fg1.includes('chainedtimers')) fail(`app minimized after RIGHT edge from run: fg=${fg1}`);
ok('RIGHT edge from run → library (app foregrounded)');

// Re-enter run view by clicking the card body (chain still running).
await evalJs(`document.querySelector('li[data-chain-id="c_x"] .chain-card-body').click(); true;`);
await wait(400);
view = await evalJs(`document.body.dataset.view`);
if (view !== 'run') fail(`could not re-enter run (got ${view})`);

// ---- Test 2: LEFT-edge swipe from run view ----
swipeEdge('left');
await wait(600);
view = await evalJs(`document.body.dataset.view`);
if (view !== 'library') fail(`LEFT edge from run: expected library, got ${view}`);
const fg2 = foregroundActivity();
if (!fg2.includes('chainedtimers')) fail(`app minimized after LEFT edge from run: fg=${fg2}`);
ok('LEFT edge from run → library (app foregrounded)');

// ---- Test 3: RIGHT-edge swipe from EDITOR view ----
// Open the editor via the + FAB.
await evalJs(`document.getElementById('new-chain-fab').click(); true;`);
await wait(400);
view = await evalJs(`document.body.dataset.view`);
if (view !== 'editor') fail(`could not open editor (got ${view})`);

swipeEdge('right');
await wait(600);
view = await evalJs(`document.body.dataset.view`);
if (view !== 'library') fail(`RIGHT edge from editor: expected library, got ${view}`);
const fg3 = foregroundActivity();
if (!fg3.includes('chainedtimers')) fail(`app minimized after RIGHT edge from editor: fg=${fg3}`);
ok('RIGHT edge from editor → library (app foregrounded)');

// ---- Test 4: LEFT-edge swipe from EDITOR view ----
await evalJs(`document.getElementById('new-chain-fab').click(); true;`);
await wait(400);
view = await evalJs(`document.body.dataset.view`);
if (view !== 'editor') fail(`could not re-open editor (got ${view})`);

swipeEdge('left');
await wait(600);
view = await evalJs(`document.body.dataset.view`);
if (view !== 'library') fail(`LEFT edge from editor: expected library, got ${view}`);
const fg4 = foregroundActivity();
if (!fg4.includes('chainedtimers')) fail(`app minimized after LEFT edge from editor: fg=${fg4}`);
ok('LEFT edge from editor → library (app foregrounded)');

// ---- Test 5: LIBRARY back-gesture DOES minimize (that's the correct terminal behaviour) ----
// Confirm from library our chainBack handler falls through to exitApp
// as designed. This isn't the bug fix — it's a regression guard so
// we don't ever "trap" the user in the app.
swipeEdge('right');
await wait(1000);
const fg5 = foregroundActivity();
if (fg5.includes('chainedtimers')) fail(`from library, back should minimize app, but fg=${fg5}`);
ok('back from LIBRARY → app minimized (correct exit behaviour)');

console.log('\nAll v1.4.10 edge-swipe checks passed.');
ws.close();
process.exit(0);
