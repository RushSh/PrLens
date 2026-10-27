/**
 * Runs census jobs launched from the dashboard, one at a time (a local Glimmer serves one request at
 * a time, and one-at-a-time keeps credit use predictable).
 *
 * Each job starts `python -m bugcensus.cli review <file> --panel a,b --json`. The report printed on
 * stdout is imported directly, so a run is saved even if the push to the API fails. Progress lines on
 * stderr go to the job log.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import type { LaunchRequest } from "@bugcensus/shared";
import type { Db } from "../db/client";
import { jobs } from "../db/schema";
import { env } from "../env";
import { importCensus } from "../import/census";

const LOG_LIMIT = 200_000;

export class JobRunner {
  private current: { id: string; child: ChildProcess } | null = null;
  private ticking = false;

  constructor(private readonly db: Db) {}

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
        filePath: file,
        panel: req.panel,
        settings: { copies: req.copies, perCopy: req.perCopy, seed: req.seed, lines: req.lines ?? null },
        note: req.note ?? null,
      })
      .returning({ id: jobs.id });
    void this.tick();
    return row!.id;
  }

  async cancel(id: string): Promise<boolean> {
    if (this.current?.id === id) {
      this.current.child.kill("SIGTERM");
      await this.db
        .update(jobs)
        .set({ status: "cancelled", finishedAt: new Date(), error: "cancelled from the dashboard" })
        .where(eq(jobs.id, id));
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
    if (this.ticking || this.current) return;
    this.ticking = true;
    try {
      const [next] = await this.db
        .select()
        .from(jobs)
        .where(eq(jobs.status, "queued"))
        .orderBy(asc(jobs.createdAt))
        .limit(1);
      if (next) this.launch(next);
    } finally {
      this.ticking = false;
    }
  }

  private launch(job: typeof jobs.$inferSelect): void {
    const s = job.settings as { copies?: number; perCopy?: number; seed?: number; lines?: string | null };
    const args = ["-m", "bugcensus.cli", "review", job.filePath, "--panel", job.panel.join(","), "--json"];
    args.push("--copies", String(s.copies ?? 2), "--per-copy", String(s.perCopy ?? 5), "--seed", String(s.seed ?? 0));
    if (s.lines) args.push("--lines", s.lines);

    const child = spawn(env.BUGCENSUS_PYTHON, args, {
      cwd: env.BUGCENSUS_ROOT,
      env: {
        ...process.env,
        PYTHONPATH: `${env.BUGCENSUS_ROOT}/src`,
        PYTHONUNBUFFERED: "1",
        BUGCENSUS_JOB_ID: job.id,
        BUGCENSUS_API_URL: "", // the runner imports stdout itself; no second copy via push
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.current = { id: job.id, child };
    let stdout = "";
    let log = `$ ${path.basename(env.BUGCENSUS_PYTHON)} ${args.join(" ")}\n`;
    let flushTimer: NodeJS.Timeout | null = null;
    const flush = () => {
      flushTimer = null;
      void this.db.update(jobs).set({ log: log.slice(-LOG_LIMIT) }).where(eq(jobs.id, job.id));
    };
    child.stdout!.on("data", (b: Buffer) => (stdout += b.toString()));
    child.stderr!.on("data", (b: Buffer) => {
      log += b.toString();
      flushTimer ??= setTimeout(flush, 1000);
    });

    void this.db
      .update(jobs)
      .set({ status: "running", startedAt: new Date(), pid: child.pid ?? null, log })
      .where(eq(jobs.id, job.id));

    const finish = async (code: number | null, spawnError?: Error) => {
      if (flushTimer) clearTimeout(flushTimer);
      this.current = null;
      const [now] = await this.db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, job.id));
      if (now?.status === "cancelled") {
        await this.db.update(jobs).set({ log: log.slice(-LOG_LIMIT) }).where(eq(jobs.id, job.id));
      } else if (spawnError || code !== 0) {
        await this.db
          .update(jobs)
          .set({
            status: "failed",
            finishedAt: new Date(),
            log: log.slice(-LOG_LIMIT),
            error: spawnError ? `could not start Python: ${spawnError.message}` : `bugcensus exited with code ${code}`,
          })
          .where(eq(jobs.id, job.id));
      } else {
        try {
          const report: unknown = JSON.parse(stdout);
          const res = await importCensus(this.db, report);
          await this.db
            .update(jobs)
            .set({ status: "succeeded", finishedAt: new Date(), runId: res.id, log: log.slice(-LOG_LIMIT) })
            .where(eq(jobs.id, job.id));
        } catch (err) {
          await this.db
            .update(jobs)
            .set({
              status: "failed",
              finishedAt: new Date(),
              log: (log + `\n${stdout.slice(0, 4000)}`).slice(-LOG_LIMIT),
              error: `run finished but its report could not be saved: ${String(err).slice(0, 500)}`,
            })
            .where(eq(jobs.id, job.id));
        }
      }
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

export class UserError extends Error {}
