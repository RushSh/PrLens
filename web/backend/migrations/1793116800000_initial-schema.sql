-- Up Migration

CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A census run launched from the dashboard. The Python process it starts produces one row in runs.
CREATE TABLE jobs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status       TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  file_path    TEXT NOT NULL,
  panel        TEXT[] NOT NULL,
  settings     JSONB NOT NULL DEFAULT '{}'::jsonb,
  note         TEXT,
  log          TEXT NOT NULL DEFAULT '',
  error        TEXT,
  run_id       UUID,
  pid          INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX jobs_status_created_idx ON jobs (status, created_at);
CREATE TRIGGER jobs_updated_at BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- One census of one file. run_key is the Python run_id (or the file name for runs saved before
-- Oct 27 2026), so importing the same file twice is a no-op.
CREATE TABLE runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_key             TEXT NOT NULL UNIQUE,
  job_id              UUID REFERENCES jobs(id) ON DELETE SET NULL,
  schema_version      INTEGER NOT NULL,
  file_path           TEXT NOT NULL,
  source              TEXT,
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  seconds             DOUBLE PRECISION,
  git_sha             TEXT,
  prompt_sha          TEXT,
  settings            JSONB NOT NULL DEFAULT '{}'::jsonb,
  changed_lines       INTEGER,
  found_counted       INTEGER NOT NULL,
  found_is_verified   BOOLEAN NOT NULL DEFAULT false,
  decoys_counted      INTEGER NOT NULL,
  decoys_missed       INTEGER NOT NULL,
  decoys_not_reviewed INTEGER NOT NULL DEFAULT 0,
  expected_hidden     DOUBLE PRECISION,
  p_clean             DOUBLE PRECISION,
  interval_low        INTEGER,
  interval_high       INTEGER,
  q_mean              DOUBLE PRECISION,
  hidden_status       TEXT,
  verdict             TEXT NOT NULL,
  tokens_in           INTEGER,
  tokens_out          INTEGER,
  errors              TEXT[] NOT NULL DEFAULT '{}',
  metadata_inferred   BOOLEAN NOT NULL DEFAULT false,
  note                TEXT,
  raw                 JSONB NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX runs_finished_idx ON runs (finished_at DESC);
CREATE INDEX runs_file_idx ON runs (file_path);
CREATE TRIGGER runs_updated_at BEFORE UPDATE ON runs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Which model each reviewer name pointed at in that run.
CREATE TABLE run_models (
  id                SERIAL PRIMARY KEY,
  run_id            UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  reviewer          TEXT NOT NULL,
  model_id          TEXT NOT NULL,
  provider          TEXT NOT NULL,
  endpoint          TEXT,
  open_weights      BOOLEAN NOT NULL DEFAULT false,
  reasoning_effort  TEXT,
  max_tokens        INTEGER,
  inferred          BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (run_id, reviewer)
);
CREATE INDEX run_models_model_idx ON run_models (model_id);

-- One call: one reviewer on one version (original, copy-A, ...).
CREATE TABLE reviews (
  id              SERIAL PRIMARY KEY,
  run_id          UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  reviewer        TEXT NOT NULL,
  version         TEXT NOT NULL,
  findings_count  INTEGER,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  seconds         DOUBLE PRECISION,
  finish_reason   TEXT,
  error           TEXT,
  inferred        BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX reviews_run_idx ON reviews (run_id);

CREATE TABLE findings (
  id           SERIAL PRIMARY KEY,
  run_id       UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  reviewer     TEXT NOT NULL,
  version      TEXT NOT NULL,
  start_line   INTEGER NOT NULL,
  end_line     INTEGER NOT NULL,
  category     TEXT,
  explanation  TEXT
);
CREATE INDEX findings_run_idx ON findings (run_id);

CREATE TABLE suspected_bugs (
  id            SERIAL PRIMARY KEY,
  run_id        UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  start_line    INTEGER NOT NULL,
  end_line      INTEGER NOT NULL,
  reviewers     TEXT[] NOT NULL,
  explanations  TEXT[] NOT NULL
);
CREATE INDEX suspected_bugs_run_idx ON suspected_bugs (run_id);

CREATE TABLE decoys (
  id             SERIAL PRIMARY KEY,
  run_id         UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  copy_name      TEXT NOT NULL,
  kind           TEXT,
  function_name  TEXT,
  line           INTEGER,
  line_in_copy   INTEGER,
  description    TEXT NOT NULL,
  caught_by      TEXT[] NOT NULL DEFAULT '{}',
  not_reviewed   BOOLEAN NOT NULL DEFAULT false,
  matched        JSONB NOT NULL DEFAULT '[]'::jsonb,
  too_wide       JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX decoys_run_idx ON decoys (run_id);

-- Realism checks: are decoys caught about as often as real bugs?
CREATE TABLE realism_experiments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exp_key        TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  analyzed_at    TIMESTAMPTZ NOT NULL,
  bugs           INTEGER NOT NULL,
  units          INTEGER NOT NULL,
  repos          INTEGER NOT NULL,
  max_span       INTEGER NOT NULL,
  output_tokens  INTEGER NOT NULL,
  models         JSONB NOT NULL,
  miss_all       JSONB NOT NULL,
  raw            JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE realism_reviewer_stats (
  id             SERIAL PRIMARY KEY,
  experiment_id  UUID NOT NULL REFERENCES realism_experiments(id) ON DELETE CASCADE,
  reviewer       TEXT NOT NULL,
  real_rate      DOUBLE PRECISION NOT NULL,
  real_n         INTEGER NOT NULL,
  decoy_rate     DOUBLE PRECISION NOT NULL,
  decoy_n        INTEGER NOT NULL,
  gap_logit      DOUBLE PRECISION NOT NULL,
  ci_low         DOUBLE PRECISION NOT NULL,
  ci_high        DOUBLE PRECISION NOT NULL,
  UNIQUE (experiment_id, reviewer)
);

CREATE TABLE realism_families (
  id             SERIAL PRIMARY KEY,
  experiment_id  UUID NOT NULL REFERENCES realism_experiments(id) ON DELETE CASCADE,
  family         TEXT NOT NULL,
  rate           DOUBLE PRECISION NOT NULL,
  n              INTEGER NOT NULL,
  UNIQUE (experiment_id, family)
);

-- Down Migration

DROP TABLE IF EXISTS realism_families;
DROP TABLE IF EXISTS realism_reviewer_stats;
DROP TABLE IF EXISTS realism_experiments;
DROP TABLE IF EXISTS decoys;
DROP TABLE IF EXISTS suspected_bugs;
DROP TABLE IF EXISTS findings;
DROP TABLE IF EXISTS reviews;
DROP TABLE IF EXISTS run_models;
DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS jobs;
DROP FUNCTION IF EXISTS update_updated_at_column();
