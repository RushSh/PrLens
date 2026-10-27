/** Import every saved run and realism analysis from the repository (runs/*.json, data/realism_*.json). */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Db } from "../db/client";
import { importCensus } from "./census";
import { readUsageLog } from "./legacy";
import { importCalibration } from "./calibration";
import { importRealism } from "./realism";

export interface ImportSummary {
  runsCreated: number;
  runsSkipped: number;
  /** Offline `--dry-run` runs (fake reviewers only) are not imported. */
  dryRunsIgnored: number;
  realism: number;
  calibration: number;
  failed: { file: string; error: string }[];
}

async function jsonFiles(dir: string, prefix = ""): Promise<string[]> {
  try {
    return (await readdir(dir))
      .filter((f) => f.endsWith(".json") && f.startsWith(prefix))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

export async function importRepository(db: Db, root: string): Promise<ImportSummary> {
  const summary: ImportSummary = { runsCreated: 0, runsSkipped: 0, dryRunsIgnored: 0, realism: 0, calibration: 0, failed: [] };
  const usage = await readUsageLog(path.join(root, "logs", "usage.jsonl"));

  for (const file of await jsonFiles(path.join(root, "runs"))) {
    try {
      const raw: unknown = JSON.parse(await readFile(file, "utf8"));
      const reviewers = (raw as { reviewers?: unknown }).reviewers;
      if (Array.isArray(reviewers) && reviewers.length && reviewers.every((r) => String(r).startsWith("fake"))) {
        summary.dryRunsIgnored++;
        continue;
      }
      const res = await importCensus(db, raw, { fileName: file, usage });
      if (res.created) summary.runsCreated++;
      else summary.runsSkipped++;
    } catch (err) {
      summary.failed.push({ file: path.relative(root, file), error: String(err).slice(0, 400) });
    }
  }
  for (const file of await jsonFiles(path.join(root, "data"), "realism_")) {
    try {
      await importRealism(db, JSON.parse(await readFile(file, "utf8")));
      summary.realism++;
    } catch (err) {
      summary.failed.push({ file: path.relative(root, file), error: String(err).slice(0, 400) });
    }
  }
  // calibration analyses (data/calibration_<name>.json); other calibration_* files (bench) are not analyses
  for (const file of await jsonFiles(path.join(root, "data"), "calibration_")) {
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as { kind?: unknown };
      if (raw.kind !== "calibration") continue;
      await importCalibration(db, raw);
      summary.calibration++;
    } catch (err) {
      summary.failed.push({ file: path.relative(root, file), error: String(err).slice(0, 400) });
    }
  }
  return summary;
}
