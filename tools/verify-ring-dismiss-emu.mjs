// v1.4.13 — emulator verification of "Ring until dismissed".
//
// The parts that ONLY exist on device: the foreground service holding
// the gate while the WebView sleeps, the looping alarm cue, and the
// notification whose actions collapse to Dismiss. Checked here with
// real adb/dumpsys evidence rather than DOM state.
//
// Requires: emulator running (WITH audio — do not pass -no-audio),
// current debug APK installed, app foregrounded, CDP on localhost:9222,
// POST_NOTIFICATIONS granted.

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
const notifDump = () => { try { return sh('shell dumpsys notification --noredact'); } catch { return ''; } };
const startedPlayers = () => {
  try { return (sh('shell dumpsys audio').match(/state:started/g) || []).length; } catch { return 0; }
};

// 3s gated segment, then a long one. Sound on so the alarm is audible.
await evalJs(`
  // Clear any run snapshot left by a previous verification run — it
  // would be restored on load and swallow the fresh start (a chain
  // already running just re-focuses instead of starting again).
  Object.keys(localStorage).filter(k => k.startsWith('chained-timers/run/')).forEach(k => localStorage.removeItem(k));
  localStorage.setItem('chained-timers/v1', JSON.stringify({
    schemaVersion: 1,
    chains: [{ id: 'c_ring', name: 'Gated', color: 'amber', loops: 1, hasRun: true,
      segments: [
        { id: 's1', kind: 'segment', name: 'Hold', duration: 3, color: 'amber',
          cues: { ringUntilDismissed: true } },
        { id: 's2', kind: 'segment', name: 'Rest', duration: 300, color: 'teal' },
      ] }],
    settings: { sound: true, voice: false, vibrate: true, prestart: false, finalTick: false, ringThroughDnd: true },
  })); true;
`);
// A previous run may have left the notification shade expanded, which
// would sit on top of every in-app screenshot below.
try { sh('shell cmd statusbar collapse'); } catch {}
await send('Page.reload');
await wait(2500);

console.log('Phase 1: gate holds in the FOREGROUND, Dismiss bar shown');
{
  await evalJs(`(() => { const { Store, UI } = window.ChainedApp; UI.startRunForChain(Store.getChain('c_ring')); return true; })()`);
  await wait(4200);
  const s = await evalJs(`(() => {
    const run = window.ChainedApp.Engine._focused;
    return {
      awaiting: !!run?.awaitingDismiss,
      index: run?.currentIndex,
      barShown: !document.getElementById('run-dismiss-bar').hidden,
      label: document.getElementById('run-dismiss-label').textContent,
      clock: document.getElementById('run-clock').textContent,
    };
  })()`);
  if (!s.awaiting || s.index !== 0) fail(`not held: ${JSON.stringify(s)}`);
  if (!s.barShown) fail('Dismiss bar not shown');
  ok(`held at gate ("${s.label}", clock ${s.clock})`);
  shot('emu-31-ring-dismiss-bar.png');

  // The alarm must actually be producing audio on device.
  // Each burst is under a second and repeats every 1.5s, so sample
  // fast across several burst windows rather than betting on one poll
  // landing inside a burst.
  let sawAudio = false;
  for (let i = 0; i < 30; i++) {
    if (startedPlayers() > 0) { sawAudio = true; break; }
    await wait(200);
  }
  if (!sawAudio) fail('no audio player started while ringing');
  ok('alarm audible (audio players started)');

  // Notification collapses to Dismiss while ringing.
  const dump = notifDump();
  if (!/tap Dismiss/.test(dump)) fail('notification title does not show the gate');
  ok('notification title reads "… done · tap Dismiss"');
}

console.log('Phase 2: in-app Dismiss advances and silences');
{
  const p = await evalJs(`(() => { const r = document.getElementById('run-dismiss').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await wait(900);
  const s = await evalJs(`(() => {
    const run = window.ChainedApp.Engine._focused;
    return { awaiting: !!run?.awaitingDismiss, index: run?.currentIndex, alarm: window.ChainedApp.Alarm.active() };
  })()`);
  if (s.awaiting || s.index !== 1) fail(`dismiss failed: ${JSON.stringify(s)}`);
  ok('advanced to segment 2, gate cleared');
  const dump = notifDump();
  if (/tap Dismiss/.test(dump)) fail('notification still shows the gate after dismissal');
  ok('notification back to normal transport');
  shot('emu-32-ring-after-dismiss.png');
  await evalJs(`window.ChainedApp.Engine.stopRun('c_ring'); true;`);
  await wait(400);
}

console.log('Phase 3: gate holds with the app BACKGROUNDED (service-owned)');
{
  await evalJs(`(() => { const { Store, UI } = window.ChainedApp; UI.startRunForChain(Store.getChain('c_ring')); return true; })()`);
  await wait(500);
  // Home — the WebView stops getting frames; only the FGS is live.
  sh('shell input keyevent KEYCODE_HOME');
  await wait(6000);   // past the 3s gate, with margin
  const dump = notifDump();
  if (!/tap Dismiss/.test(dump)) fail('service did not hold the gate in the background');
  ok('service held the gate with the app backgrounded');
  if (!/Dismiss/.test(dump)) fail('no Dismiss action on the notification');
  ok('notification offers a Dismiss action');
  // Each burst is under a second and repeats every 1.5s, so sample
  // fast across several burst windows rather than betting on one poll
  // landing inside a burst.
  let sawAudio = false;
  for (let i = 0; i < 30; i++) {
    if (startedPlayers() > 0) { sawAudio = true; break; }
    await wait(200);
  }
  if (!sawAudio) fail('background alarm produced no audio');
  ok('background alarm audible');
  shot('emu-33-ring-background-notif.png');

  // It must NOT advance on its own while held.
  await wait(4000);
  if (!/tap Dismiss/.test(notifDump())) fail('gate released itself without a dismissal');
  ok('still held after waiting — no unattended advance');
}

console.log('Phase 4: notification Dismiss resumes the chain, JS re-syncs');
{
  // Tap the REAL Dismiss action in the notification shade. (The service
  // is deliberately not exported, so adb can't shortcut into it — which
  // is exactly why this has to go through the UI the user touches.)
  sh('shell cmd statusbar expand-notifications');
  await wait(1500);
  sh('shell uiautomator dump /sdcard/ui.xml');
  const xml = sh('shell cat /sdcard/ui.xml');
  // Action buttons render as clickable nodes whose text is the label.
  const m = xml.match(/text="Dismiss"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if (!m) fail('no Dismiss button found in the notification shade');
  const cx = Math.round((Number(m[1]) + Number(m[3])) / 2);
  const cy = Math.round((Number(m[2]) + Number(m[4])) / 2);
  shot('emu-34-ring-shade-dismiss.png');
  sh(`shell input tap ${cx} ${cy}`);
  ok(`tapped the notification's Dismiss action at ${cx},${cy}`);
  await wait(1500);
  const dump = notifDump();
  if (/tap Dismiss/.test(dump)) fail('gate still held after notification Dismiss');
  ok('service cleared the gate');
  // Back to the app: JS must agree (not stuck showing a Dismiss bar).
  sh(`shell am start -n ${PKG}/.MainActivity`);
  await wait(2500);
  const s = await evalJs(`(() => {
    const run = window.ChainedApp.Engine._focused;
    return { awaiting: !!run?.awaitingDismiss, index: run?.currentIndex,
             barShown: !document.getElementById('run-dismiss-bar').hidden };
  })()`);
  if (s.awaiting || s.barShown) fail(`JS still thinks it's held: ${JSON.stringify(s)}`);
  ok(`JS re-synced after returning (segment ${s.index + 1}, no Dismiss bar)`);
  shot('emu-35-ring-resynced.png');
  await evalJs(`window.ChainedApp.Engine.stopRun('c_ring'); true;`);
}

console.log('\n✅ emulator ring-until-dismissed checks passed');
process.exit(0);
