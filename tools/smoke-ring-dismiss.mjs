// v1.4.13 — "Ring until dismissed" regression tests.
//
// The cue is a segment-only, non-inheriting boolean: its boundary is a
// GATE. When the segment's time is up the chain holds there, ringing,
// until the user dismisses; the next segment then starts from the
// moment of dismissal (held time is not charged to it).
//
// Covered:
//   1. Cue sheet: two choices only, off by default, nested under Sound.
//      (Chain/app scope gained a SEPARATE chain-end gate in v1.4.14 —
//      see tools/smoke-ring-scope.mjs.)
//   2. Mid-chain gate: holds, clock pins at 00:00, Dismiss bar replaces
//      the transport row, chain does NOT advance on its own.
//   3. Dismiss: advances, next segment starts fresh, alarm stops.
//   4. Last-segment gate: holds at chain end; dismiss completes.
//   5. A user skip is NOT gated (explicit intent wins).
//   6. Catch-up across a gate holds instead of stepping over it.
//   7. Gate survives a persist/restore round trip.
//
// Run via:
//   npm run serve   # in another shell
//   node tools/smoke-ring-dismiss.mjs

import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:4321/';
const STORAGE_KEY = 'chained-timers/v1';

let failures = 0;
const ok  = m => console.log('  ✓', m);
const bad = m => { console.log('  ✗', m); failures++; };
const eq = (a, e, label) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  A === E ? ok(`${label} = ${A}`) : bad(`${label} expected ${E} got ${A}`);
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
page.on('pageerror', e   => bad('pageerror: ' + e.message));
page.on('console',   msg => { if (msg.type() === 'error') bad('console: ' + msg.text()); });

// Short segments so gates are reachable in test time. seg 1 rings.
const SEED = {
  schemaVersion: 1,
  chains: [
    { id: 'c_gate', name: 'Gated', color: 'amber', loops: 1, hasRun: true,
      segments: [
        { id: 's1', kind: 'segment', name: 'Work', duration: 1, color: 'amber',
          cues: { ringUntilDismissed: true } },
        { id: 's2', kind: 'segment', name: 'Rest', duration: 60, color: 'teal' },
      ], createdAt: 2, updatedAt: 2 },
    { id: 'c_last', name: 'Ends Ringing', color: 'teal', loops: 1, hasRun: true,
      segments: [
        { id: 's3', kind: 'segment', name: 'Only', duration: 1, color: 'teal',
          cues: { ringUntilDismissed: true } },
      ], createdAt: 1, updatedAt: 1 },
    { id: 'c_plain', name: 'Plain', color: 'violet', loops: 1, hasRun: true,
      segments: [{ id: 's4', kind: 'segment', name: 'A', duration: 60, color: 'violet' }],
      createdAt: 1, updatedAt: 1 },
  ],
  settings: { sound: true, voice: false, vibrate: false, prestart: false, finalTick: false },
};
await page.addInitScript(({ key, seed }) => localStorage.setItem(key, JSON.stringify(seed)), { key: STORAGE_KEY, seed: SEED });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);

const gateState = () => page.evaluate(() => {
  const { Engine } = window.ChainedApp;
  const run = Engine._focused;
  return {
    awaiting: !!run?.awaitingDismiss,
    index: run?.currentIndex ?? -1,
    clock: document.getElementById('run-clock')?.textContent,
    barHidden: document.getElementById('run-dismiss-bar')?.hidden,
    controlsHidden: document.querySelector('.run-controls')?.hidden,
    label: document.getElementById('run-dismiss-label')?.textContent,
    alarmClass: document.querySelector('.view-run')?.classList.contains('is-alarm'),
    running: Engine.activeRuns().map(r => r.id),
  };
});

console.log('Test 1: cue sheet — two choices, off by default, segment scope only');
{
  const seg = await page.evaluate(() => {
    const { UI, Store } = window.ChainedApp;
    const chain = Store.getChain('c_plain');
    UI._openCueSheet('segment', chain.segments[0], chain, () => {});
    return [...document.querySelectorAll('#cues-list .cue-row')].map(r => ({
      key: r.dataset.cueKey,
      title: r.querySelector('.cue-row-title').textContent,
      hint: r.querySelector('.cue-row-hint').textContent,
      buttons: [...r.querySelectorAll('.cue-pill button')].map(b => b.textContent),
      pressed: [...r.querySelectorAll('.cue-pill button')].filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.state),
      nested: r.classList.contains('is-nested'),
      hidden: r.hidden,
    }));
  });
  const row = seg.find(r => r.key === 'ringUntilDismissed');
  if (!row) { bad('ringUntilDismissed row missing at segment scope'); }
  else {
    ok(`row present ("${row.title}" — "${row.hint}")`);
    eq(row.buttons, ['On', 'Off'], 'exactly two choices (no Default)');
    eq(row.pressed, ['off'], 'defaults to Off');
    eq(row.nested, true, 'nested under Sound cues');
    // Order: directly after Final 3 seconds tick.
    const keys = seg.map(r => r.key);
    eq(keys.slice(0, 3), ['sound', 'finalTick', 'ringUntilDismissed'], 'sits alongside Final 3 seconds tick');
  }
  const chainKeys = await page.evaluate(() => {
    const { UI, Store } = window.ChainedApp;
    const chain = Store.getChain('c_plain');
    UI._openCueSheet('chain', chain, chain, () => {});
    return [...document.querySelectorAll('#cues-list .cue-row')].map(r => r.dataset.cueKey);
  });
  // v1.4.14 — chain and app scope gained their own ring-until-dismissed,
  // but it means something different there: it gates only the CHAIN END,
  // where this SEGMENT flag gates one specific boundary. Scope behaviour
  // is covered in tools/smoke-ring-scope.mjs; here we only check the two
  // controls exist and that the segment one stays the binary variant.
  eq(chainKeys.includes('ringUntilDismissed'), true, 'chain scope has its own (chain-end) row');
  const appHasIt = await page.evaluate(() => !!document.getElementById('setting-ringdismiss'));
  eq(appHasIt, true, 'app settings has the chain-end toggle');
  // Toggling On stores the flag; Off clears the key entirely.
  const store = await page.evaluate(() => {
    const { UI, Store } = window.ChainedApp;
    const chain = Store.getChain('c_plain');
    const seg = chain.segments[0];
    UI._openCueSheet('segment', seg, chain, () => {});
    document.querySelector('[data-cue-key="ringUntilDismissed"] button[data-state="on"]').click();
    const on = JSON.parse(JSON.stringify(seg.cues || {}));
    document.querySelector('[data-cue-key="ringUntilDismissed"] button[data-state="off"]').click();
    const off = JSON.parse(JSON.stringify(seg.cues || {}));
    return { on, off };
  });
  eq(store.on.ringUntilDismissed, true, 'On stores the flag');
  eq('ringUntilDismissed' in store.off, false, 'Off clears the key (clean export)');
  await page.evaluate(() => { document.getElementById('cues-sheet').hidden = true; });
}

console.log('\nTest 2: mid-chain gate holds the chain and rings');
{
  await page.evaluate(() => {
    const { Store, UI } = window.ChainedApp;
    UI.startRunForChain(Store.getChain('c_gate'));
  });
  await page.waitForTimeout(1600);   // 1s segment + margin
  const s = await gateState();
  eq(s.awaiting, true, 'held at the gate');
  eq(s.index, 0, 'still on the gated segment (did not advance)');
  eq(s.clock, '00:00', 'clock pinned at zero');
  eq(s.barHidden, false, 'Dismiss bar shown');
  eq(s.controlsHidden, true, 'transport row hidden');
  eq(s.alarmClass, true, 'run view flagged is-alarm');
  if (/Work/.test(s.label)) ok(`label names the finished segment ("${s.label}")`);
  else bad(`label: ${s.label}`);
  const ringing = await page.evaluate(() => window.ChainedApp.Alarm?.active?.() ?? 'no Alarm');
  eq(ringing, true, 'alarm loop running');
  // Still held a couple of seconds later — nothing auto-advances.
  await page.waitForTimeout(1500);
  const s2 = await gateState();
  eq(s2.awaiting, true, 'still held after waiting');
  eq(s2.index, 0, 'still has not advanced');
}

console.log('\nTest 3: Dismiss advances and starts the next segment fresh');
{
  await page.click('#run-dismiss');
  await page.waitForTimeout(300);
  const s = await gateState();
  eq(s.awaiting, false, 'gate cleared');
  eq(s.index, 1, 'advanced to next segment');
  eq(s.barHidden, true, 'Dismiss bar hidden');
  eq(s.controlsHidden, false, 'transport row back');
  eq(await page.evaluate(() => window.ChainedApp.Alarm.active()), false, 'alarm stopped');
  // Next segment must start from the dismissal moment, not from when
  // the gate was reached (it was held ~3s).
  const remaining = await page.evaluate(() => {
    const run = window.ChainedApp.Engine._focused;
    const seg = run.segments[run.currentIndex];
    return Math.round(seg.duration - run._elapsedMs() / 1000);
  });
  if (remaining >= 59) ok(`next segment started fresh (${remaining}s of 60 left)`);
  else bad(`held time leaked into next segment: ${remaining}s left`);
  await page.evaluate(() => window.ChainedApp.Engine.stopRun('c_gate'));
  await page.waitForTimeout(200);
}

console.log('\nTest 4: gate on the LAST segment holds at chain end, dismiss completes');
{
  await page.evaluate(() => {
    const { Store, UI } = window.ChainedApp;
    UI.startRunForChain(Store.getChain('c_last'));
  });
  await page.waitForTimeout(1600);
  const s = await gateState();
  eq(s.awaiting, true, 'held at chain end');
  eq(s.running, ['c_last'], 'run still alive (not auto-completed)');
  if (/complete/i.test(s.label)) ok(`label reads as chain end ("${s.label}")`);
  else bad(`label: ${s.label}`);
  await page.click('#run-dismiss');
  await page.waitForTimeout(400);
  eq(await page.evaluate(() => window.ChainedApp.Engine.activeRuns().map(r => r.id)), [], 'chain completed on dismiss');
  eq(await page.evaluate(() => window.ChainedApp.Alarm.active()), false, 'alarm stopped');
}

console.log('\nTest 5: an explicit skip is not gated');
{
  await page.evaluate(() => {
    const { Store, UI } = window.ChainedApp;
    UI.startRunForChain(Store.getChain('c_gate'));
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => window.ChainedApp.Engine.skipNext());
  await page.waitForTimeout(200);
  const s = await gateState();
  eq(s.awaiting, false, 'skip did not arm the gate');
  eq(s.index, 1, 'skipped straight to the next segment');
  await page.evaluate(() => window.ChainedApp.Engine.stopRun('c_gate'));
  await page.waitForTimeout(200);
}

console.log('\nTest 6: catch-up across a gate holds instead of stepping over it');
{
  const s = await page.evaluate(async () => {
    const { Store, Engine } = window.ChainedApp;
    Engine.startChain(Store.getChain('c_gate'));
    const run = Engine._runs.get('c_gate');
    // Simulate the page having been asleep well past the gate.
    run.segmentStartedAtWall = Date.now() - 30000;
    run._catchup();
    return { awaiting: run.awaitingDismiss, index: run.currentIndex };
  });
  eq(s.awaiting, true, 'catch-up stopped at the gate');
  eq(s.index, 0, 'did not step past the un-dismissed boundary');
  await page.evaluate(() => window.ChainedApp.Engine.stopRun('c_gate'));
  await page.waitForTimeout(200);
}

console.log('\nTest 7: a held gate survives persist/restore');
{
  const snap = await page.evaluate(() => {
    const { Store, Engine } = window.ChainedApp;
    Engine.startChain(Store.getChain('c_gate'));
    const run = Engine._runs.get('c_gate');
    run.segmentStartedAtWall = Date.now() - 5000;
    run._catchup();
    run._persist();
    return JSON.parse(localStorage.getItem('chained-timers/run/v2/c_gate'));
  });
  eq(snap.awaitingDismiss, true, 'gate state persisted');
  const restored = await page.evaluate(() => {
    const { Engine } = window.ChainedApp;
    // Drop the live run, then restore from the snapshot.
    Engine._runs.clear();
    Engine._focusedId = null;
    Engine.restoreIfActive();
    const run = Engine._runs.get('c_gate');
    return { awaiting: !!run?.awaitingDismiss, index: run?.currentIndex, alarm: window.ChainedApp.Alarm.active() };
  });
  eq(restored.awaiting, true, 'restored still held');
  eq(restored.index, 0, 'restored on the gated segment');
  eq(restored.alarm, true, 'alarm resumed on restore');
  await page.evaluate(() => { window.ChainedApp.Alarm.stop(); window.ChainedApp.Engine.stopRun('c_gate'); });
}

console.log(failures ? `\n❌ ${failures} assertion(s) failed` : '\n✅ all checks passed');
await browser.close();
process.exit(failures ? 1 : 0);
