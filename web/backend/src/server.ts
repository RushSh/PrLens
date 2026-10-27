import { buildApp } from "./app";
import { createDb } from "./db/client";
import { env } from "./env";
import { JobRunner } from "./jobs/runner";

const { db, pool } = createDb();
const runner = new JobRunner(db);
const app = buildApp({ db, runner });

await runner.start();
// Local only: this server starts processes on your machine, so it never listens on other interfaces
// unless HOST is changed on purpose.
await app.listen({ port: env.PORT, host: env.HOST });

const stop = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
