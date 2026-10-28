/**
 * Where the PR Reviewer tab gets its data. Today: the sample PRs. When the triage backend lands, this becomes
 * `serverGet<PrTriage[]>("/api/triage/prs")` and nothing else in the tab changes.
 */
import type { PrTriage } from "@bugcensus/shared";
import { SAMPLE_PRS } from "./triage-sample";

export async function loadTriagePrs(): Promise<PrTriage[]> {
  return SAMPLE_PRS;
}
