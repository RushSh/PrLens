/** Load a calibration analysis (scripts/calibration.py analyze) into the database. */
import { eq } from "drizzle-orm";
import { calibrationResult } from "@bugcensus/shared";
import type { Db } from "../db/client";
import { calibrationExperiments, calibrationUnits } from "../db/schema";
import type { ImportResult } from "./census";

export async function importCalibration(db: Db, raw: unknown): Promise<ImportResult> {
  const r = calibrationResult.parse(raw);
  // Same experiment (tag) analysed again under the same name: the newer analysis replaces the older one.
  const key = `${r.tag}|${r.name}`;
  return db.transaction(async (tx) => {
    const old = await tx
      .select({ id: calibrationExperiments.id })
      .from(calibrationExperiments)
      .where(eq(calibrationExperiments.expKey, key));
    if (old[0]) await tx.delete(calibrationExperiments).where(eq(calibrationExperiments.id, old[0].id));

    const [row] = await tx
      .insert(calibrationExperiments)
      .values({
        expKey: key,
        name: r.name,
        tag: r.tag,
        analyzedAt: new Date(r.analyzed_at),
        dryRun: r.dry_run,
        nUnits: r.n_units,
        repos: r.repos,
        decoysPerUnit: r.decoys_per_unit,
        decoyMissRate: r.decoy_miss_rate,
        models: r.models,
        design: r.design,
        calls: r.calls,
        variants: r.variants,
        notes: r.notes,
        raw,
      })
      .returning({ id: calibrationExperiments.id });
    const experimentId = row!.id;
    if (r.units.length) {
      await tx.insert(calibrationUnits).values(
        r.units.map((u) => ({
          experimentId,
          unitId: u.unit_id,
          repo: u.repo,
          k: u.k,
          lines: u.lines,
          foundVerified: u.found_verified,
          foundUnverified: u.found_unverified,
          decoys: u.decoys,
          missed: u.missed,
          actualHidden: u.actual_hidden,
          pred: u.pred,
        })),
      );
    }
    return { id: experimentId, created: !old[0] };
  });
}
