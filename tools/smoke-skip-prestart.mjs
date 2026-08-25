// v1.4.12 — first-run prestart Skip / Always-skip regression tests.
//
// Locks in the contract:
//   1. A chain's FIRST-ever countdown shows a bottom snackbar with
//      "Skip" and "Always skip"; Skip starts the chain immediately
//      without touching settings.
//   2. Once a chain has run, its countdown shows NO snackbar.
//   3. "Always skip" records settings.prestart = false (same as the
//      settings toggle) and starts immediately; later starts of any
//      chain then skip the countdown entirely.
//   4. Letting the countdown finish naturally dismisses the snackbar.
//   5. hasRun is stamped by every start path (bulk start too), so a
//      chain first started in bulk gets no offer later.
//
// Run via:
//   npm run serve   # in another shell
//   node tools/smoke-skip-prestart.mjs

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
    { id: 'c_a', name: 'Alpha', color: 'amber', loops: 1, segments: [seg('s1', 'One')], createdAt: 4, updatedAt: 4 },
    { id: 'c_b', name: 'Bravo', color: 'teal',  loops: 1, segments: [seg('s2', 'Two')], createdAt: 3, updatedAt: 3 },
    { id: 'c_c', name: 'Charlie', color: 'violet', loops: 1, segments: [seg('s3', 'Three')], createdAt: 2, updatedAt: 2 },
    { id: 'c_d', name: 'Delta', color: 'rust', loops: 1, segments: [seg('s4', 'Four')], createdAt: 1, updatedAt: 1 },
  ],
  settings: { sound: false, voice: false, vibrate: false, prestart: true, finalTick: false },
};
await page.addInitScript(({ key, seed }) => localStorage.setItem(key, JSON.stringify(seed)), { key: STORAGE_KEY, seed: SEED });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);

const snapshot = () => page.evaluate(() => {
  const t = document.querySelector('.toast.has-action');
  return {
    snack: !!t,
    labels: t ? [...t.querySelectorAll('.toast-action-btn')].map(b => b.textContent) : [],
    overlayShown: !document.getElementById('run-prestart').hidden,
    running: window.ChainedApp.Engine.activeRuns().map(r => r.id).sort(),
    prestartSetting: window.ChainedApp.Store.getSettings().prestart,
  };
});
const startChainUI = (id) => page.evaluate((cid) => {
  const { Store, UI } = window.ChainedApp;
  UI.startRunForChain(Store.getChain(cid));
}, id);
const clickAction = async (label) => {
  await page.evaluate((l) => {
    const btn = [...document.querySelectorAll('.toast-action-btn')].find(b => b.textContent === l);
    btn?.click();
  }, label);
  await page.waitForTimeout(250);
};

console.log('Test 1: first countdown offers Skip / Always skip; Skip starts now');
{
  await startChainUI('c_a');
  await page.waitForTimeout(300);
  const s = await snapshot();
  eq(s.overlayShown, true, 'countdown running');
  eq(s.snack, true, 'snackbar offered on first run');
  eq(s.labels, ['Skip', 'Always skip'], 'both actions present');
  await clickAction('Skip');
  const s2 = await snapshot();
  eq(s2.running, ['c_a'], 'chain started immediately');
  eq(s2.overlayShown, false, 'countdown gone');
  eq(s2.snack, false, 'snackbar dismissed');
  eq(s2.prestartSetting, true, 'Skip does NOT change the setting');
  await page.evaluate(() => window.ChainedApp.Engine.stopRun('c_a'));
  await page.waitForTimeout(200);
}

console.log('\nTest 2: second run of the same chain — countdown, but NO offer');
{
  await startChainUI('c_a');
  await page.waitForTimeout(300);
  const s = await snapshot();
  eq(s.overlayShown, true, 'countdown still runs');
  eq(s.snack, false, 'no snackbar after first run');
  await page.waitForTimeout(3200); // let it finish naturally
  const s2 = await snapshot();
  eq(s2.running, ['c_a'], 'chain started after countdown');
  await page.evaluate(() => window.ChainedApp.Engine.stopRun('c_a'));
  await page.waitForTimeout(200);
}

console.log('\nTest 3: natural countdown completion dismisses a live offer');
{
  await startChainUI('c_b');
  await page.waitForTimeout(300);
  eq((await snapshot()).snack, true, 'offer up during countdown');
  await page.waitForTimeout(3200);
  const s = await snapshot();
  eq(s.running, ['c_b'], 'chain started');
  eq(s.snack, false, 'offer dismissed with the countdown');
  await page.evaluate(() => window.ChainedApp.Engine.stopRun('c_b'));
  await page.waitForTimeout(200);
}

console.log('\nTest 4: Always skip — records the setting, starts now, future starts skip');
{
  await startChainUI('c_c');
  await page.waitForTimeout(300);
  eq((await snapshot()).snack, true, 'offer on Charlie first run');
  await clickAction('Always skip');
  const s = await snapshot();
  eq(s.running, ['c_c'], 'chain started immediately');
  eq(s.prestartSetting, false, 'settings.prestart recorded false');
  await page.evaluate(() => window.ChainedApp.Engine.stopRun('c_c'));
  await page.waitForTimeout(200);
  // Any later start now skips the countdown entirely — including a
  // first-run chain (no countdown → nothing to offer skipping).
  await startChainUI('c_d');
  await page.waitForTimeout(300);
  const s2 = await snapshot();
  eq(s2.overlayShown, false, 'no countdown at all');
  eq(s2.snack, false, 'no snackbar either');
  eq(s2.running, ['c_d'], 'Delta started directly');
  await page.evaluate(() => window.ChainedApp.Engine.stopRun('c_d'));
  await page.waitForTimeout(200);
}

console.log('\nTest 5: bulk start stamps hasRun — no offer on a later solo start');
{
  await page.evaluate(() => {
    const { Store, Engine } = window.ChainedApp;
    Store.setSetting('prestart', true); // re-enable for this test
    // Fresh never-run chain, started via bulk (which never counts down).
    Store.upsertChain({ id: 'c_bulk', name: 'Bulky', color: 'sage', loops: 1,
      segments: [{ id: 'sb', kind: 'segment', name: 'B', duration: 60, color: 'sage' }] });
    Engine.startMany([Store.getChain('c_bulk')]);
  });
  await page.waitForTimeout(300);
  eq(await page.evaluate(() => window.ChainedApp.Store.getChain('c_bulk').hasRun), true, 'bulk start stamped hasRun');
  await page.evaluate(() => window.ChainedApp.Engine.stopRun('c_bulk'));
  await page.waitForTimeout(200);
  await startChainUI('c_bulk');
  await page.waitForTimeout(300);
  const s = await snapshot();
  eq(s.overlayShown, true, 'countdown runs on solo restart');
  eq(s.snack, false, 'no offer — chain already ran (via bulk)');
  await page.evaluate(() => { window.ChainedApp.UI.cancelPrestart(); });
}

console.log(failures ? `\n❌ ${failures} assertion(s) failed` : '\n✅ all checks passed');
await browser.close();
process.exit(failures ? 1 : 0);
