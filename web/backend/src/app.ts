/** HTTP API (Fastify). Built as a function so tests can run it against a test database. */
import { readdir } from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { launchRequest, noteUpdate } from "@bugcensus/shared";
import type { Db } from "./db/client";
import { env } from "./env";
import { importCensus } from "./import/census";
import { importRepository } from "./import/files";
import { importCalibration } from "./import/calibration";
import { importRealism } from "./import/realism";
import { JobRunner, UserError } from "./jobs/runner";
import { availableModels } from "./models";
import {
  distinctFiles,
  getJob,
  getRun,
  listCalibration,
  listJobs,
  listRealism,
  listRuns,
  setRunNote,
} from "./queries";

const uuidParam = z.object({ id: z.string().uuid() });

export interface AppOptions {
  db: Db;
  runner?: JobRunner;
  /** Override for tests (no Python needed). */
  models?: typeof availableModels;
  root?: string;
}

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

  // ---- imports (the Python CLI pushes here; `npm run import` reads the files directly)
  app.post("/api/import/census", async (req) => importCensus(db, req.body));
  app.post("/api/import/realism", async (req) => importRealism(db, req.body));
  app.post("/api/import/calibration", async (req) => importCalibration(db, req.body));
  app.post("/api/import/files", async () => importRepository(db, root));

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

  return app;
}
