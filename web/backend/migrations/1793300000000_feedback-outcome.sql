-- Up Migration

-- Bug-conditional adaptive updates: a reviewer reports where a bug surfaced, not just whether one was missed.
--   bug_skipped  - a bug was in code PR Lens skipped        (err 1: the threshold tightens)
--   bug_reviewed - a bug was in code PR Lens sent to review (err 0: the threshold loosens)
--   no_bug       - no bug surfaced                          (recorded, no update)
-- Earlier "nothing missed" rows did not say whether a bug surfaced, so they become no_bug.
ALTER TABLE triage_feedback ADD COLUMN outcome TEXT NOT NULL DEFAULT 'no_bug'
  CHECK (outcome IN ('bug_skipped', 'bug_reviewed', 'no_bug'));
UPDATE triage_feedback SET outcome = 'bug_skipped' WHERE missed;
ALTER TABLE triage_feedback DROP COLUMN missed;

-- Down Migration

ALTER TABLE triage_feedback ADD COLUMN missed BOOLEAN NOT NULL DEFAULT false;
UPDATE triage_feedback SET missed = (outcome = 'bug_skipped');
ALTER TABLE triage_feedback DROP COLUMN outcome;
