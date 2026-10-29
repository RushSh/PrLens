-- Up Migration

-- PR Lens: triaged pull requests and the pipeline jobs started from the dashboard.

CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- One set of triaged PRs: "eval" (real commits with a known bug, from `prlens export`) or "live"
-- (PRs triaged on request, from `prlens triage-pr`). Files data/triage_<name>.json are imported automatically.
CREATE TABLE triage_sets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL UNIQUE,
  generated_at  TIMESTAMPTZ NOT NULL,
  model         TEXT NOT NULL,
  threshold     DOUBLE PRECISION NOT NULL,
  alpha         DOUBLE PRECISION NOT NULL,
  summary       JSONB NOT NULL,
  evaluation    JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One triaged PR: list columns for the PR list, the full PrTriage document in payload.
CREATE TABLE triage_prs (
  id               SERIAL PRIMARY KEY,
  set_id           UUID NOT NULL REFERENCES triage_sets(id) ON DELETE CASCADE,
  pr_id            TEXT NOT NULL,
  repo             TEXT NOT NULL,
  title            TEXT NOT NULL,
  opened_at        TEXT NOT NULL,
  review_count     INTEGER NOT NULL,
  skip_count       INTEGER NOT NULL,
  read_lines       INTEGER NOT NULL,
  total_lines      INTEGER NOT NULL,
  caught_by_triage BOOLEAN,
  payload          JSONB NOT NULL,
  UNIQUE (set_id, pr_id)
);
CREATE INDEX triage_prs_set_idx ON triage_prs (set_id);
CREATE INDEX triage_prs_pr_idx ON triage_prs (pr_id);

-- A pipeline step started from the dashboard (allow-listed in src/pipeline.ts). Lanes run one job at a time:
-- 'models' = calls models, 'cpu' = local work, 'ops' = quick admin steps.
CREATE TABLE jobs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status       TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  action       TEXT NOT NULL,
  title        TEXT NOT NULL,
  lane         TEXT NOT NULL DEFAULT 'cpu' CHECK (lane IN ('models', 'cpu', 'ops')),
  args         TEXT[] NOT NULL DEFAULT '{}',
  settings     JSONB NOT NULL DEFAULT '{}',
  note         TEXT,
  log          TEXT NOT NULL DEFAULT '',
  error        TEXT,
  pr_id        TEXT,
  pid          INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX jobs_lane_status_idx ON jobs (lane, status, created_at);
CREATE TRIGGER jobs_updated_at BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Down Migration

DROP TABLE IF EXISTS jobs;
DROP TABLE IF EXISTS triage_prs;
DROP TABLE IF EXISTS triage_sets;
DROP FUNCTION IF EXISTS update_updated_at_column();
