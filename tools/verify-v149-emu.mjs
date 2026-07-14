// Emulator-backed verification of the v1.4.9 fixes. Talks to the
// Android WebView directly via Chrome DevTools Protocol — no Playwright
// (which rejects Android WebView's Browser context API). Uses Node 22's
// built-in WebSocket, so no extra deps.
//
// This is the test the user asked for: the browser smoke pass green
// doesn't prove the *packaged* app behaves the same, because Android
// WebView has its own touch-handling quirks (that's exactly the class
// of bug v1.4.9 was fixing — swipe events that pass in Chromium didn't
// dispatch in the WebView).
//
// Prereqs (see run-verify-emu.ps1 wrapper for the setup):
//   1. Emulator running, debug APK installed and app in foreground.
//   2. adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
//      (pid via `adb shell cat /proc/net/unix | grep webview`).

const CDP_HTTP = 'http://localhost:9222';

// Grab the first inspectable page (the SPA WebView).
const list = await (await fetch(`${CDP_HTTP}/json/list`)).json();
const target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
if (!target) { console.error('no debuggable page found'); process.exit(2); }
console.log('Attaching to', target.url);

const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
const events  = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id) {
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  } else {
    events.push(m);
  }
};
ws.onerror = (e) => { console.error('WS error:', e.message); process.exit(2); };
await new Promise((r) => ws.onopen = r);

const send = (method, params = {}) => {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
};
await send('Runtime.enable');
await send('Page.enable');
await send('DOM.enable');

const evalJs = async (expr, awaitPromise = true) => {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description || ''));
  return r.result?.value;
};

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const ok    = (m) => console.log('  ✓', m);
const fail  = (m) => { console.error('  ✗', m); process.exit(1); };

// Auto-accept any confirm() dialog (bulk-delete flow uses one).
await send('Page.setBypassCSP', { enabled: true }).catch(() => {});
// Override window.confirm to always accept — simpler than routing dialogs
// through CDP's Dialog domain (which needs Page.javascriptDialogOpening
// events to be delivered before we ack).
await evalJs(`window.confirm = () => true; true;`, false);

// ---------------------------------------------------------------------
console.log('[0] Seed two chains, reload');
await evalJs(`
  localStorage.setItem('chained-timers/v1', JSON.stringify({
    schemaVersion: 1,
    chains: [
      { id: 'c_a', name: 'Alpha Chain', color: 'amber', loops: 1,
        segments: [
          { id: 's1', kind: 'segment', name: 'A1', duration: 30, color: 'amber' },
          { id: 's2', kind: 'segment', name: 'A2', duration: 30, color: 'rust'  },
        ], createdAt: 1, updatedAt: 1 },
      { id: 'c_b', name: 'Beta Chain', color: 'rust', loops: 1,
        segments: [{ id: 's3', kind: 'segment', name: 'B1', duration: 30, color: 'rust' }],
        createdAt: 2, updatedAt: 2 },
    ], settings: {},
  }));
  true;
`, false);
await send('Page.reload');
// Wait for the seeded chain card to render.
for (let i = 0; i < 30; i++) {
  const found = await evalJs(`!!document.querySelector('li[data-chain-id="c_a"]')`, false);
  if (found) break;
  await wait(200);
}
const seedOk = await evalJs(`!!document.querySelector('li[data-chain-id="c_a"]')`, false);
if (!seedOk) fail('seed chains did not render'); else ok('two chains rendered');

// After reload, re-inject confirm override.
await evalJs(`window.confirm = () => true; true;`, false);

// Helper: click a CSS selector.
const clickSel = async (sel) => {
  await evalJs(`document.querySelector(${JSON.stringify(sel)}).click(); true;`, false);
};

// Helper: synthesise a horizontal touch drag through CDP so the
// Android WebView sees a real touch sequence (this is precisely what
// v1.4.8 got wrong — the JS handler was correct, but the WebView's
// default touch-action ate the drag before pointer events fired).
const swipe = async (dir /* 'left'|'right' */) => {
  const box = await evalJs(`(() => {
    const r = document.querySelector('.view-run').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`, false);
  const cy = Math.round(box.y + box.h / 2);
  const [x0, x1] = dir === 'left'
    ? [Math.round(box.x + box.w - 40), Math.round(box.x + 60)]
    : [Math.round(box.x + 40),         Math.round(box.x + box.w - 60)];
  await send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: x0, y: cy }],
  });
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / steps);
    await send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: cy }],
    });
    await wait(20);
  }
  await send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
};

// ---------------------------------------------------------------------
console.log('[1] Swipe-back on run view (LEFT + RIGHT)');

await clickSel('li[data-chain-id="c_a"] .chain-card-play');
// Wait for view=run AND the prestart to finish (3s countdown).
for (let i = 0; i < 30; i++) {
  const v = await evalJs(`document.body.dataset.view`, false);
  if (v === 'run') break;
  await wait(150);
}
await wait(3500);
let view = await evalJs(`document.body.dataset.view`, false);
if (view !== 'run') fail(`expected run view, got ${view}`);
ok('landed on run view');

await swipe('left');
await wait(500);
view = await evalJs(`document.body.dataset.view`, false);
if (view !== 'library') fail(`left swipe: expected library, got ${view}`);
ok('LEFT swipe on WebView → library');

// Re-enter run view. Directly focus + navigate — bypasses the fact
// that .chain-card-play on a running chain doesn't always land us on
// run (there's an inline status card that eats some clicks).
// `const Engine =` at top level of a browser script is a lexical
// binding, not a window property, but bare-name lookup in the page
// global scope still resolves it.
// Re-enter run view. `const Engine` in the app script isn't reachable
// via Runtime.evaluate (script-scoped, not on window). Simulate a real
// touch tap on Alpha's running chain card — the app's own click
// handler resolves "already running → focus + navigate to run view".
{
  const rc = await evalJs(`(() => {
    const r = document.querySelector('li[data-chain-id="c_a"]').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`, false);
  const tx = Math.round(rc.x + rc.w / 2);
  const ty = Math.round(rc.y + rc.h / 2);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tx, y: ty }] });
  await wait(60);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await wait(400);
}
view = await evalJs(`document.body.dataset.view`, false);
if (view !== 'run') fail(`could not re-enter run view (view=${view})`);

await swipe('right');
await wait(500);
view = await evalJs(`document.body.dataset.view`, false);
if (view !== 'library') fail(`right swipe: expected library, got ${view}`);
ok('RIGHT swipe on WebView → library');

// ---------------------------------------------------------------------
console.log('[2] Chain-name inline rename from run view');

// Alpha is still running from [1] — tap its row to re-enter run view.
{
  const rc = await evalJs(`(() => {
    const r = document.querySelector('li[data-chain-id="c_a"]').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`, false);
  const tx = Math.round(rc.x + rc.w / 2);
  const ty = Math.round(rc.y + rc.h / 2);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tx, y: ty }] });
  await wait(60);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await wait(400);
}
view = await evalJs(`document.body.dataset.view`, false);
if (view !== 'run') fail(`could not enter run view (view=${view})`);

const before = (await evalJs(`document.getElementById('run-chain-name').textContent`, false))?.trim();
if (before !== 'Alpha Chain') fail(`expected "Alpha Chain", got "${before}"`);
ok(`topbar shows "${before}"`);

await clickSel('#run-chain-name');
await wait(300);
const hasInput = await evalJs(`!!document.querySelector('.run-chain-name-input')`, false);
if (!hasInput) fail('rename input did not appear');
ok('rename input appeared');

// Set value then dispatch Enter — the handler listens for keydown Enter,
// which blurs and triggers the commit path.
await evalJs(`
  const el = document.querySelector('.run-chain-name-input');
  el.focus();
  el.value = 'Renamed On Device';
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  true;
`, false);
await wait(300);
const after = (await evalJs(`document.getElementById('run-chain-name').textContent`, false))?.trim();
if (after !== 'Renamed On Device') fail(`expected "Renamed On Device", got "${after}"`);
ok('topbar shows new name');
const stored = await evalJs(`
  JSON.parse(localStorage.getItem('chained-timers/v1')).chains.find(c => c.id === 'c_a').name
`, false);
if (stored !== 'Renamed On Device') fail(`Store still has "${stored}"`);
ok('Store persisted rename');

// ---------------------------------------------------------------------
console.log('[3] Bulk-delete from multi-select toolbar');

// Back to library via the chainBack event (same channel the hardware
// back button uses — verifies our navigation contract too).
await evalJs(`window.dispatchEvent(new Event('chainBack')); true;`, false);
await wait(400);
// Stop any running chain so the long-press below hits an idle row.
// Stop any running chain by clicking the app's stop button — the
// bulk-delete long-press works on running chains too, but a stopped
// row makes the test's assertions clearer.
await evalJs(`
  (() => {
    const stops = document.querySelectorAll('.chain-status-stop, .now-playing-stop');
    stops.forEach(b => b.click());
  })();
  true;
`, false);
await wait(200);

// Enter select mode via CDP touch long-press on Beta.
const rb = await evalJs(`(() => {
  const r = document.querySelector('li[data-chain-id="c_b"]').getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
})()`, false);
const tx = Math.round(rb.x + rb.w / 2);
const ty = Math.round(rb.y + rb.h / 2);
await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tx, y: ty }] });
await wait(700);
await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await wait(400);

const barHidden = await evalJs(`document.getElementById('library-topbar-select').hidden`, false);
if (barHidden) fail('select toolbar did not appear');
ok('select toolbar visible');

const delMissing = await evalJs(`!document.getElementById('library-select-delete')`, false);
if (delMissing) fail('bulk-delete button missing');
const delDisabled = await evalJs(`document.getElementById('library-select-delete').disabled`, false);
if (delDisabled) fail('bulk-delete button should be enabled with 1 selection');
ok('bulk-delete enabled');

await clickSel('#library-select-delete');
await wait(400);
const stillPresent = await evalJs(`
  JSON.parse(localStorage.getItem('chained-timers/v1')).chains.some(c => c.id === 'c_b')
`, false);
if (stillPresent) fail('c_b should be deleted');
ok('c_b removed from Store on device');

console.log('\nAll v1.4.9 emulator checks passed.');
ws.close();
process.exit(0);
