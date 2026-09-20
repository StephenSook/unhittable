-- Unhittable corpus schema.
--
-- Two things are stored and they answer different questions. A SCAN is one
-- measurement of one page, and it is what a visitor gets back. An ELEMENT row
-- is one measured control, and it exists so that corpus-wide questions can be
-- asked of real measurements rather than of remembered summaries: how small is
-- the median button on the web, which axis usually fails, how many controls
-- satisfy the standard and still cannot be held.
--
-- Every column here is measured. Nothing in this database is seeded with a
-- figure that was not produced by loading a real page in a real browser.

CREATE TABLE IF NOT EXISTS scans (
  id                BIGSERIAL PRIMARY KEY,
  requested_url     TEXT        NOT NULL,
  final_url         TEXT        NOT NULL,
  host              TEXT        NOT NULL,
  viewport          TEXT        NOT NULL,
  cpi               INTEGER     NOT NULL,
  recording_id      TEXT        NOT NULL,
  want              REAL        NOT NULL,
  scanned_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms       INTEGER     NOT NULL,
  http_status       INTEGER,
  title             TEXT,
  layout_scale      REAL,
  -- Summary counts, denormalised so the corpus page is one query.
  n_targets         INTEGER     NOT NULL,
  n_wcag_pass       INTEGER     NOT NULL,
  n_hand_pass       INTEGER     NOT NULL,
  n_standard_not_hand INTEGER   NOT NULL,
  median_hold       DOUBLE PRECISION,
  worst_hold        DOUBLE PRECISION,
  -- Whether this row is part of the published corpus or an ad-hoc scan a
  -- visitor asked for. The published number must not move because someone
  -- scanned their own staging site.
  in_corpus         BOOLEAN     NOT NULL DEFAULT FALSE,
  report            JSONB       NOT NULL
);

-- The cache key. A repeat of the same question returns the same answer
-- instead of loading someone else's page again.
CREATE UNIQUE INDEX IF NOT EXISTS scans_lookup
  ON scans (requested_url, viewport, cpi, recording_id);
CREATE INDEX IF NOT EXISTS scans_host      ON scans (host);
CREATE INDEX IF NOT EXISTS scans_recent    ON scans (scanned_at DESC);
CREATE INDEX IF NOT EXISTS scans_corpus    ON scans (in_corpus) WHERE in_corpus;

CREATE TABLE IF NOT EXISTS elements (
  id            BIGSERIAL PRIMARY KEY,
  scan_id       BIGINT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  tag           TEXT,
  role          TEXT,
  name          TEXT,
  selector      TEXT,
  w             DOUBLE PRECISION NOT NULL,
  h             DOUBLE PRECISION NOT NULL,
  size_ok       BOOLEAN NOT NULL,
  wcag_pass     BOOLEAN NOT NULL,
  inline_exempt BOOLEAN NOT NULL DEFAULT FALSE,
  -- hold is the WORST azimuth, because the recovered horizontal frame has an
  -- arbitrary heading. hold_best and hold_spread publish how much that
  -- unknowable rotation is worth rather than hiding it inside one number.
  hold          DOUBLE PRECISION NOT NULL,
  hold_best     DOUBLE PRECISION NOT NULL,
  hold_spread   DOUBLE PRECISION NOT NULL,
  binding_side  TEXT,   -- 'width' or 'height': a property of the ELEMENT
  need_w        DOUBLE PRECISION,
  need_h        DOUBLE PRECISION,
  standard_not_hand BOOLEAN NOT NULL
);
CREATE INDEX IF NOT EXISTS elements_scan ON elements (scan_id);
CREATE INDEX IF NOT EXISTS elements_corpus_hold ON elements (hold);

-- The list of sites the published corpus is drawn from, so the corpus is a
-- DEFINED set that can be re-run and audited, not an accumulation of whatever
-- strangers happened to paste in.
CREATE TABLE IF NOT EXISTS corpus_sites (
  url        TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  category   TEXT NOT NULL,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT
);
