import { PrReviewer } from "@/components/triage/PrReviewer";
import { Empty } from "@/components/ui";
import { loadTriageList, loadTriagePr } from "@/lib/triage-source";

export const dynamic = "force-dynamic";

export default async function PrReviewerPage({ searchParams }: { searchParams: Promise<{ pr?: string }> }) {
  const [{ list, sample }, { pr: wanted }] = await Promise.all([loadTriageList(), searchParams]);
  if (!list.prs.length) return <Empty>No pull requests to triage yet.</Empty>;
  // default to the first PR where the bug was caught (a missed one is one click away with the filter)
  const id = (list.prs.find((p) => p.id === wanted) ?? list.prs.find((p) => p.caughtByTriage) ?? list.prs[0]!).id;
  const pr = await loadTriagePr(id, sample);
  if (!pr) return <Empty>Could not load {id}. Is the backend running?</Empty>;
  return <PrReviewer key={pr.id} list={list} pr={pr} sample={sample} />;
}
