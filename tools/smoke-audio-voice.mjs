// End-to-end tests for the v1.3.4 audio + voice changes.
//
// Three properties to lock in:
//
//   1. Per-segment TTS toggle persists, surfaces .is-off CSS, and stores
//      seg.voice only when explicitly OFF (legacy chains with no field
//      stay ON by default).
//
//   2. Engine.startChain triggers exactly ONE Audio.finalThree() call
//      per segment as the chain enters the last-3s window — never three
//      independent calls, never zero, never repeats inside the same
//      segment. This is the central regression risk of the 3-2-1 fix.
//
//   3. Voice.speak fires on segment advance ONLY when both the global
//      voice setting AND the per-segment seg.voice !== false are true.
//      A toggled-off segment must produce zero speak() calls for its
//      own announcement.
//
// Run via:
//   npm run serve   # in another shell
//   node tools/smoke-audio-voice.mjs

import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:4321/';
const STORAGE_KEY = 'chained-timers/v1';

let failures = 0;
function ok(msg)  { console.log('  ✓', msg); }
function bad(msg) { console.log('  ✗', msg); failures++; }
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(`${label} = ${a}`);
  else         bad(`${label} expected ${e} got ${a}`);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
page.on('pageerror', e   => bad('pageerror: ' + e.message));
page.on('console',   msg => { if (msg.type() === 'error') bad('console: ' + msg.text()); });

// Seed a known chain so we can deterministically open the editor and
// run it. Three 4-second segments: short enough to reach the 3-2-1 window
// within seconds of fake-time advancement, long enough that the engine
// actually walks past several boundaries.
const SEED = {
  schemaVersion: 1,
  chains: [{
    id: 'c_test', name: 'Test', color: 'amber', loops: 1,
    segments: [
      { id: 's1', kind: 'segment', name: 'Alpha',   duration: 4, color: 'amber' },
      { id: 's2', kind: 'segment', name: 'Bravo',   duration: 4, color: 'rust'  },
      { id: 's3', kind: 'segment', name: 'Charlie', duration: 4, color: 'sage'  },
    ],
    createdAt: 1700000000000, updatedAt: 1700000000000,
  }],
  settings: {
    sound: true, voice: true, vibrate: false, prestart: false,
    finalTick: true,
  },
};
await page.addInitScript(({ key, seed }) => {
  localStorage.setItem(key, JSON.stringify(seed));
}, { key: STORAGE_KEY, seed: SEED });

await page.goto(URL, { waitUntil: 'networkidle' });

console.log('Test 1: SpeechSynthesis-supported env shows the per-segment speaker button');
{
  // Enter the editor via the chain card body (NOT the play button).
  await page.locator('.chain-card .chain-card-body').first().click();
  await page.waitForSelector('.view-editor:not([hidden])', { timeout: 3000 });
  const rows = await page.locator('.segment-row').count();
  eq(rows, 3, 'segment rows');
  const voiceButtons = await page.locator('.segment-voice').count();
  eq(voiceButtons, 3, 'voice buttons rendered (1 per segment)');
  const initialOff = await page.locator('.segment-voice.is-off').count();
  eq(initialOff, 0, 'all voice buttons start ON (no .is-off)');
}

console.log('\nTest 2: Toggling the speaker button surfaces .is-off and persists seg.voice = false');
{
  await page.locator('.segment-row').nth(1).locator('.segment-voice').click();
  const offState = await page.locator('.segment-row').nth(1).locator('.segment-voice.is-off').count();
  eq(offState, 1, 'segment 2 voice button now .is-off');

  // Save via the explicit footer button (id="editor-save" — there's also
  // a "Save & start" button, so we must target the plain Save by id).
  await page.locator('#editor-save-only').click();
  await page.waitForTimeout(80);
  const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), STORAGE_KEY);
  const segs = stored.chains[0].segments;
  eq(segs[1].voice, false, 'seg.voice persisted as false on segment 2');
  eq('voice' in segs[0], false, 'segment 1 has no voice key (= default ON)');
  eq('voice' in segs[2], false, 'segment 3 has no voice key (= default ON)');
}

console.log('\nTest 3: Re-toggling segment 2 back ON deletes the seg.voice key (no zombie false)');
{
  await page.locator('.chain-card .chain-card-body').first().click();
  await page.waitForSelector('.view-editor:not([hidden])', { timeout: 3000 });
  const restoredOff = await page.locator('.segment-row').nth(1).locator('.segment-voice.is-off').count();
  eq(restoredOff, 1, 'segment 2 button restored as OFF from storage');
  await page.locator('.segment-row').nth(1).locator('.segment-voice').click();
  const flippedOn = await page.locator('.segment-row').nth(1).locator('.segment-voice.is-off').count();
  eq(flippedOn, 0, 'segment 2 button flipped back to ON');
  await page.locator('#editor-save-only').click();
  await page.waitForTimeout(80);
  const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), STORAGE_KEY);
  eq('voice' in stored.chains[0].segments[1], false, 'seg.voice key deleted (back to default ON)');
}

console.log('\nTest 4: Engine fires Audio.finalThree exactly once per segment in the last-3s window');
{
  // Hard-reset the page so the spies install cleanly under a fresh load.
  // The ChainedApp namespace is exposed by app.js after the IIFE so it's
  // reachable from page.evaluate.
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    if (!window.ChainedApp) throw new Error('ChainedApp namespace missing — test hatch not loaded');
    window.__finalThreeCalls = 0;
    window.__chimeCalls      = 0;
    window.__speakCalls      = [];
    const { Audio, Voice } = window.ChainedApp;
    const origFinalThree = Audio.finalThree.bind(Audio);
    Audio.finalThree = function() { window.__finalThreeCalls++; origFinalThree(); };
    const origChime = Audio.chime.bind(Audio);
    Audio.chime = function() { window.__chimeCalls++; origChime(); };
    const origSpeak = Voice.speak.bind(Voice);
    Voice.speak = function(t) { window.__speakCalls.push(t); origSpeak(t); };
  });

  // Mark segment 2 OFF for voice via Store before starting.
  await page.evaluate(() => {
    const { Store } = window.ChainedApp;
    const chain = Store.getChains()[0];
    chain.segments[1].voice = false;
    Store.upsertChain(chain);
  });

  // Start the chain via the public Engine API. The rAF loop reads
  // Date.now() for elapsed-time math; we use Playwright's clock.install
  // to advance synthetic wall-clock through the whole 12s chain.
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.evaluate(() => window.ChainedApp.Engine.startChain(window.ChainedApp.Store.getChains()[0]));
  // 3 segments × 4 seconds = 12 seconds of chain. Run 14s to land past the
  // chain-complete cue so we capture the full sequence.
  await page.clock.runFor(14000);

  const calls = await page.evaluate(() => ({
    final3:  window.__finalThreeCalls,
    chimes:  window.__chimeCalls,
    speaks:  window.__speakCalls,
    running: window.ChainedApp.Engine.isRunning,
    idx:     window.ChainedApp.Engine.currentIndex,
  }));
  console.log('  state:', JSON.stringify(calls));
  eq(calls.final3, 3, 'Audio.finalThree fired once per segment');
  eq(calls.chimes, 2, 'Audio.chime fired on each mid-chain boundary');
  // Voice.speak fires on:
  //   chain start    : opening segment "Alpha" (default voice ON)
  //   seg 1 → seg 2  : suppressed by seg.voice = false on segment 2 (Bravo silent)
  //   seg 2 → seg 3  : default ON → "Charlie"
  eq(calls.speaks, ['Alpha', 'Charlie'], 'Voice.speak gated by per-segment seg.voice flag (Bravo suppressed)');
}

await browser.close();
if (failures) {
  console.log(`\n❌ ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('\n✅ all checks passed');
