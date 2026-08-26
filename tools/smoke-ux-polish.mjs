// v1.4.13 — UX polish regression tests.
//
//   1. Tab reads "Chains", not "Library".
//   2. Segment-scope cue sheet drops chain-level language (no "chain
//      start/end" / "every segment boundary"); chain scope keeps it.
//   3. Chain name defaults: first segment's name when the user typed
//      one, else "Chain" — never "Untitled".
//   4. Drag-reorder by the grip persists a new chain order; the grip
//      only exists in select mode.
//
// Run via:
//   npm run serve   # in another shell
//   node tools/smoke-ux-polish.mjs

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

const seg = (id, name) => ({ id, kind: 'segment', name, duration: 60, color: 'amber' });
const SEED = {
  schemaVersion: 1,
  chains: [
    { id: 'c_1', name: 'One',   color: 'amber',  loops: 1, segments: [seg('s1', 'A')], createdAt: 3, updatedAt: 3, hasRun: true },
    { id: 'c_2', name: 'Two',   color: 'teal',   loops: 1, segments: [seg('s2', 'B')], createdAt: 2, updatedAt: 2, hasRun: true },
    { id: 'c_3', name: 'Three', color: 'violet', loops: 1, segments: [seg('s3', 'C')], createdAt: 1, updatedAt: 1, hasRun: true },
  ],
  settings: { sound: false, voice: false, vibrate: false, prestart: false, finalTick: false },
};
await page.addInitScript(({ key, seed }) => localStorage.setItem(key, JSON.stringify(seed)), { key: STORAGE_KEY, seed: SEED });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);

console.log('Test 1: tab label says Chains');
{
  const label = await page.evaluate(() => document.querySelector('.tab[data-tab="library"] span')?.textContent);
  eq(label, 'Chains', 'tab label');
  const anyLibraryCopy = await page.evaluate(() =>
    [...document.querySelectorAll('.tab span, .templates-blurb, #export-data')].map(e => e.textContent).join(' | '));
  if (!/\bLibrary\b/i.test(anyLibraryCopy)) ok('no user-facing "Library" wording left in nav/blurb/export');
  else bad(`stale wording: ${anyLibraryCopy}`);
}

console.log('\nTest 2: cue sheet copy is scope-aware');
{
  const chainCopy = await page.evaluate(() => {
    const { UI, Store } = window.ChainedApp;
    UI._openCueSheet('chain', Store.getChain('c_1'), Store.getChain('c_1'), () => {});
    return [...document.querySelectorAll('#cues-list .cue-row')].map(r => ({
      title: r.querySelector('.cue-row-title').textContent,
      hint:  r.querySelector('.cue-row-hint').textContent,
    }));
  });
  const chainSound = chainCopy.find(r => /sound/i.test(r.title));
  if (/chain start\/end/.test(chainSound.hint)) ok('chain scope keeps chain-level sound wording');
  else bad(`chain sound hint: ${chainSound.hint}`);
  const chainVib = chainCopy.find(r => /segment ends/i.test(r.title));
  if (chainVib) ok('chain scope keeps "When a segment ends" title');
  else bad('chain vibrate row title changed unexpectedly');

  const segCopy = await page.evaluate(() => {
    const { UI, Store } = window.ChainedApp;
    const chain = Store.getChain('c_1');
    UI._openCueSheet('segment', chain.segments[0], chain, () => {});
    return [...document.querySelectorAll('#cues-list .cue-row')].map(r => ({
      title: r.querySelector('.cue-row-title').textContent,
      hint:  r.querySelector('.cue-row-hint').textContent,
    }));
  });
  const joined = segCopy.map(r => `${r.title} :: ${r.hint}`).join(' | ');
  if (!/chain start\/end/i.test(joined)) ok('segment scope drops "chain start/end"');
  else bad(`segment copy still mentions chain start/end: ${joined}`);
  if (!/every segment boundary|at chain end/i.test(joined)) ok('segment scope drops chain-wide boundary wording');
  else bad(`segment copy still chain-wide: ${joined}`);
  const segVib = segCopy.find(r => /buzz/i.test(r.title));
  if (segVib) ok(`segment vibrate row retitled ("${segVib.title}" — "${segVib.hint}")`);
  else bad(`no buzz-titled row at segment scope: ${joined}`);
  const segSound = segCopy.find(r => /sound/i.test(r.title));
  if (/this segment/i.test(segSound.hint)) ok(`segment sound hint scoped ("${segSound.hint}")`);
  else bad(`segment sound hint: ${segSound.hint}`);
  // prestart is chain-only — assert that directly rather than pinning a
  // row count (the sheet legitimately grows, e.g. ring-until-dismissed).
  if (!/pre-start/i.test(joined)) ok('pre-start countdown stays chain-only');
  else bad(`prestart leaked into segment scope: ${joined}`);
  await page.evaluate(() => { document.getElementById('cues-sheet').hidden = true; });
}

console.log('\nTest 3: chain name defaults');
{
  const r = await page.evaluate(() => {
    const { Editor, Store } = window.ChainedApp;
    const out = {};
    // (a) no chain name, first segment named → borrow the segment name
    Editor.newChain();
    Editor.draft.name = '';
    Editor.addSegment();
    Editor.draft.segments[0].name = 'Hanging';
    out.borrowed = Editor.saveDraft().name;
    // (b) nothing named at all → "Chain"
    Editor.newChain();
    Editor.draft.name = '';
    Editor.addSegment();
    Editor.draft.segments[0].name = '';
    out.fallback = Editor.saveDraft().name;
    // (c) explicit name wins
    Editor.newChain();
    Editor.draft.name = 'My Chain';
    Editor.addSegment();
    Editor.draft.segments[0].name = 'Seg';
    out.explicit = Editor.saveDraft().name;
    out.placeholder = document.getElementById('editor-name').placeholder;
    out.anyUntitled = Store.getChains().some(c => /untitled/i.test(c.name || ''));
    return out;
  });
  eq(r.borrowed, 'Hanging', 'nameless chain borrows first segment name');
  eq(r.fallback, 'Chain', 'nothing named falls back to "Chain"');
  eq(r.explicit, 'My Chain', 'explicit name preserved');
  eq(r.placeholder, 'Chain', 'editor placeholder');
  eq(r.anyUntitled, false, 'no chain ends up named Untitled');
}

console.log('\nTest 4: grip drag reorders and persists');
{
  await page.evaluate(() => {
    const { Store, UI, View } = window.ChainedApp;
    // Reset to the 3 seed chains in known order.
    Store.state.chains = Store.state.chains.filter(c => ['c_1','c_2','c_3'].includes(c.id));
    Store.reorderChains(['c_1','c_2','c_3']);
    View.show('library');
    UI.exitSelectMode();
  });
  await page.waitForTimeout(200);
  const gripHidden = await page.evaluate(() => {
    const g = document.querySelector('li[data-chain-id="c_1"] .chain-card-grip');
    return g ? getComputedStyle(g).display : 'missing';
  });
  eq(gripHidden, 'none', 'grip hidden outside select mode');

  await page.evaluate(() => window.ChainedApp.UI.enterSelectMode('c_1'));
  await page.waitForTimeout(200);
  const gripShown = await page.evaluate(() =>
    getComputedStyle(document.querySelector('li[data-chain-id="c_1"] .chain-card-grip')).display);
  if (gripShown !== 'none') ok(`grip visible in select mode (display: ${gripShown})`);
  else bad('grip still hidden in select mode');

  // The tick column must actually carry a glyph (its CSS named a
  // _setTickContent helper that didn't exist, leaving an empty gutter).
  const ticks = await page.evaluate(() => {
    const { UI } = window.ChainedApp;
    UI.toggleSelected('c_2');   // c_1 already selected → c_2 is second
    return [...document.querySelectorAll('li.chain-card')].map(li => {
      const t = li.querySelector('.chain-card-select-tick');
      return { id: li.dataset.chainId, svg: !!t.querySelector('svg'), lbl: t.querySelector('.chain-card-select-tick-lbl')?.textContent || '' };
    });
  });
  if (ticks.every(t => t.svg)) ok('every row shows a selection glyph');
  else bad(`missing glyphs: ${JSON.stringify(ticks)}`);
  eq(ticks.find(t => t.id === 'c_1').lbl, 'Focus', 'first selection labelled Focus');
  eq(ticks.find(t => t.id === 'c_2').lbl, '2', 'second selection labelled 2');
  eq(ticks.find(t => t.id === 'c_3').lbl, '', 'unselected row has no label');
  await page.evaluate(() => window.ChainedApp.UI.toggleSelected('c_2'));
  await page.waitForTimeout(150);

  // Drag chain 1 down past chains 2 and 3.
  const box = await page.locator('li[data-chain-id="c_1"] .chain-card-grip').boundingBox();
  const card = await page.locator('li[data-chain-id="c_3"]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const targetY = card.y + card.height - 10;
  const steps = 14;
  for (let i = 1; i <= steps; i++) {
    const y = box.y + box.height / 2 + ((targetY - (box.y + box.height / 2)) * i) / steps;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.waitForTimeout(20);
  }
  const dragging = await page.evaluate(() => !!document.querySelector('.chain-card.is-reordering'));
  eq(dragging, true, 'dragged row marked while in flight');
  await page.mouse.up();
  await page.waitForTimeout(400);
  const order = await page.evaluate(() => window.ChainedApp.Store.getChains().map(c => c.id));
  eq(order, ['c_2', 'c_3', 'c_1'], 'store order after dragging chain 1 to the end');
  const domOrder = await page.evaluate(() =>
    [...document.querySelectorAll('li.chain-card')].map(c => c.dataset.chainId));
  eq(domOrder, order, 'rendered order matches stored order');
  const clean = await page.evaluate(() => ({
    reordering: document.querySelectorAll('.is-reordering').length,
    bodyFlag: document.body.classList.contains('is-reordering-chains'),
    transforms: [...document.querySelectorAll('li.chain-card')].filter(c => c.style.transform).length,
  }));
  eq(clean, { reordering: 0, bodyFlag: false, transforms: 0 }, 'drag state cleaned up');

  // The new order must be WRITTEN THROUGH to storage, not just held in
  // memory. (Asserted against localStorage rather than a reload: this
  // suite's addInitScript re-seeds storage on every navigation, so a
  // reload would test the seed, not the save.)
  eq(await page.evaluate(() =>
      JSON.parse(localStorage.getItem('chained-timers/v1')).chains.map(c => c.id)),
     ['c_2', 'c_3', 'c_1'], 'order persisted to storage');
}

console.log(failures ? `\n❌ ${failures} assertion(s) failed` : '\n✅ all checks passed');
await browser.close();
process.exit(failures ? 1 : 0);
