// v1.4.19 / v1.4.20 — ring-until-dismissed, clock, and completion fixes.
//
//   A. Restarting a chain after dismissing its gate must start CLEAN.
//      The foreground service keys gate state by runId, which IS the
//      chain id and is therefore reused by the next run of the same
//      chain. completeRun removed the run without clearing that entry,
//      so JS picked it up on resume and fast-forwarded the fresh run
//      onto a finished segment: 00:00 remaining, dead Play button.
//      Fixed on both sides — the service clears on completion, and JS
//      ignores gate state older than the current run.
//
//   B. The clock drops a leading "00:" when only seconds remain, and
//      the last ten seconds read as one digit — the stock Android timer
//      shape. The elapsed/remaining row below keeps MM:SS.
//
//   C. Once a gate rings, the clock keeps counting in NEGATIVE time, so
//      you can see how long ago the timer went off.
//
//   D. (v1.4.20) "Run again" on the completion overlay restarts the chain
//      that just finished. It read Engine.chain — the FOCUSED run's chain
//      — and by then there is no focused run, so the button did nothing
//      at all and the overlay counted 0 segments.
//
// (The native buzz during a hold is Java-side and is checked on device.)
//
// Run via:
//   npm run serve   # in another shell
//   node tools/smoke-ring-restart.mjs

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
page.on('pageerror', e => bad('pageerror: ' + e.message));
page.on('console', msg => { if (msg.type() === 'error') bad('console: ' + msg.text()); });

await page.addInitScript(({ key }) => localStorage.setItem(key, JSON.stringify({
  schemaVersion: 1,
  chains: [{ id: 'c_r', name: 'Ring', color: 'amber', loops: 1, hasRun: true,
    segments: [{ id: 's1', kind: 'segment', name: 'Only', duration: 2, color: 'amber',
      cues: { ringUntilDismissed: true } }] }],
  settings: { sound: true, voice: false, vibrate: true, prestart: false, finalTick: false },
})), { key: STORAGE_KEY });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);

const state = () => page.evaluate(() => {
  const { Engine } = window.ChainedApp;
  const run = Engine._focused;
  return {
    awaiting: !!run?.awaitingDismiss,
    idx: run?.currentIndex,
    running: Engine.activeRuns().map(r => r.id),
    clock: document.getElementById('run-clock').textContent,
    remaining: document.getElementById('run-remaining').textContent,
    barHidden: document.getElementById('run-dismiss-bar').hidden,
    controlsHidden: document.querySelector('.run-controls').hidden,
  };
});

console.log('Test A1: gate → dismiss → restart is a clean run');
{
  await page.evaluate(() => { const { Store, UI } = window.ChainedApp; UI.startRunForChain(Store.getChain('c_r')); });
  await page.waitForTimeout(2600);
  eq((await state()).awaiting, true, 'gated at the end');
  await page.click('#run-dismiss');
  await page.waitForTimeout(600);
  eq((await state()).running, [], 'chain completed');

  await page.evaluate(() => { window.ChainedApp.UI.hideCompletion(); window.ChainedApp.View.show('library'); });
  await page.waitForTimeout(200);
  await page.evaluate(() => { const { Store, UI } = window.ChainedApp; UI.startRunForChain(Store.getChain('c_r')); });
  await page.waitForTimeout(500);
  const s = await state();
  eq(s.running, ['c_r'], 'restarted');
  eq(s.awaiting, false, 'not stuck in the held state');
  eq(s.idx, 0, 'back on segment 1');
  eq(s.barHidden, true, 'no leftover Dismiss bar');
  eq(s.controlsHidden, false, 'transport controls usable again');
  if (s.clock !== '00' && s.clock !== '0') ok(`clock is counting, not frozen at zero ("${s.clock}")`);
  else bad(`clock frozen at "${s.clock}"`);
  await page.evaluate(() => window.ChainedApp.Engine.stopRun('c_r'));
  await page.waitForTimeout(200);
}

console.log('\nTest A2: stale service gate state is ignored on a fresh run');
{
  // Exactly the shape the service used to leave behind: the PREVIOUS
  // run's dismissal, with a segment start from before this run began.
  const s = await page.evaluate(async () => {
    const { Store, Engine, UI } = window.ChainedApp;
    UI.hideCompletion();
    Engine.startChain(Store.getChain('c_r'));
    const run = Engine._runs.get('c_r');
    const freshStart = run.segmentStartedAtWall;
    const stale = JSON.stringify([{ id: 'c_r', ringing: -1, dismissed: 0, index: 1,
                                    segStartedAtMs: freshStart - 600000 }]);
    window.Capacitor = { ...(window.Capacitor || {}), Plugins: {
      ...((window.Capacitor || {}).Plugins || {}),
      ChainTimer: { getGateStates: async () => ({ states: stale }) } } };
    // Same path the app takes when it returns to the foreground.
    window.dispatchEvent(new Event('chained:appresume'));
    await new Promise(r => setTimeout(r, 400));
    return {
      idx: run.currentIndex,
      startUnchanged: run.segmentStartedAtWall === freshStart,
      awaiting: !!run.awaitingDismiss,
      remainingSec: Math.round(run.segments[run.currentIndex].duration - run._elapsedMs() / 1000),
    };
  });
  eq(s.idx, 0, 'stale index NOT applied');
  eq(s.startUnchanged, true, 'stale segment start NOT applied');
  eq(s.awaiting, false, 'not forced into the held state');
  if (s.remainingSec > 0) ok(`run still has time on the clock (${s.remainingSec}s)`);
  else bad(`run was fast-forwarded to ${s.remainingSec}s`);
  await page.evaluate(() => window.ChainedApp.Engine.stopRun('c_r'));
  await page.waitForTimeout(200);
}

console.log('\nTest A3: genuinely newer service state is still applied');
{
  // The legitimate case this guard must not break: the service cleared a
  // gate in the background, so its segment start is NEWER than ours.
  const s = await page.evaluate(async () => {
    const { Store, Engine, UI } = window.ChainedApp;
    UI.hideCompletion();
    Store.upsertChain({ id: 'c_two', name: 'Two', color: 'amber', loops: 1, hasRun: true,
      segments: [{ id: 'a', kind: 'segment', name: 'A', duration: 2, color: 'amber',
                   cues: { ringUntilDismissed: true } },
                 { id: 'b', kind: 'segment', name: 'B', duration: 120, color: 'teal' }] });
    Engine.startChain(Store.getChain('c_two'));
    const run = Engine._runs.get('c_two');
    const newer = Date.now() + 500;
    const st = JSON.stringify([{ id: 'c_two', ringing: -1, dismissed: 0, index: 1, segStartedAtMs: newer }]);
    window.Capacitor = { ...(window.Capacitor || {}), Plugins: {
      ...((window.Capacitor || {}).Plugins || {}),
      ChainTimer: { getGateStates: async () => ({ states: st }) } } };
    window.dispatchEvent(new Event('chained:appresume'));
    await new Promise(r => setTimeout(r, 400));
    return { idx: run.currentIndex, dismissedAtIndex: run.dismissedAtIndex };
  });
  eq(s.idx, 1, 'background dismissal still advances the run');
  eq(s.dismissedAtIndex, 0, 'cleared boundary adopted');
  await page.evaluate(() => window.ChainedApp.Engine.stopRun('c_two'));
  await page.waitForTimeout(200);
}

console.log('\nTest B: the clock drops "00:" when only seconds remain');
{
  const r = await page.evaluate(() => {
    const { UI } = window.ChainedApp;
    const out = {};
    for (const t of ['00:32', '00:05', '00:00', '01:00', '59:59', '02:11:38', '3', '-00:07', '-01:12']) {
      UI._setClockText(t);
      out[t] = document.getElementById('run-clock').textContent;
    }
    return out;
  });
  eq(r['00:32'], '32', 'under a minute shows seconds only');
  eq(r['00:05'], '5', 'the last ten seconds are a single digit, like the stock timer');
  eq(r['00:00'], '0', 'zero shows as a single 0');
  eq(r['01:00'], '01:00', 'a minute keeps MM:SS');
  eq(r['59:59'], '59:59', 'MM:SS untouched');
  eq(r['02:11:38'], '02:11:38', 'HH:MM:SS untouched');
  eq(r['3'], '3', 'prestart digit untouched');
  eq(r['-00:07'], '-7', 'overtime under ten seconds keeps one digit and the sign');
  eq(r['-01:12'], '-01:12', 'overtime past a minute keeps MM:SS');

  // The row underneath keeps MM:SS so the two columns stay aligned.
  await page.evaluate(() => {
    const { Store, Engine } = window.ChainedApp;
    Store.upsertChain({ id: 'c_s', name: 'Secs', color: 'amber', loops: 1, hasRun: true,
      segments: [{ id: 'x', kind: 'segment', name: 'S', duration: 40, color: 'amber' }] });
    Engine.startChain(Store.getChain('c_s'));
  });
  await page.waitForTimeout(600);
  const live = await page.evaluate(() => ({
    clock: document.getElementById('run-clock').textContent,
    remaining: document.getElementById('run-remaining').textContent,
    elapsed: document.getElementById('run-elapsed').textContent,
  }));
  if (/^\d{2}$/.test(live.clock)) ok(`live clock under a minute reads "${live.clock}"`);
  else bad(`live clock: "${live.clock}"`);
  if (/^\d{2}:\d{2} remaining$/.test(live.remaining) && /^\d{2}:\d{2} elapsed$/.test(live.elapsed)) {
    ok(`elapsed/remaining keep MM:SS ("${live.elapsed}", "${live.remaining}")`);
  } else {
    bad(`elapsed/remaining changed: "${live.elapsed}", "${live.remaining}"`);
  }
  await page.evaluate(() => window.ChainedApp.Engine.stopRun('c_s'));
}

console.log('\nTest C: a ringing gate counts overtime in negative time');
{
  await page.evaluate(() => {
    const { Store, Engine, UI } = window.ChainedApp;
    UI.hideCompletion();
    Store.upsertChain({ id: 'c_over', name: 'Over', color: 'amber', loops: 1, hasRun: true,
      segments: [{ id: 'o1', kind: 'segment', name: 'Hold', duration: 1, color: 'amber',
                   cues: { ringUntilDismissed: true } },
                 { id: 'o2', kind: 'segment', name: 'After', duration: 300, color: 'teal' }] });
    Engine.startChain(Store.getChain('c_over'));
  });
  await page.waitForTimeout(1400);
  eq(await page.evaluate(() => !!window.ChainedApp.Engine._focused?.awaitingDismiss), true, 'held at the gate');

  const first = await page.evaluate(() => document.getElementById('run-clock').textContent);
  if (/^(0|-\d)$/.test(first)) ok(`clock starts at "${first}" when the gate opens`);
  else bad(`clock reads "${first}" right after the boundary`);

  await page.waitForTimeout(2600);
  const later = await page.evaluate(() => document.getElementById('run-clock').textContent);
  const n = Number(later);
  if (n < 0) ok(`clock counts up in negative time ("${later}")`);
  else bad(`clock is not counting overtime ("${later}")`);
  if (Number(first) > n) ok('overtime grows while the gate waits');
  else bad(`overtime did not advance ("${first}" → "${later}")`);

  // Overtime from a hold that began long ago must be right immediately,
  // not restart from zero — the app can be opened well after it rang.
  const long = await page.evaluate(async () => {
    const run = window.ChainedApp.Engine._focused;
    run.pausedAtWall = Date.now() - 75000;     // as if it rang 75 seconds ago
    window.ChainedApp.UI._syncAlarmUI();
    await new Promise(r => setTimeout(r, 400));
    return document.getElementById('run-clock').textContent;
  });
  if (/^-01:1[45]$/.test(long)) ok(`a gate that rang 75s ago reads "${long}"`);
  else bad(`expected about -01:15, got "${long}"`);

  // Dismissing hands the clock back to the run.
  await page.click('#run-dismiss');
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => ({
    clock: document.getElementById('run-clock').textContent,
    ticking: !!window.ChainedApp.UI._overtimeTimer,
  }));
  if (after.clock.startsWith('-')) bad(`clock still negative after Dismiss ("${after.clock}")`);
  else ok(`clock back to counting down after Dismiss ("${after.clock}")`);
  eq(after.ticking, false, 'overtime ticker stopped');
  await page.evaluate(() => window.ChainedApp.Engine.stopRun('c_over'));
}

console.log('\nTest D: "Run again" on the completion overlay actually runs again');
{
  const overlay = () => page.evaluate(() => ({
    shown: !document.getElementById('run-complete').hidden,
    count: document.getElementById('run-complete-count').textContent,
    running: window.ChainedApp.Engine.activeRuns().map(r => r.id),
    view: document.body.dataset.view,
  }));

  // (a) a chain that ends on its own.
  await page.evaluate(() => {
    const { Store, Engine, UI } = window.ChainedApp;
    UI.hideCompletion();
    Store.upsertChain({ id: 'c_again', name: 'Again', color: 'amber', loops: 1, hasRun: true,
      segments: [{ id: 'g1', kind: 'segment', name: 'One', duration: 1, color: 'amber' },
                 { id: 'g2', kind: 'segment', name: 'Two', duration: 1, color: 'teal' }] });
    Engine.startChain(Store.getChain('c_again'));
  });
  await page.waitForTimeout(2800);
  let s = await overlay();
  eq(s.shown, true, 'completion overlay shown');
  eq(s.running, [], 'nothing left running');
  eq(s.count, '2', 'segment count is the finished chain\'s, not the empty engine\'s');

  await page.click('#run-complete-again');
  await page.waitForTimeout(600);
  s = await overlay();
  eq(s.shown, false, 'overlay dismissed');
  eq(s.running, ['c_again'], 'the same chain is running again');
  eq(s.view, 'run', 'still on the run view');
  await page.evaluate(() => window.ChainedApp.Engine.stopRun('c_again'));
  await page.waitForTimeout(200);

  // (b) the reported path: a chain whose LAST segment holds a ring gate,
  // finished by tapping Dismiss.
  await page.evaluate(() => {
    const { Store, Engine, UI } = window.ChainedApp;
    UI.hideCompletion();
    Store.upsertChain({ id: 'c_gated', name: 'Gated', color: 'amber', loops: 1, hasRun: true,
      segments: [{ id: 'h1', kind: 'segment', name: 'Last', duration: 1, color: 'amber',
                   cues: { ringUntilDismissed: true } }] });
    Engine.startChain(Store.getChain('c_gated'));
  });
  await page.waitForTimeout(1600);
  eq(await page.evaluate(() => !!window.ChainedApp.Engine._focused?.awaitingDismiss), true, 'held at the end gate');
  await page.click('#run-dismiss');
  await page.waitForTimeout(700);
  eq((await overlay()).shown, true, 'overlay shown after Dismiss');

  await page.click('#run-complete-again');
  await page.waitForTimeout(600);
  s = await overlay();
  eq(s.shown, false, 'overlay dismissed');
  eq(s.running, ['c_gated'], 'the dismissed chain runs again');
  const clock = await page.evaluate(() => document.getElementById('run-clock').textContent);
  if (!clock.startsWith('-')) ok(`clock counting down again ("${clock}")`);
  else bad(`still showing overtime ("${clock}")`);
  await page.evaluate(() => window.ChainedApp.Engine.stopRun('c_gated'));
  await page.waitForTimeout(200);

  // (c) a chain deleted while its overlay was up must not wedge the button.
  await page.evaluate(() => {
    const { Store, Engine, UI } = window.ChainedApp;
    UI.hideCompletion();
    Store.upsertChain({ id: 'c_gone', name: 'Gone', color: 'amber', loops: 1, hasRun: true,
      segments: [{ id: 'x1', kind: 'segment', name: 'Solo', duration: 1, color: 'amber' }] });
    Engine.startChain(Store.getChain('c_gone'));
  });
  await page.waitForTimeout(1800);
  eq((await overlay()).shown, true, 'overlay shown');
  await page.evaluate(() => window.ChainedApp.Store.deleteChain('c_gone'));
  await page.click('#run-complete-again');
  await page.waitForTimeout(600);
  s = await overlay();
  eq(s.shown, false, 'overlay dismissed');
  eq(s.running, ['c_gone'], 'the deleted chain still runs from the overlay copy');
  await page.evaluate(() => window.ChainedApp.Engine.stopRun('c_gone'));
}

console.log(failures ? `\n❌ ${failures} assertion(s) failed` : '\n✅ all checks passed');
await browser.close();
process.exit(failures ? 1 : 0);
