import { JobLive } from "@/components/JobLive";

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <JobLive id={id} />;
}
