// Gallery screenshots, taken from the DEPLOYED site so they show what a judge
// would actually see rather than a local dev server.
import { chromium } from 'playwright-core';
const SITE = 'https://stephensook.github.io/unhittable/';
const OUT = 'docs/screenshots';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const shot = async (name, opts = {}) => {
  await page.screenshot({ path: `${OUT}/${name}.png`, ...opts });
  console.log('  ', name);
};

await page.goto(SITE, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3500);
console.log('capturing:');
await shot('01-hero');

// A scan of a real government site.
await page.locator('#scanner').scrollIntoViewIfNeeded();
await page.fill('#scanUrl', 'https://www.ssa.gov/');
await page.click('#scanBtn');
await page.waitForSelector('.scoreboard', { timeout: 90000 });
await page.waitForTimeout(1500);
await page.locator('.scoreboard').scrollIntoViewIfNeeded();
await page.waitForTimeout(600);
await shot('02-scan-ssa');

await page.locator('.chip[data-filter="gap"]').click();
await page.waitForTimeout(900);
await page.mouse.wheel(0, 420);
await page.waitForTimeout(700);
await shot('03-the-gap');

await page.locator('#corpus').scrollIntoViewIfNeeded();
await page.waitForTimeout(1200);
await shot('04-corpus');

await page.locator('#cohort').scrollIntoViewIfNeeded();
await page.waitForTimeout(1200);
await shot('05-cohort');

await page.mouse.wheel(0, 900);
await page.waitForTimeout(1000);
await shot('06-sweep');

await page.locator('#selfTest').scrollIntoViewIfNeeded();
await page.waitForTimeout(1200);
await shot('07-self-test');

// Mobile, to show it is responsive and that the viewport warning exists.
const m = await browser.newContext({ viewport: { width: 414, height: 900 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const mp = await m.newPage();
await mp.goto(SITE, { waitUntil: 'networkidle', timeout: 60000 });
await mp.waitForTimeout(3000);
await mp.screenshot({ path: `${OUT}/08-mobile.png` });
console.log('   08-mobile');

await browser.close();
