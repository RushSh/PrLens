# Database Process Guide (BugCensus dashboard)

Postgres holds every census run, the models that reviewed it, and realism checks, so runs can be
compared over time. The schema is owned by SQL migrations (node-pg-migrate); queries go through
Drizzle ORM for type safety. `src/db/schema.ts` mirrors the migrations, and `npm test` fails if the
two disagree.

## TL;DR

| Situation | What to do |
|---|---|
| First setup | `createdb bugcensus`, copy `.env.example` to `.env`, `npm run migrate`, `npm run import` |
| Any schema change | `npm run migrate:create -- describe-your-change`, write the SQL, update `src/db/schema.ts`, `npm run migrate`, `npm test` |
| Clean slate (dev) | `npm run db:reset` (drops all BugCensus tables, replays every migration), then `npm run import` |
| Load saved runs | `npm run import` (reads `runs/*.json` and `data/realism_*.json`; safe to repeat) |

## Rules

- `migrations/1793116800000_initial-schema.sql` is the baseline. Never edit a migration that has run;
  add a new timestamped file instead (node-pg-migrate records applied files in `pgmigrations`).
- `DATABASE_URL` (used by node-pg-migrate) must point at the same database as `DB_*` (used by the app):
  `DATABASE_URL=postgres://<DB_USER>:<DB_PASSWORD>@<DB_HOST>:<DB_PORT>/<DB_NAME>`
- `db:reset` refuses to run with `NODE_ENV=production`. All data is lost, but nothing original is:
  the run files in `runs/` and `data/` are the source of truth and `npm run import` reloads them.

## Key constraints

| Table | Constraint | Why |
|---|---|---|
| `runs` | `UNIQUE(run_key)` | One row per run. `run_key` is the Python `run_id`, or `legacy:<file name>` for runs saved before Oct 27 2026, so importing twice is a no-op. |
| `run_models` | `UNIQUE(run_id, reviewer)` | A reviewer name means one model within a run. |
| `realism_experiments` | `UNIQUE(exp_key)` | Re-analysing the same reviews replaces the older analysis instead of duplicating it. |

## Tables

| Table | Description |
|---|---|
| `jobs` | Runs started from the dashboard: file, chosen reviewers, settings, status, live log |
| `runs` | One census of one file: verdict, estimate, decoy counts, tokens, prompt and code version, the full report (`raw`) |
| `run_models` | Which model, provider, reasoning effort and token cap each reviewer used in that run (`inferred` for older runs) |
| `reviews` | One row per review call (reviewer × version): tokens, time, finish reason, error |
| `findings` | Every finding from every review call |
| `suspected_bugs` | Findings from the original version, grouped into suspected bugs |
| `decoys` | Each planted decoy: family, function, line, caught by whom, matching finding |
| `realism_experiments` | One realism check (real bugs vs decoys) |
| `realism_reviewer_stats` | Per reviewer (and panel) catch rates, logit gap, 95% CI |
| `realism_families` | Panel catch rate per decoy family |
