/** Read side: database rows -> API shapes from @prlens/shared. */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { adaptiveState, evalSetName, type AdaptiveState, type Job, type PrFeedback, type PrTriage, type TriageList, type TriageSetInfo } from "@prlens/shared";
import type { Db } from "./db/client";
import { jobs, triageFeedback, triagePrs, triageSets } from "./db/schema";

const iso = (d: Date | null) => (d ? d.toISOString() : null);

// ---- triage

function toSet(s: typeof triageSets.$inferSelect): TriageSetInfo {
  return {
    name: s.name,
    generatedAt: s.generatedAt.toISOString(),
    model: s.model,
    threshold: s.threshold,
    alpha: s.alpha,
    summary: s.summary,
    evaluation: s.evaluation ?? null,
  };
}

/** Every imported set, and every PR in them: live PRs first (newest first), then the evaluation set by repo. */
export async function listTriage(db: Db): Promise<TriageList> {
  const sets = await db.select().from(triageSets).orderBy(asc(triageSets.name));
  const rows = await db
    .select({
      id: triagePrs.prId,
      set: triageSets.name,
      title: triagePrs.title,
      repo: triagePrs.repo,
      openedAt: triagePrs.openedAt,
      reviewCount: triagePrs.reviewCount,
      skipCount: triagePrs.skipCount,
      readLines: triagePrs.readLines,
      totalLines: triagePrs.totalLines,
      caughtByTriage: triagePrs.caughtByTriage,
      payload: triagePrs.payload,
    })
    .from(triagePrs)
    .innerJoin(triageSets, eq(triagePrs.setId, triageSets.id))
    .orderBy(asc(triagePrs.repo), desc(triagePrs.openedAt));
  const prs = rows.map(({ payload, ...r }) => ({
    ...r,
    number: payload.number,
    branch: payload.branch,
    source: payload.source,
    language: payload.language ?? "python",
  }));
  const rank = (s: string) => (s === "live" ? 0 : 1);
  prs.sort((a, b) => rank(a.source) - rank(b.source) || (a.source === "live" ? b.openedAt.localeCompare(a.openedAt) : 0));
  return { sets: sets.map(toSet), prs };
}

export async function getTriageSet(db: Db, name: string): Promise<TriageSetInfo | null> {
  const [s] = await db.select().from(triageSets).where(eq(triageSets.name, name));
  return s ? toSet(s) : null;
}

/** A PR by id; when two sets hold the same id, the most recently generated one wins. */
export async function getTriagePr(db: Db, prId: string): Promise<PrTriage | null> {
  const [row] = await db
    .select({ payload: triagePrs.payload })
    .from(triagePrs)
    .innerJoin(triageSets, eq(triagePrs.setId, triageSets.id))
    .where(eq(triagePrs.prId, prId))
    .orderBy(desc(triageSets.generatedAt))
    .limit(1);
  return row?.payload ?? null;
}

// ---- jobs

export function toJob(j: typeof jobs.$inferSelect): Job {
  return {
    id: j.id,
    status: j.status,
    action: j.action,
    title: j.title,
    lane: j.lane,
    args: j.args,
    settings: j.settings,
    note: j.note,
    log: j.log,
    error: j.error,
    prId: j.prId,
    createdAt: j.createdAt.toISOString(),
    startedAt: iso(j.startedAt),
    finishedAt: iso(j.finishedAt),
  };
}

export async function listJobs(db: Db, limit = 30): Promise<Job[]> {
  const rows = await db.select().from(jobs).orderBy(desc(jobs.createdAt)).limit(limit);
  return rows.map(toJob);
}

export async function getJob(db: Db, id: string): Promise<Job | null> {
  const [j] = await db.select().from(jobs).where(eq(jobs.id, id));
  return j ? toJob(j) : null;
}

// ---- feedback and the adaptive threshold

/** The language of a repository's most recently triaged PR (Python when it has none yet). */
export async function scopeLanguage(db: Db, scope: string): Promise<string> {
  const [row] = await db
    .select({ payload: triagePrs.payload })
    .from(triagePrs)
    .where(eq(triagePrs.repo, scope))
    .orderBy(desc(triagePrs.openedAt))
    .limit(1);
  return row?.payload.language ?? "python";
}

/** Where a scope's threshold starts: its language's calibrated threshold, else Python's (0.06 before any exists). */
export async function startThreshold(db: Db, language = "python"): Promise<number> {
  for (const name of [evalSetName(language), "eval"]) {
    const [s] = await db.select({ t: triageSets.threshold }).from(triageSets).where(eq(triageSets.name, name));
    if (s) return s.t;
  }
  return 0.06;
}

export async function adaptiveFor(db: Db, scope: string): Promise<AdaptiveState> {
  const rows = await db
    .select({ prId: triageFeedback.prId, missed: triageFeedback.missed, at: triageFeedback.createdAt })
    .from(triageFeedback)
    .where(eq(triageFeedback.scope, scope))
    .orderBy(asc(triageFeedback.createdAt), asc(triageFeedback.id));
  return adaptiveState(scope, await startThreshold(db, await scopeLanguage(db, scope)), rows.map((r) => ({ ...r, at: r.at.toISOString() })));
}

export async function adaptiveAll(db: Db): Promise<AdaptiveState[]> {
  const scopes = await db.selectDistinct({ scope: triageFeedback.scope }).from(triageFeedback).orderBy(asc(triageFeedback.scope));
  return Promise.all(scopes.map((s) => adaptiveFor(db, s.scope)));
}

/** Record (or change) a PR's outcome. Changing it keeps its place in the order, so history is not rewritten. */
export async function recordFeedback(
  db: Db,
  scope: string,
  prId: string,
  f: { missed: boolean; itemIds: string[]; note?: string },
): Promise<void> {
  await db
    .insert(triageFeedback)
    .values({ scope, prId, missed: f.missed, itemIds: f.itemIds, note: f.note ?? null })
    .onConflictDoUpdate({
      target: [triageFeedback.scope, triageFeedback.prId],
      set: { missed: f.missed, itemIds: f.itemIds, note: f.note ?? null, updatedAt: sql`now()` },
    });
}

export async function getFeedback(db: Db, scope: string, prId: string): Promise<PrFeedback | null> {
  const [r] = await db
    .select()
    .from(triageFeedback)
    .where(and(eq(triageFeedback.scope, scope), eq(triageFeedback.prId, prId)));
  return r ? { prId: r.prId, scope: r.scope, missed: r.missed, itemIds: r.itemIds, note: r.note, at: r.createdAt.toISOString() } : null;
}
