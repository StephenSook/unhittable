import { chromium } from 'playwright-core';
import path from 'node:path';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('file://' + path.resolve('docs/deck/slides.html'), { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);                      // let the webfonts land
await page.pdf({ path: 'docs/deck/unhittable.pdf', width: '1280px', height: '720px',
                 printBackground: true, pageRanges: '1-' });
const n = await page.locator('section.s').count();
console.log('slides:', n);
await browser.close();
