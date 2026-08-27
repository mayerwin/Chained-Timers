// v1.4.16 — feedback prompt eligibility + routing.
//
// The prompt is deliberately NOT a star picker. Showing stars and
// sending only the 5-star taps to the Store is "review gating", which
// Play prohibits; both answers here get a real destination (Play's own
// review sheet, or a prefilled GitHub issue) and equal visual weight.
//
// Covered:
//   1. Android only — the PWA never sees it.
//   2. Not before N days AND N completed chains, and never mid-run.
//   3. Asking is terminal: one offer per install, either answer.
//   4. A failed review flow does NOT burn the offer.
//   5. Dismissing snoozes once, then stops asking.
//   6. No star widget, and the negative answer is equally reachable.
//
// Run via:
//   npm run serve   # in another shell
//   node tools/smoke-feedback-prompt.mjs

import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:4321/';
const STORAGE_KEY = 'chained-timers/v1';
const DAY = 24 * 60 * 60 * 1000;

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
  chains: [{ id: 'c_1', name: 'One', color: 'amber', loops: 1, hasRun: true,
    segments: [{ id: 's1', kind: 'segment', name: 'A', duration: 60, color: 'amber' }] }],
  settings: { sound: false, voice: false, vibrate: false, prestart: false, finalTick: false },
})), { key: STORAGE_KEY });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);

// Pretend to be the native shell, and capture what the review bridge is
// asked to do. `shown` drives whether the single offer gets burned.
const fakeNative = (shown = true) => page.evaluate((sh) => {
  window.ChainedNative = { ...(window.ChainedNative || {}), isNative: true };
  window.__reviewCalls = 0;
  window.__opened = [];
  window.Capacitor = {
    ...(window.Capacitor || {}),
    getPlatform: () => 'android',
    Plugins: {
      ...((window.Capacitor || {}).Plugins || {}),
      ChainTimer: {
        ...(((window.Capacitor || {}).Plugins || {}).ChainTimer || {}),
        requestReview: async () => { window.__reviewCalls++; return { shown: sh }; },
      },
    },
  };
  window.open = (url) => { window.__opened.push(url); return null; };
}, shown);

const setup = (over) => page.evaluate((o) => {
  const { Store } = window.ChainedApp;
  Object.entries(o).forEach(([k, v]) => Store.setSetting(k, v));
  document.getElementById('feedback-sheet').hidden = true;
}, over);

const askNow = () => page.evaluate(() => window.ChainedApp.UI.maybeAskForFeedback());
const sheetOpen = () => page.evaluate(() => !document.getElementById('feedback-sheet').hidden);
const state = () => page.evaluate(() => {
  const s = window.ChainedApp.Store.getSettings();
  return { feedbackState: s.feedbackState, chainsCompleted: s.chainsCompleted };
});

const READY = { firstLaunchAt: Date.now() - 10 * DAY, chainsCompleted: 5, feedbackState: '', feedbackSnoozedAt: 0 };

console.log('Test 1: never on the web build');
{
  await page.evaluate(() => { window.ChainedNative = { isNative: false }; });
  await setup(READY);
  eq(await askNow(), false, 'PWA is not eligible');
  eq(await sheetOpen(), false, 'no sheet on web');
}

await fakeNative(true);

console.log('\nTest 2: eligibility gates');
{
  await setup({ ...READY, firstLaunchAt: Date.now() - 1 * DAY });
  eq(await askNow(), false, 'too soon after install (1 day)');

  await setup({ ...READY, chainsCompleted: 1 });
  eq(await askNow(), false, 'not enough completed chains');

  await setup(READY);
  const midRun = await page.evaluate(() => {
    const { Store, Engine, UI } = window.ChainedApp;
    Engine.startChain(Store.getChain('c_1'));
    const r = UI.maybeAskForFeedback();
    Engine.stopRun('c_1');
    return r;
  });
  eq(midRun, false, 'never while a chain is running');

  await setup(READY);
  eq(await askNow(), true, 'eligible once days + chains + idle all hold');
  eq(await sheetOpen(), true, 'sheet shown');
}

console.log('\nTest 3: no stars, and both answers are equally reachable');
{
  const shape = await page.evaluate(() => {
    const card = document.querySelector('#feedback-sheet .sheet-card');
    const no = document.getElementById('feedback-no');
    const yes = document.getElementById('feedback-yes');
    const r1 = no.getBoundingClientRect(), r2 = yes.getBoundingClientRect();
    return {
      title: document.getElementById('feedback-title').textContent,
      stars: card.textContent.includes('★') || !!card.querySelector('[class*="star"]'),
      bothVisible: r1.width > 0 && r2.width > 0,
      sameWidth: Math.abs(r1.width - r2.width) < 2,
      sameRow: Math.abs(r1.top - r2.top) < 2,
      noHidden: getComputedStyle(no).display === 'none' || getComputedStyle(no).visibility === 'hidden',
    };
  });
  if (!/enjoying/i.test(shape.title)) bad(`title not a neutral question: ${shape.title}`);
  else ok(`neutral question ("${shape.title}")`);
  eq(shape.stars, false, 'no star widget anywhere');
  eq(shape.bothVisible, true, 'both answers rendered');
  eq(shape.sameWidth, true, 'equal width — negative answer not de-emphasised');
  eq(shape.sameRow, true, 'side by side, same prominence');
  eq(shape.noHidden, false, '"Not really" is not hidden');
}

console.log('\nTest 4: "Yes" hands off to Play and burns the single offer');
{
  await page.click('#feedback-yes');
  await page.waitForTimeout(200);
  const r = await page.evaluate(() => ({ calls: window.__reviewCalls, opened: window.__opened.length }));
  eq(r.calls, 1, 'Play review flow requested');
  eq(r.opened, 0, 'no external URL opened — the sheet is in-app');
  eq(await sheetOpen(), false, 'prompt closed');
  eq((await state()).feedbackState, 'asked', 'marked asked');
  eq(await askNow(), false, 'never asked again');
}

console.log('\nTest 5: a review flow that never showed does NOT burn the offer');
{
  await fakeNative(false);           // Play declined to show its sheet
  await setup(READY);
  await askNow();
  await page.click('#feedback-yes');
  await page.waitForTimeout(200);
  eq((await state()).feedbackState, '', 'state left clear when nothing was shown');
  eq(await askNow(), true, 'still eligible another day');
  await page.evaluate(() => window.ChainedApp.UI.closeFeedback());
}

console.log('\nTest 6: "Not really" opens a prefilled GitHub issue, not the Store');
{
  await fakeNative(true);
  await setup(READY);
  await askNow();
  await page.click('#feedback-no');
  await page.waitForTimeout(200);
  const r = await page.evaluate(() => ({ opened: window.__opened, calls: window.__reviewCalls }));
  const url = r.opened[0] || '';
  if (/github\.com\/mayerwin\/Chained-Timers\/issues\/new/.test(url)) ok('routed to a GitHub issue');
  else bad(`unexpected destination: ${url}`);
  if (!/play\.google\.com/.test(url)) ok('never sent to the Play listing');
  else bad('negative feedback sent to the Store');
  if (/body=/.test(url) && /App\+version|App%20version/.test(url)) ok('issue body prefilled with version/device');
  else bad(`issue not prefilled: ${url}`);
  eq(r.calls, 0, 'Play review flow NOT triggered for the negative path');
  eq((await state()).feedbackState, 'declined', 'marked declined');
  eq(await askNow(), false, 'never asked again');
}

console.log('\nTest 7: dismissing snoozes once, then stops');
{
  await setup(READY);
  await askNow();
  await page.click('#feedback-sheet [data-close-sheet]');
  await page.waitForTimeout(150);
  eq((await state()).feedbackState, 'snoozed', 'first dismissal snoozes');
  eq(await askNow(), false, 'not asked again during the snooze');

  // Fast-forward past the snooze window.
  await page.evaluate((d) => window.ChainedApp.Store.setSetting('feedbackSnoozedAt', Date.now() - 100 * d), DAY);
  eq(await askNow(), true, 'one final ask after the snooze expires');
  await page.click('#feedback-sheet [data-close-sheet]');
  await page.waitForTimeout(150);
  eq((await state()).feedbackState, 'declined', 'second dismissal ends it');
  eq(await askNow(), false, 'never asked again');
}

console.log('\nTest 8: finishing a chain counts toward eligibility');
{
  const before = (await state()).chainsCompleted;
  await page.evaluate(() => window.ChainedApp.UI.showCompletion(60));
  await page.waitForTimeout(150);
  eq((await state()).chainsCompleted, before + 1, 'completion increments the counter');
  await page.evaluate(() => window.ChainedApp.UI.hideCompletion());
}

console.log(failures ? `\n❌ ${failures} assertion(s) failed` : '\n✅ all checks passed');
await browser.close();
process.exit(failures ? 1 : 0);
