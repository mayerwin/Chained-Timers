// v1.4.12 — emulator-backed visual check of swipe-to-delete.
//
// Drives the installed debug APK over CDP (forwarded to :9222) using
// Input.dispatchTouchEvent so the drag can be HELD mid-gesture for
// screenshots: the red underlay + trash reveal, the armed icon pop,
// the post-delete Undo snackbar, and the blocked (embedded chain)
// resist + notice. In-page gestures are exactly what CDP touch
// injection exercises reliably (the v1.4.9 lesson only applies to
// SYSTEM edge gestures, which bypass it).
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

// Touch helpers — CSS px coordinates (the WebView viewport).
const touchStart = (x, y) => send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
const touchMove  = (x, y) => send('Input.dispatchTouchEvent', { type: 'touchMove',  touchPoints: [{ x, y }] });
const touchEnd   = ()     => send('Input.dispatchTouchEvent', { type: 'touchEnd',   touchPoints: [] });
async function dragTo(x0, y0, x1, steps = 14) {
  await touchStart(x0, y0);
  for (let i = 1; i <= steps; i++) {
    await touchMove(x0 + ((x1 - x0) * i) / steps, y0);
    await wait(16);
  }
}
const cardCenter = async (chainId) => evalJs(`(() => {
  const li = document.querySelector('li[data-chain-id="${chainId}"]');
  const r = li.getBoundingClientRect();
  return { x: r.left + r.width * 0.4, y: r.top + r.height / 2 };
})()`);

// Seed: one deletable chain, one embedded chain + 5 chains referencing it.
const seg = (id, name) => `{ id: '${id}', kind: 'segment', name: '${name}', duration: 45, color: 'amber' }`;
await evalJs(`
  localStorage.setItem('chained-timers/v1', JSON.stringify({
    schemaVersion: 1,
    chains: [
      { id: 'c_hang', name: 'Hanging', color: 'amber', loops: 1,
        segments: [${seg('s1', 'Hold')}], createdAt: 5, updatedAt: 5 },
      { id: 'c_emb', name: 'Warmup', color: 'teal', loops: 1,
        segments: [${seg('s2', 'Reach')}], createdAt: 4, updatedAt: 4 },
      { id: 'c_a', name: 'Morning Mobility Routine', color: 'violet', loops: 1,
        segments: [{ id: 'x1', kind: 'subchain', refId: 'c_emb' }], createdAt: 3, updatedAt: 3 },
      { id: 'c_b', name: 'Leg Day', color: 'rust', loops: 1,
        segments: [{ id: 'x2', kind: 'subchain', refId: 'c_emb' }], createdAt: 3, updatedAt: 3 },
      { id: 'c_c', name: 'Push Day', color: 'sage', loops: 1,
        segments: [{ id: 'x3', kind: 'subchain', refId: 'c_emb' }], createdAt: 3, updatedAt: 3 },
      { id: 'c_d', name: 'Pull Day', color: 'amber', loops: 1,
        segments: [{ id: 'x4', kind: 'subchain', refId: 'c_emb' }], createdAt: 3, updatedAt: 3 },
      { id: 'c_e', name: 'Core Day', color: 'teal', loops: 1,
        segments: [{ id: 'x5', kind: 'subchain', refId: 'c_emb' }], createdAt: 3, updatedAt: 3 },
    ],
    settings: { sound: false, voice: false, vibrate: false, prestart: false, finalTick: false },
  }));
  true;
`);
await send('Page.reload');
await wait(2500);

console.log('Phase 1: drag left, hold mid-gesture → red underlay + trash reveal');
{
  const { x, y } = await cardCenter('c_hang');
  await dragTo(x, y, x - 70);
  await wait(150);
  const s = await evalJs(`(() => {
    const u = document.querySelector('.swipe-underlay');
    return { u: !!u, blocked: u?.classList.contains('is-blocked') ?? true, armed: u?.classList.contains('is-armed') ?? false };
  })()`);
  if (!s.u || s.blocked) fail(`underlay wrong: ${JSON.stringify(s)}`);
  ok('red underlay revealed, not yet armed');
  shot('emu-17-swipe-reveal.png');

  console.log('Phase 2: drag past threshold → trash pops (armed)');
  await dragTo(x - 70, y, x - 150, 8);
  await wait(200);
  const armed = await evalJs(`document.querySelector('.swipe-underlay')?.classList.contains('is-armed')`);
  if (!armed) fail('not armed past threshold');
  ok('armed — trash icon popped');
  shot('emu-18-swipe-armed.png');

  console.log('Phase 3: release → slide out, collapse, Undo snackbar');
  await touchEnd();
  await wait(800);
  const after = await evalJs(`(() => {
    const { Store } = window.ChainedApp;
    const t = document.querySelector('.toast.has-action');
    return {
      deleted: !Store.getChain('c_hang'),
      snack: !!t, text: t?.textContent || '',
      undoBtn: !!t?.querySelector('.toast-action-btn'),
    };
  })()`);
  if (!after.deleted) fail('chain not deleted');
  if (!after.snack || !after.undoBtn) fail('undo snackbar missing');
  ok(`deleted, snackbar: "${after.text}"`);
  shot('emu-19-swipe-deleted-undo.png');

  console.log('Phase 4: tap Undo → chain restored');
  const b = await evalJs(`(() => { const r = document.querySelector('.toast-action-btn').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
  await touchStart(b.x, b.y); await touchEnd();
  await wait(400);
  const restored = await evalJs(`!!window.ChainedApp.Store.getChain('c_hang')`);
  if (!restored) fail('undo did not restore');
  ok('undo restored the chain');
}

console.log('Phase 5: embedded chain — resisted drag, neutral underlay, used-by notice');
{
  const { x, y } = await cardCenter('c_emb');
  await dragTo(x, y, x - 150);
  await wait(150);
  const s = await evalJs(`(() => {
    const u = document.querySelector('.swipe-underlay');
    const li = document.querySelector('li[data-chain-id="c_emb"]');
    const tx = parseFloat((li?.style.transform || '').replace(/[^-\\d.]/g, '')) || 0;
    return { blocked: u?.classList.contains('is-blocked') ?? false, tx };
  })()`);
  if (!s.blocked) fail('blocked underlay missing');
  if (!(s.tx < 0 && s.tx >= -56)) fail(`resistance off: tx=${s.tx}`);
  ok(`resisted at ${s.tx}px, neutral underlay`);
  shot('emu-20-swipe-blocked.png');
  await touchEnd();
  await wait(400);
  const notice = await evalJs(`document.querySelector('.toast.has-action')?.textContent || ''`);
  if (!notice.includes("Can't delete") || !notice.includes('+2 more')) fail(`notice off: "${notice}"`);
  const stillThere = await evalJs(`!!window.ChainedApp.Store.getChain('c_emb')`);
  if (!stillThere) fail('embedded chain was deleted');
  ok(`notice: "${notice}"`);
  shot('emu-21-swipe-blocked-notice.png');
}

console.log('\n✅ emulator swipe-delete checks passed');
process.exit(0);
