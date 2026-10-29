/** npm run import: load data/triage_*.json into the database (safe to repeat; the server also does this). */
import { createDb } from "../db/client";
import { env } from "../env";
import { importRepository } from "./files";

const { db, pool } = createDb();
try {
  const s = await importRepository(db, env.PRLENS_ROOT);
  console.log(`Triage sets imported or updated: ${s.triage}.`);
  for (const f of s.failed) console.error(`  could not import ${f.file}: ${f.error}`);
  process.exitCode = s.failed.length ? 1 : 0;
} finally {
  await pool.end();
}
