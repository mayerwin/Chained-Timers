// v1.4.18 — the run clock must sit INSIDE the progress ring.
//
// History: the font was clamp(56px, 18vw, 96px), tuned for "MM:SS", so
// "HH:MM:SS" ran off the screen (v1.4.17 fixed the overflow by fitting
// to the app column). It still crossed the ring, so it is now fitted to
// the ring itself.
//
// Fitting text in a circle is a CHORD problem: the widest the text may
// be is the chord at its own height, not the diameter. This test checks
// the real geometry — every corner of the text's box must lie inside the
// ring's clear inner circle, with breathing room — for every duration
// format, on the phone widths people actually use.
//
// Run via:
//   npm run serve   # in another shell
//   node tools/smoke-clock-fit.mjs

import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:4321/';
const STORAGE_KEY = 'chained-timers/v1';

let failures = 0;
const ok  = m => console.log('  ✓', m);
const bad = m => { console.log('  ✗', m); failures++; };

// Every string the clock can render: the prestart digit, MM:SS, and the
// HH:MM:SS family up to a chain long enough to need three hour digits.
const CASES = ['3', '00:00', '09:59', '59:59', '01:00:00', '02:11:38', '23:59:59', '100:00:00'];

// Real devices, smallest first: iPhone SE, common Android, iPhone SE2/8,
// iPhone 12-15, Pixel 7, Pixel 6 Pro, iPhone Plus, iPhone Pro Max, and a
// tablet-ish width where the app column caps at 560px.
const DEVICES = [
  ['iPhone SE (1st gen)', 320, 568],
  ['Android small',       360, 640],
  ['iPhone SE2 / 8',      375, 667],
  ['iPhone 13 / 14',      390, 844],
  ['Pixel 7',             393, 852],
  ['Pixel 6 Pro',         412, 892],
  ['iPhone 8 Plus',       414, 736],
  ['iPhone 15 Pro Max',   430, 932],
  ['Tablet / desktop',    768, 1024],
];

const browser = await chromium.launch({ headless: true });

for (const [name, width, height] of DEVICES) {
  const context = await browser.newContext({
    viewport: { width, height }, isMobile: width < 700, hasTouch: width < 700,
  });
  const page = await context.newPage();
  page.on('pageerror', e => bad('pageerror: ' + e.message));
  await page.addInitScript(({ key }) => localStorage.setItem(key, JSON.stringify({
    schemaVersion: 1,
    chains: [{ id: 'c_1', name: 'Chain', color: 'amber', loops: 1, hasRun: true,
      segments: [{ id: 's1', kind: 'segment', name: 'BREAK', duration: 9000, color: 'amber' }] }],
    settings: { sound: false, voice: false, vibrate: false, prestart: false, finalTick: false },
  })), { key: STORAGE_KEY });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(250);
  await page.evaluate(() => window.ChainedApp.View.show('run'));
  await page.waitForTimeout(200);

  const results = await page.evaluate((cases) => {
    const out = [];
    const el = document.getElementById('run-clock');
    const ring = document.getElementById('run-ring-fill');
    for (const text of cases) {
      window.ChainedApp.UI._setClockText(text);
      const rr = ring.getBoundingClientRect();
      const stroke = parseFloat(getComputedStyle(ring).strokeWidth) || 0;
      const cx = rr.left + rr.width / 2;
      const cy = rr.top + rr.height / 2;
      // Clear space inside the stroke: the box is 2r + stroke wide.
      const rInner = (rr.width - 2 * stroke) / 2;
      const b = el.getBoundingClientRect();
      // Farthest corner of the text box from the ring centre.
      const dx = Math.max(Math.abs(b.left - cx), Math.abs(b.right - cx));
      const dy = Math.max(Math.abs(b.top - cy), Math.abs(b.bottom - cy));
      out.push({
        text,
        fontSize: parseFloat(getComputedStyle(el).fontSize),
        cornerDist: Math.hypot(dx, dy),
        rInner,
        clearance: rInner - Math.hypot(dx, dy),
        centreOffsetX: Math.abs((b.left + b.width / 2) - cx),
        centreOffsetY: Math.abs((b.top + b.height / 2) - cy),
        widthUse: b.width / (2 * rInner),
      });
    }
    return out;
  }, CASES);

  let inside = 0, centred = 0, worstClearance = Infinity, tightest = null;
  for (const r of results) {
    if (r.clearance >= 0) inside++;
    else bad(`${name} (${width}px) / "${r.text}": corner is ${(-r.clearance).toFixed(1)}px OUTSIDE the ring`);
    if (r.centreOffsetX < 1.5 && r.centreOffsetY < 1.5) centred++;
    else bad(`${name} (${width}px) / "${r.text}": off centre by (${r.centreOffsetX.toFixed(1)}, ${r.centreOffsetY.toFixed(1)})`);
    if (r.clearance < worstClearance) { worstClearance = r.clearance; tightest = r; }
  }
  if (inside === results.length && centred === results.length) {
    ok(`${name.padEnd(20)} ${String(width).padStart(4)}px — all ${results.length} formats inside the ring & centred `
       + `(tightest "${tightest.text}" @ ${tightest.fontSize.toFixed(0)}px, ${tightest.clearance.toFixed(1)}px clear)`);
  }

  // Spacing must be REAL, not hairline — the ask was "with small spacing".
  if (worstClearance >= 4) ok(`${name.padEnd(20)} ${String(width).padStart(4)}px — keeps ≥4px clear of the ring`);
  else bad(`${name} (${width}px): only ${worstClearance.toFixed(1)}px clearance`);

  // …but it should still be reasonably large, not timid.
  const longest = results.find(r => r.text === '100:00:00');
  if (longest.widthUse > 0.7) ok(`${name.padEnd(20)} ${String(width).padStart(4)}px — longest fills ${(longest.widthUse * 100).toFixed(0)}% of the ring width`);
  else bad(`${name} (${width}px): longest string only fills ${(longest.widthUse * 100).toFixed(0)}% of the ring`);

  await context.close();
}

// Rotation changes the ring size; the clock must refit rather than keep
// a stale size computed for the old width.
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', e => bad('pageerror: ' + e.message));
  await page.addInitScript(({ key }) => localStorage.setItem(key, JSON.stringify({
    schemaVersion: 1,
    chains: [{ id: 'c_1', name: 'Chain', color: 'amber', loops: 1, hasRun: true,
      segments: [{ id: 's1', kind: 'segment', name: 'BREAK', duration: 9000, color: 'amber' }] }],
    settings: { sound: false, voice: false, vibrate: false, prestart: false, finalTick: false },
  })), { key: STORAGE_KEY });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    window.ChainedApp.View.show('run');
    window.ChainedApp.UI._setClockText('02:11:38');
  });
  await page.waitForTimeout(150);
  const before = await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('run-clock')).fontSize));
  await page.setViewportSize({ width: 844, height: 390 });   // rotate
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => {
    const el = document.getElementById('run-clock');
    const ring = document.getElementById('run-ring-fill');
    const rr = ring.getBoundingClientRect();
    const stroke = parseFloat(getComputedStyle(ring).strokeWidth) || 0;
    const cx = rr.left + rr.width / 2, cy = rr.top + rr.height / 2;
    const rInner = (rr.width - 2 * stroke) / 2;
    const b = el.getBoundingClientRect();
    const dx = Math.max(Math.abs(b.left - cx), Math.abs(b.right - cx));
    const dy = Math.max(Math.abs(b.top - cy), Math.abs(b.bottom - cy));
    return { fontSize: parseFloat(getComputedStyle(el).fontSize), clearance: rInner - Math.hypot(dx, dy) };
  });
  if (after.clearance >= 0) ok(`after rotation still inside the ring (${before.toFixed(0)}px → ${after.fontSize.toFixed(0)}px, ${after.clearance.toFixed(1)}px clear)`);
  else bad(`after rotation the clock is ${(-after.clearance).toFixed(1)}px outside the ring`);
  await context.close();
}

// The reported case, on a real run rather than an injected string.
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', e => bad('pageerror: ' + e.message));
  await page.addInitScript(({ key }) => localStorage.setItem(key, JSON.stringify({
    schemaVersion: 1,
    chains: [{ id: 'c_long', name: 'HANGING', color: 'amber', loops: 1, hasRun: true,
      segments: [{ id: 's1', kind: 'segment', name: 'BREAK', duration: 9000, color: 'amber' }] }],
    settings: { sound: false, voice: false, vibrate: false, prestart: false, finalTick: false },
  })), { key: STORAGE_KEY });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    const { Store, UI } = window.ChainedApp;
    UI.startRunForChain(Store.getChain('c_long'));
  });
  await page.waitForTimeout(700);
  const r = await page.evaluate(() => {
    const el = document.getElementById('run-clock');
    const ring = document.getElementById('run-ring-fill');
    const rr = ring.getBoundingClientRect();
    const stroke = parseFloat(getComputedStyle(ring).strokeWidth) || 0;
    const cx = rr.left + rr.width / 2, cy = rr.top + rr.height / 2;
    const rInner = (rr.width - 2 * stroke) / 2;
    const b = el.getBoundingClientRect();
    const dx = Math.max(Math.abs(b.left - cx), Math.abs(b.right - cx));
    const dy = Math.max(Math.abs(b.top - cy), Math.abs(b.bottom - cy));
    return { text: el.textContent, clearance: rInner - Math.hypot(dx, dy),
             fontSize: parseFloat(getComputedStyle(el).fontSize) };
  });
  if (/^\d{2}:\d{2}:\d{2}$/.test(r.text) && r.clearance >= 0) {
    ok(`live HH:MM:SS run sits inside the ring ("${r.text}" @ ${r.fontSize.toFixed(0)}px, ${r.clearance.toFixed(1)}px clear)`);
  } else {
    bad(`live run: "${r.text}", clearance ${r.clearance.toFixed(1)}px`);
  }
  await context.close();
}

console.log(failures ? `\n❌ ${failures} assertion(s) failed` : '\n✅ all checks passed');
await browser.close();
process.exit(failures ? 1 : 0);
