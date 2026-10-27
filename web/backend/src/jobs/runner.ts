/**
 * Runs jobs launched from the dashboard: a census of one file, or an allow-listed experiment step.
 *
 * Jobs run in lanes, one at a time per lane: 'models' (anything that calls models: predictable credit use,
 * and a local Glimmer serves one request at a time), 'cpu' (local work such as test runs and analysis) and
 * 'ops' (quick admin steps). So a long decoy validation does not block a census, and two paid runs never
 * overlap.
 *
 * A census job runs `python -m bugcensus.cli review <file> --panel a,b --json` and imports the report from
 * stdout. Experiment steps write their results to files; the file watcher imports those.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import type { LaunchRequest } from "@bugcensus/shared";
import type { Db } from "../db/client";
import { jobs } from "../db/schema";
import { env } from "../env";
import { UserError } from "../errors";
import { importCensus } from "../import/census";

export { UserError } from "../errors";

const LOG_LIMIT = 300_000;
const LANES = ["models", "cpu", "ops"] as const;
type Lane = (typeof LANES)[number];

export interface ExperimentJob {
  action: string;
  title: string;
  lane: Lane;
  program: string;
  args: string[];
  settings: Record<string, unknown>;
  note?: string;
}

export class JobRunner {
  private running = new Map<string, { lane: Lane; child: ChildProcess }>();
  private ticking = false;

  constructor(
    private readonly db: Db,
    private readonly onFinished: () => void = () => {},
  ) {}

  /** Jobs left 'running' by a backend that stopped are failed; queued jobs are picked up. */
  async start(): Promise<void> {
    await this.db
      .update(jobs)
      .set({ status: "failed", error: "the backend stopped while this job was running", finishedAt: new Date() })
      .where(eq(jobs.status, "running"));
    void this.tick();
  }

  async enqueue(req: LaunchRequest): Promise<string> {
    const file = resolveRepoFile(req.file);
    const [row] = await this.db
      .insert(jobs)
      .values({
        kind: "census",
        lane: "models",
        title: `Census of ${file}`,
        filePath: file,
        panel: req.panel,
        settings: { copies: req.copies, perCopy: req.perCopy, seed: req.seed, lines: req.lines ?? null },
        note: req.note ?? null,
      })
      .returning({ id: jobs.id });
    void this.tick();
    return row!.id;
  }

  async enqueueExperiment(job: ExperimentJob): Promise<string> {
    const [row] = await this.db
      .insert(jobs)
      .values({
        kind: "experiment",
        action: job.action,
        title: job.title,
        lane: job.lane,
        args: [job.program, ...job.args],
        settings: job.settings,
        panel: Array.isArray(job.settings.panel) ? (job.settings.panel as string[]) : [],
        note: job.note ?? null,
      })
      .returning({ id: jobs.id });
    void this.tick();
    return row!.id;
  }

  async cancel(id: string): Promise<boolean> {
    const live = this.running.get(id);
    if (live) {
      await this.db
        .update(jobs)
        .set({ status: "cancelled", finishedAt: new Date(), error: "cancelled from the dashboard" })
        .where(eq(jobs.id, id));
      live.child.kill("SIGTERM");
      return true;
    }
    const rows = await this.db
      .update(jobs)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(and(eq(jobs.status, "queued"), eq(jobs.id, id)))
      .returning({ id: jobs.id });
    return rows.length > 0;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const lane of LANES) {
        if ([...this.running.values()].some((r) => r.lane === lane)) continue;
        const [next] = await this.db
          .select()
          .from(jobs)
          .where(and(eq(jobs.status, "queued"), eq(jobs.lane, lane)))
          .orderBy(asc(jobs.createdAt))
          .limit(1);
        if (next) this.launch(next);
      }
    } finally {
      this.ticking = false;
    }
  }

  private launch(job: typeof jobs.$inferSelect): void {
    let program: string;
    let args: string[];
    if (job.kind === "census") {
      const s = job.settings as { copies?: number; perCopy?: number; seed?: number; lines?: string | null };
      program = env.BUGCENSUS_PYTHON;
      args = ["-m", "bugcensus.cli", "review", job.filePath ?? "", "--panel", job.panel.join(","), "--json",
        "--copies", String(s.copies ?? 2), "--per-copy", String(s.perCopy ?? 5), "--seed", String(s.seed ?? 0)];
      if (s.lines) args.push("--lines", s.lines);
    } else {
      [program, ...args] = job.args as [string, ...string[]];
    }

    const child = spawn(program, args, {
      cwd: env.BUGCENSUS_ROOT,
      env: {
        ...process.env,
        PYTHONPATH: `${env.BUGCENSUS_ROOT}/src`,
        PYTHONUNBUFFERED: "1",
        BUGCENSUS_JOB_ID: job.id,
        // census: the runner imports stdout itself; experiments: results are files the watcher imports
        BUGCENSUS_API_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.running.set(job.id, { lane: job.lane, child });
    let stdout = "";
    let log = `$ ${path.basename(program)} ${args.join(" ")}\n`;
    let flushTimer: NodeJS.Timeout | null = null;
    const flush = () => {
      flushTimer = null;
      void this.db.update(jobs).set({ log: log.slice(-LOG_LIMIT) }).where(eq(jobs.id, job.id));
    };
    const append = (text: string) => {
      log += text;
      flushTimer ??= setTimeout(flush, 1000);
    };
    child.stdout!.on("data", (b: Buffer) => {
      if (job.kind === "census") stdout += b.toString();
      else append(b.toString());
    });
    child.stderr!.on("data", (b: Buffer) => append(b.toString()));

    void this.db
      .update(jobs)
      .set({ status: "running", startedAt: new Date(), pid: child.pid ?? null, log })
      .where(eq(jobs.id, job.id));

    let finished = false;
    const finish = async (code: number | null, spawnError?: Error) => {
      if (finished) return;
      finished = true;
      if (flushTimer) clearTimeout(flushTimer);
      this.running.delete(job.id);
      const [now] = await this.db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, job.id));
      const done = { finishedAt: new Date(), log: log.slice(-LOG_LIMIT) };
      if (now?.status === "cancelled") {
        await this.db.update(jobs).set({ log: done.log }).where(eq(jobs.id, job.id));
      } else if (spawnError || code !== 0) {
        await this.db
          .update(jobs)
          .set({
            ...done,
            status: "failed",
            error: spawnError ? `could not start ${path.basename(program)}: ${spawnError.message}` : `exited with code ${code}`,
          })
          .where(eq(jobs.id, job.id));
      } else if (job.kind === "census") {
        try {
          const res = await importCensus(this.db, JSON.parse(stdout) as unknown);
          await this.db.update(jobs).set({ ...done, status: "succeeded", runId: res.id }).where(eq(jobs.id, job.id));
        } catch (err) {
          await this.db
            .update(jobs)
            .set({
              ...done,
              status: "failed",
              log: (log + `\n${stdout.slice(0, 4000)}`).slice(-LOG_LIMIT),
              error: `run finished but its report could not be saved: ${String(err).slice(0, 500)}`,
            })
            .where(eq(jobs.id, job.id));
        }
      } else {
        await this.db.update(jobs).set({ ...done, status: "succeeded" }).where(eq(jobs.id, job.id));
      }
      this.onFinished();
      void this.tick();
    };
    child.on("error", (err) => void finish(null, err));
    child.on("close", (code) => void finish(code));
  }
}

/**
 * Only files inside the repository can be reviewed (the backend starts processes, so a path from the
 * browser must never point elsewhere). Returns the path relative to the repo root.
 */
export function resolveRepoFile(file: string, root: string = env.BUGCENSUS_ROOT): string {
  const abs = path.resolve(root, file);
  if (!existsSync(abs)) throw new UserError(`file not found: ${file}`);
  const real = realpathSync(abs);
  const realRoot = realpathSync(root);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new UserError("only files inside the BugCensus repository can be reviewed");
  }
  if (!real.endsWith(".py")) throw new UserError("only Python (.py) files can be reviewed for now");
  return path.relative(realRoot, real);
}
