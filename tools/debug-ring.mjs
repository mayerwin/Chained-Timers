import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
});
const page = await ctx.newPage();
await page.addInitScript(() => {
  if (sessionStorage.getItem('seeded')) return;
  sessionStorage.setItem('seeded', '1');
  const seed = {
    schemaVersion: 1,
    chains: [{
      id: 'c1', name: 'Tabata', color: 'rust', loops: 1,
      segments: [{ id: 's1', kind: 'segment', name: 'Work', duration: 20, color: 'rust' }],
      createdAt: 1, updatedAt: 1,
    }],
    settings: { sound: false, vibrate: false, prestart: false, finalTick: false, voice: false, wake: false, notifsAsked: false },
  };
  localStorage.setItem('chained-timers/v1', JSON.stringify(seed));
});
await page.goto('http://localhost:4321/', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await page.click('.chain-card:nth-child(1) .chain-card-play');
await page.waitForTimeout(10500);
await page.screenshot({ path: 'screenshots/_debug-ring.png' });
const data = await page.evaluate(() => {
  const ring = document.getElementById('run-ring-fill');
  const r = ring.getBoundingClientRect();
  return {
    dasharray: ring.getAttribute('stroke-dasharray'),
    dashoffset: ring.getAttribute('stroke-dashoffset'),
    clock: document.getElementById('run-clock').textContent,
    rect: { w: r.width, h: r.height },
    radius: ring.getAttribute('r'),
    cx: ring.getAttribute('cx'),
    cy: ring.getAttribute('cy'),
  };
});
console.log(JSON.stringify(data, null, 2));
await browser.close();
