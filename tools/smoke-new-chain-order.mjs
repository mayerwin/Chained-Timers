// v1.4.14 — new chains are appended, not prepended.
//
// The + button sits at the BOTTOM of the library, so that is where
// users look for what it just made (Android's stock Clock behaves the
// same). Prepending also pushed throwaway timers above the chains you
// actually care about. Covered here:
//   1. A newly saved chain lands LAST, not first.
//   2. Editing an existing chain does not move it.
//   3. The new row is scrolled into view and flashed.
//   4. A duplicate lands next to its original.
//   5. A template fork also lands last.
//   6. Deleting still works on the appended row (the "temporary timer"
//      workflow this change is for).
//
// Run via:
//   npm run serve   # in another shell
//   node tools/smoke-new-chain-order.mjs

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

const seg = (id, n) => ({ id, kind: 'segment', name: n, duration: 60, color: 'amber' });
await page.addInitScript(({ key }) => localStorage.setItem(key, JSON.stringify({
  schemaVersion: 1,
  chains: [
    { id: 'c_1', name: 'Alpha', color: 'amber',  loops: 1, hasRun: true, segments: [{ id: 's1', kind: 'segment', name: 'A', duration: 60, color: 'amber' }] },
    { id: 'c_2', name: 'Bravo', color: 'teal',   loops: 1, hasRun: true, segments: [{ id: 's2', kind: 'segment', name: 'B', duration: 60, color: 'teal' }] },
    { id: 'c_3', name: 'Charlie', color: 'violet', loops: 1, hasRun: true, segments: [{ id: 's3', kind: 'segment', name: 'C', duration: 60, color: 'violet' }] },
  ],
  settings: { sound: false, voice: false, vibrate: false, prestart: false, finalTick: false },
})), { key: STORAGE_KEY });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);

const names = () => page.evaluate(() => window.ChainedApp.Store.getChains().map(c => c.name));
const domNames = () => page.evaluate(() =>
  [...document.querySelectorAll('li.chain-card .chain-card-name')].map(n => n.textContent));

console.log('Test 1: a new chain is appended to the bottom');
{
  eq(await names(), ['Alpha', 'Bravo', 'Charlie'], 'starting order');
  // Exactly what the + button does, then Save.
  await page.evaluate(() => { window.ChainedApp.Editor.newChain(); window.ChainedApp.View.show('editor'); });
  await page.waitForTimeout(150);
  await page.fill('#editor-name', 'Fresh');
  await page.evaluate(() => { window.ChainedApp.Editor.draft.name = 'Fresh'; });
  await page.click('#editor-save-only');
  await page.waitForTimeout(400);
  eq(await names(), ['Alpha', 'Bravo', 'Charlie', 'Fresh'], 'new chain is LAST');
  // NB: the card caps are CSS text-transform, so textContent keeps the
  // stored casing.
  eq(await domNames(), ['Alpha', 'Bravo', 'Charlie', 'Fresh'], 'rendered in the same order');
}

console.log('\nTest 2: the new row is revealed (scrolled to + flashed)');
{
  const flashed = await page.evaluate(() => {
    const li = [...document.querySelectorAll('li.chain-card')].pop();
    return li?.classList.contains('is-new');
  });
  eq(flashed, true, 'new row carries the flash class');
  const visible = await page.evaluate(() => {
    const li = [...document.querySelectorAll('li.chain-card')].pop();
    const r = li.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight;
  });
  eq(visible, true, 'new row is inside the viewport');
  await page.waitForTimeout(1800);
  const cleared = await page.evaluate(() =>
    [...document.querySelectorAll('li.chain-card')].pop()?.classList.contains('is-new'));
  eq(cleared, false, 'flash clears itself');
}

console.log('\nTest 3: editing an existing chain does not move it');
{
  await page.evaluate(() => { window.ChainedApp.Editor.loadChain('c_2'); window.ChainedApp.View.show('editor'); });
  await page.waitForTimeout(150);
  await page.evaluate(() => { window.ChainedApp.Editor.draft.name = 'Bravo edited'; });
  await page.click('#editor-save-only');
  await page.waitForTimeout(300);
  eq(await names(), ['Alpha', 'Bravo edited', 'Charlie', 'Fresh'], 'edited chain stays in place');
  const flashed = await page.evaluate(() =>
    !!document.querySelector('li.chain-card.is-new'));
  eq(flashed, false, 'no flash for a plain edit');
}

console.log('\nTest 4: a duplicate lands next to its original');
{
  const after = await page.evaluate(() => {
    const { Store } = window.ChainedApp;
    Store.duplicateChain('c_1');
    return Store.getChains().map(c => c.name);
  });
  eq(after, ['Alpha', 'Alpha (copy)', 'Bravo edited', 'Charlie', 'Fresh'], 'copy sits right after its source');
}

console.log('\nTest 5: a template fork also lands last');
{
  const after = await page.evaluate(() => {
    const { Editor, Store } = window.ChainedApp;
    Editor.loadFromTemplate({ name: 'Forked', color: 'teal', loops: 1,
      segments: [{ kind: 'segment', name: 'X', duration: 30, color: 'teal' }] });
    Editor.saveDraft();
    return Store.getChains().map(c => c.name);
  });
  eq(after[after.length - 1], 'Forked', 'forked template appended');
}

console.log('\nTest 6: the appended row still swipe-deletes');
{
  const before = (await names()).length;
  await page.evaluate(() => window.ChainedApp.View.show('library'));
  await page.waitForTimeout(200);
  const card = page.locator('li.chain-card').last();
  await card.evaluate(el => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(150);
  const box = await card.boundingBox();
  const x = box.x + box.width * 0.4, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) { await page.mouse.move(x - (150 * i) / 12, y); await page.waitForTimeout(12); }
  await page.mouse.up();
  await page.waitForTimeout(700);
  eq((await names()).length, before - 1, 'appended chain deleted by swipe');
}

console.log(failures ? `\n❌ ${failures} assertion(s) failed` : '\n✅ all checks passed');
await browser.close();
process.exit(failures ? 1 : 0);
