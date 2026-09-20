// server.js - the scanning service.
//
// Three design rules, each of which exists because of a specific way this
// kind of service fails:
//
//   1. The browser is launched once and kept warm. A cold Chromium start is
//      several seconds, and a judge who waits ten seconds for a first result
//      concludes the thing is broken.
//   2. Scans are serialised through a small queue. Each scan is a browser
//      context with a live page, and an unbounded number of them is how a
//      512 MB instance dies.
//   3. Nothing that needs Postgres is on the path of a live scan. If the
//      database is unreachable, scanning still works and only the corpus
//      endpoints say so.

import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { chromium } from 'playwright-core';
import { scanUrl, ResolverCache, VIEWPORTS, USER_AGENT } from './scanner.js';
import { createGuardProxy } from './guard-proxy.js';
import { loadRecordings, getRecording, DEFAULT_RECORDING } from './recordings.js';
import * as db from './db.js';
import { normaliseTargetUrl } from '@unhittable/core/url-guard.js';
import { WCAG_MIN_PX, WCAG_ENHANCED_PX } from '@unhittable/core/geometry.js';

const PORT = Number(process.env.PORT || 8791);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_CONCURRENT_SCANS = Number(process.env.MAX_CONCURRENT_SCANS || 2);
const CACHE_HOURS = Number(process.env.CACHE_HOURS || 24);

/** A queue with a hard ceiling, so load sheds instead of the process dying. */
class ScanQueue {
  constructor(limit) { this.limit = limit; this.active = 0; this.waiting = []; }
  get depth() { return this.waiting.length; }
  async run(fn) {
    if (this.active >= this.limit && this.waiting.length >= 12) {
      const e = new Error('Too many scans in flight. Try again in a moment.');
      e.statusCode = 503;
      throw e;
    }
    if (this.active >= this.limit) await new Promise((r) => this.waiting.push(r));
    this.active++;
    try { return await fn(); }
    finally {
      this.active--;
      const next = this.waiting.shift();
      if (next) next();
    }
  }
}

export async function build({ logger = true } = {}) {
  const app = Fastify({
    logger,
    bodyLimit: 64 * 1024,
    trustProxy: true,
  });

  const allowed = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  await app.register(cors, {
    origin: allowed.length ? allowed : true,
    methods: ['GET', 'POST', 'OPTIONS'],
  });
  await app.register(rateLimit, {
    max: Number(process.env.RATE_LIMIT || 40),
    timeWindow: '1 minute',
    // Scanning costs a browser context, so it is limited harder than reading.
    keyGenerator: (req) => req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip,
  });

  const recordings = loadRecordings();
  const pool = db.createPool(process.env.DATABASE_URL);
  const resolver = new ResolverCache();
  const queue = new ScanQueue(MAX_CONCURRENT_SCANS);

  // One proxy for the process. Every scan's browser context routes through
  // it, and it is the only component that opens a socket to the outside.
  const guardProxy = createGuardProxy();
  const proxyUrl = await guardProxy.listen();
  app.log.info({ proxyUrl }, 'connection fence listening');

  let browser = null;
  let browserError = null;
  async function getBrowser() {
    if (browser && browser.isConnected()) return browser;
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',                      // required inside a container
        '--disable-dev-shm-usage',           // /dev/shm is tiny on most hosts
        '--disable-gpu',
        '--no-zygote',
        '--disable-background-networking',
        '--disable-extensions',
      ],
    });
    browser.on('disconnected', () => { browser = null; });
    return browser;
  }

  if (pool) {
    try { await db.migrate(pool); app.log.info('database ready'); }
    catch (e) { app.log.error({ err: e.message }, 'migration failed; corpus endpoints will report unavailable'); }
  } else {
    app.log.warn('no DATABASE_URL; corpus endpoints will report unavailable');
  }

  // ---- routes -----------------------------------------------------------

  app.get('/health', async () => ({
    ok: true,
    // Reported honestly and separately, so a green health check can never
    // mean "the database is fine" when it is not.
    browser: browser?.isConnected() ? 'warm' : 'cold',
    browserError,
    database: pool ? 'configured' : 'absent',
    connectionFence: 'active',
    recordings: recordings.ids.length,
    queueDepth: queue.depth,
    uptimeSeconds: Math.round(process.uptime()),
    version: '1.0.0',
  }));

  app.get('/api/recordings', async () => ({
    default: DEFAULT_RECORDING,
    dataset: recordings.manifest,
  }));

  app.get('/api/constants', async () => ({
    wcagMinPx: WCAG_MIN_PX,
    wcagEnhancedPx: WCAG_ENHANCED_PX,
    viewports: Object.fromEntries(Object.entries(VIEWPORTS).map(([k, v]) => [k, { width: v.width, height: v.height, label: v.label }])),
    userAgent: USER_AGENT,
    cacheHours: CACHE_HOURS,
  }));

  app.post('/api/scan', {
    config: { rateLimit: { max: Number(process.env.SCAN_RATE_LIMIT || 10), timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['url'],
        additionalProperties: false,
        properties: {
          url: { type: 'string', maxLength: 2048 },
          viewport: { type: 'string', enum: ['desktop', 'mobile'] },
          cpi: { type: 'integer', minimum: 200, maximum: 1600 },
          recording: { type: 'string', maxLength: 80 },
          fresh: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    const { url, viewport = 'desktop', cpi = 800, recording: recId = DEFAULT_RECORDING, fresh = false } = req.body;

    const rec = getRecording(recId);
    if (!rec) return reply.code(400).send({ error: `Unknown recording "${recId}".`, available: recordings.ids });

    let normalised;
    try { normalised = normaliseTargetUrl(url); }
    catch (e) { return reply.code(400).send({ error: e.message }); }

    if (pool && !fresh) {
      try {
        const hit = await db.findCached(pool, {
          url: normalised.href, viewport, cpi, recordingId: rec.id, maxAgeHours: CACHE_HOURS,
        });
        if (hit) return { ...hit.report, cached: true, scannedAt: hit.scannedAt };
      } catch (e) { req.log.warn({ err: e.message }, 'cache lookup failed, scanning fresh'); }
    }

    let report;
    try {
      const b = await getBrowser();
      report = await queue.run(() => scanUrl({ browser: b, resolver }, {
        url: normalised.href, path: rec.path, cpi, viewport, proxyUrl,
      }));
    } catch (e) {
      const code = e.statusCode || (/Refusing|not a web page|Could not load|Could not resolve|does not resolve/.test(e.message) ? 400 : 500);
      if (code === 500) { browserError = e.message; req.log.error({ err: e.message }, 'scan failed'); }
      return reply.code(code).send({ error: e.message });
    }

    report.recording = {
      id: rec.id,
      condition: rec.meta.condition,
      hz: rec.meta.hz,
      p2pMm: rec.meta.p2pMm,
      detectable: rec.meta.detectable,
    };
    report.cached = false;

    if (pool) {
      db.saveScan(pool, report, { recordingId: rec.id })
        .catch((e) => req.log.warn({ err: e.message }, 'could not store scan'));
    }
    return report;
  });

  app.get('/api/corpus', async (req, reply) => {
    if (!pool) return reply.code(503).send({ error: 'The corpus store is not configured on this instance.' });
    try { return await db.corpusSummary(pool); }
    catch (e) { return reply.code(503).send({ error: `Corpus unavailable: ${e.message}` }); }
  });

  app.get('/api/recent', async (req, reply) => {
    if (!pool) return reply.code(503).send({ error: 'The corpus store is not configured on this instance.' });
    try { return { scans: await db.recentScans(pool, 12) }; }
    catch (e) { return reply.code(503).send({ error: `Unavailable: ${e.message}` }); }
  });

  app.addHook('onClose', async () => {
    await browser?.close().catch(() => {});
    await guardProxy.close().catch(() => {});
    await pool?.end().catch(() => {});
  });

  app.decorate('warmUp', async () => { try { await getBrowser(); } catch (e) { browserError = e.message; } });
  app.decorate('pool', pool);
  return app;
}

// Only start a server when run directly, so the test suite can build the app
// without binding a port.
//
// pathToFileURL rather than string concatenation: import.meta.url is
// percent-encoded, so a repository path containing a space compares unequal
// to `file://` + argv[1] and the server silently never listens. That failure
// mode prints nothing at all, which is the worst kind.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await build();
  await app.listen({ port: PORT, host: HOST });
  // Pay the Chromium start-up cost now rather than on a visitor's first scan.
  app.warmUp().then(() => app.log.info('browser warm'));
}
