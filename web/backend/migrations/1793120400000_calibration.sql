-- Up Migration

-- One calibration analysis (scripts/calibration.py analyze): predicted vs actual hidden bugs.
CREATE TABLE calibration_experiments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exp_key          TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  tag              TEXT NOT NULL,
  analyzed_at      TIMESTAMPTZ NOT NULL,
  dry_run          BOOLEAN NOT NULL DEFAULT false,
  n_units          INTEGER NOT NULL,
  repos            INTEGER NOT NULL,
  decoys_per_unit  DOUBLE PRECISION NOT NULL,
  decoy_miss_rate  DOUBLE PRECISION NOT NULL,
  models           JSONB NOT NULL,
  design           JSONB NOT NULL,
  calls            JSONB NOT NULL,
  variants         JSONB NOT NULL,
  notes            TEXT[] NOT NULL DEFAULT '{}',
  raw              JSONB NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-unit truth and predictions, for drilling into a calibration.
CREATE TABLE calibration_units (
  id                SERIAL PRIMARY KEY,
  experiment_id     UUID NOT NULL REFERENCES calibration_experiments(id) ON DELETE CASCADE,
  unit_id           TEXT NOT NULL,
  repo              TEXT NOT NULL,
  k                 INTEGER NOT NULL,
  lines             INTEGER NOT NULL,
  found_verified    INTEGER NOT NULL,
  found_unverified  INTEGER NOT NULL,
  decoys            INTEGER NOT NULL,
  missed            INTEGER NOT NULL,
  actual_hidden     INTEGER NOT NULL,
  pred              JSONB NOT NULL,
  UNIQUE (experiment_id, unit_id)
);
CREATE INDEX calibration_units_exp_idx ON calibration_units (experiment_id);

-- Down Migration

DROP TABLE IF EXISTS calibration_units;
DROP TABLE IF EXISTS calibration_experiments;
