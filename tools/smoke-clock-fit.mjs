// v1.4.17 — the run clock must fit the screen at every duration.
//
// The bug: font-size was clamp(56px, 18vw, 96px), tuned for "MM:SS". As
// soon as a chain ran past an hour the string became "HH:MM:SS" and ran
// off the right edge (reported at 02:11:38 on a 921px-wide phone).
//
// Asserted here, across viewport widths and string lengths:
//   • never wider than the app column minus its gutters,
//   • horizontally centred within the app column,
//   • as large as it can be without overflowing (it USES the space),
//   • one line, never wrapped.
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

const browser = await chromium.launch({ headless: true });

// Every format the clock can actually render, shortest to longest.
const CASES = ['3', '00:00', '09:59', '59:59', '01:00:00', '02:11:38', '23:59:59', '100:00:00'];
const WIDTHS = [320, 360, 390, 412, 480, 768, 1280];

for (const width of WIDTHS) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 700, hasTouch: width < 700 });
  const page = await context.newPage();
  page.on('pageerror', e => bad('pageerror: ' + e.message));
  await page.addInitScript(({ key }) => localStorage.setItem(key, JSON.stringify({
    schemaVersion: 1,
    chains: [{ id: 'c_1', name: 'Chain', color: 'amber', loops: 1, hasRun: true,
      segments: [{ id: 's1', kind: 'segment', name: 'DRAPS', duration: 9000, color: 'amber' }] }],
    settings: { sound: false, voice: false, vibrate: false, prestart: false, finalTick: false },
  })), { key: STORAGE_KEY });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(250);
  await page.evaluate(() => { window.ChainedApp.View.show('run'); });
  await page.waitForTimeout(150);

  const results = await page.evaluate((cases) => {
    const out = [];
    const app = document.querySelector('.app');
    const el = document.getElementById('run-clock');
    const appBox = app.getBoundingClientRect();
    for (const text of cases) {
      window.ChainedApp.UI._setClockText(text);
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const gutter = parseFloat(cs.getPropertyValue('--clock-gutter')) || 20;
      out.push({
        text,
        width: r.width,
        fontSize: parseFloat(cs.fontSize),
        lineHeightPx: r.height,
        // Centre of the clock vs centre of the app column.
        centreOffset: Math.abs((r.left + r.width / 2) - (appBox.left + appBox.width / 2)),
        available: appBox.width - 2 * gutter,
        overflowsLeft: r.left < appBox.left,
        overflowsRight: r.right > appBox.right,
        chars: cs.getPropertyValue('--clock-chars').trim(),
        whiteSpace: cs.whiteSpace,
      });
    }
    return out;
  }, CASES);

  let widthBad = 0, centreBad = 0, wrapBad = 0, charsBad = 0, slack = [];
  for (const r of results) {
    if (r.width > r.available + 1) { widthBad++; bad(`${width}px / "${r.text}": ${Math.round(r.width)}px > ${Math.round(r.available)}px available`); }
    if (r.overflowsLeft || r.overflowsRight) { widthBad++; bad(`${width}px / "${r.text}": spills outside the app column`); }
    if (r.centreOffset > 1.5) { centreBad++; bad(`${width}px / "${r.text}": off-centre by ${r.centreOffset.toFixed(1)}px`); }
    if (r.whiteSpace !== 'nowrap') { wrapBad++; bad(`${width}px / "${r.text}": whiteSpace=${r.whiteSpace}`); }
    if (r.chars !== String(r.text.length)) { charsBad++; bad(`${width}px / "${r.text}": --clock-chars=${r.chars}`); }
    slack.push(r.available - r.width);
  }
  if (!widthBad)  ok(`${String(width).padStart(4)}px — all ${CASES.length} formats fit inside the column`);
  if (!centreBad) ok(`${String(width).padStart(4)}px — all centred`);
  if (!wrapBad && !charsBad) ok(`${String(width).padStart(4)}px — single line, char count tracked`);

  // "Uses the space": the longest string should either be near the cap
  // (96px) or come close to filling the available width.
  const longest = results.find(r => r.text === '100:00:00');
  const fill = longest.width / longest.available;
  if (longest.fontSize >= 95.5 || fill > 0.9) {
    ok(`${String(width).padStart(4)}px — longest string fills ${(fill * 100).toFixed(0)}% of the width @ ${longest.fontSize.toFixed(0)}px`);
  } else {
    bad(`${width}px: longest string only fills ${(fill * 100).toFixed(0)}% @ ${longest.fontSize.toFixed(0)}px`);
  }
  await context.close();
}

// The reported case end to end: a real run past an hour.
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', e => bad('pageerror: ' + e.message));
  await page.addInitScript(({ key }) => localStorage.setItem(key, JSON.stringify({
    schemaVersion: 1,
    chains: [{ id: 'c_long', name: 'Chain', color: 'amber', loops: 1, hasRun: true,
      segments: [{ id: 's1', kind: 'segment', name: 'DRAPS', duration: 9000, color: 'amber' }] }],
    settings: { sound: false, voice: false, vibrate: false, prestart: false, finalTick: false },
  })), { key: STORAGE_KEY });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    const { Store, UI } = window.ChainedApp;
    UI.startRunForChain(Store.getChain('c_long'));
  });
  await page.waitForTimeout(600);
  const r = await page.evaluate(() => {
    const el = document.getElementById('run-clock');
    const app = document.querySelector('.app').getBoundingClientRect();
    const b = el.getBoundingClientRect();
    return { text: el.textContent, fits: b.left >= app.left && b.right <= app.right,
             fontSize: parseFloat(getComputedStyle(el).fontSize) };
  });
  if (/^\d{2}:\d{2}:\d{2}$/.test(r.text)) ok(`live run shows an HH:MM:SS clock ("${r.text}")`);
  else bad(`unexpected clock text: ${r.text}`);
  if (r.fits) ok(`the reported overflow case now fits @ ${r.fontSize.toFixed(0)}px`);
  else bad('still overflowing on a real run');
  await context.close();
}

console.log(failures ? `\n❌ ${failures} assertion(s) failed` : '\n✅ all checks passed');
await browser.close();
process.exit(failures ? 1 : 0);
