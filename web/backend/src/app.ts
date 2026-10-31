/** HTTP API (Fastify). Built as a function so tests can run it against a test database. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { feedbackRequest, pipelineRequest, type PipelinePlan } from "@prlens/shared";
import type { Db } from "./db/client";
import { env } from "./env";
import { UserError } from "./errors";
import { importRepository, type ImportSummary } from "./import/files";
import { importTriage } from "./import/triage";
import type { JobRunner } from "./jobs/runner";
import { availableModels } from "./models";
import { command, confirmToken, getAction, listActions, parseParams, PR_URL } from "./pipeline";
import {
  adaptiveAll,
  adaptiveFor,
  getFeedback,
  getJob,
  getTriagePr,
  getTriageSet,
  listJobs,
  listTriage,
  recordFeedback,
} from "./queries";

const uuidParam = z.object({ id: z.string().uuid() });

export interface AppOptions {
  db: Db;
  runner?: JobRunner;
  /** Override for tests (no Python needed). */
  models?: typeof availableModels;
  root?: string;
  /** Runs an import of the repository's triage files (the auto-importer's, when the server has one). */
  onImport?: () => Promise<ImportSummary>;
}

const exec = promisify(execFile);

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: env.NODE_ENV !== "test", bodyLimit: 20 * 1024 * 1024 });
  const { db } = opts;
  const models = opts.models ?? availableModels;
  const root = opts.root ?? env.PRLENS_ROOT;

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
  // which this server never approves. The dashboard sends it.
  app.addHook("onRequest", async (req, reply) => {
    if (req.method !== "GET" && req.method !== "HEAD" && req.headers["x-prlens-client"] !== "1") {
      return reply.status(403).send({ error: "missing X-PRLens-Client header" });
    }
  });

  app.get("/api/health", async () => ({ ok: true }));

  // ---- triaged PRs
  app.get("/api/triage/prs", async () => listTriage(db));
  app.get("/api/triage/prs/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(300) }).parse(req.params);
    return (await getTriagePr(db, id)) ?? reply.status(404).send({ error: "PR not found" });
  });
  app.get("/api/triage/sets/:name", async (req, reply) => {
    const { name } = z.object({ name: z.string().regex(/^[a-z0-9_-]+$/) }).parse(req.params);
    return (await getTriageSet(db, name)) ?? reply.status(404).send({ error: "set not found" });
  });

  // ---- feedback: where did a bug surface (skipped code, reviewed code, none)? Each repository's skip threshold adapts
  // to the PRs where one did.
  const prParam = z.object({ id: z.string().min(1).max(300) });
  app.get("/api/triage/prs/:id/feedback", async (req, reply) => {
    const { id } = prParam.parse(req.params);
    const pr = await getTriagePr(db, id);
    if (!pr) return reply.status(404).send({ error: "PR not found" });
    return { feedback: await getFeedback(db, pr.repo, id), adaptive: await adaptiveFor(db, pr.repo) };
  });
  app.post("/api/triage/prs/:id/feedback", async (req, reply) => {
    const { id } = prParam.parse(req.params);
    const body = feedbackRequest.parse(req.body);
    const pr = await getTriagePr(db, id);
    if (!pr) return reply.status(404).send({ error: "PR not found" });
    const skipped = new Set(pr.skipped.map((s) => s.id));
    const unknown = body.itemIds.filter((i) => !skipped.has(i));
    if (unknown.length) throw new UserError(`not skipped in this PR: ${unknown.join(", ")}`);
    if (body.outcome !== "bug_skipped" && body.itemIds.length) throw new UserError("only a bug in skipped code points at skipped items");
    await recordFeedback(db, pr.repo, id, body);
    return { feedback: await getFeedback(db, pr.repo, id), adaptive: await adaptiveFor(db, pr.repo) };
  });
  app.get("/api/adaptive", async (req) => {
    const { scope } = z.object({ scope: z.string().min(1).max(200).optional() }).parse(req.query);
    return scope ? adaptiveFor(db, scope) : adaptiveAll(db);
  });

  // ---- imports (`npm run import` and the file watcher read the files directly)
  app.post("/api/import/triage", async (req) => importTriage(db, req.body));
  app.post("/api/import/files", async () => (opts.onImport ? opts.onImport() : importRepository(db, root)));

  // ---- models and jobs
  app.get("/api/models", async (req) => {
    const { refresh } = z.object({ refresh: z.string().optional() }).parse(req.query);
    return models(refresh === "1");
  });
  app.get("/api/jobs", async () => listJobs(db));
  app.get("/api/jobs/:id", async (req, reply) => {
    const { id } = uuidParam.parse(req.params);
    return (await getJob(db, id)) ?? reply.status(404).send({ error: "job not found" });
  });
  app.post("/api/jobs/:id/cancel", async (req, reply) => {
    if (!opts.runner) return reply.status(503).send({ error: "this server does not run jobs" });
    const { id } = uuidParam.parse(req.params);
    return (await opts.runner.cancel(id)) ? { ok: true } : reply.status(409).send({ error: "job is not queued or running" });
  });

  // ---- pipeline (allow-listed steps; paid ones must be planned and confirmed)
  app.get("/api/pipeline/actions", async () => listActions(root));
  app.post("/api/pipeline/plan", async (req): Promise<PipelinePlan> => {
    const body = pipelineRequest.parse(req.body);
    const action = getAction(body.action);
    if (!action.paid) throw new UserError("this step is free and has no plan");
    const params = await parseParams(action, body.params, root);
    const { program, args } = command(action, params, true);
    args.push(...(await thresholdArgs(action.id, params)));
    try {
      const { stdout, stderr } = await exec(program, args, {
        cwd: root,
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, PYTHONPATH: `${root}/src`, PYTHONUNBUFFERED: "1" },
      });
      return { ok: true, output: (stdout + stderr).trim(), confirmToken: confirmToken(action.id, params) };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      return { ok: false, output: ((e.stdout ?? "") + (e.stderr ?? "") || e.message).trim(), confirmToken: null };
    }
  });
  app.post("/api/pipeline/run", async (req, reply) => {
    if (!opts.runner) return reply.status(503).send({ error: "this server does not run jobs" });
    const body = pipelineRequest.parse(req.body);
    const action = getAction(body.action);
    const params = await parseParams(action, body.params, root);
    if (action.paid && body.confirmToken !== confirmToken(action.id, params)) {
      throw new UserError("plan this step first and confirm its cost (the settings changed since the plan, or the server restarted)");
    }
    const { program, args } = command(action, params);
    args.push(...(await thresholdArgs(action.id, params)));
    const id = await opts.runner.enqueue({
      action: action.id,
      title: action.id === "triage-pr" ? `Triage ${String(params.url).replace("https://github.com/", "")}` : action.title,
      lane: action.lane,
      program,
      args,
      settings: params,
      note: body.note,
    });
    return reply.status(201).send({ id });
  });

  /** Live triage uses the repository's current adaptive threshold (it starts at the evaluation set's). */
  async function thresholdArgs(actionId: string, params: Record<string, unknown>): Promise<string[]> {
    if (actionId !== "triage-pr") return [];
    const url = String(params.url);
    if (!PR_URL.test(url)) return [];
    const [owner, repo] = url.replace("https://github.com/", "").split("/");
    const state = await adaptiveFor(db, `${owner}/${repo}`);
    // no reviews yet: let triage use the calibrated threshold of the PR's own language
    return state.n ? ["--threshold", state.threshold.toFixed(6)] : [];
  }

  return app;
}
