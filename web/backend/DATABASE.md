# Database Process Guide (PR Lens dashboard)

Postgres holds the triaged pull requests (the evaluation set and PRs triaged on request) and the pipeline
jobs started from the dashboard. The schema is owned by SQL migrations (node-pg-migrate); queries go through
Drizzle ORM for type safety. `src/db/schema.ts` mirrors the migrations, and `npm test` fails if the two disagree.

## TL;DR

| Situation | What to do |
|---|---|
| First setup | copy `.env.example` to `.env` and start the backend: it creates the database, migrates and imports on start |
| Any schema change | `npm run migrate:create -- describe-your-change`, write the SQL, update `src/db/schema.ts`, `npm run migrate`, `npm test` |
| Clean slate (dev) | `npm run db:reset` (drops all PR Lens tables, replays every migration); the backend re-imports on start |
| Load triage results | automatic while the backend runs (it watches `data/`); `npm run import` does the same by hand |

## Rules

- `migrations/1793131200000_initial-schema.sql` is the baseline (the pre-pivot migrations were squashed into
  it on Oct 28 2026). Never edit a migration that has run; add a new timestamped file instead
  (node-pg-migrate records applied files in `pgmigrations`).
- `DATABASE_URL` (used by node-pg-migrate) must point at the same database as `DB_*` (used by the app):
  `DATABASE_URL=postgres://<DB_USER>:<DB_PASSWORD>@<DB_HOST>:<DB_PORT>/<DB_NAME>`
- `db:reset` refuses to run with `NODE_ENV=production`. All data is lost, but nothing original is:
  `data/triage_*.json` are the source of truth and are re-imported automatically.

## Key constraints

| Table | Constraint | Why |
|---|---|---|
| `triage_sets` | `UNIQUE(name)` | One row per set (`eval`, `live`); a newer export replaces the older one, an unchanged file is skipped. |
| `triage_prs` | `UNIQUE(set_id, pr_id)` | A PR appears once per set; deleting a set deletes its PRs. |

## Tables

| Table | Description |
|---|---|
| `triage_sets` | One set of triaged PRs: model, skip threshold, miss bound, summary, and (for the evaluation set) the evaluation curve |
| `triage_prs` | One triaged PR: list columns (repo, title, lines to read, caught or not) and the full `PrTriage` document (`payload`) |
| `jobs` | A pipeline step started from the dashboard (allow-listed `action`, `args`), its lane (`models`, `cpu`, `ops`), status, live log, and the PR it produced (`pr_id`) |
