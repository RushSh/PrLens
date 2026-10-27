-- Up Migration

-- Jobs can now be any allow-listed experiment step, not only a census of one file.
ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'census' CHECK (kind IN ('census', 'experiment'));
ALTER TABLE jobs ADD COLUMN action TEXT;
ALTER TABLE jobs ADD COLUMN title TEXT;
ALTER TABLE jobs ADD COLUMN args TEXT[] NOT NULL DEFAULT '{}';
-- 'models' = calls models (one at a time), 'cpu' = local work (one at a time), 'ops' = quick admin steps
ALTER TABLE jobs ADD COLUMN lane TEXT NOT NULL DEFAULT 'models' CHECK (lane IN ('models', 'cpu', 'ops'));
ALTER TABLE jobs ALTER COLUMN file_path DROP NOT NULL;
ALTER TABLE jobs ALTER COLUMN panel SET DEFAULT '{}';
CREATE INDEX jobs_lane_status_idx ON jobs (lane, status, created_at);

-- Down Migration

DROP INDEX IF EXISTS jobs_lane_status_idx;
DELETE FROM jobs WHERE kind = 'experiment';
ALTER TABLE jobs ALTER COLUMN panel DROP DEFAULT;
ALTER TABLE jobs ALTER COLUMN file_path SET NOT NULL;
ALTER TABLE jobs DROP COLUMN lane;
ALTER TABLE jobs DROP COLUMN args;
ALTER TABLE jobs DROP COLUMN title;
ALTER TABLE jobs DROP COLUMN action;
ALTER TABLE jobs DROP COLUMN kind;
