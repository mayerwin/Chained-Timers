// v1.4.12 — run-view clock consistency regression test.
//
// User-reported: on a single-segment chain the big clock could read
// 04:36 while the bottom row said "04:35 remaining" — the clock CEILS
// the fractional remaining (so the digit flip lines up with the
// final-3 audio ticks) while the bottom row passed the raw value
// through fmt(), which ROUNDS. Locks in:
//   1. Big clock and "remaining" always agree on a single-segment
//      chain, sampled repeatedly across second boundaries.
//   2. "elapsed" + "remaining" always sum exactly to the chain total.
//
// Run via:
//   npm run serve   # in another shell
//   node tools/smoke-clock-consistency.mjs

import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:4321/';
const STORAGE_KEY = 'chained-timers/v1';

let failures = 0;
const ok  = m => console.log('  ✓', m);
const bad = m => { console.log('  ✗', m); failures++; };

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
page.on('pageerror', e   => bad('pageerror: ' + e.message));
page.on('console',   msg => { if (msg.type() === 'error') bad('console: ' + msg.text()); });

const SEED = {
  schemaVersion: 1,
  chains: [
    { id: 'c_one', name: 'Solo', color: 'amber', loops: 1,
      segments: [{ id: 's1', kind: 'segment', name: 'Hold', duration: 300, color: 'amber' }],
      createdAt: 1, updatedAt: 1, hasRun: true },
  ],
  settings: { sound: false, voice: false, vibrate: false, prestart: false, finalTick: false },
};
await page.addInitScript(({ key, seed }) => localStorage.setItem(key, JSON.stringify(seed)), { key: STORAGE_KEY, seed: SEED });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);

await page.evaluate(() => {
  const { Store, UI } = window.ChainedApp;
  UI.startRunForChain(Store.getChain('c_one'));
});
await page.waitForTimeout(400);

const toSec = (t) => {
  const p = t.trim().split(':').map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
};

console.log('Sampling clock vs bottom row across second boundaries');
let agree = 0, sums = 0, n = 0;
for (let i = 0; i < 10; i++) {
  const s = await page.evaluate(() => ({
    clock: document.getElementById('run-clock').textContent,
    remaining: document.getElementById('run-remaining').textContent.replace(' remaining', ''),
    elapsed: document.getElementById('run-elapsed').textContent.replace(' elapsed', ''),
  }));
  n++;
  const c = toSec(s.clock), r = toSec(s.remaining), e = toSec(s.elapsed);
  if (c === r) agree++;
  else bad(`sample ${i}: clock ${s.clock} != remaining ${s.remaining}`);
  if (e + r === 300) sums++;
  else bad(`sample ${i}: elapsed ${s.elapsed} + remaining ${s.remaining} != 05:00`);
  await page.waitForTimeout(330); // straddle second boundaries
}
if (agree === n) ok(`clock == remaining in all ${n} samples`);
if (sums === n)  ok(`elapsed + remaining == total in all ${n} samples`);

await page.evaluate(() => window.ChainedApp.Engine.stopRun('c_one'));

console.log(failures ? `\n❌ ${failures} assertion(s) failed` : '\n✅ all checks passed');
await browser.close();
process.exit(failures ? 1 : 0);
