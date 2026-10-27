/**
 * Load a census report (runs/*.json, or a report pushed by the Python CLI) into the database.
 * Idempotent: the same run (same run_key) is stored once.
 */
import path from "node:path";
import { eq } from "drizzle-orm";
import {
  censusReportV2,
  legacyCensusReport,
  type CensusReportV2,
  type LegacyCensusReport,
} from "@bugcensus/shared";
import type { Db } from "../db/client";
import { decoys, findings, reviews, runModels, runs, suspectedBugs } from "../db/schema";
import { inferModel, type UsageEntry } from "./legacy";

export interface ImportResult {
  id: string;
  created: boolean;
}

type RunInsert = typeof runs.$inferInsert;
type ModelInsert = Omit<typeof runModels.$inferInsert, "runId">;
type ReviewInsert = Omit<typeof reviews.$inferInsert, "runId">;

const DECOY_RE = /^(\w+) in (\w+)\(\) line (\d+):/;

/** Verdict rule (same as pipeline._verdict): never CLEAR while found bugs remain. */
export function verdictFor(found: number, status: string | null | undefined): string {
  if (!status) return "NOT ESTIMATED";
  if (found > 0) return `FIX ${found} FOUND BUG${found > 1 ? "S" : ""}`;
  return status;
}

export async function importCensus(
  db: Db,
  raw: unknown,
  opts: { fileName?: string; usage?: UsageEntry[] } = {},
): Promise<ImportResult> {
  const obj = raw as { schema_version?: unknown };
  if (obj && obj.schema_version === 2) {
    return insertRun(db, raw, fromV2(censusReportV2.parse(raw)));
  }
  if (!opts.fileName) {
    throw new Error("A census report without schema_version can only be imported from its file (name needed).");
  }
  return insertRun(db, raw, fromLegacy(legacyCensusReport.parse(raw), opts.fileName, opts.usage ?? []));
}

interface Prepared {
  run: Omit<RunInsert, "raw">;
  models: ModelInsert[];
  reviews: ReviewInsert[];
  findings: Omit<typeof findings.$inferInsert, "runId">[];
  suspected: Omit<typeof suspectedBugs.$inferInsert, "runId">[];
  decoys: Omit<typeof decoys.$inferInsert, "runId">[];
}

function common(r: CensusReportV2 | LegacyCensusReport) {
  const est = r.estimate;
  const notReviewed = r.decoys.filter((d) => d.not_reviewed).length;
  return {
    filePath: r.file,
    seconds: r.seconds,
    changedLines: r.changed_lines,
    foundCounted: r.found_counted,
    foundIsVerified: r.found_is_verified,
    decoysCounted: r.decoys_planted,
    decoysMissed: r.decoys_missed_by_all,
    decoysNotReviewed: notReviewed,
    expectedHidden: est?.expected_hidden ?? null,
    pClean: est?.p_clean ?? null,
    intervalLow: est?.interval[0] ?? null,
    intervalHigh: est?.interval[1] ?? null,
    qMean: est?.q_mean ?? null,
    hiddenStatus: est?.status ?? null,
    verdict: r.verdict ?? verdictFor(r.found_counted, est?.status),
    tokensIn: r.tokens.input,
    tokensOut: r.tokens.output,
    errors: r.errors,
  };
}

function findingRows(r: CensusReportV2 | LegacyCensusReport): Prepared["findings"] {
  return Object.entries(r.findings_by_version ?? {}).flatMap(([version, fs]) =>
    fs.map((f) => ({
      reviewer: f.reviewer,
      version,
      startLine: f.lines[0],
      endLine: f.lines[1],
      category: f.category ?? null,
      explanation: f.explanation ?? null,
    })),
  );
}

function decoyRows(r: CensusReportV2 | LegacyCensusReport): Prepared["decoys"] {
  return r.decoys.map((d) => {
    const m = DECOY_RE.exec(d.decoy);
    return {
      copyName: d.copy,
      kind: d.kind ?? m?.[1] ?? null,
      functionName: d.function ?? m?.[2] ?? null,
      line: d.line ?? (m?.[3] ? Number(m[3]) : null),
      lineInCopy: d.line_in_copy ?? null,
      description: d.decoy,
      caughtBy: d.caught_by,
      notReviewed: d.not_reviewed,
      matched: d.matched,
      tooWide: d.too_wide,
    };
  });
}

function suspectedRows(r: CensusReportV2 | LegacyCensusReport): Prepared["suspected"] {
  return r.suspected_bugs.map((s) => ({
    startLine: s.lines[0],
    endLine: s.lines[1],
    reviewers: s.reviewers,
    explanations: s.explanations,
  }));
}

function fromV2(r: CensusReportV2): Prepared {
  return {
    run: {
      ...common(r),
      runKey: r.run_id,
      jobId: r.job_id ?? null,
      schemaVersion: 2,
      source: r.source,
      startedAt: new Date(r.started_at),
      finishedAt: new Date(r.finished_at),
      gitSha: r.git_sha,
      promptSha: r.prompt_sha,
      settings: r.settings,
      metadataInferred: false,
    },
    models: r.models.map((m) => ({
      reviewer: m.reviewer,
      modelId: m.model_id,
      provider: m.provider,
      endpoint: m.endpoint ?? null,
      openWeights: m.open_weights,
      reasoningEffort: m.reasoning_effort ?? null,
      maxTokens: m.max_tokens ?? null,
      inferred: m.inferred,
    })),
    reviews: r.reviews.map((v) => ({
      reviewer: v.reviewer,
      version: v.version,
      findingsCount: v.findings,
      inputTokens: v.input_tokens,
      outputTokens: v.output_tokens,
      seconds: v.seconds,
      finishReason: v.finish_reason ?? null,
      error: v.error,
      inferred: false,
    })),
    findings: findingRows(r),
    suspected: suspectedRows(r),
    decoys: decoyRows(r),
  };
}

/**
 * Runs saved before Oct 27 2026 have no model details or per-review records. Models come from the
 * registry defaults of that time; per-review tokens and times come from logs/usage.jsonl entries
 * written during the run. Everything reconstructed is marked inferred.
 */
function fromLegacy(r: LegacyCensusReport, fileName: string, usage: UsageEntry[]): Prepared {
  const base = path.basename(fileName);
  const epoch = /-(\d{10})(?:-[0-9a-f]+)?\.json$/.exec(base)?.[1];
  const finished = epoch ? new Date(Number(epoch) * 1000) : null;
  const started = finished ? new Date(finished.getTime() - r.seconds * 1000) : null;
  const models = r.reviewers.map(inferModel);
  const byModel = new Map(models.map((m) => [m.modelId, m.reviewer]));

  const window = finished && started
    ? usage.filter((u) => u.ts >= started.getTime() / 1000 - 5 && u.ts <= finished.getTime() / 1000 + 5)
    : [];
  const errors = [...r.errors];
  const reviewRows: ReviewInsert[] = window
    .filter((u) => byModel.has(u.model))
    .map((u) => {
      const reviewer = byModel.get(u.model)!;
      // Before Oct 27 a local Glimmer review that hit the old 6,000-token cap came back empty and was
      // counted as "no findings". Flag those so the comparison view shows the run is not trustworthy.
      const cut = inferModel(reviewer).provider === "mlx-local" && u.output_tokens === 6000;
      if (cut) {
        errors.push(
          `${reviewer}/${u.version}: probably cut off at the old 6,000-token limit (inferred from the usage log); ` +
            "its decoys were counted as missed",
        );
      }
      return {
        reviewer,
        version: u.version,
        findingsCount: null,
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        seconds: u.seconds,
        finishReason: cut ? "length (inferred)" : null,
        error: cut ? "probably cut off at the 6,000-token limit" : null,
        inferred: true,
      };
    });

  return {
    run: {
      ...common(r),
      errors,
      runKey: `legacy:${base}`,
      jobId: null,
      schemaVersion: 1,
      source: null,
      startedAt: started,
      finishedAt: finished,
      gitSha: null,
      promptSha: null,
      settings: {},
      metadataInferred: true,
    },
    models,
    reviews: reviewRows,
    findings: findingRows(r),
    suspected: suspectedRows(r),
    decoys: decoyRows(r),
  };
}

async function insertRun(db: Db, raw: unknown, p: Prepared): Promise<ImportResult> {
  return db.transaction(async (tx) => {
    const existing = await tx.select({ id: runs.id }).from(runs).where(eq(runs.runKey, p.run.runKey!));
    if (existing[0]) return { id: existing[0].id, created: false };

    const [row] = await tx
      .insert(runs)
      .values({ ...p.run, raw } as RunInsert)
      .returning({ id: runs.id });
    const runId = row!.id;
    const withRun = <T extends object>(rows: T[]) => rows.map((x) => ({ ...x, runId }));
    if (p.models.length) await tx.insert(runModels).values(withRun(p.models));
    if (p.reviews.length) await tx.insert(reviews).values(withRun(p.reviews));
    if (p.findings.length) await tx.insert(findings).values(withRun(p.findings));
    if (p.suspected.length) await tx.insert(suspectedBugs).values(withRun(p.suspected));
    if (p.decoys.length) await tx.insert(decoys).values(withRun(p.decoys));
    return { id: runId, created: true };
  });
}
