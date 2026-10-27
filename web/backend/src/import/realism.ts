/** Load a realism analysis (scripts/realism.py analyze --json) into the database. */
import { eq } from "drizzle-orm";
import { realismResult } from "@bugcensus/shared";
import type { Db } from "../db/client";
import { realismExperiments, realismFamilies, realismReviewerStats } from "../db/schema";
import type { ImportResult } from "./census";

export async function importRealism(db: Db, raw: unknown): Promise<ImportResult> {
  const r = realismResult.parse(raw);
  // Re-analysing the same reviews gives the same key, so the newer analysis replaces the older one.
  const key = [r.name, r.reviews_file, r.units, r.output_tokens, r.reviewers.map((x) => x.reviewer).join(",")].join("|");
  return db.transaction(async (tx) => {
    const old = await tx
      .select({ id: realismExperiments.id })
      .from(realismExperiments)
      .where(eq(realismExperiments.expKey, key));
    if (old[0]) await tx.delete(realismExperiments).where(eq(realismExperiments.id, old[0].id));

    const [row] = await tx
      .insert(realismExperiments)
      .values({
        expKey: key,
        name: r.name,
        analyzedAt: new Date(r.analyzed_at),
        bugs: r.bugs,
        units: r.units,
        repos: r.repos,
        maxSpan: r.max_span,
        outputTokens: r.output_tokens,
        models: r.models,
        missAll: r.miss_all,
        raw,
      })
      .returning({ id: realismExperiments.id });
    const experimentId = row!.id;
    if (r.reviewers.length) {
      await tx.insert(realismReviewerStats).values(
        r.reviewers.map((x) => ({
          experimentId,
          reviewer: x.reviewer,
          realRate: x.real_rate,
          realN: x.real_n,
          decoyRate: x.decoy_rate,
          decoyN: x.decoy_n,
          gapLogit: x.gap_logit,
          ciLow: x.ci_low,
          ciHigh: x.ci_high,
        })),
      );
    }
    if (r.families.length) {
      await tx
        .insert(realismFamilies)
        .values(r.families.map((f) => ({ experimentId, family: f.family, rate: f.rate, n: f.n })));
    }
    return { id: experimentId, created: !old[0] };
  });
}
