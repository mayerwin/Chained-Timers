// Screenshot the multi-select toolbar so we can eyeball the new
// bulk-delete trash button placement.
import { chromium } from 'playwright';

const URL = 'http://localhost:4321/';
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true, hasTouch: true, colorScheme: 'dark',
})).newPage();

await page.addInitScript(() => {
  localStorage.setItem('chained-timers/v1', JSON.stringify({
    schemaVersion: 1,
    chains: [
      { id: 'c_a', name: 'Alpha', color: 'amber', loops: 1,
        segments: [{ id: 's1', kind: 'segment', name: 'A1', duration: 30, color: 'amber' }],
        createdAt: 1, updatedAt: 1 },
      { id: 'c_b', name: 'Beta', color: 'rust', loops: 1,
        segments: [{ id: 's2', kind: 'segment', name: 'B1', duration: 30, color: 'rust' }],
        createdAt: 2, updatedAt: 2 },
    ], settings: {},
  }));
});
await page.goto(URL, { waitUntil: 'networkidle' });

const row = page.locator('li[data-chain-id="c_a"]');
const rb = await row.boundingBox();
await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
await page.mouse.down();
await page.waitForTimeout(700);
await page.mouse.up();
await page.waitForTimeout(200);
await page.screenshot({ path: 'screenshots/14-select-mode.png' });
console.log('wrote screenshots/14-select-mode.png');
await browser.close();
