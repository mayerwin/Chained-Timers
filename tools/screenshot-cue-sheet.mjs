// One-shot screenshot capture of the new cue-override sheet at chain and
// segment scope. Lets us eyeball the layout (tri-state pills, nested
// finalTick row, "Default (On)" inheritance label) without flipping
// through the app manually.

import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:4321/';
const STORAGE_KEY = 'chained-timers/v1';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();

await page.addInitScript((k) => {
  localStorage.setItem(k, JSON.stringify({
    schemaVersion: 1,
    chains: [{
      id: 'c_x', name: 'Plank Stack', color: 'amber', loops: 1,
      segments: [
        { id: 's1', kind: 'segment', name: 'Front plank',  duration: 90, color: 'amber' },
        { id: 's2', kind: 'segment', name: 'Side plank L', duration: 60, color: 'rust',
          cues: { voice: false } },  // pre-seeded so we can see "Off" pill selected
      ],
      createdAt: 1700000000000, updatedAt: 1700000000000,
    }],
    settings: { sound: true, voice: true, vibrate: true, prestart: true, finalTick: true },
  }));
}, STORAGE_KEY);

await page.goto(URL, { waitUntil: 'networkidle' });
await page.locator('.chain-card .chain-card-body').first().click();
await page.waitForSelector('.view-editor:not([hidden])');

// Chain-level cue sheet
await page.locator('#editor-cues-btn').click();
await page.waitForSelector('#cues-sheet:not([hidden])');
await page.waitForTimeout(120);
await page.screenshot({ path: 'screenshots/14-cues-chain.png' });

// Close and open segment-level cue sheet
await page.locator('#cues-sheet button[data-close-sheet]').click();
await page.waitForTimeout(100);
await page.locator('.segment-row').nth(1).locator('.segment-cues').click();
await page.waitForSelector('#cues-sheet:not([hidden])');
await page.waitForTimeout(120);
await page.screenshot({ path: 'screenshots/15-cues-segment.png' });

await browser.close();
console.log('captured 14-cues-chain.png + 15-cues-segment.png');
