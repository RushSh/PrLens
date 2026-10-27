/** Read side: database rows -> API shapes from @bugcensus/shared. */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type {
  CalibrationExperiment,
  Job,
  RealismExperiment,
  RunDetail,
  RunModel,
  RunSummary,
} from "@bugcensus/shared";
import type { Db } from "./db/client";
import {
  calibrationExperiments,
  decoys,
  findings,
  jobs,
  realismExperiments,
  realismFamilies,
  realismReviewerStats,
  reviews,
  runModels,
  runs,
  suspectedBugs,
} from "./db/schema";

type RunRow = typeof runs.$inferSelect;
type ModelRow = typeof runModels.$inferSelect;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function toModel(m: ModelRow): RunModel {
  return {
    reviewer: m.reviewer,
    modelId: m.modelId,
    provider: m.provider,
    endpoint: m.endpoint,
    openWeights: m.openWeights,
    reasoningEffort: m.reasoningEffort,
    maxTokens: m.maxTokens,
    inferred: m.inferred,
  };
}

function toSummary(r: Pick<RunRow, keyof typeof summaryColumns>, models: ModelRow[]): RunSummary {
  return {
    id: r.id,
    runKey: r.runKey,
    filePath: r.filePath,
    finishedAt: iso(r.finishedAt),
    verdict: r.verdict,
    hiddenStatus: r.hiddenStatus,
    expectedHidden: r.expectedHidden,
    pClean: r.pClean,
    intervalLow: r.intervalLow,
    intervalHigh: r.intervalHigh,
    foundCounted: r.foundCounted,
    decoysCounted: r.decoysCounted,
    decoysMissed: r.decoysMissed,
    decoysNotReviewed: r.decoysNotReviewed,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    seconds: r.seconds,
    promptSha: r.promptSha,
    gitSha: r.gitSha,
    metadataInferred: r.metadataInferred,
    note: r.note,
    errors: r.errors,
    models: models.map(toModel),
  };
}

const summaryColumns = {
  id: runs.id,
  runKey: runs.runKey,
  filePath: runs.filePath,
  finishedAt: runs.finishedAt,
  verdict: runs.verdict,
  hiddenStatus: runs.hiddenStatus,
  expectedHidden: runs.expectedHidden,
  pClean: runs.pClean,
  intervalLow: runs.intervalLow,
  intervalHigh: runs.intervalHigh,
  foundCounted: runs.foundCounted,
  decoysCounted: runs.decoysCounted,
  decoysMissed: runs.decoysMissed,
  decoysNotReviewed: runs.decoysNotReviewed,
  tokensIn: runs.tokensIn,
  tokensOut: runs.tokensOut,
  seconds: runs.seconds,
  promptSha: runs.promptSha,
  gitSha: runs.gitSha,
  metadataInferred: runs.metadataInferred,
  note: runs.note,
  errors: runs.errors,
};

export async function listRuns(db: Db, filter: { file?: string; model?: string } = {}): Promise<RunSummary[]> {
  let ids: string[] | null = null;
  if (filter.model) {
    const rows = await db
      .select({ runId: runModels.runId })
      .from(runModels)
      .where(eq(runModels.modelId, filter.model));
    ids = rows.map((r) => r.runId);
    if (!ids.length) return [];
  }
  const rows = await db
    .select(summaryColumns)
    .from(runs)
    .where(
      and(
        filter.file ? eq(runs.filePath, filter.file) : undefined,
        ids ? inArray(runs.id, ids) : undefined,
      ),
    )
    .orderBy(desc(runs.finishedAt), desc(runs.createdAt))
    .limit(500);
  const models = rows.length
    ? await db.select().from(runModels).where(inArray(runModels.runId, rows.map((r) => r.id)))
    : [];
  return rows.map((r) => toSummary(r, models.filter((m) => m.runId === r.id)));
}

export async function getRun(db: Db, id: string): Promise<RunDetail | null> {
  const [r] = await db.select().from(runs).where(eq(runs.id, id));
  if (!r) return null;
  const [models, revs, fs, sus, ds] = await Promise.all([
    db.select().from(runModels).where(eq(runModels.runId, id)).orderBy(asc(runModels.id)),
    db.select().from(reviews).where(eq(reviews.runId, id)).orderBy(asc(reviews.id)),
    db.select().from(findings).where(eq(findings.runId, id)).orderBy(asc(findings.version), asc(findings.startLine)),
    db.select().from(suspectedBugs).where(eq(suspectedBugs.runId, id)).orderBy(asc(suspectedBugs.startLine)),
    db.select().from(decoys).where(eq(decoys.runId, id)).orderBy(asc(decoys.copyName), asc(decoys.id)),
  ]);
  return {
    ...toSummary(r, models),
    source: r.source,
    settings: r.settings,
    changedLines: r.changedLines,
    qMean: r.qMean,
    foundIsVerified: r.foundIsVerified,
    jobId: r.jobId,
    reviews: revs.map((v) => ({
      reviewer: v.reviewer,
      version: v.version,
      findingsCount: v.findingsCount,
      inputTokens: v.inputTokens,
      outputTokens: v.outputTokens,
      seconds: v.seconds,
      finishReason: v.finishReason,
      error: v.error,
      inferred: v.inferred,
    })),
    findings: fs.map((f) => ({
      reviewer: f.reviewer,
      version: f.version,
      startLine: f.startLine,
      endLine: f.endLine,
      category: f.category,
      explanation: f.explanation,
    })),
    suspectedBugs: sus.map((s) => ({
      startLine: s.startLine,
      endLine: s.endLine,
      reviewers: s.reviewers,
      explanations: s.explanations,
    })),
    decoys: ds.map((d) => ({
      copyName: d.copyName,
      kind: d.kind,
      functionName: d.functionName,
      line: d.line,
      lineInCopy: d.lineInCopy,
      description: d.description,
      caughtBy: d.caughtBy,
      notReviewed: d.notReviewed,
      matched: d.matched,
      tooWide: d.tooWide,
    })),
  };
}

export async function setRunNote(db: Db, id: string, note: string | null): Promise<boolean> {
  const rows = await db.update(runs).set({ note }).where(eq(runs.id, id)).returning({ id: runs.id });
  return rows.length > 0;
}

export async function listRealism(db: Db): Promise<RealismExperiment[]> {
  const exps = await db.select().from(realismExperiments).orderBy(desc(realismExperiments.analyzedAt));
  if (!exps.length) return [];
  const ids = exps.map((e) => e.id);
  const [stats, fams] = await Promise.all([
    db.select().from(realismReviewerStats).where(inArray(realismReviewerStats.experimentId, ids)),
    db.select().from(realismFamilies).where(inArray(realismFamilies.experimentId, ids)),
  ]);
  return exps.map((e) => ({
    id: e.id,
    name: e.name,
    analyzedAt: e.analyzedAt.toISOString(),
    bugs: e.bugs,
    units: e.units,
    repos: e.repos,
    maxSpan: e.maxSpan,
    outputTokens: e.outputTokens,
    models: (e.models as Array<Record<string, unknown>>).map((m) => ({
      reviewer: String(m.reviewer),
      modelId: String(m.model_id),
      provider: String(m.provider),
      endpoint: (m.endpoint as string | null) ?? null,
      openWeights: Boolean(m.open_weights),
      reasoningEffort: (m.reasoning_effort as string | null) ?? null,
      maxTokens: (m.max_tokens as number | null) ?? null,
      inferred: Boolean(m.inferred),
    })),
    missAll: e.missAll,
    reviewers: stats
      .filter((s) => s.experimentId === e.id)
      .sort((a, b) => (a.reviewer === "panel" ? 1 : b.reviewer === "panel" ? -1 : a.reviewer.localeCompare(b.reviewer)))
      .map((s) => ({
        reviewer: s.reviewer,
        realRate: s.realRate,
        realN: s.realN,
        decoyRate: s.decoyRate,
        decoyN: s.decoyN,
        gapLogit: s.gapLogit,
        ciLow: s.ciLow,
        ciHigh: s.ciHigh,
      })),
    families: fams
      .filter((f) => f.experimentId === e.id)
      .sort((a, b) => b.n - a.n)
      .map((f) => ({ family: f.family, rate: f.rate, n: f.n })),
  }));
}

export function toJob(j: typeof jobs.$inferSelect): Job {
  return {
    id: j.id,
    status: j.status,
    filePath: j.filePath,
    panel: j.panel,
    settings: j.settings,
    note: j.note,
    log: j.log,
    error: j.error,
    runId: j.runId,
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

export async function distinctFiles(db: Db): Promise<string[]> {
  const rows = await db.selectDistinct({ f: runs.filePath }).from(runs).orderBy(asc(runs.filePath));
  return rows.map((r) => r.f);
}

export async function listCalibration(db: Db): Promise<CalibrationExperiment[]> {
  const rows = await db.select().from(calibrationExperiments).orderBy(desc(calibrationExperiments.analyzedAt));
  return rows.map((e) => ({
    id: e.id,
    name: e.name,
    tag: e.tag,
    analyzedAt: e.analyzedAt.toISOString(),
    dryRun: e.dryRun,
    nUnits: e.nUnits,
    repos: e.repos,
    decoysPerUnit: e.decoysPerUnit,
    decoyMissRate: e.decoyMissRate,
    models: (e.models as Array<Record<string, unknown>>).map((m) => ({
      reviewer: String(m.reviewer),
      modelId: String(m.model_id),
      provider: String(m.provider),
      reasoningEffort: (m.reasoning_effort as string | null) ?? null,
    })),
    design: e.design,
    calls: e.calls,
    variants: e.variants,
    notes: e.notes,
  }));
}
