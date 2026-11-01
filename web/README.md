# PR Lens dashboard

Triaged pull requests, shown the way GitHub shows a PR, plus the evaluation and the pipeline that produces them.
Node.js backend (Fastify, Drizzle ORM, Postgres) and Next.js frontend, all TypeScript, sharing one set of types (`shared/`).

```
web/
├── shared/     triage types + zod schemas for imported files, API types (used by both sides)
├── backend/    API on 127.0.0.1:4000, Postgres access, importer, job runner
└── frontend/   Next.js app on localhost:3000 (calls the backend through /api)
```

## Setup (once)

```bash
cd web
npm install
cp backend/.env.example backend/.env     # set DB_USER / DB_PASSWORD for your local Postgres
```

On start the backend creates the database if it is missing, applies pending migrations, imports `data/triage_*.json`,
and keeps importing whenever those files change.

## Every day

```bash
cd web
npm run dev:backend      # terminal 1
npm run dev:frontend     # terminal 2, then open http://localhost:3000
```

- **Pull requests**: PRs triaged on request, and the evaluation set (real commits with a known bug) with whether PR Lens
  kept the bug for review. Search, filter by repository and outcome.
- **A PR**: *Conversation* (the description, PR Lens's summary comment with the top items, the skip promise, and on
  evaluation PRs a "reveal the real bug" box), *Files changed* (every file, PR Lens comments inline under the flagged
  lines, skipped code collapsed in place with its reason, a review queue in priority order, Viewed and Reviewed
  checkboxes, "Reveal the real bug" on evaluation PRs), *Checks* (the triage as a status check).
- **Evaluation**: lines read against bugs skipped for every threshold, per-repository results, ranking quality, and what
  the numbers do and do not show.
- **Triage a PR**: paste a public GitHub PR link, check the cost, triage it, open it.
- **Pipeline**: every `prlens` step (mine, validate, trace, baseline, score, fit, export) and the Fireworks deployment
  controls; paid steps show calls and cost first and run only after you confirm. One job runs at a time per lane
  (models, this machine, admin).

Light and dark mode follow the system setting.

## Safety

The backend starts processes, so it listens on 127.0.0.1 only and refuses state-changing requests without the
`X-PRLens-Client` header (so other web pages open in your browser cannot start anything). It runs only allow-listed
steps whose command lines it builds itself from validated form values (a PR link must be a GitHub pull request URL),
and refuses a paid step unless it was planned with exactly the same settings (a token from the plan binds the
confirmation to those values). Nothing calls a model until you confirm.

## Checks

```bash
npm run typecheck        # shared, backend, frontend
npm test                 # backend tests against a throwaway real Postgres (embedded-postgres)
npm run build            # production build of the frontend
```
