// Smoke test: load the app, take screenshots of each major view, log JS errors.
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';

const URL = process.env.URL || 'http://localhost:4321/';
const OUT = path.resolve('screenshots');
await fs.mkdir(OUT, { recursive: true });

const VP = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: VP.width, height: VP.height },
  deviceScaleFactor: VP.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  reducedMotion: 'no-preference',
  colorScheme: 'dark',
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', msg => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); });

// Pre-seed some chains via localStorage so the library isn't empty.
// Use a sessionStorage flag so reloads don't re-seed (lets us test the empty state).
await page.addInitScript(() => {
  if (sessionStorage.getItem('seeded')) return;
  sessionStorage.setItem('seeded', '1');
  const seed = {
    schemaVersion: 1,
    chains: [
      {
        id: 'c_demo1',
        name: 'Plank Stack',
        color: 'amber',
        loops: 1,
        segments: [
          { id: 's1', kind: 'segment', name: 'Front plank',    duration: 90, color: 'amber' },
          { id: 's2', kind: 'segment', name: 'Side plank — L', duration: 60, color: 'rust'  },
          { id: 's3', kind: 'segment', name: 'Side plank — R', duration: 60, color: 'rust'  },
          { id: 's4', kind: 'segment', name: 'Front plank',    duration: 90, color: 'amber' },
          { id: 's5', kind: 'segment', name: 'Side plank — L', duration: 60, color: 'rust'  },
          { id: 's6', kind: 'segment', name: 'Side plank — R', duration: 60, color: 'rust'  },
          { id: 's7', kind: 'segment', name: 'Final hold',     duration: 90, color: 'sage'  },
        ],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: 'c_demo2',
        name: 'Tabata',
        color: 'rust',
        loops: 8,
        segments: [
          { id: 't1', kind: 'segment', name: 'Work', duration: 20, color: 'rust' },
          { id: 't2', kind: 'segment', name: 'Rest', duration: 10, color: 'sage' },
        ],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: 'c_demo3',
        name: 'Box Breath',
        color: 'violet',
        loops: 6,
        segments: [
          { id: 'b1', kind: 'segment', name: 'Inhale', duration: 4, color: 'violet' },
          { id: 'b2', kind: 'segment', name: 'Hold',   duration: 4, color: 'bone'   },
          { id: 'b3', kind: 'segment', name: 'Exhale', duration: 4, color: 'sage'   },
          { id: 'b4', kind: 'segment', name: 'Hold',   duration: 4, color: 'bone'   },
        ],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: 'c_demo4',
        name: 'Boxing Rounds',
        color: 'rose',
        loops: 1,
        segments: [
          { id: 'bx1', kind: 'segment', name: 'Round 1', duration: 180, color: 'rose' },
          { id: 'bx2', kind: 'segment', name: 'Rest',    duration: 60,  color: 'sage' },
          { id: 'bx3', kind: 'segment', name: 'Round 2', duration: 180, color: 'rose' },
          { id: 'bx4', kind: 'segment', name: 'Rest',    duration: 60,  color: 'sage' },
          { id: 'bx5', kind: 'segment', name: 'Round 3', duration: 180, color: 'rose' },
        ],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: 'c_demo5',
        name: 'Full Workout',
        color: 'indigo',
        loops: 1,
        segments: [
          { id: 'fw1', kind: 'segment', name: 'Warmup',   duration: 120, color: 'indigo' },
          { id: 'fw2', kind: 'subchain', refId: 'c_demo1', loops: 1 },
          { id: 'fw3', kind: 'segment', name: 'Cooldown', duration: 120, color: 'sage' },
        ],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
    settings: { sound: true, voice: false, vibrate: true, wake: true, prestart: true, finalTick: true, notifsAsked: false },
  };
  localStorage.setItem('chained-timers/v1', JSON.stringify(seed));
});

async function shoot(name, opts = {}) {
  await page.waitForTimeout(opts.delay || 250);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
  console.log(`📸 ${name}.png`);
}

console.log('→ Loading', URL);
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(800); // let fonts settle

await shoot('01-library');

// Tap into the editor (long press would also work)
await page.click('.chain-card:nth-child(1) .chain-card-body');
await page.waitForTimeout(400);
await shoot('02-editor');

// Open duration picker
await page.click('.segment-row:nth-child(1) .segment-duration');
await page.waitForTimeout(400);
await shoot('03-duration-picker');

// Close duration picker (click the icon-btn close, not the scrim)
await page.click('#duration-sheet .sheet-header .icon-btn');
await page.waitForTimeout(300);

// Open settings (use visible back button — scope to editor view)
await page.click('.view-editor [data-back="library"]');
await page.waitForTimeout(300);
await page.click('#open-settings');
await page.waitForTimeout(400);
await shoot('04-settings');

// Close settings
await page.click('#settings-sheet .sheet-header .icon-btn');
await page.waitForTimeout(300);

// Templates view
await page.click('.tab[data-tab="templates"]');
await page.waitForTimeout(400);
await shoot('05-templates');

// Library again (use templates view's back button)
await page.click('.view-templates [data-back="library"]');
await page.waitForTimeout(300);

// Run mode for the second card (Tabata, with very short segments — easier to capture mid-action)
// Disable prestart and sound for the test
await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('chained-timers/v1'));
  s.settings.prestart = false;
  s.settings.sound = false;
  localStorage.setItem('chained-timers/v1', JSON.stringify(s));
  location.reload();
});
await page.waitForLoadState('networkidle');
await page.waitForTimeout(500);
await page.click('.chain-card:nth-child(2) .chain-card-play');
await page.waitForTimeout(400);
await shoot('06-run');

// Pause it
await page.click('#run-toggle');
await page.waitForTimeout(400);
await shoot('07-run-paused');

// Stop run via JS to avoid native confirm dialog
await page.evaluate(() => {
  const orig = window.confirm;
  window.confirm = () => true;
  document.getElementById('run-stop').click();
  setTimeout(() => { window.confirm = orig; }, 100);
});
await page.waitForTimeout(500);

// Empty state — clear chains
await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('chained-timers/v1'));
  s.chains = [];
  localStorage.setItem('chained-timers/v1', JSON.stringify(s));
  location.reload();
});
await page.waitForLoadState('networkidle');
await page.waitForTimeout(500);
await shoot('08-empty');

// New chain editor
await page.click('#empty-new-chain');
await page.waitForTimeout(400);
await shoot('09-editor-new');

// Re-seed and capture editor with embedded sub-chain (Full Workout) + run mid-progress
await page.evaluate(() => { sessionStorage.removeItem('seeded'); location.reload(); });
await page.waitForLoadState('networkidle');
await page.waitForTimeout(800);

// Open Full Workout (5th card — has embedded chain)
await page.click('.chain-card:nth-child(5) .chain-card-body');
await page.waitForTimeout(500);
await shoot('10-editor-with-subchain');

// Back, then start "Plank Stack" with prestart off and skip into the middle
await page.click('.view-editor [data-back="library"]');
await page.waitForTimeout(300);
await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('chained-timers/v1'));
  s.settings.prestart = false;
  s.settings.sound = false;
  localStorage.setItem('chained-timers/v1', JSON.stringify(s));
});
// Start chain 1 (Plank Stack — 7 segments)
await page.click('.chain-card:nth-child(1) .chain-card-play');
await page.waitForTimeout(500);
// Skip to segment 3 (Side plank R) for a midway look
await page.click('#run-next-btn');
await page.waitForTimeout(200);
await page.click('#run-next-btn');
await page.waitForTimeout(400);
await shoot('11-run-midway');

// Capture a "ring-half-full" hero shot by faking elapsed time
await page.evaluate(() => {
  // Engine should still be running. Rewind segmentStartedAt to make it look ~55% elapsed.
  const seg = window.Engine?.segments?.[window.Engine.currentIndex];
  // Engine isn't on window — this is a no-op; we'll do a different approach.
});
// Stop run and start Tabata (chain 2) — 20s segments. Wait 12s for a ~60%-full ring.
await page.evaluate(() => {
  const orig = window.confirm;
  window.confirm = () => true;
  document.getElementById('run-stop').click();
  setTimeout(() => { window.confirm = orig; }, 100);
});
await page.waitForTimeout(500);
await page.click('.chain-card:nth-child(2) .chain-card-play');
await page.waitForTimeout(12500); // 12.5s into a 20s "Work" segment
await shoot('13-run-active');

// Now stop and open actions sheet
await page.evaluate(() => {
  const orig = window.confirm;
  window.confirm = () => true;
  document.getElementById('run-stop').click();
  setTimeout(() => { window.confirm = orig; }, 100);
});
await page.waitForTimeout(500);
await page.click('.chain-card:nth-child(1) .chain-card-body');
await page.waitForTimeout(400);
await page.click('#editor-menu-btn');
await page.waitForTimeout(400);
await shoot('12-actions-sheet');

console.log('\nErrors caught:', errors.length);
errors.forEach(e => console.log('  ' + e));

await browser.close();
console.log('Done.');
