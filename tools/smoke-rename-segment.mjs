// v1.4.12 — mid-run segment rename regression tests.
//
// Locks in the run-view inline segment rename contract:
//   1. Tap the big segment title → input; Enter commits: the Store
//      segment, the run's expanded instances (ALL loop repetitions),
//      and the display update.
//   2. When the current segment comes from an embedded subchain, the
//      rename lands on the SUBCHAIN's segment (the true owner), not on
//      the parent chain.
//   3. Escape cancels; empty input is refused (name kept).
//   4. A repaint mid-edit doesn't clobber the in-flight input.
//   5. Rename works while paused.
//   6. A synthetic pre-v1.4.12 run snapshot (no src ids) refuses the
//      rename gracefully instead of hitting the wrong segment.
//
// Run via:
//   npm run serve   # in another shell
//   node tools/smoke-rename-segment.mjs

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

const SEED = {
  schemaVersion: 1,
  chains: [
    // Loops ×2 so the same source segment appears twice in the plan.
    { id: 'c_main', name: 'Workout', color: 'amber', loops: 2,
      segments: [
        { id: 's_work', kind: 'segment', name: 'Work', duration: 300, color: 'amber' },
        { id: 's_rest', kind: 'segment', name: 'Rest', duration: 300, color: 'teal' },
      ],
      createdAt: 3, updatedAt: 3 },
    { id: 'c_sub', name: 'Warmup', color: 'violet', loops: 1,
      segments: [{ id: 's_sub', kind: 'segment', name: 'Reach', duration: 300, color: 'violet' }],
      createdAt: 2, updatedAt: 2 },
    { id: 'c_host', name: 'Host', color: 'rust', loops: 1,
      segments: [{ id: 'sc1', kind: 'subchain', refId: 'c_sub' }],
      createdAt: 1, updatedAt: 1 },
  ],
  settings: { sound: false, voice: false, vibrate: false, prestart: false, finalTick: false },
};
await page.addInitScript(({ key, seed }) => localStorage.setItem(key, JSON.stringify(seed)), { key: STORAGE_KEY, seed: SEED });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);

const title = () => page.evaluate(() => document.getElementById('run-segment-name')?.textContent);
const openEditor = async () => {
  await page.click('#run-segment-name');
  await page.waitForTimeout(120);
  return page.evaluate(() => {
    const i = document.querySelector('.run-segment-name-input');
    return i ? { value: i.value, focused: document.activeElement === i } : null;
  });
};
const typeAndEnter = async (text) => {
  await page.fill('.run-segment-name-input', text);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
};

console.log('Test 1: rename current segment — Store + all loop instances + display');
{
  await page.evaluate(() => {
    const { Store, Engine } = window.ChainedApp;
    Engine.startChain(Store.getChain('c_main'));
    window.ChainedApp.View.show('run');
  });
  await page.waitForTimeout(300);
  eq(await title(), 'Work', 'title shows current segment');
  const ed = await openEditor();
  eq(!!ed, true, 'input swapped in on tap');
  eq(ed.value, 'Work', 'input prefilled with source name');
  eq(ed.focused, true, 'input focused');
  await typeAndEnter('Deep Work');
  eq(await title(), 'Deep Work', 'display updated');
  const state = await page.evaluate(() => {
    const { Store, Engine } = window.ChainedApp;
    const src = Store.getChain('c_main').segments.find(s => s.id === 's_work');
    const run = Engine._runs.get('c_main');
    return {
      storeName: src.name,
      expandedNames: run.segments.map(s => s.name),
      persisted: JSON.parse(localStorage.getItem('chained-timers/run/v2/c_main') || 'null')?.segments?.map(s => s.name) || null,
    };
  });
  eq(state.storeName, 'Deep Work', 'Store segment renamed');
  eq(state.expandedNames, ['Deep Work', 'Rest', 'Deep Work', 'Rest'], 'BOTH loop instances renamed');
  eq(state.persisted, ['Deep Work', 'Rest', 'Deep Work', 'Rest'], 'run snapshot re-persisted');
  eq(await page.evaluate(() => document.getElementById('run-segment-name')?.tagName), 'BUTTON', 'button rebuilt after commit');
}

console.log('\nTest 2: Escape cancels; empty refused');
{
  await openEditor();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  eq(await title(), 'Deep Work', 'Escape keeps the name');
  await openEditor();
  await typeAndEnter('   ');
  eq(await title(), 'Deep Work', 'empty commit refused');
  const src = await page.evaluate(() => window.ChainedApp.Store.getChain('c_main').segments.find(s => s.id === 's_work').name);
  eq(src, 'Deep Work', 'Store untouched by refusals');
}

console.log('\nTest 3: repaint mid-edit does not clobber the input');
{
  await openEditor();
  await page.fill('.run-segment-name-input', 'Halfway typed');
  await page.evaluate(() => window.ChainedApp.UI.updateRunSegmentInfo());
  const v = await page.evaluate(() => document.querySelector('.run-segment-name-input')?.value);
  eq(v, 'Halfway typed', 'in-flight value preserved through repaint');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
}

console.log('\nTest 4: rename while paused');
{
  await page.evaluate(() => window.ChainedApp.Engine.toggle());
  await page.waitForTimeout(150);
  await openEditor();
  await typeAndEnter('Paused Rename');
  eq(await title(), 'Paused Rename', 'renamed while paused');
  await page.evaluate(() => { window.ChainedApp.Engine.toggle(); window.ChainedApp.Engine.stopRun('c_main'); });
  await page.waitForTimeout(200);
}

console.log('\nTest 5: subchain segment — rename lands on the subchain, not the host');
{
  await page.evaluate(() => {
    const { Store, Engine } = window.ChainedApp;
    Engine.startChain(Store.getChain('c_host'));
    window.ChainedApp.View.show('run');
  });
  await page.waitForTimeout(300);
  eq(await title(), 'Reach', 'showing the embedded segment');
  await openEditor();
  await typeAndEnter('Reach Higher');
  const s = await page.evaluate(() => {
    const { Store } = window.ChainedApp;
    return {
      sub: Store.getChain('c_sub').segments[0].name,
      hostSegs: Store.getChain('c_host').segments.map(x => x.kind),
    };
  });
  eq(s.sub, 'Reach Higher', "subchain's own segment renamed");
  eq(s.hostSegs, ['subchain'], 'host chain untouched (still just the ref)');
  eq(await title(), 'Reach Higher', 'display updated');
  await page.evaluate(() => window.ChainedApp.Engine.stopRun('c_host'));
  await page.waitForTimeout(200);
}

console.log('\nTest 6: legacy run without src ids refuses gracefully');
{
  await page.evaluate(() => {
    const { Store, Engine } = window.ChainedApp;
    Engine.startChain(Store.getChain('c_main'));
    // Simulate a pre-v1.4.12 snapshot: strip the source mapping.
    const run = Engine._runs.get('c_main');
    run.segments.forEach(s => { delete s.srcChainId; delete s.srcSegId; });
    window.ChainedApp.View.show('run');
  });
  await page.waitForTimeout(300);
  const before = await title();
  await page.click('#run-segment-name');
  await page.waitForTimeout(150);
  const r = await page.evaluate(() => ({
    input: !!document.querySelector('.run-segment-name-input'),
    toast: [...document.querySelectorAll('.toast')].map(t => t.textContent).join('|'),
  }));
  eq(r.input, false, 'no input opened');
  if (r.toast.includes('Rename unavailable')) ok('explanatory toast shown');
  else bad(`toast missing: ${r.toast}`);
  eq(await title(), before, 'title unchanged');
  await page.evaluate(() => window.ChainedApp.Engine.stopRun('c_main'));
}

console.log(failures ? `\n❌ ${failures} assertion(s) failed` : '\n✅ all checks passed');
await browser.close();
process.exit(failures ? 1 : 0);
