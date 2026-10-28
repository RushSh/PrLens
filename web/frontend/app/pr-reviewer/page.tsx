import { PrReviewer } from "@/components/triage/PrReviewer";
import { Empty } from "@/components/ui";
import { loadTriagePrs } from "@/lib/triage-source";

export const dynamic = "force-dynamic";

export default async function PrReviewerPage({ searchParams }: { searchParams: Promise<{ pr?: string }> }) {
  const [prs, { pr }] = await Promise.all([loadTriagePrs(), searchParams]);
  if (!prs.length) return <Empty>No pull requests to triage yet.</Empty>;
  const initial = prs.find((p) => p.id === pr)?.id ?? prs[0]!.id;
  return <PrReviewer prs={prs} initialId={initial} />;
}
