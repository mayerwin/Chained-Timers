// v1.4.13 — two small UX fixes.
//
//   A. Web speech speaks in the USER's language. An utterance with no
//      `lang` inherits the document's (<html lang="en">), so every PWA
//      user got an English voice regardless of their browser language —
//      non-English segment names were mispronounced. Native Android has
//      always followed the device TTS locale (verified on-device by
//      swapping the system locale: same text synthesised to different
//      audio), so this is the web path catching up.
//   B. First-run pointer at the duration control in the editor.
//
// Run via:
//   npm run serve   # in another shell
//   node tools/smoke-voice-lang-hint.mjs

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

// ---------------------------------------------------------------- A
// Drive the app in a French-locale context and capture what language
// the utterance actually carries.
async function spokenLangFor(locale) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale,
  });
  const page = await context.newPage();
  page.on('pageerror', e => bad('pageerror: ' + e.message));
  // Stub the speech API before app code runs so nothing depends on the
  // headless browser actually having voices installed.
  await page.addInitScript(() => {
    window.__spoken = [];
    class FakeUtterance {
      constructor(text) { this.text = text; this.lang = ''; }
    }
    window.SpeechSynthesisUtterance = FakeUtterance;
    // speechSynthesis is a read-only accessor on window — a plain
    // assignment silently no-ops and the real API keeps being used, so
    // define over it.
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        speak: (u) => window.__spoken.push({ text: u.text, lang: u.lang }),
        cancel: () => {},
        getVoices: () => [],
        addEventListener: () => {},
      },
    });
  });
  await page.addInitScript(({ key }) => localStorage.setItem(key, JSON.stringify({
    schemaVersion: 1,
    chains: [{ id: 'c_fr', name: 'Souffle', color: 'amber', loops: 1, hasRun: true,
      segments: [{ id: 's1', kind: 'segment', name: 'Respiration profonde', duration: 60, color: 'amber' }] }],
    settings: { sound: false, voice: true, vibrate: false, prestart: false, finalTick: false },
  })), { key: STORAGE_KEY });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const { Store, Engine } = window.ChainedApp;
    Engine.startChain(Store.getChain('c_fr'));
  });
  await page.waitForTimeout(400);
  const out = await page.evaluate(() => ({
    spoken: window.__spoken,
    navLang: navigator.language,
    docLang: document.documentElement.lang,
    preferred: window.ChainedApp.Voice.preferredLang(),
  }));
  await context.close();
  return out;
}

console.log('Test A: web speech follows the browser language, not <html lang>');
{
  const fr = await spokenLangFor('fr-FR');
  eq(fr.docLang, 'en', 'document still declares lang=en (UI is English)');
  eq(fr.navLang, 'fr-FR', 'browser locale is French');
  eq(fr.preferred, 'fr-FR', 'Voice.preferredLang() resolves to the browser language');
  // Voice.warmupForChain primes the engine with a blank, volume-0
  // utterance first; the one under test is the segment name.
  const real = fr.spoken.find(u => (u.text || '').trim());
  if (!real) bad(`no real utterance (got ${JSON.stringify(fr.spoken)})`);
  else {
    eq(real.text, 'Respiration profonde', 'segment name spoken');
    eq(real.lang, 'fr-FR', 'utterance carries the French tag (was inheriting "en")');
  }

  const en = await spokenLangFor('en-GB');
  eq(en.spoken.find(u => (u.text || '').trim())?.lang, 'en-GB', 'English browser still gets its own tag');
}

// ---------------------------------------------------------------- B
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
page.on('pageerror', e => bad('pageerror: ' + e.message));
await page.addInitScript(({ key }) => localStorage.setItem(key, JSON.stringify({
  schemaVersion: 1,
  chains: [{ id: 'c_old', name: 'Existing', color: 'amber', loops: 1, hasRun: true,
    segments: [{ id: 's1', kind: 'segment', name: 'Seg', duration: 90, color: 'amber' }] }],
  settings: { sound: false, voice: false, vibrate: false, prestart: false, finalTick: false },
})), { key: STORAGE_KEY });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);

const hintState = () => page.evaluate(() => ({
  hinted: [...document.querySelectorAll('.segment-duration')].map(d => d.classList.contains('is-hinted')),
  tip: document.getElementById('editor-hint')?.textContent || '',
  pointing: document.getElementById('editor-hint')?.classList.contains('is-pointing'),
}));

console.log('\nTest B: new chain points at the duration control');
{
  await page.evaluate(() => { window.ChainedApp.Editor.newChain(); window.ChainedApp.View.show('editor'); });
  await page.waitForTimeout(200);
  const s = await hintState();
  eq(s.hinted, [true], 'first (only) segment duration is hinted');
  eq(s.pointing, true, 'tip line switches to pointing mode');
  if (/tap the highlighted duration/i.test(s.tip)) ok(`tip reads: "${s.tip}"`);
  else bad(`tip: ${s.tip}`);

  // A second segment must NOT also be hinted — one target, not two.
  await page.evaluate(() => { window.ChainedApp.Editor.addSegment(); window.ChainedApp.UI.renderEditor(); });
  await page.waitForTimeout(150);
  eq((await hintState()).hinted, [true, false], 'only the first segment is hinted');
}

console.log('\nTest C: the hint retires once the user finds the control');
{
  await page.evaluate(() => {
    const seg = window.ChainedApp.Editor.draft.segments[0];
    window.ChainedApp.UI.openDurationPicker(seg);
    document.getElementById('duration-sheet').hidden = true;
    window.ChainedApp.UI.renderEditor();
  });
  await page.waitForTimeout(150);
  const s = await hintState();
  eq(s.hinted, [false, false], 'hint cleared after opening the picker');
  eq(s.pointing, false, 'tip line back to the normal gestures tip');
  if (/drag the handle/i.test(s.tip)) ok('normal tip restored');
  else bad(`tip: ${s.tip}`);
}

console.log('\nTest D: editing an EXISTING chain never hints');
{
  await page.evaluate(() => {
    window.ChainedApp.Editor.loadChain('c_old');
    window.ChainedApp.View.show('editor');
  });
  await page.waitForTimeout(200);
  const s = await hintState();
  eq(s.hinted, [false], 'saved chain shows no pointer');
  eq(s.pointing, false, 'tip stays neutral');
}

console.log('\nTest E: a customised new chain stops hinting');
{
  const s = await page.evaluate(() => {
    const { Editor, UI } = window.ChainedApp;
    Editor.newChain();
    Editor.draft.segments[0].name = 'Warmup';   // user typed a name first
    UI.renderEditor();
    return [...document.querySelectorAll('.segment-duration')].map(d => d.classList.contains('is-hinted'));
  });
  eq(s, [false], 'named first segment is no longer "untouched"');
  // …but a truly fresh one hints again (per-chain, not once-ever).
  const s2 = await page.evaluate(() => {
    const { Editor, UI } = window.ChainedApp;
    Editor.newChain();
    UI.renderEditor();
    return [...document.querySelectorAll('.segment-duration')].map(d => d.classList.contains('is-hinted'));
  });
  eq(s2, [true], 'next new chain hints again');
}

console.log(failures ? `\n❌ ${failures} assertion(s) failed` : '\n✅ all checks passed');
await browser.close();
process.exit(failures ? 1 : 0);
