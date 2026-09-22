// v1.4.23 — a gate that rings on a BACKGROUND run, reported from beta:
//
//   start a 1m chain, start a 2m chain, leave the app, wait for the
//   first one to end. It rings — but (1) the finished timer never comes
//   up, so nothing on screen says which chain is up or offers its
//   Dismiss, and (2) opening the longer, still-counting chain shows a
//   run view tinted red as if THAT one had finished.
//
// Covered here:
//   1. A gate reached by a background run takes engine focus and opens
//      its own run view: Dismiss bar, warn tint, label naming it.
//   2. Its chip carries is-ringing (not is-paused — the freeze rides on
//      the pause plumbing, so it used to read as merely paused).
//   3. Opening the other, still-counting chain leaves NO finished tint.
//   4. Any tint left on the view is re-derived away the moment the run
//      view is painted — the symptom is unreachable whatever caused it.
//   5. A second gate does not steal the view from the one already
//      ringing (don't move the target under a user mid-dismissal).
//   6. A gate ringing while the user is in the editor does not yank
//      them out of it, but still takes engine focus.
//   7. A notification command applies to the run it names: Dismiss on
//      the background chain's notification clears THAT chain, not the
//      focused one.
//   8. Stopping a chain that sits at a ringing gate silences it.
//
// Run via:
//   npm run serve   # in another shell
//   node tools/smoke-bg-gate-focus.mjs

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

// "Short" is the chain that ends and rings (chain-end gate on by
// default in this seed); "Long" is the one still counting in the
// background when it does.
const SEED = {
  schemaVersion: 1,
  chains: [
    { id: 'c_short', name: 'Short', color: 'amber', loops: 1, hasRun: true,
      segments: [{ id: 's1', kind: 'segment', name: 'Only', duration: 60, color: 'amber' }],
      createdAt: 1, updatedAt: 1 },
    { id: 'c_long', name: 'Long', color: 'teal', loops: 1, hasRun: true,
      segments: [{ id: 'l1', kind: 'segment', name: 'Long one', duration: 120, color: 'teal' }],
      createdAt: 2, updatedAt: 2 },
    { id: 'c_third', name: 'Third', color: 'violet', loops: 1, hasRun: true,
      segments: [{ id: 't1', kind: 'segment', name: 'Third one', duration: 60, color: 'violet' }],
      createdAt: 3, updatedAt: 3 },
  ],
  settings: { sound: false, voice: false, vibrate: false, prestart: false,
              finalTick: false, ringUntilDismissed: true },
};
await page.addInitScript(({ key, seed }) => localStorage.setItem(key, JSON.stringify(seed)), { key: STORAGE_KEY, seed: SEED });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);

const state = () => page.evaluate(() => {
  const { Engine, View } = window.ChainedApp;
  const view = document.querySelector('.view-run');
  const run = Engine._focused;
  const seg = run?.segments[run.currentIndex];
  const chipCls = (id) => {
    const c = document.querySelector(`.run-chip[data-chain-id="${id}"]`);
    return c ? [...c.classList].filter(x => x !== 'run-chip').sort() : null;
  };
  return {
    view: View.current,
    focused: Engine.focusedRunId(),
    tints: [...view.classList].filter(c => c === 'is-alarm' || c === 'is-warning' || c === 'is-paused').sort(),
    chainName: document.getElementById('run-chain-name')?.textContent,
    dismissBar: !document.getElementById('run-dismiss-bar').hidden,
    controls: !document.querySelector('.run-controls').hidden,
    dismissLabel: document.getElementById('run-dismiss-label')?.textContent,
    remaining: seg ? Math.round(seg.duration - run._elapsedMs() / 1000) : null,
    chipShort: chipCls('c_short'),
    chipLong: chipCls('c_long'),
    held: Engine.activeRuns().filter(r => r.awaitingDismiss).map(r => r.id).sort(),
    running: Engine.activeRuns().map(r => r.id).sort(),
  };
});

// Start Short, then Long — the chain tapped last is the focused one.
const setup = () => page.evaluate(() => {
  const { Engine, Store, UI, View } = window.ChainedApp;
  [...Engine._runs.keys()].forEach(id => Engine.stopRun(id));
  UI.hideCompletion();
  View.show('library');
  UI.startRunForChain(Store.getChain('c_short'));
  View.show('library');
  UI.startRunForChain(Store.getChain('c_long'));
  View.show('library');
});

// A run whose segment ended while the app was away. Nothing is faked
// about the gate itself: the segment start is backdated past its end and
// the engine catches up to the wall clock exactly as it does on resume.
const expireInBackground = (id) => page.evaluate((id) => {
  const { Engine } = window.ChainedApp;
  const run = Engine.runById(id);
  cancelAnimationFrame(run.rafId);
  run.segmentStartedAtWall -= (run.segments[run.currentIndex].duration + 2) * 1000;
  Engine._catchup();
}, id);

console.log('Test 1 + 2: a gate reached in the background opens its own run view');
{
  await setup();
  await page.waitForTimeout(100);
  const before = await state();
  eq(before.focused, 'c_long',  'focus starts on the chain tapped last');
  eq(before.view,    'library', 'user is on the library');

  await expireInBackground('c_short');
  await page.waitForTimeout(150);
  const s = await state();
  eq(s.held,         ['c_short'],  'Short is held at its gate');
  eq(s.focused,      'c_short',    'the ringing chain took focus');
  eq(s.view,         'run',        'its run view opened');
  eq(s.chainName,    'Short',      'the view shows the ringing chain');
  eq(s.tints,        ['is-alarm'], 'view reads as ringing');
  eq(s.dismissBar,   true,         'Dismiss bar offered');
  eq(s.controls,     false,        'transport row stands down');
  eq(s.dismissLabel, 'Short complete', 'label names what is up');
  eq(s.chipShort,    ['is-focused', 'is-ringing'], 'ringing chip marked');
  eq(s.chipLong,     [],           'the other chip is untouched');
}

console.log('\nTest 3: opening the still-counting chain shows NO finished tint');
{
  await page.evaluate(`document.querySelector('.run-chip[data-chain-id="c_long"]').click()`);
  await page.waitForTimeout(400);
  const s = await state();
  eq(s.focused,    'c_long', 'focus moved to the chain still counting');
  eq(s.chainName,  'Long',   'run view shows it');
  eq(s.tints,      [],       'no red left over');
  eq(s.dismissBar, false,    'no Dismiss bar left over');
  eq(s.controls,   true,     'transport row is back');
  const t0 = s.remaining;
  await page.waitForTimeout(1200);
  const s2 = await state();
  eq(s2.tints, [], 'still no red a second later');
  (s2.remaining < t0) ? ok(`clock still counting down = ${t0} -> ${s2.remaining}`)
                      : bad(`clock stopped counting: ${t0} -> ${s2.remaining}`);
}

console.log('\nTest 4: a tint left on the view is re-derived away on paint');
{
  await page.evaluate(`(() => {
    document.querySelector('.view-run').classList.add('is-alarm', 'is-warning', 'is-paused');
    document.getElementById('run-dismiss-bar').hidden = false;
  })()`);
  await page.evaluate(`window.ChainedApp.View.show('library')`);
  await page.evaluate(`window.ChainedApp.UI.startRunForChain(window.ChainedApp.Store.getChain('c_long'))`);
  await page.waitForTimeout(200);
  const s = await state();
  eq(s.tints,      [],    'painting the run view cleared every stale tint');
  eq(s.dismissBar, false, 'and the stale Dismiss bar');
}

console.log('\nTest 5: a second gate does not steal the view from the first');
{
  await setup();
  await expireInBackground('c_short');
  await page.waitForTimeout(150);
  eq((await state()).focused, 'c_short', 'first gate owns the view');
  await expireInBackground('c_long');
  await page.waitForTimeout(150);
  const s = await state();
  eq(s.held,    ['c_long', 'c_short'], 'both are held');
  eq(s.focused, 'c_short',             'the view stays with the first ringer');
  eq(s.tints,   ['is-alarm'],          'still reads as ringing');
}

console.log('\nTest 6: a gate does not yank the user out of the editor');
{
  await setup();
  await page.evaluate(`window.ChainedApp.View.show('editor')`);
  await page.waitForTimeout(100);
  await expireInBackground('c_short');
  await page.waitForTimeout(150);
  const s = await state();
  eq(s.view,    'editor',     'still in the editor');
  eq(s.focused, 'c_short',    'the ringing chain owns the run view behind it');
  eq(s.tints,   ['is-alarm'], 'painted ready for when they leave');
}

console.log('\nTest 7: a notification command applies to the run it names');
{
  await setup();
  await expireInBackground('c_short');
  await page.waitForTimeout(150);
  // Focus back on the chain still counting, as the user would.
  await page.evaluate(`window.ChainedApp.Engine.focus('c_long')`);
  await page.waitForTimeout(100);
  eq((await state()).focused, 'c_long', 'focused on the long chain');
  await page.evaluate(`window.dispatchEvent(new CustomEvent('chained:enginecommand', {
    detail: { command: 'dismiss', runId: 'c_short', source: 'notification' },
  }))`);
  await page.waitForTimeout(250);
  const s = await state();
  eq(s.running, ['c_long'], 'Dismiss ended the chain it named');
  eq(s.held,    [],         'no gate left held');
  eq(s.focused, 'c_long',   'the focused chain was not touched');
  eq(s.tints,   [],         'and carries no tint from the one that rang');
}

console.log('\nTest 8: stopping a chain at a ringing gate silences it');
{
  await setup();
  await expireInBackground('c_short');
  await page.waitForTimeout(150);
  eq(await page.evaluate(`window.ChainedApp.Alarm.active()`), true, 'alarm ringing (web path)');
  await page.evaluate(`window.ChainedApp.Engine.stopRun('c_short')`);
  await page.waitForTimeout(150);
  eq(await page.evaluate(`window.ChainedApp.Alarm.active()`), false, 'stopped run stops ringing');
  const s = await state();
  eq(s.running, ['c_long'], 'the other chain survives');
  eq(s.tints,   [],         'view carries no ringing tint');
}

console.log('');
if (failures) { console.log(`❌ ${failures} assertion(s) failed`); process.exit(1); }
console.log('✅ all checks passed');
await browser.close();
