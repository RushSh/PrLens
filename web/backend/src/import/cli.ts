/** npm run import: load runs/*.json and data/realism_*.json into the database (safe to repeat). */
import { createDb } from "../db/client";
import { env } from "../env";
import { importRepository } from "./files";

const { db, pool } = createDb();
try {
  const s = await importRepository(db, env.BUGCENSUS_ROOT);
  console.log(
    `Runs: ${s.runsCreated} imported, ${s.runsSkipped} already there, ${s.dryRunsIgnored} dry runs ignored. Realism analyses: ${s.realism}. Calibrations: ${s.calibration}.`,
  );
  for (const f of s.failed) console.error(`  could not import ${f.file}: ${f.error}`);
  process.exitCode = s.failed.length ? 1 : 0;
} finally {
  await pool.end();
}
