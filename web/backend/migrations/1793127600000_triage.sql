-- Up Migration

-- One set of triaged PRs (scripts/export_triage.py -> data/triage_<name>.json), e.g. the evaluation set.
CREATE TABLE triage_sets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL UNIQUE,
  generated_at  TIMESTAMPTZ NOT NULL,
  model         TEXT NOT NULL,
  threshold     DOUBLE PRECISION NOT NULL,
  alpha         DOUBLE PRECISION NOT NULL,
  summary       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One triaged PR: list columns for the picker, the full PrTriage document in payload.
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

-- Down Migration

DROP TABLE IF EXISTS triage_prs;
DROP TABLE IF EXISTS triage_sets;
