// v1.4.24 — the 3-2-1 tick lands on the 3, 2 and 1, even for a segment
// that starts inside its last three seconds.
//
// Reported: "when I start a 3 second chain it doesn't beep when 3
// appears, but it beeps when 0 appears". The burst was always played
// from its first pulse whenever it was armed, so a burst armed late put
// its pulses a beat behind the clock and the last one on top of the
// chime. The web path now schedules only the pulses still ahead, at
// their true offsets (finalThreeOffsets in js/app.js); the FGS seeks
// into final3.wav by the same rule.
//
// Covered:
//   1. A 3s segment arms the burst at its very start (~3000ms left).
//   2. The vibration pattern matches: three pulses, the first immediately.
//   3. A 2s segment gets two pulses (on 2 and 1), not three.
//   4. A 1s segment gets one pulse, on the 1.
//
// Run via:
//   npm run serve   # in another shell
//   node tools/smoke-final3-align.mjs

import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:4321/';
const STORAGE_KEY = 'chained-timers/v1';

let failures = 0;
const ok  = m => console.log('  ✓', m);
const bad = m => { console.log('  ✗', m); failures++; };
const eq  = (a, b, m) => JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(`${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
page.on('pageerror', e   => bad('pageerror: ' + e.message));
page.on('console',   msg => { if (msg.type() === 'error') bad('console: ' + msg.text()); });

const seg = (id, duration) => ({ id, kind: 'segment', name: 'S' + id, duration, color: 'amber' });
const SEED = {
  schemaVersion: 1,
  chains: [
    { id: 'c3',  name: 'Three',   color: 'amber', loops: 1, hasRun: true, segments: [seg('a', 3)],   createdAt: 3, updatedAt: 3 },
    { id: 'c2',  name: 'Two',     color: 'amber', loops: 1, hasRun: true, segments: [seg('b', 2)],   createdAt: 2, updatedAt: 2 },
    { id: 'c1',  name: 'One',     color: 'amber', loops: 1, hasRun: true, segments: [seg('c', 1)],   createdAt: 1, updatedAt: 1 },
    { id: 'cw',  name: 'Warmup',  color: 'amber', loops: 1, hasRun: true, segments: [seg('w', 60)],  createdAt: 0, updatedAt: 0 },
  ],
  settings: { sound: true, finalTick: true, vibrate: true, voice: false, prestart: false },
};
await page.addInitScript(({ key, seed }) => {
  localStorage.setItem(key, JSON.stringify(seed));
  window.__vibes = [];
  navigator.vibrate = p => { window.__vibes.push(p); return true; };
}, { key: STORAGE_KEY, seed: SEED });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);

// Record what the engine asks Audio.finalThree for, and what pulses it
// actually schedules on the audio clock.
await page.evaluate(() => {
  const { Audio } = window.ChainedApp;
  window.__bursts = [];
  const orig = Audio.finalThree.bind(Audio);
  Audio.finalThree = (remainingMs) => {
    const starts = [];
    Audio.ensure();
    const ctx = Audio.ctx;
    const t0 = ctx ? ctx.currentTime : 0;
    const make = ctx && ctx.createOscillator.bind(ctx);
    if (ctx) {
      ctx.createOscillator = () => {
        const o = make();
        const start = o.start.bind(o);
        o.start = t => { starts.push(Math.round((t - t0) * 1000)); start(t); };
        return o;
      };
    }
    orig(remainingMs);
    if (ctx) ctx.createOscillator = make;
    window.__bursts.push({ remainingMs, starts });
  };
});

async function runChain(id, ms) {
  await page.evaluate(id => {
    window.__bursts = []; window.__vibes = [];
    const { Store, UI } = window.ChainedApp;
    UI.startRunForChain(Store.getChain(id));
  }, id);
  await page.waitForTimeout(ms);
  return page.evaluate(() => ({
    bursts: window.__bursts,
    // Only the 3-2-1 pattern — drop the start / segment-end / finale buzzes.
    tick: window.__vibes.find(p => Array.isArray(p) && p.includes(40)) || null,
  }));
}

// The first run in a fresh page pays for its first paint (fonts, view
// switch): its first frame can come hundreds of ms late. That burst is
// still aligned — it just drops the pulse already behind it — but warm
// up first so Test 1 measures the ordinary case.
await page.evaluate(() => { const { Store, UI } = window.ChainedApp; UI.startRunForChain(Store.getChain('cw')); });
await page.waitForTimeout(800);
await page.evaluate(() => window.ChainedApp.Engine.stopRun('cw'));
await page.waitForTimeout(300);

console.log('Test 1+2: a 3s segment ticks on 3, 2 and 1');
{
  const r = await runChain('c3', 3600);
  eq(r.bursts.length, 1, 'one burst');
  const b = r.bursts[0] || { remainingMs: 0, starts: [] };
  if (b.remainingMs > 2850) ok(`armed at the start (${Math.round(b.remainingMs)}ms left)`);
  else bad(`armed late: ${Math.round(b.remainingMs)}ms left`);
  eq(b.starts.length, 3, 'three pulses');
  const want = [b.remainingMs - 3000, b.remainingMs - 2000, b.remainingMs - 1000].map(x => Math.max(0, Math.round(x)));
  if (b.starts.every((s, i) => Math.abs(s - want[i]) <= 2)) ok(`pulses at ${b.starts.join(' / ')}ms`);
  else bad(`pulses at ${b.starts.join(' / ')}ms, want ${want.join(' / ')}`);
  if (r.tick && r.tick[0] === 40 && r.tick.filter(x => x === 40).length === 3) ok(`vibration ${JSON.stringify(r.tick)}`);
  else bad(`vibration ${JSON.stringify(r.tick)}`);
}

console.log('\nTest 3: a 2s segment ticks on 2 and 1 only');
{
  const r = await runChain('c2', 2600);
  const b = r.bursts[0] || { starts: [] };
  eq(b.starts.length, 2, 'two pulses');
  if (b.starts[0] <= 20 && Math.abs(b.starts[1] - 1000) <= 20) ok(`pulses at ${b.starts.join(' / ')}ms`);
  else bad(`pulses at ${b.starts.join(' / ')}ms`);
  if (r.tick && r.tick.filter(x => x === 40).length === 2) ok(`vibration ${JSON.stringify(r.tick)}`);
  else bad(`vibration ${JSON.stringify(r.tick)}`);
}

console.log('\nTest 4: a 1s segment ticks once, on the 1');
{
  const r = await runChain('c1', 1600);
  const b = r.bursts[0] || { starts: [] };
  eq(b.starts.length, 1, 'one pulse');
  if (b.starts[0] <= 20) ok(`pulse at once (${b.starts[0]}ms)`);
  else bad(`pulse at ${b.starts[0]}ms`);
  eq(r.tick, [40], 'one buzz');
}

await browser.close();
console.log(failures ? `\n${failures} failure(s)` : '\nAll passed');
process.exit(failures ? 1 : 0);
