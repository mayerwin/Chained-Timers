// v1.4.21 — cue changes while a chain is running.
//
//   A. Silencing a chain from the run view stops an alarm that is
//      ALREADY ringing at the end of it. The ring loop had captured its
//      cues when the gate opened and the foreground service was never
//      told, so the phone kept ringing. (Reported against the mute
//      button, which v1.4.22 removed — the bell is the path now.)
//   B. Turning "Ring until dismissed" off while a gate is ringing lets
//      the gate go immediately, instead of leaving the chain waiting on
//      a Dismiss the user has just said they don't want.
//   C. The cue bell in the run topbar opens the same chain cue sheet as
//      the editor, persists to the saved chain, and reaches the live run
//      (and, on native, the foreground service) on every pill tap.
//
// Run via:
//   npm run serve   # in another shell
//   node tools/smoke-run-cues.mjs

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

await page.addInitScript(({ key }) => localStorage.setItem(key, JSON.stringify({
  schemaVersion: 1,
  chains: [
    { id: 'c_ring', name: 'Ring', color: 'amber', loops: 1, hasRun: true,
      segments: [{ id: 's1', kind: 'segment', name: 'Only', duration: 1, color: 'amber',
                   cues: { ringUntilDismissed: true } }] },
    { id: 'c_long', name: 'Long', color: 'teal', loops: 1, hasRun: true,
      segments: [{ id: 'l1', kind: 'segment', name: 'One', duration: 300, color: 'teal' },
                 { id: 'l2', kind: 'segment', name: 'Two', duration: 300, color: 'teal' }] },
  ],
  settings: { sound: true, voice: false, vibrate: true, prestart: false, finalTick: false },
})), { key: STORAGE_KEY });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);

// Count alarm bursts and capture what the native bridge would be told.
await page.evaluate(() => {
  const { Audio } = window.ChainedApp;
  window.__bursts = 0;
  const real = Audio.alarmBurst.bind(Audio);
  Audio.alarmBurst = () => { window.__bursts++; return real(); };
  window.__emits = [];
  window.addEventListener('chain:fgsupdate', e => window.__emits.push(e.detail));
  window.addEventListener('chain:reschedule', e => window.__emits.push(e.detail));
});
const lastEmit = (id) => page.evaluate((runId) =>
  [...window.__emits].reverse().find(d => d.runId === runId) || null, id);
const bursts = () => page.evaluate(() => window.__bursts);

console.log('Test A: Sound cues off silences an alarm that is already ringing');
{
  // v1.4.22: this used to go through a mute button in the run topbar.
  // That button wrote the GLOBAL sound default from a transient screen,
  // so it was removed and the bell is now the one way to silence a chain
  // from the run view. The fault it exposed is the same either way: a
  // ring loop that had captured its cues when the gate opened, and a
  // foreground service nobody told.
  await page.evaluate(() => {
    const { Store, UI } = window.ChainedApp;
    UI.startRunForChain(Store.getChain('c_ring'));
  });
  await page.waitForTimeout(1600);
  eq(await page.evaluate(() => !!window.ChainedApp.Engine._focused?.awaitingDismiss), true, 'held at the gate');
  const before = await bursts();
  if (before > 0) ok(`ringing (${before} burst(s) so far)`);
  else bad('the gate is not ringing at all');

  await page.click('#run-cues-btn');
  await page.waitForTimeout(200);
  await page.click('.cue-row[data-cue-key="sound"] button[data-state="off"]');
  await page.waitForTimeout(300);
  const atMute = await bursts();
  await page.waitForTimeout(3400);              // two full burst intervals
  eq(await bursts(), atMute, 'no further bursts once sound is off');

  // The gate itself stays: silencing is not dismissing.
  eq(await page.evaluate(() => !!window.ChainedApp.Engine._focused?.awaitingDismiss), true, 'still held');
  eq(await page.evaluate(() => document.getElementById('run-dismiss-bar').hidden), false, 'Dismiss bar still shown');

  // What the foreground service would be told.
  eq((await lastEmit('c_ring'))?.soundEnabled, false, 'the service is told sound is off');

  // Back to Default brings it back.
  await page.click('.cue-row[data-cue-key="sound"] button[data-state="default"]');
  await page.waitForTimeout(1900);
  if (await bursts() > atMute) ok('ringing resumes when sound comes back');
  else bad('restoring sound did not resume the ring');
  eq((await lastEmit('c_ring'))?.soundEnabled, true, 'the service is told sound is back on');

  await page.evaluate(() => {
    document.getElementById('cues-sheet').hidden = true;
    window.ChainedApp.Engine.stopRun('c_ring');
    window.ChainedApp.UI.hideCompletion();
  });
  await page.waitForTimeout(200);
}

console.log('\nTest B: switching "Ring until dismissed" off releases a held gate');
{
  await page.evaluate(() => {
    const { Store, UI } = window.ChainedApp;
    Store.setSetting('sound', true);
    UI.hideCompletion();
    UI.startRunForChain(Store.getChain('c_ring'));
  });
  await page.waitForTimeout(1600);
  eq(await page.evaluate(() => !!window.ChainedApp.Engine._focused?.awaitingDismiss), true, 'held at the gate');

  // Off via the cue sheet, exactly as the user would: bell → Ring row → Off.
  await page.click('#run-cues-btn');
  await page.waitForTimeout(200);
  eq(await page.evaluate(() => !document.getElementById('cues-sheet').hidden), true, 'cue sheet opened from the run view');
  await page.click('.cue-row[data-cue-key="ringUntilDismissed"] button[data-state="off"]');
  await page.waitForTimeout(700);

  eq(await page.evaluate(() => window.ChainedApp.Engine.activeRuns().map(r => r.id)), [],
     'the chain finished instead of ringing on');
  eq(await page.evaluate(() => document.getElementById('run-dismiss-bar').hidden), true, 'Dismiss bar gone');
  eq(await page.evaluate(() => window.ChainedApp.Store.getChain('c_ring').cues.ringUntilDismissed), false,
     'the choice persisted to the chain');
  // The gate was held by the SEGMENT's own binary ring cue, which outranks
  // the chain. Turning the chain switch off while staring at that ringing
  // boundary clears it there too, or the switch would look inert.
  eq(await page.evaluate(() => (window.ChainedApp.Store.getChain('c_ring').segments[0].cues || {}).ringUntilDismissed),
     undefined, 'the ringing segment stopped overriding it');
  const after = await bursts();
  await page.waitForTimeout(1800);
  eq(await bursts(), after, 'and the ringing stopped');
  await page.evaluate(() => { window.ChainedApp.UI.hideCompletion(); document.getElementById('cues-sheet').hidden = true; });
}

console.log('\nTest B2: changing any OTHER cue leaves a held gate alone');
{
  // Regression: the release path is wired to the ring row only. When it
  // ran on every edit, turning Buzz cues off silently dismissed the gate
  // and ended the chain.
  await page.evaluate(() => {
    const { Store, UI } = window.ChainedApp;
    UI.hideCompletion();
    Store.upsertChain({ id: 'c_ring2', name: 'Ring2', color: 'amber', loops: 1, hasRun: true,
      segments: [{ id: 'r1', kind: 'segment', name: 'Only', duration: 1, color: 'amber',
                   cues: { ringUntilDismissed: true } },
                 { id: 'r2', kind: 'segment', name: 'After', duration: 300, color: 'teal' }] });
    UI.startRunForChain(Store.getChain('c_ring2'));
  });
  await page.waitForTimeout(1600);
  eq(await page.evaluate(() => !!window.ChainedApp.Engine._focused?.awaitingDismiss), true, 'held at the gate');
  await page.click('#run-cues-btn');
  await page.waitForTimeout(200);
  await page.click('.cue-row[data-cue-key="vibrate"] button[data-state="off"]');
  await page.waitForTimeout(600);
  eq(await page.evaluate(() => !!window.ChainedApp.Engine._focused?.awaitingDismiss), true,
     'STILL held — a buzz change must not dismiss the gate');
  eq(await page.evaluate(() => (window.ChainedApp.Store.getChain('c_ring2').segments[0].cues || {}).ringUntilDismissed),
     true, 'and the segment kept its ring cue');
  await page.evaluate(() => {
    document.getElementById('cues-sheet').hidden = true;
    window.ChainedApp.Engine.stopRun('c_ring2');
    window.ChainedApp.UI.hideCompletion();
  });
  await page.waitForTimeout(200);
}

console.log('\nTest C: the run-view bell edits the running chain');
{
  await page.evaluate(() => {
    const { Store, UI } = window.ChainedApp;
    UI.hideCompletion();
    UI.startRunForChain(Store.getChain('c_long'));
  });
  await page.waitForTimeout(500);
  eq(await page.evaluate(() => document.getElementById('run-cues-dot').hidden), true, 'no override dot on a clean chain');

  await page.click('#run-cues-btn');
  await page.waitForTimeout(200);
  await page.click('.cue-row[data-cue-key="vibrate"] button[data-state="off"]');
  await page.waitForTimeout(400);
  eq(await page.evaluate(() => window.ChainedApp.Store.getChain('c_long').cues.vibrate), false,
     'the override persisted to the stored chain');
  eq(await page.evaluate(() => (window.ChainedApp.Engine._focused.chain.cues || {}).vibrate), false,
     'the RUNNING chain sees it too (same object, no restart needed)');
  eq((await lastEmit('c_long'))?.vibrateEnabled, false, 'the service is told buzz is off');
  eq(await page.evaluate(() => document.getElementById('run-cues-dot').hidden), false, 'the bell shows an override dot');

  // Back to Default clears it again.
  await page.click('.cue-row[data-cue-key="vibrate"] button[data-state="default"]');
  await page.waitForTimeout(400);
  eq(await page.evaluate(() => (window.ChainedApp.Store.getChain('c_long').cues || {}).vibrate), undefined,
     'Default clears the override');
  eq((await lastEmit('c_long'))?.vibrateEnabled, true, 'the service is told buzz is back');
  await page.evaluate(() => { document.getElementById('cues-sheet').hidden = true; });
}

console.log('\nTest D: the run view carries no global sound switch any more');
{
  // v1.4.22 — the mute button is gone. It wrote the app-wide Sound
  // default from a screen you leave, so one tap during a workout
  // silenced every chain after it, with only an icon to say so.
  eq(await page.evaluate(() => !!document.getElementById('run-mute')), false, 'no mute button in the run view');
  eq(await page.evaluate(() => !!document.getElementById('run-cues-btn')), true, 'the cue bell is what remains');
  // Sound still has exactly one home per scope.
  eq(await page.evaluate(() => !!document.getElementById('setting-sound')), true, 'app default lives in Settings');
}

console.log('\nTest E: an App Settings cue change reaches a running chain');
{
  await page.evaluate(() => {
    const { Store, UI } = window.ChainedApp;
    UI.hideCompletion();
    Store.setSetting('vibrate', true);
    UI.startRunForChain(Store.getChain('c_long'));
  });
  await page.waitForTimeout(400);
  eq((await lastEmit('c_long'))?.vibrateEnabled, true, 'buzz on to begin with');
  await page.evaluate(() => {
    window.ChainedApp.View.show('settings');
    const el = document.getElementById('setting-vibrate');
    el.checked = false;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(400);
  eq((await lastEmit('c_long'))?.vibrateEnabled, false, 'toggling Buzz cues in Settings reaches the run');
  await page.evaluate(() => window.ChainedApp.Engine.stopRun('c_long'));
}

console.log(failures ? `\n❌ ${failures} assertion(s) failed` : '\n✅ all checks passed');
await browser.close();
process.exit(failures ? 1 : 0);
