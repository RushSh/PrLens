/** Import every triage set saved in the repository (data/triage_<name>.json). */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Db } from "../db/client";
import { importTriage } from "./triage";

export interface ImportSummary {
  /** Triage sets newly imported or replaced (unchanged files are skipped). */
  triage: number;
  failed: { file: string; error: string }[];
}

export async function importRepository(db: Db, root: string): Promise<ImportSummary> {
  const summary: ImportSummary = { triage: 0, failed: [] };
  const dir = path.join(root, "data");
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.startsWith("triage_") && f.endsWith(".json")).sort();
  } catch {
    return summary;
  }
  for (const name of files) {
    const file = path.join(dir, name);
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as { kind?: unknown };
      if (raw.kind !== "triage") continue;
      if ((await importTriage(db, raw)).created) summary.triage++;
    } catch (err) {
      summary.failed.push({ file: path.relative(root, file), error: String(err).slice(0, 400) });
    }
  }
  return summary;
}
