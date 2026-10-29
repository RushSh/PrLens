-- Up Migration

-- What a reviewer reported after reviewing a triaged PR: did a bug turn up in code PR Lens skipped?
-- Each scope's (repository's) adaptive skip threshold is replayed from these rows, oldest first.
CREATE TABLE triage_feedback (
  id          SERIAL PRIMARY KEY,
  scope       TEXT NOT NULL,
  pr_id       TEXT NOT NULL,
  missed      BOOLEAN NOT NULL,
  item_ids    TEXT[] NOT NULL DEFAULT '{}',
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scope, pr_id)
);
CREATE INDEX triage_feedback_scope_idx ON triage_feedback (scope, created_at);
CREATE TRIGGER triage_feedback_updated_at BEFORE UPDATE ON triage_feedback
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Down Migration

DROP TABLE IF EXISTS triage_feedback;
