/**
 * Where the dashboard gets triaged PRs: the backend's imported sets (GET /api/triage/prs). There is no built-in
 * fallback data: every PR shown is a real triage.
 */
import { cache } from "react";
import { EVAL_LANGUAGES, type AdaptiveState, type EvalLanguage, type PrTriage, type TriageList, type TriageSetInfo } from "@prlens/shared";
import { serverGet } from "./api";

export interface TriageSource {
  list: TriageList;
  /** True when the backend could not be reached (as opposed to reachable with nothing imported yet). */
  offline: boolean;
}

export const loadTriageList = cache(async (): Promise<TriageSource> => {
  try {
    return { list: await serverGet<TriageList>("/api/triage/prs"), offline: false };
  } catch {
    return { list: { sets: [], prs: [] }, offline: true };
  }
});

export const loadTriagePr = cache(async (id: string): Promise<PrTriage | null> => {
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
