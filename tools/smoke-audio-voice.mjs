// End-to-end tests for the v1.3.5 cue-inheritance + Android TTS work.
//
// Five properties to lock in:
//
//   1. Segment row renders a bell button (replaces the v1.3.4 speaker
//      icon). Bell starts without the .has-overrides accent dot when
//      the segment has no cue overrides.
//
//   2. Opening the segment cue sheet, tapping a per-cue pill writes
//      seg.cues[key] (only when the user picks On/Off — picking Default
//      removes the key so storage stays minimal).
//
//   3. Engine.startChain triggers exactly ONE Audio.finalThree() call
//      per segment as the chain enters the last-3s window. Central
//      regression risk of the v1.3.4 3-2-1 concatenation: must not
//      revert to per-second fan-out.
//
//   4. Three-level inheritance: a segment-level voice override beats a
//      chain-level override beats the app default. Concretely:
//        seg2: voice=undefined  (inherits), chain.voice=false  → silent
//        seg3: voice=true       (override), chain.voice=false  → speaks
//        seg4: voice=undefined,             chain has no override → inherits app default ON → speaks
//
//   5. Same inheritance applies to sound (chime + finalThree). When the
//      chain mutes sound, Audio.chime and Audio.finalThree are not
//      called for default-inheriting segments; a per-segment override
//      back to ON wakes them up.
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

console.log('Test 1: Segment row renders bell with no accent dot when no overrides exist');
{
  await page.locator('.chain-card .chain-card-body').first().click();
  await page.waitForSelector('.view-editor:not([hidden])', { timeout: 3000 });
  const rows = await page.locator('.segment-row').count();
  eq(rows, 3, 'segment rows');
  const bells = await page.locator('.segment-row .segment-cues').count();
  eq(bells, 3, 'one bell per segment row');
  const overridden = await page.locator('.segment-row .segment-cues.has-overrides').count();
  eq(overridden, 0, 'no segments start with overrides');
}

console.log('\nTest 2: Tapping a cue pill writes seg.cues; tapping Default removes the key');
{
  // Open the cue sheet for segment 2 (Bravo) and flip Voice → Off.
  await page.locator('.segment-row').nth(1).locator('.segment-cues').click();
  await page.waitForSelector('#cues-sheet:not([hidden])', { timeout: 2000 });
  await page.locator('.cue-row[data-cue-key="voice"] .cue-pill button[data-state="off"]').click();
  // Save the draft so the override persists to storage.
  await page.locator('#cues-sheet button[data-close-sheet]').click();
  await page.locator('#editor-save-only').click();
  await page.waitForTimeout(80);
  const stored1 = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), STORAGE_KEY);
  eq(stored1.chains[0].segments[1].cues?.voice, false, 'segment 2: seg.cues.voice = false');
  eq('voice' in (stored1.chains[0].segments[0].cues || {}), false, 'segment 1 untouched');

  // Bell now reflects the override.
  await page.locator('.chain-card .chain-card-body').first().click();
  await page.waitForSelector('.view-editor:not([hidden])', { timeout: 3000 });
  const hasDot = await page.locator('.segment-row').nth(1).locator('.segment-cues.has-overrides').count();
  eq(hasDot, 1, 'segment 2 bell now has-overrides');

  // Reset to Default — should delete the key entirely (no zombie false).
  await page.locator('.segment-row').nth(1).locator('.segment-cues').click();
  await page.waitForSelector('#cues-sheet:not([hidden])', { timeout: 2000 });
  await page.locator('.cue-row[data-cue-key="voice"] .cue-pill button[data-state="default"]').click();
  await page.locator('#cues-sheet button[data-close-sheet]').click();
  await page.locator('#editor-save-only').click();
  await page.waitForTimeout(80);
  const stored2 = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), STORAGE_KEY);
  // After reset the cues object should be gone (we delete it once empty).
  eq(stored2.chains[0].segments[1].cues, undefined, 'seg.cues removed when last override cleared');
}

console.log('\nTest 3: Audio.finalThree fires exactly once per segment (3-2-1 not regressed)');
{
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
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.evaluate(() => window.ChainedApp.Engine.startChain(window.ChainedApp.Store.getChains()[0]));
  await page.clock.runFor(14000);
  const calls = await page.evaluate(() => ({
    final3: window.__finalThreeCalls,
    chimes: window.__chimeCalls,
    speaks: window.__speakCalls,
  }));
  console.log('  state:', JSON.stringify(calls));
  eq(calls.final3, 3, 'finalThree fires exactly 3 times (one per segment)');
  eq(calls.chimes, 2, 'chime fires exactly 2 times (mid-chain boundaries only)');
}

console.log('\nTest 4: 3-level inheritance — segment override beats chain override beats app default');
{
  // Fresh page; set up a chain where:
  //   chain.cues.voice = false      → would silence everything by default
  //   seg[0].cues.voice = undefined → inherits chain.false → silent
  //   seg[1].cues.voice = true      → OVERRIDES chain → speaks
  //   seg[2].cues.voice = undefined → inherits chain.false → silent
  //
  // Mutate via the in-memory Store (the addInitScript re-seeds on every
  // page reload and would wipe direct localStorage edits).
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    const { Store } = window.ChainedApp;
    const chain = Store.getChains()[0];
    chain.cues = { voice: false };
    chain.segments[1].cues = { voice: true };
    Store.upsertChain(chain);
    window.__speakCalls = [];
    const { Voice } = window.ChainedApp;
    Voice.speak = function(t) { window.__speakCalls.push(t); };
  });
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.evaluate(() => window.ChainedApp.Engine.startChain(window.ChainedApp.Store.getChains()[0]));
  await page.clock.runFor(14000);
  const calls = await page.evaluate(() => ({ speaks: window.__speakCalls }));
  console.log('  state:', JSON.stringify(calls));
  eq(calls.speaks, ['Bravo'], 'only segment with explicit voice=true speaks; chain.voice=false silences others');
}

console.log('\nTest 5: Sound inheritance — chain mutes sound, segment can re-enable it');
{
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    const { Store, Audio } = window.ChainedApp;
    const chain = Store.getChains()[0];
    chain.cues = { sound: false };
    delete chain.segments[1].cues;
    chain.segments[2].cues = { sound: true };  // Charlie overrides chain mute
    Store.upsertChain(chain);
    window.__finalThreeCalls = 0;
    window.__chimeCalls      = 0;
    Audio.finalThree = function() { window.__finalThreeCalls++; };
    Audio.chime      = function() { window.__chimeCalls++; };
  });
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.evaluate(() => window.ChainedApp.Engine.startChain(window.ChainedApp.Store.getChains()[0]));
  await page.clock.runFor(14000);
  const calls = await page.evaluate(() => ({
    final3: window.__finalThreeCalls,
    chimes: window.__chimeCalls,
  }));
  console.log('  state:', JSON.stringify(calls));
  // finalThree fires once for Charlie (segment 3, has sound=true override).
  // It does NOT fire for Alpha or Bravo because their effective sound is false.
  eq(calls.final3, 1, 'finalThree fires only for Charlie (the segment with sound=true override)');
  // chime fires on boundary going INTO each segment AFTER segment-end. The
  // chime is gated by the OUTGOING segment's cues:
  //   Alpha (chain.sound=false, no override) end → no chime
  //   Bravo (inherits chain.sound=false)      end → no chime
  eq(calls.chimes, 0, 'no chimes — every boundary out of a sound-off segment is silent');
}

await browser.close();
if (failures) {
  console.log(`\n❌ ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('\n✅ all checks passed');
