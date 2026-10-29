/** Load a triage set (data/triage_<name>.json from `prlens export` or `prlens triage-pr`) into the database. */
import { eq } from "drizzle-orm";
import { triageFile, triageLoad } from "@prlens/shared";
import type { Db } from "../db/client";
import { triagePrs, triageSets } from "../db/schema";


export interface ImportResult {
  id: string;
  /** false when the same file was already imported */
  created: boolean;
}

export async function importTriage(db: Db, raw: unknown): Promise<ImportResult> {
  const f = triageFile.parse(raw);
  const generatedAt = new Date(f.generated_at);
  return db.transaction(async (tx) => {
    // Same set name: unchanged files are skipped, a newer export replaces the older one.
    const old = await tx
      .select({ id: triageSets.id, generatedAt: triageSets.generatedAt })
      .from(triageSets)
      .where(eq(triageSets.name, f.name));
    if (old[0] && old[0].generatedAt.getTime() === generatedAt.getTime()) return { id: old[0].id, created: false };
    if (old[0]) await tx.delete(triageSets).where(eq(triageSets.id, old[0].id));

    const [row] = await tx
      .insert(triageSets)
      .values({
        name: f.name,
        generatedAt,
        model: f.model,
        threshold: f.threshold,
        alpha: f.alpha,
        summary: f.summary,
        evaluation: f.evaluation ?? null,
      })
      .returning({ id: triageSets.id });
    const setId = row!.id;
    const rows = f.prs.map((pr) => {
      const { readLines, totalLines } = triageLoad(pr);
      return {
        setId,
        prId: pr.id,
        repo: pr.repo,
        title: pr.title,
        openedAt: pr.openedAt,
        reviewCount: pr.toReview.length,
        skipCount: pr.skipped.length,
        readLines,
        totalLines,
        caughtByTriage: pr.groundTruth ? pr.groundTruth.caughtByTriage : null,
        payload: pr,
      };
    });
    for (let i = 0; i < rows.length; i += 25) await tx.insert(triagePrs).values(rows.slice(i, i + 25));
    return { id: setId, created: true };
  });
}
