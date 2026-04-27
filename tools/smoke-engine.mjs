// Regression test for the wall-clock catchup logic.
//
// Reproduces the bug from the user report: while the app is backgrounded
// the Capacitor Android WebView pauses JS timers + frame callbacks, so
// performance.now() can't drive the engine. We validate that the engine
// (a) advances solely from Date.now() math, (b) walks past every segment
// whose duration elapsed during the freeze, and (c) restores correctly
// from a persisted run state after a simulated WebView kill.

import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:4321/';

let failures = 0;
function ok(msg)  { console.log('  ✓', msg); }
function bad(msg) { console.log('  ✗', msg); failures++; }
function eq(actual, expected, label) {
  if (actual === expected) ok(`${label} = ${actual}`);
  else                     bad(`${label} expected ${expected} got ${actual}`);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
page.on('pageerror',  e   => bad('pageerror: ' + e.message));
page.on('console',    msg => { if (msg.type() === 'error') bad('console: ' + msg.text()); });

await page.addInitScript(() => {
  const seed = {
    schemaVersion: 1,
    chains: [{
      id: 'c_test', name: 'Test', color: 'amber', loops: 1,
      segments: [
        { id: 's1', kind: 'segment', name: 'S1', duration: 60, color: 'amber' },
        { id: 's2', kind: 'segment', name: 'S2', duration: 60, color: 'rust'  },
        { id: 's3', kind: 'segment', name: 'S3', duration: 60, color: 'sage'  },
        { id: 's4', kind: 'segment', name: 'S4', duration: 60, color: 'violet' },
        { id: 's5', kind: 'segment', name: 'S5', duration: 60, color: 'teal'  },
      ],
      createdAt: Date.now(), updatedAt: Date.now(),
    }],
    settings: { sound: false, voice: false, vibrate: false, wake: false, prestart: false, finalTick: false, notifsAsked: false },
  };
  localStorage.setItem('chained-timers/v1', JSON.stringify(seed));
});

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);

// Expose the Engine for the test harness — the IIFE keeps it module-scoped.
await page.evaluate(() => {
  // The Engine is closure-private; reach it via the click handler's
  // closure isn't possible. Instead drive everything through the public
  // start path and hook the engine via the run-toggle/run-next-btn.
});

// ============================================================
// Test 1: catch-up across multiple segments
// ============================================================
console.log('\nTest 1: background freeze must catch up multiple segments');

// Start the chain (no prestart, no audio).
await page.click('.chain-card:nth-child(1) .chain-card-play');
await page.waitForTimeout(200);

// Pull engine state via DOM queries on the run view.
const initial = await page.evaluate(() => ({
  running: !document.querySelector('.view-run').hidden,
  segText: document.getElementById('run-segment-tag')?.textContent,
  posText: document.getElementById('run-chain-pos')?.textContent,
}));
eq(initial.running,  true,        'run view visible');
eq(initial.segText,  'Segment 1', 'starts on segment 1');

// Simulate a 3-minute background freeze: we can't actually freeze
// performance.now without a debugger, but we *can* roll the engine's
// segmentStartedAtWall back by 3 minutes and trigger a visibilitychange
// — that exercises the same code path the real bug hit.
//
// 3 minutes = 180s. With 60s segments, the engine should catch up to
// segment 4 (index 3) with 0s elapsed and walk into 60s of segment 4 …
// actually 180s consumes segments 1, 2, 3 fully → currentIndex 3, 0s
// into segment 4 (at the boundary). Engine may or may not advance into
// segment 4 depending on rounding; we accept either index 3 or 2 if the
// boundary is on edge. Use 200s instead so we land cleanly mid-segment 4.
await page.evaluate(() => {
  // The engine instance is closure-scoped. We modify wall-clock state
  // by accessing it through a known global side-effect: the persistence
  // payload. Easier path: tweak Date.now via a clock shim.
  const SHIFT_MS = 200_000;
  const realDateNow = Date.now;
  Date.now = () => realDateNow() + SHIFT_MS;
  // Trigger the visibility refresh that the app installs on load.
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event('focus'));
});
await page.waitForTimeout(300);

const afterCatchup = await page.evaluate(() => ({
  segText: document.getElementById('run-segment-tag')?.textContent,
  posText: document.getElementById('run-chain-pos')?.textContent,
  running: !document.querySelector('.view-run').hidden,
}));
// 200s elapsed → segments 1, 2, 3 done; ~20s into segment 4.
eq(afterCatchup.segText, 'Segment 4', 'caught up to segment 4');
eq(afterCatchup.posText, '4 / 5',     'position 4/5');
eq(afterCatchup.running, true,        'still running');

// ============================================================
// Test 2: persistence — kill and restore should land on right segment
// ============================================================
console.log('\nTest 2: persisted run state restores after a "WebView kill"');

// Reset Date.now shim so the persisted state is a "now" snapshot.
await page.evaluate(() => {
  // Re-wrap: keep the cumulative shift so the snapshot reflects the
  // shifted clock — i.e., the prior session "started" 200s ago.
});
// Snapshot the engine state to localStorage (the engine persists on
// every advance; advance one more time to trigger persistence).
await page.evaluate(() => {
  document.getElementById('run-next-btn').click();   // skip → forces _persist
});
await page.waitForTimeout(150);

// "Kill" the WebView: blow away in-memory state by reloading the page.
// The persisted run state in localStorage should resurrect the run.
// Add another 60s shift so segment 5 is also exhausted on restore.
await page.evaluate(() => {
  // Persist the shift across reload so init's restore sees a stale
  // segmentStartedAtWall — which is exactly what would happen after a
  // real activity kill where the user comes back 4 minutes later.
  sessionStorage.setItem('test-clock-shift', '260000');
});
await page.addInitScript(() => {
  const shift = parseInt(sessionStorage.getItem('test-clock-shift') || '0', 10);
  if (shift) {
    const real = Date.now;
    Date.now = () => real() + shift;
  }
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(500);

const afterRestore = await page.evaluate(() => ({
  visible: document.body.dataset.view,
  runHidden: document.querySelector('.view-run')?.hidden,
  segText: document.getElementById('run-segment-tag')?.textContent,
  posText: document.getElementById('run-chain-pos')?.textContent,
  // If chain completed during the catch-up, completion overlay is in DOM
  // but visually hidden by run view's hidden state.
  completeShown: !document.getElementById('run-complete')?.hidden,
}));
console.log('  state after restore:', afterRestore);
// 260s total elapsed — at minimum segments 1-4 are done. The skip during
// test 1 advanced us past segment 4 with 0s elapsed in segment 5; an
// additional 60s shift should land us at chain end.
// We accept either: chain complete (back on library) or running on seg 5.
if (afterRestore.runHidden && afterRestore.visible === 'library') {
  ok('chain completed during restore catch-up');
  // Catchup completion must NOT unhide the completion overlay, otherwise
  // it'd flash on the next chain run.
  eq(afterRestore.completeShown, false, 'completion overlay stays hidden after catchup-complete');
} else if (afterRestore.segText === 'Segment 5') {
  ok('restored on segment 5');
} else {
  bad(`unexpected restore state: ${JSON.stringify(afterRestore)}`);
}

// ============================================================
// Test 3: paused state survives a reload
// ============================================================
console.log('\nTest 3: paused state survives a reload');
await page.evaluate(() => {
  sessionStorage.removeItem('test-clock-shift');
  localStorage.removeItem('chained-timers/run/v1');
  Date.now = (function () { const r = Date.now; return () => r.call(Date); })();
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(300);

await page.click('.chain-card:nth-child(1) .chain-card-play');
await page.waitForTimeout(200);
await page.click('#run-toggle');     // pause
await page.waitForTimeout(200);

const pausedBefore = await page.evaluate(() => {
  const raw = localStorage.getItem('chained-timers/run/v1');
  return raw ? JSON.parse(raw).isPaused : null;
});
eq(pausedBefore, true, 'paused state persisted');

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(400);

const pausedAfter = await page.evaluate(() => ({
  view: document.body.dataset.view,
  paused: document.querySelector('.view-run')?.classList.contains('is-paused'),
  segText: document.getElementById('run-segment-tag')?.textContent,
}));
eq(pausedAfter.view,    'run',        'restored to run view');
eq(pausedAfter.paused,  true,         'still paused after reload');
eq(pausedAfter.segText, 'Segment 1',  'still on segment 1');

await browser.close();

console.log('\n' + (failures ? `❌ ${failures} failure(s)` : '✅ all checks passed'));
process.exit(failures ? 1 : 0);
