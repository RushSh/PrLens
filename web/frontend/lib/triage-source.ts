/**
 * Where the dashboard gets triaged PRs: the backend's imported sets (GET /api/triage/prs), or the built-in
 * sample PRs when the backend has none or cannot be reached.
 */
import { cache } from "react";
import { EVAL_LANGUAGES, triageLoad, type AdaptiveState, type EvalLanguage, type PrTriage, type PrTriageSummary, type TriageList, type TriageSetInfo } from "@prlens/shared";
import { serverGet } from "./api";
import { SAMPLE_PRS } from "./triage-sample";

export interface TriageSource {
  list: TriageList;
  /** True when showing the built-in sample PRs. */
  sample: boolean;
}

function summarize(pr: PrTriage): PrTriageSummary {
  const { readLines, totalLines } = triageLoad(pr);
  return {
    id: pr.id,
    set: "sample",
    number: pr.number,
    title: pr.title,
    repo: pr.repo,
    branch: pr.branch,
    openedAt: pr.openedAt,
    source: pr.source,
    reviewCount: pr.toReview.length,
    skipCount: pr.skipped.length,
    readLines,
    totalLines,
    caughtByTriage: pr.groundTruth ? pr.groundTruth.caughtByTriage : null,
    language: pr.language ?? "python",
  };
}

export const loadTriageList = cache(async (): Promise<TriageSource> => {
  try {
    const list = await serverGet<TriageList>("/api/triage/prs");
    if (list.prs.length) return { list, sample: false };
  } catch {
    // backend down or nothing imported yet: fall back to the sample PRs
  }
  return { list: { sets: [], prs: SAMPLE_PRS.map(summarize) }, sample: true };
});

export const loadTriagePr = cache(async (id: string): Promise<PrTriage | null> => {
  const sample = SAMPLE_PRS.find((p) => p.id === id);
  if (sample) return sample;
  try {
    return await serverGet<PrTriage>(`/api/triage/prs/${encodeURIComponent(id)}`);
  } catch {
    return null;
  }
});

export const loadEvalSet = cache(async (name = "eval"): Promise<TriageSetInfo | null> => {
  try {
    return await serverGet<TriageSetInfo>(`/api/triage/sets/${encodeURIComponent(name)}`);
  } catch {
    return null;
  }
});

/** Each calibrated language's evaluation set, or null for a language whose set is not published yet. */
export const loadEvalSets = cache(async (): Promise<Record<EvalLanguage, TriageSetInfo | null>> => {
  const sets = await Promise.all(EVAL_LANGUAGES.map((l) => loadEvalSet(l.set)));
  return Object.fromEntries(EVAL_LANGUAGES.map((l, i) => [l.key, sets[i]])) as Record<EvalLanguage, TriageSetInfo | null>;
});

export const loadAdaptive = cache(async (scope: string): Promise<AdaptiveState | null> => {
  try {
    return await serverGet<AdaptiveState>(`/api/adaptive?scope=${encodeURIComponent(scope)}`);
  } catch {
    return null;
  }
});
