/**
 * Where the PR Reviewer tab gets its data: the backend's imported triage set (GET /api/triage/prs), or the
 * built-in sample PRs when the backend has none or cannot be reached.
 */
import { triageLoad, type PrTriage, type PrTriageSummary, type TriageList } from "@bugcensus/shared";
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
  };
}

export async function loadTriageList(): Promise<TriageSource> {
  try {
    const list = await serverGet<TriageList>("/api/triage/prs");
    if (list.prs.length) return { list, sample: false };
  } catch {
    // backend down or not migrated yet: fall back to the sample PRs
  }
  return { list: { set: null, prs: SAMPLE_PRS.map(summarize) }, sample: true };
}

export async function loadTriagePr(id: string, sample: boolean): Promise<PrTriage | null> {
  if (sample) return SAMPLE_PRS.find((p) => p.id === id) ?? null;
  try {
    return await serverGet<PrTriage>(`/api/triage/prs/${encodeURIComponent(id)}`);
  } catch {
    return null;
  }
}
