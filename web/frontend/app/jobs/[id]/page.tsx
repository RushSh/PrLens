import { JobLive } from "@/components/JobLive";

export const dynamic = "force-dynamic";

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <JobLive id={id} />;
}
