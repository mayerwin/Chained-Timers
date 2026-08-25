// v1.4.12 — swipe-to-delete regression tests.
//
// Locks in the library swipe gesture contract:
//   1. Swipe left past the threshold deletes the chain, with an Undo
//      snackbar; Undo restores the chain at its original index.
//   2. Swipe below the threshold springs back — chain intact, and the
//      synthesized click after the drag does NOT open the editor.
//   3. A chain embedded in other chains can't be swipe-deleted: the
//      card resists, nothing is deleted, and the bottom notice lists
//      up to 3 referencing chains (long names capped with an ellipsis)
//      plus "+N more" for the rest.
//   4. In select mode the gesture is inert.
//   5. The Undo snackbar auto-dismisses (delete becomes final).
//
// Run via:
//   npm run serve   # in another shell
//   node tools/smoke-swipe-delete.mjs

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
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
page.on('pageerror', e   => bad('pageerror: ' + e.message));
page.on('console',   msg => { if (msg.type() === 'error') bad('console: ' + msg.text()); });

const seg = (id, name) => ({ id, kind: 'segment', name, duration: 30, color: 'amber' });
const SEED = {
  schemaVersion: 1,
  chains: [
    { id: 'c_solo', name: 'Solo', color: 'amber', loops: 1,
      segments: [seg('s1', 'One')], createdAt: 5, updatedAt: 5 },
    { id: 'c_mid', name: 'Middle', color: 'teal', loops: 1,
      segments: [seg('s2', 'Two')], createdAt: 4, updatedAt: 4 },
    { id: 'c_embedded', name: 'Embedded', color: 'violet', loops: 1,
      segments: [seg('s3', 'Three')], createdAt: 3, updatedAt: 3 },
    { id: 'c_userA', name: 'A very long chain name indeed', color: 'rust', loops: 1,
      segments: [seg('s4', 'Four'), { id: 'sc1', kind: 'subchain', refId: 'c_embedded' }],
      createdAt: 2, updatedAt: 2 },
    { id: 'c_userB', name: 'Bravo', color: 'sage', loops: 1,
      segments: [{ id: 'sc2', kind: 'subchain', refId: 'c_embedded' }],
      createdAt: 2, updatedAt: 2 },
    { id: 'c_userC', name: 'Charlie', color: 'amber', loops: 1,
      segments: [{ id: 'sc3', kind: 'subchain', refId: 'c_embedded' }],
      createdAt: 2, updatedAt: 2 },
    { id: 'c_userD', name: 'Delta', color: 'teal', loops: 1,
      segments: [{ id: 'sc4', kind: 'subchain', refId: 'c_embedded' }],
      createdAt: 2, updatedAt: 2 },
    { id: 'c_userE', name: 'Echo', color: 'violet', loops: 1,
      segments: [{ id: 'sc5', kind: 'subchain', refId: 'c_embedded' }],
      createdAt: 2, updatedAt: 2 },
  ],
  settings: { sound: false, voice: false, vibrate: false, prestart: false, finalTick: false },
};
await page.addInitScript(({ key, seed }) => localStorage.setItem(key, JSON.stringify(seed)), { key: STORAGE_KEY, seed: SEED });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);

// Drag helper: mouse-driven horizontal drag on a chain card (the gesture
// rides pointer events, so mouse and touch share the code path).
async function dragCard(chainId, dx, { steps = 12 } = {}) {
  const card = page.locator(`li.chain-card[data-chain-id="${chainId}"]`);
  // Center the card in the scroller — scrollIntoViewIfNeeded's minimal
  // scroll can leave a bottom-row card underneath the fixed tabbar,
  // where pointer events would hit the tabbar instead of the card.
  await card.evaluate(el => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(120);
  const box = await card.boundingBox();
  const x = box.x + box.width * 0.4, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x + (dx * i) / steps, y, { steps: 1 });
    await page.waitForTimeout(12);
  }
  return { x, y };
}
const chainIds = () => page.evaluate(() => window.ChainedApp.Store.getChains().map(c => c.id));

console.log('Test 1: swipe left past threshold deletes; Undo restores at original index');
{
  await dragCard('c_mid', -160);
  // Mid-drag: underlay revealed + armed (trash pops).
  const mid = await page.evaluate(() => {
    const u = document.querySelector('.swipe-underlay');
    const li = document.querySelector('li[data-chain-id="c_mid"]');
    return {
      underlay: !!u,
      armed: u?.classList.contains('is-armed') ?? false,
      blockedStyle: u?.classList.contains('is-blocked') ?? true,
      translated: (li?.style.transform || '').includes('-'),
    };
  });
  eq(mid.underlay, true,  'underlay revealed during drag');
  eq(mid.armed, true,     'armed past threshold');
  eq(mid.blockedStyle, false, 'red delete styling (not blocked)');
  eq(mid.translated, true, 'card translated left');
  await page.mouse.up();
  await page.waitForTimeout(600); // slide-out + collapse + re-render
  eq(await chainIds(), ['c_solo', 'c_embedded', 'c_userA', 'c_userB', 'c_userC', 'c_userD', 'c_userE'], 'chain deleted from store');
  const snack = await page.evaluate(() => {
    const t = document.querySelector('.toast.has-action');
    return { present: !!t, text: t?.textContent || '', btn: !!t?.querySelector('.toast-action-btn') };
  });
  eq(snack.present, true, 'undo snackbar shown');
  eq(snack.btn, true, 'undo button present');
  if (snack.text.includes('Middle') && snack.text.toLowerCase().includes('deleted')) ok('snackbar names the chain');
  else bad(`snackbar text off: ${snack.text}`);
  await page.click('.toast-action-btn');
  await page.waitForTimeout(300);
  eq(await chainIds(), ['c_solo', 'c_mid', 'c_embedded', 'c_userA', 'c_userB', 'c_userC', 'c_userD', 'c_userE'], 'undo restored at original index');
  eq(await page.evaluate(() => !!document.querySelector('.toast.has-action')), false, 'snackbar dismissed after undo');
}

console.log('\nTest 2: below-threshold swipe springs back; no delete, no editor open');
{
  await dragCard('c_mid', -60);
  await page.mouse.up();
  await page.waitForTimeout(400);
  eq((await chainIds()).includes('c_mid'), true, 'chain survives short swipe');
  eq(await page.evaluate(() => document.body.dataset.view), 'library', 'drag did not open the editor');
  const clean = await page.evaluate(() => ({
    underlays: document.querySelectorAll('.swipe-underlay').length,
    transform: document.querySelector('li[data-chain-id="c_mid"]').style.transform,
  }));
  eq(clean.underlays, 0, 'underlay cleaned up');
  eq(clean.transform === '' || clean.transform === 'translateX(0px)', true, 'card back at rest');
  // A plain tap still opens the editor.
  await page.click('li[data-chain-id="c_mid"] .chain-card-body');
  await page.waitForTimeout(200);
  eq(await page.evaluate(() => document.body.dataset.view), 'editor', 'plain tap still opens editor');
  await page.evaluate(() => window.ChainedApp.View.show('library'));
  await page.waitForTimeout(200);
}

console.log('\nTest 3: embedded chain resists and surfaces the used-by notice');
{
  await dragCard('c_embedded', -160);
  const mid = await page.evaluate(() => {
    const u = document.querySelector('.swipe-underlay');
    const li = document.querySelector('li[data-chain-id="c_embedded"]');
    const tx = parseFloat((li?.style.transform || '').replace(/[^-\d.]/g, '')) || 0;
    return { blocked: u?.classList.contains('is-blocked') ?? false, tx };
  });
  eq(mid.blocked, true, 'neutral blocked underlay (no red)');
  if (mid.tx < 0 && mid.tx >= -56) ok(`drag resisted (clamped at ${mid.tx}px)`);
  else bad(`resistance wrong: tx=${mid.tx}`);
  await page.mouse.up();
  await page.waitForTimeout(400);
  eq((await chainIds()).includes('c_embedded'), true, 'embedded chain NOT deleted');
  const notice = await page.evaluate(() => document.querySelector('.toast.has-action')?.textContent || '');
  if (notice.includes("Can't delete") && notice.includes('used by')) ok('notice shown');
  else bad(`notice missing/off: ${notice}`);
  if (notice.includes('A very long cha…')) ok('long referencing name capped with ellipsis');
  else bad(`name cap missing: ${notice}`);
  if (notice.includes('+2 more')) ok('overflow rolled into +2 more');
  else bad(`+N more missing: ${notice}`);
  const shown = (notice.match(/,/g) || []).length + 1;
  if (shown <= 3) ok('at most 3 names listed');
  else bad(`too many names listed: ${notice}`);
  // The full message must be VISIBLE, not ellipsis-clipped by the pill
  // (the notice wraps to multiple lines; the undo snackbar stays 1-line).
  const clip = await page.evaluate(() => {
    const m = document.querySelector('.toast.has-action .t-msg');
    return { w: m.scrollWidth - m.clientWidth, h: m.scrollHeight - m.clientHeight };
  });
  if (clip.w <= 1 && clip.h <= 1) ok('notice fully visible (no clipping)');
  else bad(`notice clipped: overflow ${JSON.stringify(clip)}`);
  await page.waitForTimeout(4200); // let the notice expire
}

console.log('\nTest 4: gesture inert in select mode');
{
  await page.evaluate(() => window.ChainedApp.UI.enterSelectMode('c_solo'));
  await page.waitForTimeout(200);
  await dragCard('c_mid', -160);
  const midDrag = await page.evaluate(() => document.querySelectorAll('.swipe-underlay').length);
  await page.mouse.up();
  await page.waitForTimeout(300);
  eq(midDrag, 0, 'no underlay in select mode');
  eq((await chainIds()).includes('c_mid'), true, 'nothing deleted in select mode');
  await page.evaluate(() => window.ChainedApp.UI.exitSelectMode());
  await page.waitForTimeout(200);
}

console.log('\nTest 5: snackbar auto-dismisses and the delete stands');
{
  await dragCard('c_solo', -170);
  await page.mouse.up();
  await page.waitForTimeout(600);
  eq((await chainIds()).includes('c_solo'), false, 'chain deleted');
  await page.waitForTimeout(5400); // 5s standard + out animation
  eq(await page.evaluate(() => !!document.querySelector('.toast.has-action')), false, 'snackbar auto-dismissed');
  eq((await chainIds()).includes('c_solo'), false, 'delete final after timeout');
}

console.log('\nTest 6: commit animation interpolates (slide-out, then height collapse)');
{
  // c_userE ("Echo") is deletable — it references nothing and nothing
  // references it.
  await dragCard('c_userE', -150);
  await page.mouse.up();
  // Sample the card's inline styles over the ~400ms exit choreography;
  // a flawless animation shows intermediate transform values AND
  // intermediate heights, never a single jump-cut.
  const samples = await page.evaluate(() => new Promise(res => {
    const li = document.querySelector('li[data-chain-id="c_userE"]');
    const out = [];
    const iv = setInterval(() => {
      if (!li.isConnected) { clearInterval(iv); res(out); return; }
      const r = li.getBoundingClientRect();
      // Computed transform, not inline style — transitions interpolate
      // in computed space while the inline value jumps to the target.
      const m = getComputedStyle(li).transform;
      const tx = m && m !== 'none' ? Math.round(parseFloat(m.split(',')[4])) : 0;
      out.push({ tx, h: Math.round(r.height), op: li.style.opacity });
    }, 30);
    setTimeout(() => { clearInterval(iv); res(out); }, 900);
  }));
  const txs = [...new Set(samples.map(s => s.tx).filter(t => t < 0))];
  const hs  = [...new Set(samples.map(s => s.h))];
  if (txs.length >= 2) ok(`slide-out interpolated (${txs.length} distinct transforms sampled)`);
  else bad(`slide-out jump-cut: ${JSON.stringify(txs)}`);
  if (hs.some(h => h > 0 && h < Math.max(...hs))) ok(`height collapse interpolated (${hs.length} distinct heights)`);
  else bad(`height collapse jump-cut: ${JSON.stringify(hs)}`);
  eq((await chainIds()).includes('c_userE'), false, 'chain deleted after animation');
  await page.waitForTimeout(5400); // clear the snackbar for the next test
}

console.log('\nTest 7: running rows keep swipe-to-stop (no delete underlay)');
{
  let sawDialog = null;
  page.once('dialog', d => { sawDialog = d.message(); d.dismiss(); });
  await page.evaluate(() => {
    const { Store, Engine } = window.ChainedApp;
    Engine.startChain(Store.getChain('c_mid'));
    window.ChainedApp.View.show('library');
  });
  await page.waitForTimeout(300);
  await dragCard('c_mid', -160);
  const midDrag = await page.evaluate(() => document.querySelectorAll('.swipe-underlay').length);
  await page.mouse.up();
  await page.waitForTimeout(400);
  eq(midDrag, 0, 'no delete underlay on a running row');
  if (sawDialog && sawDialog.includes('Stop')) ok(`swipe-to-stop confirm fired ("${sawDialog}")`);
  else bad(`stop confirm missing (got ${JSON.stringify(sawDialog)})`);
  eq((await chainIds()).includes('c_mid'), true, 'running chain not deleted');
  await page.evaluate(() => window.ChainedApp.Engine.stopRun('c_mid'));
}

console.log(failures ? `\n❌ ${failures} assertion(s) failed` : '\n✅ all checks passed');
await browser.close();
process.exit(failures ? 1 : 0);
