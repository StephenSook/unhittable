// scanner.js - load a real page and measure what a real hand can hit.
//
// The browser is not a convenience here. Target size is a layout property, so
// there is no static analysis that answers the question. This module owns the
// browser, and it owns the rule that every single request the page makes is
// checked against the SSRF fence before it is allowed out.

import dns from 'node:dns/promises';
import { collectTargets, TARGET_SELECTOR } from '@unhittable/core/probe.js';
import { normaliseTargetUrl, assertFetchable } from '@unhittable/core/url-guard.js';
import { evaluateSpacing, judgeElement, summarise, cpiToCssPxPerMm, azimuthFamily } from '@unhittable/core/geometry.js';
import { recordingToPath } from '@unhittable/core/replay.js';
import { createGuardProxy } from './guard-proxy.js';

/** We say who we are. A site owner reading their logs deserves to know. */
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/153.0.0.0 Safari/537.36 Unhittable/1.0 (+https://github.com/StephenSook/unhittable; accessibility target-size measurement)';

export const VIEWPORTS = {
  // deviceScaleFactor is pinned to 1 so that one CSS pixel is one measured
  // pixel. WCAG is written in CSS pixels and a retina factor here would
  // silently halve every number.
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, label: 'desktop, 1280 by 800' },
  mobile: { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true, label: 'mobile, 390 by 844' },
};

/**
 * A DNS cache with a short TTL.
 *
 * Needed because the fence checks EVERY request, and a page makes hundreds.
 * The TTL is deliberately short: a long cache is a rebinding window.
 */
class ResolverCache {
  constructor({ ttlMs = 30_000, timeoutMs = 4_000 } = {}) {
    this.ttlMs = ttlMs;
    this.timeoutMs = timeoutMs;
    this.map = new Map();
  }
  async resolve(hostname) {
    const now = Date.now();
    const hit = this.map.get(hostname);
    if (hit && hit.expires > now) {
      if (hit.error) throw new Error(hit.error);
      return hit.addresses;
    }
    try {
      const records = await Promise.race([
        dns.lookup(hostname, { all: true, verbatim: true }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('DNS timeout')), this.timeoutMs)),
      ]);
      const addresses = records.map((r) => r.address);
      this.map.set(hostname, { addresses, expires: now + this.ttlMs });
      return addresses;
    } catch (e) {
      this.map.set(hostname, { error: e.message, expires: now + 5_000 });
      throw e;
    }
  }
}

/** Reasons a request was stopped, kept so a report can explain itself. */
function makeBlockLog() {
  const blocked = [];
  return {
    blocked,
    record(url, why) {
      if (blocked.length < 50) blocked.push({ url: String(url).slice(0, 200), why });
    },
  };
}

/**
 * Scan one URL.
 *
 * @param {object} deps
 * @param {import('playwright-core').Browser} deps.browser  a browser kept warm by the caller
 * @param {ResolverCache} [deps.resolver]
 * @param {(url: URL|string, resolve: Function) => Promise<URL>} [deps.guard]
 *        The fence. Defaults to the strict one. It is a CODE parameter and is
 *        never reachable from an HTTP request, so no input a stranger can send
 *        relaxes it. The integration suite injects a permissive fence in order
 *        to scan a loopback fixture, and a test asserts that the DEFAULT still
 *        refuses loopback so the relaxation cannot leak into production.
 * @param {object} opts
 * @param {string} opts.url
 * @param {object} opts.path      the tremor path from recordingToPath
 * @param {number} [opts.cpi]
 * @param {'desktop'|'mobile'} [opts.viewport]
 */
export async function scanUrl({ browser, resolver = new ResolverCache(), guard = assertFetchable }, opts) {
  const started = Date.now();
  const cpi = opts.cpi ?? 800;
  const viewportName = opts.viewport === 'mobile' ? 'mobile' : 'desktop';
  const viewport = VIEWPORTS[viewportName];
  const navTimeout = opts.timeoutMs ?? 25_000;
  const want = opts.want ?? 0.95;

  // Fence the URL the user gave us, before a browser exists.
  const target = normaliseTargetUrl(opts.url);
  await guard(target, (h) => resolver.resolve(h));

  const log = makeBlockLog();

  // Chromium reaches the network ONLY through the validating proxy. The
  // route handler below is a second layer for scheme and policy, but it
  // cannot be the SSRF boundary on its own: it approves a request and then
  // lets the browser resolve the name again, which is a rebinding window.
  // The proxy resolves once and connects to the address it validated.
  //
  // This is REQUIRED rather than optional. It used to default to null, and
  // the corpus seeder simply never passed it, so the sweep that produces our
  // published numbers ran with the rebinding gap wide open on every page and
  // subresource. An option that defaults to unsafe is a vulnerability with a
  // configuration flag in front of it.
  const proxyUrl = opts.proxyUrl ?? null;
  if (!proxyUrl && !opts.unsafeNoProxy) {
    throw new Error(
      'scanUrl: a connection fence is required. Pass proxyUrl from createGuardProxy(), ' +
      'or unsafeNoProxy: true if you are a test scanning a local fixture.');
  }

  const context = await browser.newContext({
    ...(proxyUrl ? { proxy: { server: proxyUrl } } : {}),
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor,
    isMobile: viewport.isMobile,
    hasTouch: !!viewport.hasTouch,
    userAgent: USER_AGENT,
    javaScriptEnabled: true,
    ignoreHTTPSErrors: false,
    serviceWorkers: 'block',
    reducedMotion: 'reduce',
    locale: 'en-US',
  });

  // Nothing leaves this context without passing the fence. A page that
  // fetches an internal endpoint and writes the response into a button label
  // would otherwise be an exfiltration path, which is why subresources are
  // checked and not only the top-level navigation.
  await context.route('**/*', async (route) => {
    const reqUrl = route.request().url();
    let u;
    try { u = new URL(reqUrl); } catch { log.record(reqUrl, 'unparseable'); return route.abort('blockedbyclient'); }

    if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return route.continue();
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      log.record(reqUrl, `scheme ${u.protocol}`);
      return route.abort('blockedbyclient');
    }
    try {
      await guard(u, (h) => resolver.resolve(h));
    } catch (e) {
      log.record(reqUrl, e.message);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });

  // WebSockets are routed separately by Playwright, so the HTTP route
  // handler above does not see them at all. A hostile page could otherwise
  // open ws://127.0.0.1 and place returned frames into a button label. The
  // measurement needs no sockets, so they are refused outright.
  try {
    await context.routeWebSocket('**', (ws) => ws.close());
  } catch { /* older Playwright: the proxy still fences the connection */ }

  const page = await context.newPage();
  // A modal dialog would hang the run forever, so they are dismissed rather
  // than waited on.
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  page.on('download', (d) => d.cancel().catch(() => {}));

  const consoleErrors = [];
  page.on('pageerror', (e) => { if (consoleErrors.length < 10) consoleErrors.push(String(e.message).slice(0, 200)); });

  let response;
  try {
    response = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: navTimeout });
  } catch (e) {
    await context.close();
    throw new Error(`Could not load ${target.href}: ${e.message.split('\n')[0]}`);
  }

  if (!response) {
    await context.close();
    throw new Error(`No response from ${target.href}.`);
  }
  const status = response.status();
  const contentType = (response.headers()['content-type'] || '').split(';')[0].trim();
  if (contentType && !/^(text\/html|application\/xhtml\+xml)$/.test(contentType)) {
    await context.close();
    throw new Error(`${target.href} served ${contentType || 'an unknown type'}, which is not a web page.`);
  }

  // Redirects are followed inside the browser, so the address that actually
  // loaded is re-checked here rather than assumed to be the one we vetted.
  const finalUrl = page.url();
  try {
    await guard(normaliseTargetUrl(finalUrl), (h) => resolver.resolve(h));
  } catch (e) {
    await context.close();
    throw new Error(`Redirected somewhere we will not load: ${e.message}`);
  }

  // Let late CSS and web fonts land. A font swap changes button sizes, and
  // measuring before it happens produces a report about a page nobody saw.
  try { await page.waitForLoadState('load', { timeout: 8_000 }); } catch { /* slow third party, measure anyway */ }
  try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch { /* no font API */ }
  await page.waitForTimeout(400);

  // page.evaluate runs in the page's own world and calls page-controlled
  // APIs, so a hostile site can replace one of them with an infinite loop and
  // occupy a worker for ever. Playwright has no timeout on evaluate, so the
  // deadline is enforced here and the context is destroyed when it expires.
  let probe;
  const evalTimeoutMs = opts.evalTimeoutMs ?? 15_000;
  try {
    let timer;
    probe = await Promise.race([
      page.evaluate(collectTargets, { selector: TARGET_SELECTOR, maxTargets: opts.maxTargets ?? 1500 }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`measurement did not finish within ${evalTimeoutMs} ms`)), evalTimeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  } catch (e) {
    await context.close().catch(() => {});
    throw new Error(`Could not measure ${finalUrl}: ${e.message.split('\n')[0]}`);
  }

  await context.close();

  // ---- judge, using the same core the page and the tests use -------------

  const pxPerMm = cpiToCssPxPerMm(cpi);
  const rects = probe.targets.map((t) => ({ x: t.x, y: t.y, w: t.w, h: t.h }));
  const spacing = evaluateSpacing(rects);

  // Plane projections are computed once per RECORDING, not per control, so a
  // page with eight hundred targets stays fast. recordingToPath already built
  // the family, because the plane a pointing device moves in is unknown and
  // every figure is published across the whole set.
  const family = opts.path.family?.length
    ? opts.path.family
    : azimuthFamily(opts.path, opts.azimuths ?? 12);

  const elements = probe.targets.map((t, i) => {
    const j = judgeElement(rects[i], spacing[i], family, pxPerMm, { want });
    return {
      tag: t.tag, type: t.type, role: t.role, name: t.name, selector: t.selector,
      x: t.x, y: t.y, w: t.w, h: t.h,
      inViewport: t.inViewport,
      inlineExempt: t.inlineExempt,
      nativeControl: t.nativeControl,
      ...j,
      // The Inline exception is the standard's, so it is applied to the
      // standard's verdict and NOT to ours. A link in a sentence is exempt
      // from the size rule; the hand still has to hit it.
      wcagPass: j.wcagPass || t.inlineExempt,
      wcagExemptReason: j.sizeOk ? null
        : t.inlineExempt ? 'inline, in a sentence'
        : (j.spacingApplies && j.spacingPass) ? 'undersized but adequately spaced'
        : null,
    };
  });

  const summary = summarise(elements, { want });
  const undecidable = elements.filter((e) => !e.sizeOk && !e.wcagPass && e.nativeControl).length;

  // Reported as a page-level finding rather than folded into the element
  // counts, because it multiplies EVERY target at once instead of failing any
  // particular one.
  // Computed here, against the width we ASKED the browser for, because that
  // is the device width the page will really be shown at. Inside the page the
  // layout viewport and innerWidth are the same number and their ratio is
  // always 1, which is exactly the bug a test caught.
  const layoutScale = probe.page.layoutWidth > 0
    ? Math.min(1, viewport.width / probe.page.layoutWidth)
    : 1;
  const warnings = [];
  if (viewportName === 'mobile' && layoutScale < 0.99) {
    const pct = Math.round(layoutScale * 100);
    warnings.push({
      kind: 'no-viewport-meta',
      detail: probe.page.hasViewportMeta
        ? `The page lays out at ${Math.round(probe.page.layoutWidth)} CSS px on a ${viewport.width} px screen, so every target is displayed at ${pct}% of its measured size.`
        : `The page has no viewport meta tag, so a phone lays it out at ${Math.round(probe.page.layoutWidth)} CSS px and shrinks it to fit. Every target below is displayed at about ${pct}% of the size measured here.`,
      layoutScale,
    });
  }

  return {
    url: finalUrl,
    requestedUrl: target.href,
    status,
    title: probe.page.title,
    viewport: { name: viewportName, ...viewport },
    cpi,
    pxPerMm,
    want,
    durationMs: Date.now() - started,
    page: { ...probe.page, layoutScale },
    skipped: probe.skipped,
    truncated: probe.truncated,
    warnings,
    blockedRequests: log.blocked,
    pageErrors: consoleErrors,
    summary: {
      ...summary,
      // Counted separately and never folded into a pass or a fail, because
      // three of the five exceptions in SC 2.5.8 are not decidable from
      // geometry and claiming otherwise would be the kind of overreach that
      // makes a tool untrustworthy.
      notAutomaticallyDecidable: undecidable,
    },
    elements,
  };
}

export { ResolverCache };
