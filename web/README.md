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
createdb bugcensus                       # your local Postgres
cp backend/.env.example backend/.env     # set DB_USER / DB_PASSWORD / DATABASE_URL
npm run migrate -w backend
npm run import -w backend                # loads runs/*.json and data/realism_*.json
```

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
- **Realism checks**: real-bug vs decoy catch rates per reviewer and per decoy family.

Runs started from the command line are saved too: they are written to `runs/` as before, and if
`BUGCENSUS_API_URL=http://127.0.0.1:4000` is set in the repo's `.env` they also appear in the dashboard
right away (otherwise run `npm run import -w backend`). Realism analyses: `python scripts/realism.py
analyze --name "..." --json data/realism_<name>.json`.

Runs saved before Oct 27 2026 lack model details. The importer fills them from the defaults of that time
and from `logs/usage.jsonl`, marks them with `*`, and flags Glimmer reviews that hit the old 6,000-token
limit.

## Safety

The backend starts Python processes, so it listens on 127.0.0.1 only, accepts only `.py` files inside
this repository, and refuses state-changing requests without the `X-BugCensus-Client` header (so other web
pages open in your browser cannot start runs). Nothing calls a model until you press Run.

## Checks

```bash
npm run typecheck        # shared, backend, frontend
npm test                 # backend tests against a throwaway real Postgres (embedded-postgres)
npm run build            # production build of the frontend
```
