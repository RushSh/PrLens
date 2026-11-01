import { notFound } from "next/navigation";
import { FilesChanged } from "@/components/pr/FilesChanged";
import { prIdFromKey } from "@/lib/pr";
import { loadTriagePr } from "@/lib/triage-source";

export const dynamic = "force-dynamic";

export default async function FilesPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const id = prIdFromKey(key);
  const pr = id ? await loadTriagePr(id) : null;
  if (!pr) notFound();
  return <FilesChanged pr={pr} />;
}
