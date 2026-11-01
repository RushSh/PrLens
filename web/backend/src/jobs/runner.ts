/**
 * Runs pipeline steps launched from the dashboard (allow-listed in ../pipeline.ts).
 *
 * Jobs run in lanes, one at a time per lane: 'models' (anything that calls models: predictable spend, and a
 * local Glimmer serves one request at a time), 'cpu' (local work such as tracing and fitting) and 'ops'
 * (quick admin steps). So a long trace does not block triaging a PR, and two paid runs never overlap.
 * Steps write their results to files under data/; the file watcher imports them.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import type { Lane } from "@prlens/shared";
import type { Db } from "../db/client";
import { jobs } from "../db/schema";
import { env } from "../env";

export { UserError } from "../errors";

const LOG_LIMIT = 300_000;
const LANES: Lane[] = ["models", "cpu", "ops"];
/** `prlens triage-pr` prints this line when it saved a PR, so the job can link to it. */
const PR_LINE = /^PRLENS_PR_ID=(\S+)$/m;

export interface PipelineJob {
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
    private readonly onFinished: () => Promise<unknown> | void = () => {},
  ) {}

  /** Jobs left 'running' by a backend that stopped are failed; queued jobs are picked up. */
  async start(): Promise<void> {
    await this.db
      .update(jobs)
      .set({ status: "failed", error: "the backend stopped while this job was running", finishedAt: new Date() })
      .where(eq(jobs.status, "running"));
    void this.tick();
  }

  async enqueue(job: PipelineJob): Promise<string> {
    const [row] = await this.db
      .insert(jobs)
      .values({
        action: job.action,
        title: job.title,
        lane: job.lane,
        args: [job.program, ...job.args],
        settings: job.settings,
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
    const [program, ...args] = job.args as [string, ...string[]];
    const child = spawn(program, args, {
      cwd: env.PRLENS_ROOT,
      env: { ...process.env, PYTHONPATH: `${env.PRLENS_ROOT}/src`, PYTHONUNBUFFERED: "1", PRLENS_JOB_ID: job.id },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.running.set(job.id, { lane: job.lane, child });
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
    child.stdout!.on("data", (b: Buffer) => append(b.toString()));
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
      } else {
        // import the step's output files before marking it done, so "open the PR" works right away
        await Promise.resolve(this.onFinished()).catch(() => {});
        const prId = PR_LINE.exec(log)?.[1] ?? null;
        await this.db.update(jobs).set({ ...done, status: "succeeded", prId }).where(eq(jobs.id, job.id));
      }
      void this.tick();
    };
    child.on("error", (err) => void finish(null, err));
    child.on("close", (code) => void finish(code));
  }
}
