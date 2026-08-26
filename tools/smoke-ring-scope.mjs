// v1.4.14 — "Ring until dismissed" at APP and CHAIN scope.
//
// Scope semantics (deliberately not plain cue inheritance):
//   • SEGMENT flag  → gates that one boundary.
//   • CHAIN / APP   → gates the END OF THE CHAIN only. Gating every
//     boundary would halt a workout at each segment, which is not what
//     "my timers should wait for me" means.
//
// The last segment's boundary IS the chain end, so a segment flag and
// the chain-end flag can both point at it. They must collapse to ONE
// gate — the user dismisses once, not twice.
//
// Run via:
//   npm run serve   # in another shell
//   node tools/smoke-ring-scope.mjs

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
  chains: [
    // Two 1s segments so both boundaries are reachable quickly.
    { id: 'c_two', name: 'Pair', color: 'amber', loops: 1, hasRun: true, segments: [
      { id: 's1', kind: 'segment', name: 'First',  duration: 1, color: 'amber' },
      { id: 's2', kind: 'segment', name: 'Second', duration: 1, color: 'teal'  },
    ] },
  ],
  settings: { sound: true, voice: false, vibrate: false, prestart: false, finalTick: false },
})), { key: STORAGE_KEY });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);

const state = () => page.evaluate(() => {
  const { Engine } = window.ChainedApp;
  const run = Engine._focused;
  return {
    awaiting: !!run?.awaitingDismiss,
    index: run?.currentIndex ?? -1,
    running: Engine.activeRuns().map(r => r.id),
  };
});
// Reset the chain + settings, then start it.
const startWith = (opts) => page.evaluate((o) => {
  const { Store, Engine, UI } = window.ChainedApp;
  Engine._runs.forEach(r => Engine.stopRun(r.id));
  // A completed run from the previous case leaves the completion overlay
  // up, and it swallows clicks aimed at the Dismiss bar.
  UI.hideCompletion();
  Object.keys(localStorage).filter(k => k.startsWith('chained-timers/run/')).forEach(k => localStorage.removeItem(k));
  Store.setSetting('ringUntilDismissed', !!o.app);
  const chain = Store.getChain('c_two');
  if (o.chain === undefined) { if (chain.cues) delete chain.cues.ringUntilDismissed; }
  else { chain.cues = { ...(chain.cues || {}), ringUntilDismissed: o.chain }; }
  chain.segments.forEach((s, i) => {
    const want = (o.segs || [])[i];
    if (want) s.cues = { ...(s.cues || {}), ringUntilDismissed: true };
    else if (s.cues) delete s.cues.ringUntilDismissed;
  });
  Store.save();
  UI.startRunForChain(chain);
}, opts);

console.log('Test 1: app-level row exists, nested under Sound, off by default');
{
  const r = await page.evaluate(() => {
    const { Store, UI } = window.ChainedApp;
    UI.openSettings();
    const row = document.getElementById('setting-row-ringdismiss');
    const box = document.getElementById('setting-ringdismiss');
    const before = { sub: row?.classList.contains('setting-row-sub'), checked: box?.checked, hidden: row?.hidden };
    Store.setSetting('sound', false); UI._syncFinalTickRowVisibility();
    const soundOff = row?.hidden;
    Store.setSetting('sound', true); UI._syncFinalTickRowVisibility();
    return { ...before, hiddenWhenSoundOff: soundOff, dflt: Store.getSettings().ringUntilDismissed };
  });
  eq(r.sub, true, 'rendered as a Sound sub-option');
  eq(r.dflt, false, 'off by default at app level');
  eq(r.checked, false, 'checkbox reflects off');
  eq(r.hidden, false, 'visible while Sound cues is on');
  eq(r.hiddenWhenSoundOff, true, 'hidden when Sound cues is off');
  await page.evaluate(() => { document.getElementById('settings-sheet').hidden = true; });
}

console.log('\nTest 2: chain-level row offers Default / On / Off');
{
  const r = await page.evaluate(() => {
    const { UI, Store } = window.ChainedApp;
    const chain = Store.getChain('c_two');
    UI._openCueSheet('chain', chain, chain, () => {});
    const row = document.querySelector('[data-cue-key="ringUntilDismissed"]');
    const out = {
      present: !!row,
      title: row?.querySelector('.cue-row-title')?.textContent,
      hint: row?.querySelector('.cue-row-hint')?.textContent,
      buttons: [...(row?.querySelectorAll('.cue-pill button') || [])].map(b => b.textContent),
      nested: row?.classList.contains('is-nested'),
      keys: [...document.querySelectorAll('#cues-list .cue-row')].map(x => x.dataset.cueKey),
    };
    document.getElementById('cues-sheet').hidden = true;
    return out;
  });
  eq(r.present, true, 'chain scope has the row');
  eq(r.buttons, ['DefaultOff', 'On', 'Off'], 'three choices, Default shows inherited Off');
  eq(r.nested, true, 'nested under Sound cues');
  eq(r.keys.slice(0, 3), ['sound', 'finalTick', 'ringUntilDismissed'], 'sits beside Final 3 seconds tick');
  if (/chain finishes/i.test(r.hint)) ok(`hint says it is a chain-end gate ("${r.hint}")`);
  else bad(`hint: ${r.hint}`);
}

console.log('\nTest 3: app ON gates the CHAIN END only, not every boundary');
{
  await startWith({ app: true });
  await page.waitForTimeout(1500);          // past boundary 1
  const mid = await state();
  eq(mid.awaiting, false, 'first boundary NOT gated');
  eq(mid.index, 1, 'ran straight into segment 2');
  await page.waitForTimeout(1500);          // past boundary 2 = chain end
  const end = await state();
  eq(end.awaiting, true, 'chain end IS gated');
  eq(end.running, ['c_two'], 'chain held, not completed');
  await page.click('#run-dismiss');
  await page.waitForTimeout(400);
  eq((await state()).running, [], 'one dismissal completes the chain');
}

console.log('\nTest 4: chain override beats the app default (both directions)');
{
  await startWith({ app: true, chain: false });
  await page.waitForTimeout(3000);
  eq((await state()).running, [], 'chain Off overrides app On — no gate, chain finished');

  await startWith({ app: false, chain: true });
  await page.waitForTimeout(3000);
  const s = await state();
  eq(s.awaiting, true, 'chain On overrides app Off — gated at the end');
  await page.click('#run-dismiss');
  await page.waitForTimeout(400);
  eq((await state()).running, [], 'dismissed');
}

console.log('\nTest 5: THE DEDUP — last segment ON *and* chain ON = one dismissal');
{
  await startWith({ app: true, chain: true, segs: [false, true] });
  await page.waitForTimeout(1500);
  eq((await state()).awaiting, false, 'first boundary still not gated');
  await page.waitForTimeout(1500);
  const held = await state();
  eq(held.awaiting, true, 'gated once at the end');
  // ONE dismissal must finish the chain — not leave a second gate behind.
  await page.click('#run-dismiss');
  await page.waitForTimeout(600);
  const after = await state();
  eq(after.awaiting, false, 'no second gate after dismissing');
  eq(after.running, [], 'chain completed on the FIRST dismissal');
  const barHidden = await page.evaluate(() => document.getElementById('run-dismiss-bar')?.hidden);
  eq(barHidden, true, 'Dismiss bar gone');
}

console.log('\nTest 6: an intermediate segment flag still gates on its own');
{
  await startWith({ app: false, chain: false, segs: [true, false] });
  await page.waitForTimeout(1500);
  const mid = await state();
  eq(mid.awaiting, true, 'mid-chain segment gate fires');
  eq(mid.index, 0, 'held on segment 1');
  await page.click('#run-dismiss');
  await page.waitForTimeout(400);
  eq((await state()).index, 1, 'continues into segment 2');
  await page.waitForTimeout(1600);
  eq((await state()).running, [], 'chain end NOT gated (app+chain both off)');
}

console.log('\nTest 7: the native payload carries the collapsed answer');
{
  const plan = await page.evaluate(async () => {
    const { Store, Engine } = window.ChainedApp;
    Store.setSetting('ringUntilDismissed', true);
    const chain = Store.getChain('c_two');
    if (chain.cues) delete chain.cues.ringUntilDismissed;
    chain.segments.forEach(s => { if (s.cues) delete s.cues.ringUntilDismissed; });
    Store.save();
    let captured = null;
    const onEvt = (e) => { captured = e.detail?.segments?.map(s => !!s.ringUntilDismissed); };
    window.addEventListener('chain:fgsupdate', onEvt);
    window.addEventListener('chain:start', onEvt);
    Engine.startChain(chain);
    await new Promise(r => setTimeout(r, 200));
    window.removeEventListener('chain:fgsupdate', onEvt);
    window.removeEventListener('chain:start', onEvt);
    Engine.stopRun('c_two');
    return captured;
  });
  eq(plan, [false, true], 'only the final segment is flagged for the FGS');
}

console.log(failures ? `\n❌ ${failures} assertion(s) failed` : '\n✅ all checks passed');
await browser.close();
process.exit(failures ? 1 : 0);
