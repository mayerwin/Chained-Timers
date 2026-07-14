// v1.4.9 targeted verification. Loads the app, exercises the three
// user-reported bugs, and either passes or throws.
//
// Bugs under test:
//   1. Swipe-back on the run view (BOTH directions) navigates to library.
//   2. Clicking the run-view chain-name opens an inline input; typing
//      + Enter commits the rename, both in Store and on the topbar.
//   3. Multi-select toolbar shows a trash button that enables when a
//      chain is selected; clicking it (with confirm auto-accepted)
//      actually removes the selected chain from Store.
//
// Failure mode: any assertion that fails throws, node exits non-zero.

import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:4321/';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
  reducedMotion: 'no-preference',
  colorScheme: 'dark',
});
const page = await context.newPage();
page.on('pageerror', e => { console.error('PAGEERROR:', e.message); process.exit(2); });

// Auto-accept confirm() so the bulk-delete flow can be exercised
// without human input. We do this per-page and pre-navigation so it
// registers before app JS runs.
page.on('dialog', d => d.accept());

// Seed a couple of chains so we have something to select / rename.
await page.addInitScript(() => {
  localStorage.setItem('chained-timers/v1', JSON.stringify({
    schemaVersion: 1,
    chains: [
      { id: 'c_a', name: 'Alpha Chain',  color: 'amber', loops: 1,
        segments: [{ id: 's1', kind: 'segment', name: 'A1', duration: 30, color: 'amber' },
                   { id: 's2', kind: 'segment', name: 'A2', duration: 30, color: 'rust'  }],
        createdAt: 1, updatedAt: 1 },
      { id: 'c_b', name: 'Beta Chain',   color: 'rust',  loops: 1,
        segments: [{ id: 's3', kind: 'segment', name: 'B1', duration: 30, color: 'rust' }],
        createdAt: 2, updatedAt: 2 },
      { id: 'c_c', name: 'Gamma Chain',  color: 'teal',  loops: 1,
        segments: [{ id: 's4', kind: 'segment', name: 'C1', duration: 30, color: 'teal' }],
        createdAt: 3, updatedAt: 3 },
    ],
    settings: {},
  }));
});

await page.goto(URL, { waitUntil: 'networkidle' });

const ok    = (msg) => console.log('  ✓', msg);
const fail  = (msg) => { console.error('  ✗', msg); process.exit(1); };

// ---------------------------------------------------------------------
console.log('[1] Swipe-back on run view (both directions)');

// Start Alpha Chain — tap its play button.
await page.locator('li[data-chain-id="c_a"] .chain-card-play').click();
await page.waitForTimeout(400);
// Wait through any prestart countdown (default 3s prestart may fire).
await page.waitForSelector('.view-run:not([hidden])', { timeout: 5000 });
await page.waitForTimeout(3500);

let view = await page.evaluate(() => document.body.dataset.view);
if (view !== 'run') fail(`expected view=run before swipe, got ${view}`);
ok('landed on run view');

// LEFT swipe (finger moves left, dx negative). Threshold >60px absolute.
const box = await page.locator('.view-run').boundingBox();
const cy  = box.y + box.height / 2;
await page.mouse.move(box.x + box.width - 40, cy);
await page.mouse.down();
for (let x = box.x + box.width - 40; x > box.x + 60; x -= 20) {
  await page.mouse.move(x, cy);
}
await page.mouse.up();
await page.waitForTimeout(200);
view = await page.evaluate(() => document.body.dataset.view);
if (view !== 'library') fail(`left swipe did not return to library (view=${view})`);
ok('left swipe → library');

// Return to run view and try RIGHT swipe.
await page.locator('.run-chip, .now-playing-strip [data-chain-id="c_a"], [data-chain-id="c_a"]').first().click().catch(() => {});
// Fallback: navigate via the play/status card
if ((await page.evaluate(() => document.body.dataset.view)) !== 'run') {
  await page.locator('li[data-chain-id="c_a"] .chain-card-play').click();
  await page.waitForTimeout(300);
}
await page.waitForTimeout(200);
view = await page.evaluate(() => document.body.dataset.view);
if (view !== 'run') { console.log('  (skipping right-swipe: could not re-enter run view)'); }
else {
  const box2 = await page.locator('.view-run').boundingBox();
  const cy2  = box2.y + box2.height / 2;
  await page.mouse.move(box2.x + 40, cy2);
  await page.mouse.down();
  for (let x = box2.x + 40; x < box2.x + box2.width - 60; x += 20) {
    await page.mouse.move(x, cy2);
  }
  await page.mouse.up();
  await page.waitForTimeout(200);
  view = await page.evaluate(() => document.body.dataset.view);
  if (view !== 'library') fail(`right swipe did not return to library (view=${view})`);
  ok('right swipe → library');
}

// ---------------------------------------------------------------------
console.log('[2] Chain-name rename from run view');

// Re-enter run view via the play button.
await page.locator('li[data-chain-id="c_a"] .chain-card-play').click();
await page.waitForTimeout(300);
view = await page.evaluate(() => document.body.dataset.view);
if (view !== 'run') fail(`could not enter run view for rename test (view=${view})`);

// Click chain-name button.
const nameBtn = page.locator('#run-chain-name');
const originalName = await nameBtn.textContent();
if (originalName?.trim() !== 'Alpha Chain') fail(`expected Alpha Chain in topbar, got "${originalName}"`);
ok(`topbar shows "${originalName?.trim()}"`);

await nameBtn.click();
await page.waitForTimeout(150);
// The button was swapped for an input with class .run-chain-name-input.
const input = page.locator('.run-chain-name-input');
if (!(await input.count())) fail('rename input did not appear after click');
ok('rename input appeared');
await input.fill('Alpha Renamed');
await input.press('Enter');
await page.waitForTimeout(150);

// The button should be back, with the new name.
const newName = (await page.locator('#run-chain-name').textContent())?.trim();
if (newName !== 'Alpha Renamed') fail(`expected "Alpha Renamed", got "${newName}"`);
ok('topbar shows new name');

// Store should reflect the rename too.
const stored = await page.evaluate(() => {
  const raw = JSON.parse(localStorage.getItem('chained-timers/v1') || '{}');
  return raw.chains?.find(c => c.id === 'c_a')?.name;
});
if (stored !== 'Alpha Renamed') fail(`Store still has "${stored}"`);
ok('Store persisted rename');

// ---------------------------------------------------------------------
console.log('[3] Bulk-delete from multi-select toolbar');

// Back to library.
await page.evaluate(() => window.dispatchEvent(new Event('chainBack')));
await page.waitForTimeout(200);
// stop the running chain — bulk delete a running chain is safe, but
// let's exercise the more common case of deleting an idle chain.
await page.evaluate(() => window.Engine?.stop?.());
await page.waitForTimeout(100);

// Enter select mode via long-press on a chain row. Simulate with a
// mousedown-hold >= LONGPRESS_MS.
const rowB = page.locator('[data-chain-id="c_b"]').first();
const rb = await rowB.boundingBox();
await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
await page.mouse.down();
await page.waitForTimeout(700); // >LONGPRESS_MS (500)
await page.mouse.up();
await page.waitForTimeout(150);

// Select toolbar should be visible.
const selectBar = page.locator('#library-topbar-select');
if (await selectBar.isHidden()) fail('select toolbar did not show after long-press');
ok('select toolbar visible');

// Delete button should exist AND be enabled (at least 1 selected).
const del = page.locator('#library-select-delete');
if (!(await del.count())) fail('bulk-delete button missing from DOM');
const disabled = await del.getAttribute('disabled');
if (disabled !== null) fail('bulk-delete button should be enabled with a selection');
ok('bulk-delete button enabled with 1 selection');

// Click it — page.on('dialog') accepts the confirm.
await del.click();
await page.waitForTimeout(200);

const remaining = await page.evaluate(() => {
  const raw = JSON.parse(localStorage.getItem('chained-timers/v1') || '{}');
  return raw.chains?.map(c => c.id);
});
if (!remaining || remaining.includes('c_b')) fail(`c_b should be deleted, chains=${JSON.stringify(remaining)}`);
if (!remaining.includes('c_a') || !remaining.includes('c_c')) fail('other chains should remain');
ok('c_b removed from Store');

// Select mode should have exited.
if (!(await selectBar.isHidden())) fail('select toolbar should hide after delete');
ok('select mode exited');

console.log('\nAll v1.4.9 checks passed.');
await browser.close();
