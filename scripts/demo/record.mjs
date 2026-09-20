// Record the product doing the thing, against the DEPLOYED site, so the
// footage is of what a judge would get rather than of a local dev server.
import { chromium } from 'playwright-core';

const SITE = 'https://stephensook.github.io/unhittable/';
const W = 1600, H = 1000;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir: '/tmp/demo/video', size: { width: W, height: H } },
  deviceScaleFactor: 1,
  reducedMotion: 'no-preference',
});
const page = await ctx.newPage();
const beat = (ms) => page.waitForTimeout(ms);

console.log('01 land');
await page.goto(SITE, { waitUntil: 'networkidle', timeout: 60000 });
await beat(4500);                                  // the tremor misses the 24 px target

console.log('02 grow the target until it holds');
const size = page.locator('#size');
for (const v of [24, 40, 60, 90, 130, 180, 240]) {
  await size.fill(String(v));
  await size.dispatchEvent('input');
  await beat(620);
}
await beat(900);
for (const v of [180, 120, 70, 24]) {
  await size.fill(String(v));
  await size.dispatchEvent('input');
  await beat(420);
}
await beat(1400);

console.log('03 the range of real hands');
const picks = await page.locator('#picker button').all();
// control -> median -> severe, so the spread is visible
for (const idx of [5, 3, 2]) {
  if (picks[idx]) { await picks[idx].click(); await beat(2600); }
}
await beat(700);

console.log('04 the scanner');
await page.locator('#scanner').scrollIntoViewIfNeeded();
await beat(1400);
await page.fill('#scanUrl', 'https://www.ssa.gov/');
await beat(900);
await page.click('#scanBtn');
await page.waitForSelector('.scoreboard', { timeout: 90000 });
await beat(3600);

console.log('05 the gap');
await page.locator('.chip[data-filter="gap"]').click();
await beat(3000);
await page.mouse.wheel(0, 520);
await beat(3000);

console.log('06 the corpus');
await page.locator('#corpus').scrollIntoViewIfNeeded();
await beat(4200);
await page.mouse.wheel(0, 640);
await beat(3200);

console.log('07 the cohort');
await page.locator('#cohort').scrollIntoViewIfNeeded();
await beat(3800);

console.log('08 we fail our own test');
await page.locator('#selfTest').scrollIntoViewIfNeeded();
await beat(5200);

const path = await page.video().path();
await ctx.close();                                  // flushes the file
await browser.close();
console.log('VIDEO', path);
