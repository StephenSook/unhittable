// Record the product against the DEPLOYED site, so the footage is of what a
// judge would actually get. Previous takes are deleted by the caller first,
// because a stale .webm reads exactly like a fresh one.
import { chromium } from 'playwright-core';

const SITE = 'https://stephensook.github.io/unhittable/';
const W = 1600, H = 1000;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir: '/tmp/demo/video', size: { width: W, height: H } },
  deviceScaleFactor: 1,
});
const page = await ctx.newPage();
const beat = (ms) => page.waitForTimeout(ms);
const mark = (s) => console.log(new Date().toISOString().slice(14, 19), s);

mark('01 land: the tremor is already missing a conforming target');
await page.goto(SITE, { waitUntil: 'networkidle', timeout: 60000 });
await beat(7000);

mark('02 how big would it have to be');
const size = page.locator('#size');
for (const v of [24, 44, 70, 100, 140, 190, 240]) {
  await size.fill(String(v)); await size.dispatchEvent('input'); await beat(700);
}
await beat(1600);
for (const v of [150, 90, 44, 24]) {
  await size.fill(String(v)); await size.dispatchEvent('input'); await beat(430);
}
await beat(1800);

mark('03 the range of real hands: control, median, severe');
const picks = await page.locator('#picker button').all();
for (const i of [7, 4, 2]) { if (picks[i]) { await picks[i].click(); await beat(3200); } }
await beat(800);

mark('04 point it at a real site');
await page.locator('#scanner').scrollIntoViewIfNeeded();
await beat(1800);
await page.fill('#scanUrl', 'https://www.ssa.gov/');
await beat(1200);
await page.click('#scanBtn');
await page.waitForSelector('.scoreboard', { timeout: 90000 });
await beat(4500);

mark('05 the controls that pass and still cannot be held');
await page.locator('.chip[data-filter="gap"]').click();
await beat(2600);
await page.mouse.wheel(0, 560); await beat(2800);
await page.mouse.wheel(0, 560); await beat(2600);

mark('06 the corpus');
await page.locator('#corpus').scrollIntoViewIfNeeded();
await beat(5000);
await page.mouse.wheel(0, 700); await beat(3600);

mark('07 the cohort, including the part that weakens the claim');
await page.locator('#cohort').scrollIntoViewIfNeeded();
await beat(4500);
await page.mouse.wheel(0, 700); await beat(3200);

mark('08 we are not exempt either');
await page.locator('#selfTest').scrollIntoViewIfNeeded();
await beat(6000);

const path = await page.video().path();
await ctx.close();
await browser.close();
console.log('VIDEO', path);
