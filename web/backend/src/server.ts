import { buildApp } from "./app";
import { createDb } from "./db/client";
import { env } from "./env";
import { JobRunner } from "./jobs/runner";
import { autoImport, ensureDatabase, migrateUp } from "./startup";

// No manual steps: create the database if needed, apply migrations, import saved results, keep importing.
await ensureDatabase();
await migrateUp();

const { db, pool } = createDb();
const importer = autoImport(db);
const runner = new JobRunner(db, () => void importer.now());
const app = buildApp({ db, runner, onImport: importer.now });

await importer.now();
await runner.start();
// Local only: this server starts processes on your machine, so it never listens on other interfaces
// unless HOST is changed on purpose.
await app.listen({ port: env.PORT, host: env.HOST });

const stop = async () => {
  importer.stop();
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
