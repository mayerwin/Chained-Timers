// Verifies v1.4.11 inline prestart: starting chain B while chain A runs
// now counts down 3-2-1 inline (clock area + pending chip) instead of
// being skipped, while the single-chain full-screen overlay is unchanged.
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

const SEED = {
  schemaVersion: 1,
  chains: [
    { id: 'c_a', name: 'Alpha', color: 'amber', loops: 1,
      segments: [{ id: 'a1', kind: 'segment', name: 'A-One', duration: 120, color: 'amber' }],
      createdAt: 1700000000000, updatedAt: 1700000000000 },
    { id: 'c_b', name: 'Bravo', color: 'teal', loops: 1,
      segments: [{ id: 'b1', kind: 'segment', name: 'B-One', duration: 90, color: 'teal' }],
      createdAt: 1700000000000, updatedAt: 1700000000000 },
    { id: 'c_c', name: 'Charlie', color: 'violet', loops: 1,
      segments: [{ id: 'c1', kind: 'segment', name: 'C-One', duration: 60, color: 'violet' }],
      createdAt: 1700000000000, updatedAt: 1700000000000 },
  ],
  // prestart ON (the cue under test); sound/voice/vibrate off to keep audio quiet
  settings: { sound: false, voice: false, vibrate: false, prestart: true, finalTick: false },
};
await page.addInitScript(({ key, seed }) => localStorage.setItem(key, JSON.stringify(seed)), { key: STORAGE_KEY, seed: SEED });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);

const snap = () => page.evaluate(() => {
  const { Engine, UI } = window.ChainedApp;
  const g = id => document.getElementById(id);
  return {
    view: document.body.dataset.view,
    overlayHidden: g('run-prestart').hidden,
    clock: g('run-clock').textContent,
    clockPrestart: g('run-clock').classList.contains('is-prestart'),
    tag: g('run-segment-tag').textContent,
    segName: g('run-segment-name').textContent,
    chipsHidden: g('run-chips').hidden,
    chipCount: g('run-chips').children.length,
    chipTexts: [...g('run-chips').children].map(c => c.textContent),
    pendingChipClock: g('run-chip-pending-clock')?.textContent ?? null,
    running: Engine.activeRuns().map(r => r.id).sort(),
    focused: Engine.focusedRunId(),
    pending: UI.prestartPendingChain?.id ?? null,
    yielded: UI.prestartYielded,
  };
});

console.log('Test 1: single-chain start still uses the full-screen overlay');
{
  await page.evaluate(() => {
    const { Store, UI } = window.ChainedApp;
    UI.startRunForChain(Store.getChain('c_a'));
  });
  await page.waitForTimeout(150);
  const s = await snap();
  eq(s.view, 'run', 'on run view');
  eq(s.overlayHidden, false, 'overlay shown');
  eq(s.clockPrestart, false, 'no inline class on clock');
  eq(s.chipsHidden, true, 'chip strip hidden');
  eq(s.pending, null, 'no inline pending state');
  await page.waitForTimeout(3200);
  const s2 = await snap();
  eq(s2.overlayHidden, true, 'overlay gone after countdown');
  eq(s2.running, ['c_a'], 'Alpha running');
  eq(s2.focused, 'c_a', 'Alpha focused');
}

console.log('\nTest 2: starting Bravo while Alpha runs → inline countdown, chips visible');
{
  await page.evaluate(() => {
    const { Store, UI } = window.ChainedApp;
    UI.startRunForChain(Store.getChain('c_b'));
  });
  await page.waitForTimeout(200);
  const s = await snap();
  eq(s.overlayHidden, true, 'full-screen overlay NOT used');
  eq(s.pending, 'c_b', 'Bravo pending inline');
  eq(s.clock, '3', 'clock shows countdown digit');
  eq(s.clockPrestart, true, 'clock has is-prestart class');
  eq(s.tag, 'Get ready', 'eyebrow says Get ready');
  eq(s.segName, 'B-One', 'preview shows Bravo segment');
  eq(s.chipsHidden, false, 'chip strip visible during countdown');
  eq(s.chipCount, 2, 'Alpha chip + pending Bravo chip');
  const digitAt1s = await page.evaluate(() => document.getElementById('run-clock').textContent);
  await page.waitForTimeout(1100);
  const s1 = await snap();
  if (Number(s1.clock) < Number(digitAt1s)) ok(`countdown ticking (${digitAt1s} → ${s1.clock})`);
  else bad(`countdown not ticking (${digitAt1s} → ${s1.clock})`);
  await page.waitForTimeout(2600);
  const s2 = await snap();
  eq(s2.running, ['c_a', 'c_b'], 'both chains running after countdown');
  eq(s2.focused, 'c_b', 'Bravo focused (user stayed on preview)');
  eq(s2.pending, null, 'pending state cleared');
  eq(s2.clockPrestart, false, 'is-prestart class removed');
  eq(s2.chipCount, 2, 'two real chips');
  eq(s2.chipsHidden, false, 'chip strip still visible');
  const clockIsTime = /^\d{2}:\d{2}$/.test(s2.clock);
  clockIsTime ? ok(`clock back to time (${s2.clock})`) : bad(`clock not a time: ${s2.clock}`);
}

console.log('\nTest 3: X during inline countdown aborts the launch, keeps running chain');
{
  await page.evaluate(() => window.ChainedApp.Engine.stopRun('c_b'));
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const { Store, UI } = window.ChainedApp;
    UI.startRunForChain(Store.getChain('c_c'));
  });
  await page.waitForTimeout(200);
  const before = await snap();
  eq(before.pending, 'c_c', 'Charlie pending');
  await page.click('#run-stop');
  await page.waitForTimeout(200);
  const s = await snap();
  eq(s.pending, null, 'pending aborted');
  eq(s.running, ['c_a'], 'Charlie never started, Alpha untouched');
  eq(s.view, 'run', 'stayed on run view');
  eq(s.segName, 'A-One', 'view shows Alpha again');
  await page.waitForTimeout(3300);
  const s2 = await snap();
  eq(s2.running, ['c_a'], 'no ghost start after abort');
}

console.log('\nTest 4: tapping the running chip mid-countdown yields — pending starts in background');
{
  await page.evaluate(() => {
    const { Store, UI } = window.ChainedApp;
    UI.startRunForChain(Store.getChain('c_c'));
  });
  await page.waitForTimeout(200);
  // tap Alpha's chip (the non-pending one)
  await page.click('#run-chips .run-chip:not(.is-pending)');
  await page.waitForTimeout(150);
  const s = await snap();
  eq(s.yielded, true, 'yielded');
  eq(s.segName, 'A-One', 'view back on Alpha');
  eq(s.chipCount, 2, 'pending chip still listed');
  await page.waitForTimeout(3300);
  const s2 = await snap();
  eq(s2.running, ['c_a', 'c_c'], 'Charlie started in background');
  eq(s2.focused, 'c_a', 'focus stayed on Alpha');
  eq(s2.segName, 'A-One', 'view still Alpha');
}

console.log(failures ? `\n❌ ${failures} assertion(s) failed` : '\n✅ all checks passed');
await browser.close();
process.exit(failures ? 1 : 0);
