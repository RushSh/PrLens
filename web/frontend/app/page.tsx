import { PrList } from "@/components/PrList";
import { loadTriageList } from "@/lib/triage-source";

export const dynamic = "force-dynamic";

export default async function PullRequestsPage() {
  const { list, sample } = await loadTriageList();
  return <PrList list={list} sample={sample} />;
}
