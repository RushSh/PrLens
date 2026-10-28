/** HTTP API (Fastify). Built as a function so tests can run it against a test database. */
import { readdir } from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { experimentRequest, launchRequest, noteUpdate, type ExperimentPlan } from "@bugcensus/shared";
import type { Db } from "./db/client";
import { env } from "./env";
import { importCensus } from "./import/census";
import { importRepository } from "./import/files";
import { importCalibration } from "./import/calibration";
import { importRealism } from "./import/realism";
import { importTriage } from "./import/triage";
import { UserError } from "./errors";
import { command, confirmToken, getAction, listActions, parseParams } from "./experiments";
import type { ImportSummary } from "./import/files";
import type { JobRunner } from "./jobs/runner";
import { availableModels } from "./models";
import {
  distinctFiles,
  getJob,
  getRun,
  getTriagePr,
  listCalibration,
  listJobs,
  listRealism,
  listRuns,
  listTriage,
  setRunNote,
} from "./queries";

const uuidParam = z.object({ id: z.string().uuid() });

export interface AppOptions {
  db: Db;
  runner?: JobRunner;
  /** Override for tests (no Python needed). */
  models?: typeof availableModels;
  root?: string;
  /** Runs an import of the repository's result files (the auto-importer's, when the server has one). */
  onImport?: () => Promise<ImportSummary>;
}

const exec = promisify(execFile);

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: env.NODE_ENV !== "test", bodyLimit: 20 * 1024 * 1024 });
  const { db } = opts;
  const models = opts.models ?? availableModels;
  const root = opts.root ?? env.BUGCENSUS_ROOT;

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: "invalid request", issues: err.issues });
    }
    if (err instanceof UserError) return reply.status(400).send({ error: err.message });
    app.log.error(err);
    return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
  });

  // Any web page open in your browser can send requests to localhost. Requests that change things must
  // carry this header; a browser only lets another site send a custom header after a CORS preflight,
  // which this server never approves. The dashboard and the Python CLI send it.
  app.addHook("onRequest", async (req, reply) => {
    if (req.method !== "GET" && req.method !== "HEAD" && req.headers["x-bugcensus-client"] !== "1") {
      return reply.status(403).send({ error: "missing X-BugCensus-Client header" });
    }
  });

  app.get("/api/health", async () => ({ ok: true }));

  // ---- runs
  app.get("/api/runs", async (req) => {
    const q = z.object({ file: z.string().optional(), model: z.string().optional() }).parse(req.query);
    return listRuns(db, q);
  });
  app.get("/api/runs/:id", async (req, reply) => {
    const { id } = uuidParam.parse(req.params);
    const run = await getRun(db, id);
    return run ?? reply.status(404).send({ error: "run not found" });
  });
  app.patch("/api/runs/:id", async (req, reply) => {
    const { id } = uuidParam.parse(req.params);
    const { note } = noteUpdate.parse(req.body);
    return (await setRunNote(db, id, note)) ? { ok: true } : reply.status(404).send({ error: "run not found" });
  });
  app.get("/api/compare", async (req) => {
    const { ids } = z.object({ ids: z.string() }).parse(req.query);
    const list = z.array(z.string().uuid()).min(1).max(6).parse(ids.split(",").filter(Boolean));
    const runs = await Promise.all(list.map((id) => getRun(db, id)));
    return runs.filter((r) => r !== null);
  });
  app.get("/api/files", async () => {
    const seen = new Set(await distinctFiles(db));
    for (const dir of ["examples"]) {
      try {
        for (const f of await readdir(path.join(root, dir))) if (f.endsWith(".py")) seen.add(`${dir}/${f}`);
      } catch {
        // folder missing: nothing to add
      }
    }
    return [...seen].sort();
  });

  // ---- realism
  app.get("/api/realism", async () => listRealism(db));
  app.get("/api/calibration", async () => listCalibration(db));

  // ---- PR Reviewer triage
  app.get("/api/triage/prs", async () => listTriage(db));
  app.get("/api/triage/prs/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse(req.params);
    return (await getTriagePr(db, id)) ?? reply.status(404).send({ error: "PR not found" });
  });

  // ---- imports (the Python CLI pushes here; `npm run import` reads the files directly)
  app.post("/api/import/census", async (req) => importCensus(db, req.body));
  app.post("/api/import/realism", async (req) => importRealism(db, req.body));
  app.post("/api/import/calibration", async (req) => importCalibration(db, req.body));
  app.post("/api/import/triage", async (req) => importTriage(db, req.body));
  app.post("/api/import/files", async () => (opts.onImport ? opts.onImport() : importRepository(db, root)));

  // ---- launching runs
  app.get("/api/models", async (req) => {
    const { refresh } = z.object({ refresh: z.string().optional() }).parse(req.query);
    return models(refresh === "1");
  });
  app.get("/api/jobs", async () => listJobs(db));
  app.get("/api/jobs/:id", async (req, reply) => {
    const { id } = uuidParam.parse(req.params);
    return (await getJob(db, id)) ?? reply.status(404).send({ error: "job not found" });
  });
  app.post("/api/jobs", async (req, reply) => {
    if (!opts.runner) return reply.status(503).send({ error: "this server does not run jobs" });
    const body = launchRequest.parse(req.body);
    const known = new Map((await models(true)).map((m) => [m.reviewer, m]));
    for (const name of body.panel) {
      const m = known.get(name);
      if (!m) throw new UserError(`unknown reviewer: ${name}`);
      if (!m.ready) throw new UserError(`${name} is not ready: ${m.why}`);
    }
    const id = await opts.runner.enqueue({ ...body, panel: [...new Set(body.panel)] });
    return reply.status(201).send({ id });
  });
  app.post("/api/jobs/:id/cancel", async (req, reply) => {
    if (!opts.runner) return reply.status(503).send({ error: "this server does not run jobs" });
    const { id } = uuidParam.parse(req.params);
    return (await opts.runner.cancel(id)) ? { ok: true } : reply.status(409).send({ error: "job is not queued or running" });
  });

  // ---- experiments (allow-listed steps; paid ones must be planned and confirmed)
  app.get("/api/experiments/actions", async () => listActions(root));
  app.post("/api/experiments/plan", async (req): Promise<ExperimentPlan> => {
    const body = experimentRequest.parse(req.body);
    const action = getAction(body.action);
    if (!action.paid) throw new UserError("this step is free and has no plan");
    const params = await parseParams(action, body.params, root);
    const { program, args } = command(action, params, true);
    try {
      const { stdout, stderr } = await exec(program, args, {
        cwd: root,
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, PYTHONPATH: `${root}/src`, PYTHONUNBUFFERED: "1", BUGCENSUS_API_URL: "" },
      });
      return { ok: true, output: (stdout + stderr).trim(), confirmToken: confirmToken(action.id, params) };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      return { ok: false, output: ((e.stdout ?? "") + (e.stderr ?? "") || e.message).trim(), confirmToken: null };
    }
  });
  app.post("/api/experiments/run", async (req, reply) => {
    if (!opts.runner) return reply.status(503).send({ error: "this server does not run jobs" });
    const body = experimentRequest.parse(req.body);
    const action = getAction(body.action);
    const params = await parseParams(action, body.params, root);
    if (action.paid && body.confirmToken !== confirmToken(action.id, params)) {
      throw new UserError("plan this step first and confirm its cost (the settings changed since the plan, or the server restarted)");
    }
    const { program, args } = command(action, params);
    const id = await opts.runner.enqueueExperiment({
      action: action.id,
      title: action.title,
      lane: action.lane,
      program,
      args,
      settings: params,
      note: body.note,
    });
    return reply.status(201).send({ id });
  });

  return app;
}
