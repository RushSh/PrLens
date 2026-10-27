# BugCensus dashboard

See every census run, which models reviewed it, and how runs compare; start new runs with any mix of
reviewer models. Node.js backend (Fastify, Drizzle ORM, Postgres) and Next.js frontend, all TypeScript,
sharing one set of types (`shared/`).

```
web/
├── shared/     zod schemas for run files + API types (used by both sides)
├── backend/    API on 127.0.0.1:4000, Postgres access, importer, job runner
└── frontend/   Next.js app on localhost:3000 (calls the backend through /api)
```

## Setup (once)

```bash
cd web
npm install
cp backend/.env.example backend/.env     # set DB_USER / DB_PASSWORD for your local Postgres
```

That is all: on start the backend creates the database if it is missing, applies any pending migrations, imports
every saved run and analysis, and then keeps importing whatever lands in `runs/` and `data/`.

## Every day

```bash
cd web
npm run dev:backend      # terminal 1
npm run dev:frontend     # terminal 2, then open http://localhost:3000
```

- **Runs**: every census, with reviewers (model and provider), verdict, decoys caught, estimate, tokens, time. Tick runs to compare.
- **Run page**: what was tested (file, lines, copies, seed, code version, review prompt), who tested it (model, provider, reasoning effort, token cap), every review call, suspected bugs, each decoy and the finding that caught it, the code with markers.
- **Compare**: runs side by side; differing rows highlighted; decoy-by-decoy outcomes.
- **New run**: choose a file and one or more reviewers. Each shows whether it is ready (key set, local server up, Fireworks deployment set) and a rough cost. Jobs run one at a time; the job page streams progress.
- **Experiments**: every stage from the browser: set up repositories, write and validate decoys (model-written and
  Glimmer token decoys), build realism and calibration units, review, run calibrations, judge findings, analyze, and
  check or delete the Fireworks deployment. Steps that call models or a GPU show a plan with calls and cost first and
  only run after you confirm; free steps run straight away. One job runs at a time per lane (models, this machine,
  admin), so a long test run never blocks a census.
- **Realism checks**: real-bug vs decoy catch rates per reviewer and per decoy family.
- **Calibration**: predicted vs actual hidden bugs (calibration plot with 95% intervals), for each estimator variant, plus coverage, P(clean) reliability, false-clear rate and AUC. See "Calibration" in the main README.

Runs and analyses started from the command line appear too: the backend watches `runs/` and `data/` and imports new
files within seconds. (`npm run import -w backend` still exists for importing without the server.) Realism analyses: `python scripts/realism.py
analyze --name "..." --json data/realism_<name>.json`. Calibration analyses
(`scripts/calibration.py analyze`) are pushed the same way and saved as `data/calibration_<name>.json`.

Runs saved before Oct 27 2026 lack model details. The importer fills them from the defaults of that time
and from `logs/usage.jsonl`, marks them with `*`, and flags Glimmer reviews that hit the old 6,000-token
limit.

## Safety

The backend starts processes, so it listens on 127.0.0.1 only and refuses state-changing requests without the
`X-BugCensus-Client` header (so other web pages open in your browser cannot start anything). It runs only
allow-listed steps whose command lines it builds itself from validated form values, reviews only `.py` files inside
this repository, and refuses a paid step unless it was planned with exactly the same settings (a token from the plan
binds the confirmation to those values). Nothing calls a model until you confirm.

## Checks

```bash
npm run typecheck        # shared, backend, frontend
npm test                 # backend tests against a throwaway real Postgres (embedded-postgres)
npm run build            # production build of the frontend
```
