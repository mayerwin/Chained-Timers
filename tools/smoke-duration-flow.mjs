// v1.4.14 — new segments start at 0s and the duration picker opens for
// them immediately.
//
// Rationale: a fresh segment has no meaningful duration, and setting it
// is the first thing anyone does. Starting from 00:00:00 also suits the
// numpad, which shifts digits in from the right — a pre-filled 01m00s
// would have to be cleared first. The sheet titles itself with WHICH
// segment is being set, so on a new chain it is obvious this is only
// segment 1.
//
// The v1.4.13 first-run pointer still complements this: an AUTO open
// does not retire it, so dismissing the sheet without setting anything
// leaves the highlight up as the reminder it was written to be.
//
// Run via:
//   npm run serve   # in another shell
//   node tools/smoke-duration-flow.mjs

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
  chains: [{ id: 'c_old', name: 'Existing', color: 'amber', loops: 1, hasRun: true,
    segments: [{ id: 's1', kind: 'segment', name: 'Seg', duration: 90, color: 'amber' }] }],
  settings: { sound: false, voice: false, vibrate: false, prestart: false, finalTick: false },
})), { key: STORAGE_KEY });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);

const sheet = () => page.evaluate(() => ({
  open: !document.getElementById('duration-sheet')?.hidden,
  title: document.getElementById('duration-sheet-title')?.textContent,
  digits: document.getElementById('dpick-display')?.textContent
       ?? window.ChainedApp.UI.dpickDigits,
}));
const closeSheet = () => page.evaluate(() => {
  document.getElementById('duration-sheet').hidden = true;
});

console.log('Test 1: new chain starts at 0s and opens the picker on segment 1');
{
  await page.evaluate(() => window.ChainedApp.View.show('library'));
  await page.waitForTimeout(150);
  await page.click('#new-chain-fab');
  await page.waitForTimeout(400);          // rAF + render
  const s = await sheet();
  eq(s.open, true, 'duration picker opened by itself');
  eq(s.title, 'Segment 1', 'title names the segment being set');
  const st = await page.evaluate(() => ({
    view: document.body.dataset.view,
    dur: window.ChainedApp.Editor.draft.segments[0].duration,
    label: document.querySelector('.segment-duration')?.textContent,
    target: window.ChainedApp.Editor.draft.segments[0] === window.ChainedApp.UI.durationTarget,
  }));
  eq(st.view, 'editor', 'sitting on the editor underneath');
  eq(st.dur, 0, 'new segment duration is 0');
  eq(st.label, '0s', 'duration button reads 0s (not blank)');
  eq(st.target, true, 'picker targets segment 1');
}

console.log('\nTest 2: an auto-open does NOT retire the first-run pointer');
{
  // Dismiss without setting anything — segment is still 0s, so the
  // pointer should still be up.
  await closeSheet();
  await page.evaluate(() => window.ChainedApp.UI.renderEditor());
  await page.waitForTimeout(150);
  const s = await page.evaluate(() => ({
    used: window.ChainedApp.UI.durationHintUsed,
    hinted: document.querySelector('.segment-duration')?.classList.contains('is-hinted'),
  }));
  eq(s.used, false, 'hint not marked used by the auto-open');
  eq(s.hinted, true, 'pointer still highlights the unset duration');
}

console.log('\nTest 3: tapping the control manually retires the pointer');
{
  await page.click('.segment-duration');
  await page.waitForTimeout(200);
  eq((await sheet()).open, true, 'manual tap opens the picker');
  eq(await page.evaluate(() => window.ChainedApp.UI.durationHintUsed), true, 'manual open retires the pointer');
  await closeSheet();
}

console.log('\nTest 4: adding a segment opens the picker for THAT segment');
{
  const before = await page.evaluate(() => document.activeElement?.className || '');
  await page.click('#add-segment');
  await page.waitForTimeout(400);
  const s = await sheet();
  eq(s.open, true, 'picker opened for the new segment');
  eq(s.title, 'Segment 2', 'title names segment 2');
  const st = await page.evaluate(() => {
    const segs = window.ChainedApp.Editor.draft.segments;
    return {
      count: segs.length,
      dur: segs[1].duration,
      targetsLast: window.ChainedApp.UI.durationTarget === segs[1],
      // The old behaviour focused the NAME field; it must not steal focus.
      nameFocused: document.activeElement?.classList.contains('segment-name-input'),
    };
  });
  eq(st.count, 2, 'segment added');
  eq(st.dur, 0, 'new segment starts at 0');
  eq(st.targetsLast, true, 'picker targets the segment just added');
  eq(st.nameFocused, false, 'name input is NOT focused (duration is the target)');
  void before;
}

console.log('\nTest 5: committing a duration updates the row and clears the pointer');
{
  // Type 30 -> 30s, then confirm.
  await page.evaluate(() => {
    const { UI } = window.ChainedApp;
    UI.dpickPressDigit('3');
    UI.dpickPressDigit('0');
    UI.commitDurationPicker();
  });
  await page.waitForTimeout(250);
  const s = await page.evaluate(() => ({
    open: !document.getElementById('duration-sheet').hidden,
    dur: window.ChainedApp.Editor.draft.segments[1].duration,
    labels: [...document.querySelectorAll('.segment-duration')].map(d => d.textContent),
    hinted: [...document.querySelectorAll('.segment-duration')].map(d => d.classList.contains('is-hinted')),
  }));
  eq(s.open, false, 'sheet closed on confirm');
  eq(s.dur, 30, 'duration committed as 30s');
  eq(s.labels[1], '30s', 'row shows the new duration');
  eq(s.hinted[1], false, 'a set duration is never hinted');
}

console.log('\nTest 6: the title carries the segment name when there is one');
{
  const title = await page.evaluate(() => {
    const { Editor, UI } = window.ChainedApp;
    Editor.draft.segments[1].name = 'Rest';
    UI.openDurationPicker(Editor.draft.segments[1]);
    const t = document.getElementById('duration-sheet-title').textContent;
    document.getElementById('duration-sheet').hidden = true;
    return t;
  });
  eq(title, 'Segment 2 · Rest', 'named segment shows number and name');
}

console.log('\nTest 7: opening an EXISTING chain does not auto-open anything');
{
  await page.evaluate(() => {
    const { Editor, View } = window.ChainedApp;
    Editor.loadChain('c_old');
    View.show('editor');
  });
  await page.waitForTimeout(400);
  const s = await sheet();
  eq(s.open, false, 'no picker for an existing chain');
  const dur = await page.evaluate(() => document.querySelector('.segment-duration')?.textContent);
  eq(dur, '1m 30s', 'existing durations untouched');
}

console.log(failures ? `\n❌ ${failures} assertion(s) failed` : '\n✅ all checks passed');
await browser.close();
process.exit(failures ? 1 : 0);
