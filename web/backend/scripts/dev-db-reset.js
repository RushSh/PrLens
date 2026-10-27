// Dev only: drop all BugCensus tables and re-apply every migration (see DATABASE.md). All data is lost.
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import pg from "pg";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
config({ path: path.join(backendDir, ".env"), quiet: true });

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to reset: NODE_ENV=production");
  process.exit(1);
}

// children before parents
const TABLES = [
  "calibration_units",
  "calibration_experiments",
  "realism_families",
  "realism_reviewer_stats",
  "realism_experiments",
  "decoys",
  "suspected_bugs",
  "findings",
  "reviews",
  "run_models",
  "runs",
  "jobs",
];

const client = new pg.Client({
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME ?? "bugcensus",
  user: process.env.DB_USER ?? process.env.USER,
  password: process.env.DB_PASSWORD || undefined,
});
await client.connect();
try {
  for (const t of TABLES) await client.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
  await client.query("DROP FUNCTION IF EXISTS update_updated_at_column() CASCADE");
  await client.query("DROP TABLE IF EXISTS pgmigrations");
  console.log(`Dropped ${TABLES.length} tables in ${process.env.DB_NAME ?? "bugcensus"}.`);
} finally {
  await client.end();
}
execSync("npm run migrate", { cwd: backendDir, stdio: "inherit" });
