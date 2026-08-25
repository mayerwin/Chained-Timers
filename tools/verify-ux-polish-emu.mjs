// v1.4.13 — emulator visual check: "Chains" tab, reorder grips in
// select mode (with a real touch drag), and the segment-scope cue
// sheet wording.
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
const shot = (name) => {
  execSync(`"${ADB}" exec-out screencap -p > ${OUT}/${name}`, { shell: 'cmd.exe', stdio: ['ignore','ignore','ignore'] });
  console.log('  📸', `${OUT}/${name}`);
};
const touchStart = (x, y) => send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
const touchMove  = (x, y) => send('Input.dispatchTouchEvent', { type: 'touchMove',  touchPoints: [{ x, y }] });
const touchEnd   = ()     => send('Input.dispatchTouchEvent', { type: 'touchEnd',   touchPoints: [] });

await evalJs(`
  localStorage.setItem('chained-timers/v1', JSON.stringify({
    schemaVersion: 1,
    chains: [
      { id: 'c_1', name: 'Hanging',  color: 'amber',  loops: 1, hasRun: true,
        segments: [{ id: 's1', kind: 'segment', name: 'Hold', duration: 120, color: 'amber' }] },
      { id: 'c_2', name: 'Sprints',  color: 'teal',   loops: 1, hasRun: true,
        segments: [{ id: 's2', kind: 'segment', name: 'Run', duration: 60, color: 'teal' }] },
      { id: 'c_3', name: 'Cooldown', color: 'violet', loops: 1, hasRun: true,
        segments: [{ id: 's3', kind: 'segment', name: 'Walk', duration: 90, color: 'violet' }] },
    ],
    settings: { sound: true, voice: true, vibrate: true, prestart: true, finalTick: true },
  })); true;
`);
await send('Page.reload');
await wait(2500);

console.log('Phase 1: tab reads "Chains"');
{
  const label = await evalJs(`document.querySelector('.tab[data-tab="library"] span').textContent`);
  if (label !== 'Chains') fail(`tab label is "${label}"`);
  ok('tab label: Chains');
  shot('emu-26-chains-tab.png');
}

console.log('Phase 2: select mode shows reorder grips');
{
  await evalJs(`window.ChainedApp.UI.enterSelectMode('c_1'); true;`);
  await wait(400);
  const g = await evalJs(`(() => {
    const el = document.querySelector('li[data-chain-id="c_1"] .chain-card-grip');
    const r = el.getBoundingClientRect();
    return { display: getComputedStyle(el).display, x: r.left + r.width/2, y: r.top + r.height/2, w: r.width };
  })()`);
  if (g.display === 'none') fail('grip hidden in select mode');
  ok(`grips visible (${g.w}px column)`);
  shot('emu-27-select-grips.png');

  console.log('Phase 3: drag the first chain to the bottom by its grip');
  const before = await evalJs(`window.ChainedApp.Store.getChains().map(c => c.id)`);
  const last = await evalJs(`(() => { const r = document.querySelectorAll('li.chain-card')[2].getBoundingClientRect(); return r.top + r.height - 8; })()`);
  await touchStart(g.x, g.y);
  const steps = 16;
  for (let i = 1; i <= steps; i++) {
    await touchMove(g.x, g.y + ((last - g.y) * i) / steps);
    await wait(30);
    if (i === Math.round(steps / 2)) shot('emu-28-reorder-dragging.png');
  }
  const midDrag = await evalJs(`!!document.querySelector('.chain-card.is-reordering')`);
  if (!midDrag) fail('dragged row not marked mid-flight');
  ok('row lifts while dragging');
  await touchEnd();
  await wait(600);
  const after = await evalJs(`window.ChainedApp.Store.getChains().map(c => c.id)`);
  if (JSON.stringify(after) === JSON.stringify(before)) fail(`order unchanged: ${after}`);
  if (after[after.length - 1] !== 'c_1') fail(`c_1 not last: ${after}`);
  ok(`reordered ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  shot('emu-29-reorder-done.png');
  await evalJs(`window.ChainedApp.UI.exitSelectMode(); true;`);
  await wait(300);
}

console.log('Phase 4: segment cue sheet wording is segment-scoped');
{
  const copy = await evalJs(`(() => {
    const { UI, Store } = window.ChainedApp;
    const chain = Store.getChain('c_2');
    UI._openCueSheet('segment', chain.segments[0], chain, () => {});
    document.getElementById('cues-sheet').hidden = false;
    return [...document.querySelectorAll('#cues-list .cue-row')].map(r =>
      r.querySelector('.cue-row-title').textContent + ' :: ' + r.querySelector('.cue-row-hint').textContent);
  })()`);
  const joined = copy.join(' | ');
  if (/chain start\/end|every segment boundary|at chain end/i.test(joined)) fail(`chain-level wording leaked: ${joined}`);
  ok('no chain-level wording at segment scope');
  copy.forEach(c => console.log('     ·', c));
  shot('emu-30-segment-cues.png');
  await evalJs(`document.getElementById('cues-sheet').hidden = true; true;`);
}

console.log('\n✅ emulator UX-polish checks passed');
process.exit(0);
