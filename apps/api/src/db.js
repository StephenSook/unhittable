// db.js - the corpus store.
//
// The API is designed to work without this. If Postgres is unreachable, live
// scanning still runs and only the corpus endpoints report that they are
// unavailable, because a judge pasting a URL should not be blocked by a
// database that has nothing to do with their question. Every function here
// therefore either returns data or throws a plain error the route can turn
// into an honest "corpus unavailable" rather than a 500.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createPool(connectionString) {
  if (!connectionString) return null;
  return new pg.Pool({
    connectionString,
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
    // Neon terminates idle connections; a query that inherits a dead socket
    // should fail fast rather than hang a request.
    statement_timeout: 15_000,
  });
}

export async function migrate(pool) {
  const sql = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

/** Has this exact question already been answered? */
export async function findCached(pool, { url, viewport, cpi, recordingId, maxAgeHours = 24 }) {
  const { rows } = await pool.query(
    `SELECT id, report, scanned_at
       FROM scans
      WHERE requested_url = $1 AND viewport = $2 AND cpi = $3 AND recording_id = $4
        AND scanned_at > now() - ($5 || ' hours')::interval
      LIMIT 1`,
    [url, viewport, cpi, recordingId, String(maxAgeHours)],
  );
  if (rows.length === 0) return null;
  return { id: rows[0].id, report: rows[0].report, scannedAt: rows[0].scanned_at };
}

/**
 * Store a scan and every element it measured.
 *
 * One transaction, because a scan row whose elements failed to insert would
 * quietly corrupt every corpus aggregate afterwards and nothing would say so.
 */
export async function saveScan(pool, report, { recordingId, inCorpus = false }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const host = new URL(report.url).hostname;
    const s = report.summary;
    const { rows } = await client.query(
      `INSERT INTO scans (
         requested_url, final_url, host, viewport, cpi, recording_id, want,
         duration_ms, http_status, title, layout_scale,
         n_targets, n_wcag_pass, n_hand_pass, n_standard_not_hand,
         median_hold, worst_hold, in_corpus, report, scanned_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, now())
       ON CONFLICT (requested_url, viewport, cpi, recording_id) DO UPDATE SET
         final_url = EXCLUDED.final_url, scanned_at = now(), duration_ms = EXCLUDED.duration_ms,
         http_status = EXCLUDED.http_status, title = EXCLUDED.title,
         layout_scale = EXCLUDED.layout_scale,
         n_targets = EXCLUDED.n_targets, n_wcag_pass = EXCLUDED.n_wcag_pass,
         n_hand_pass = EXCLUDED.n_hand_pass, n_standard_not_hand = EXCLUDED.n_standard_not_hand,
         median_hold = EXCLUDED.median_hold, worst_hold = EXCLUDED.worst_hold,
         in_corpus = scans.in_corpus OR EXCLUDED.in_corpus,
         report = EXCLUDED.report
       RETURNING id`,
      [report.requestedUrl, report.url, host, report.viewport.name, report.cpi, recordingId,
       report.want, report.durationMs, report.status, report.title ?? null,
       report.page?.layoutScale ?? null,
       s.n, s.wcagPass, s.handPass, s.passesStandardButNotHand,
       s.medianHold, s.worstHold, inCorpus, report],
    );
    const scanId = rows[0].id;

    await client.query('DELETE FROM elements WHERE scan_id = $1', [scanId]);
    if (report.elements.length) {
      // One multi-row insert rather than a round trip per element: a page with
      // 800 controls would otherwise take longer to store than to measure.
      const cols = 15;
      const values = [];
      const params = [];
      report.elements.forEach((e, i) => {
        const b = i * cols;
        values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13},$${b + 14},$${b + 15})`);
        params.push(scanId, e.tag ?? null, e.role ?? null, (e.name ?? '').slice(0, 300), (e.selector ?? '').slice(0, 500),
          e.w, e.h, e.sizeOk, e.wcagPass, !!e.inlineExempt, e.hold, e.holdBest ?? e.hold, e.holdSpread ?? 0,
          e.bindingSide ?? null, e.passesStandardButNotHand);
      });
      // need_w / need_h are omitted from the bulk insert on purpose: they are
      // recomputable from the report and keeping the row narrow keeps a large
      // page's insert inside one statement.
      await client.query(
        `INSERT INTO elements (scan_id, tag, role, name, selector, w, h, size_ok, wcag_pass,
            inline_exempt, hold, hold_best, hold_spread, binding_side, standard_not_hand)
         VALUES ${values.join(',')}`,
        params,
      );
    }
    await client.query('COMMIT');
    return scanId;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * The published number.
 *
 * Restricted to in_corpus rows so that the headline cannot be moved by a
 * visitor scanning their own staging site, which is the difference between a
 * measurement and a vanity counter.
 */
export async function corpusSummary(pool, recordingId) {
  // Scoped to ONE recording, always. The cache key includes recording_id, so
  // changing the default creates a second set of rows for the same pages
  // rather than replacing them, and an unscoped aggregate then counts every
  // control twice. It did: 3,842 controls were reported as 7,723 and the
  // number looked merely large rather than wrong.
  const { rows: [agg] } = await pool.query(`
    SELECT
      count(DISTINCT s.host)                                   AS sites,
      count(DISTINCT s.id)                                     AS scans,
      count(e.id)                                              AS targets,
      count(*) FILTER (WHERE NOT e.wcag_pass)                  AS fail_standard,
      count(*) FILTER (WHERE e.standard_not_hand)              AS pass_standard_fail_hand,
      count(*) FILTER (WHERE e.hold < 0.95)                    AS below_95,
      count(*) FILTER (WHERE e.hold < 0.5)                     AS below_50,
      count(*) FILTER (WHERE e.binding_side = 'height')        AS limited_by_height,
      count(*) FILTER (WHERE e.binding_side = 'width')         AS limited_by_width,
      avg(e.hold_spread)                                       AS mean_hold_spread,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY e.hold)      AS median_hold,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY e.w)         AS median_w,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY e.h)         AS median_h,
      min(s.scanned_at)                                        AS first_scan,
      max(s.scanned_at)                                        AS last_scan
    FROM scans s
    JOIN elements e ON e.scan_id = s.id
    WHERE s.in_corpus AND ($1::text IS NULL OR s.recording_id = $1)`, [recordingId ?? null]);

  const { rows: sites } = await pool.query(`
    SELECT s.host, s.final_url, s.title, s.n_targets, s.n_wcag_pass,
           s.n_hand_pass, s.n_standard_not_hand, s.median_hold, s.worst_hold,
           s.viewport, s.scanned_at
      FROM scans s
     WHERE s.in_corpus AND ($1::text IS NULL OR s.recording_id = $1)
     ORDER BY s.n_standard_not_hand DESC, s.host
     LIMIT 200`, [recordingId ?? null]);

  return { aggregate: agg, sites };
}

/** Recent ad-hoc scans, for a "what have people been checking" strip. */
export async function recentScans(pool, limit = 12) {
  const { rows } = await pool.query(
    `SELECT host, title, n_targets, n_standard_not_hand, median_hold, viewport, scanned_at
       FROM scans WHERE NOT in_corpus ORDER BY scanned_at DESC LIMIT $1`, [limit]);
  return rows;
}

export async function upsertCorpusSite(pool, { url, label, category }) {
  await pool.query(
    `INSERT INTO corpus_sites (url, label, category) VALUES ($1,$2,$3)
     ON CONFLICT (url) DO UPDATE SET label = EXCLUDED.label, category = EXCLUDED.category`,
    [url, label, category]);
}

export async function listCorpusSites(pool) {
  const { rows } = await pool.query('SELECT url, label, category FROM corpus_sites ORDER BY category, label');
  return rows;
}

export async function recordCorpusError(pool, url, message) {
  await pool.query('UPDATE corpus_sites SET last_error = $2 WHERE url = $1', [url, String(message).slice(0, 400)]);
}
