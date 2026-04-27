// Capture store-quality screenshots at the dimensions Apple App Store and
// Google Play Store want, ready to upload as-is. Reuses the dev server.
//
// Outputs into:
//   publishing/android/screenshots/01..05.png   (1080×1920)
//   publishing/ios/screenshots/iphone-6.7/01..05.png (1290×2796)
//
// Usage: ensure dev server is running on http://localhost:4321 (npm run serve),
// then: npm run screenshots:store
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';

const URL = process.env.URL || 'http://localhost:4321/';

const PROFILES = [
  {
    name: 'Android phone',
    outDir: 'publishing/android/screenshots',
    viewport: { width: 360, height: 640 },
    deviceScaleFactor: 3, // → 1080×1920
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Mobile Safari/537.36',
  },
  {
    name: 'iPhone 6.7"',
    outDir: 'publishing/ios/screenshots/iphone-6.7',
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 3, // → 1290×2796
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  },
];

const SEED = {
  schemaVersion: 1,
  chains: [
    { id: 'c_demo1', name: 'Plank Stack', color: 'amber', loops: 1, segments: [
      { id: 's1', kind: 'segment', name: 'Front plank',    duration: 90, color: 'amber' },
      { id: 's2', kind: 'segment', name: 'Side plank — L', duration: 60, color: 'rust'  },
      { id: 's3', kind: 'segment', name: 'Side plank — R', duration: 60, color: 'rust'  },
      { id: 's4', kind: 'segment', name: 'Front plank',    duration: 90, color: 'amber' },
      { id: 's5', kind: 'segment', name: 'Side plank — L', duration: 60, color: 'rust'  },
      { id: 's6', kind: 'segment', name: 'Side plank — R', duration: 60, color: 'rust'  },
      { id: 's7', kind: 'segment', name: 'Final hold',     duration: 90, color: 'sage'  },
    ], createdAt: 1, updatedAt: 1 },
    { id: 'c_demo2', name: 'Tabata', color: 'rust', loops: 8, segments: [
      { id: 't1', kind: 'segment', name: 'Work', duration: 20, color: 'rust' },
      { id: 't2', kind: 'segment', name: 'Rest', duration: 10, color: 'sage' },
    ], createdAt: 1, updatedAt: 1 },
    { id: 'c_demo3', name: 'Box Breath', color: 'violet', loops: 6, segments: [
      { id: 'b1', kind: 'segment', name: 'Inhale', duration: 4, color: 'violet' },
      { id: 'b2', kind: 'segment', name: 'Hold',   duration: 4, color: 'bone'   },
      { id: 'b3', kind: 'segment', name: 'Exhale', duration: 4, color: 'sage'   },
      { id: 'b4', kind: 'segment', name: 'Hold',   duration: 4, color: 'bone'   },
    ], createdAt: 1, updatedAt: 1 },
    { id: 'c_demo4', name: 'Boxing Rounds', color: 'rose', loops: 1, segments: [
      { id: 'bx1', kind: 'segment', name: 'Round 1', duration: 180, color: 'rose' },
      { id: 'bx2', kind: 'segment', name: 'Rest',    duration: 60,  color: 'sage' },
      { id: 'bx3', kind: 'segment', name: 'Round 2', duration: 180, color: 'rose' },
      { id: 'bx4', kind: 'segment', name: 'Rest',    duration: 60,  color: 'sage' },
      { id: 'bx5', kind: 'segment', name: 'Round 3', duration: 180, color: 'rose' },
    ], createdAt: 1, updatedAt: 1 },
    { id: 'c_demo5', name: 'Full Workout', color: 'indigo', loops: 1, segments: [
      { id: 'fw1', kind: 'segment', name: 'Warmup',   duration: 120, color: 'indigo' },
      { id: 'fw2', kind: 'subchain', refId: 'c_demo1', loops: 1 },
      { id: 'fw3', kind: 'segment', name: 'Cooldown', duration: 120, color: 'sage' },
    ], createdAt: 1, updatedAt: 1 },
  ],
  settings: {
    sound: true, voice: false, vibrate: true, wake: true, prestart: true, finalTick: true,
    notifsAsked: true, bgAudio: false, iosNoticeSeen: true,
  },
};

const browser = await chromium.launch({ headless: true });

for (const profile of PROFILES) {
  console.log(`\n→ ${profile.name} (${profile.viewport.width * profile.deviceScaleFactor}×${profile.viewport.height * profile.deviceScaleFactor})`);

  const out = path.resolve(profile.outDir);
  await fs.mkdir(out, { recursive: true });

  const ctx = await browser.newContext({
    viewport: profile.viewport,
    deviceScaleFactor: profile.deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
    userAgent: profile.userAgent,
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
  });
  const page = await ctx.newPage();

  await page.addInitScript((seed) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('chained-timers/v1', JSON.stringify(seed));
  }, SEED);

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  const shoot = async (name) => {
    await page.waitForTimeout(300);
    const file = path.join(out, `${name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    console.log(`  📸 ${name}.png`);
  };

  // 01 — Library (the elevator pitch shot)
  await shoot('01-library');

  // 02 — Editor with embedded sub-chain (the differentiator)
  await page.click('.chain-card:nth-child(5) .chain-card-body');
  await page.waitForTimeout(500);
  await shoot('02-editor');

  // 03 — Templates catalogue (immediate value)
  await page.click('.view-editor [data-back="library"]');
  await page.waitForTimeout(300);
  await page.click('.tab[data-tab="templates"]');
  await page.waitForTimeout(500);
  await shoot('03-templates');

  // 04 — Run mode mid-segment (cinematic, ring half-full)
  await page.click('.view-templates [data-back="library"]');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('chained-timers/v1'));
    s.settings.prestart = false;
    s.settings.sound = false;
    localStorage.setItem('chained-timers/v1', JSON.stringify(s));
    location.reload();
  });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  await page.click('.chain-card:nth-child(2) .chain-card-play'); // Tabata
  await page.waitForTimeout(11000); // 11s into a 20s "Work" segment → ~55% ring
  await shoot('04-run');

  // 05 — Settings (shows polish + all features)
  await page.evaluate(() => {
    const orig = window.confirm;
    window.confirm = () => true;
    document.getElementById('run-stop').click();
    setTimeout(() => { window.confirm = orig; }, 100);
  });
  await page.waitForTimeout(500);
  await page.click('#open-settings');
  await page.waitForTimeout(500);
  await shoot('05-settings');

  await ctx.close();
}

await browser.close();
console.log('\n✓ Store screenshots ready in publishing/{android,ios}/screenshots/\n');
