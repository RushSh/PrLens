/** A throwaway real Postgres for tests (embedded-postgres), migrated with the real migration files. */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import { runner } from "node-pg-migrate";
import { createDb } from "../src/db/client";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function startTestDb() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "prlens-pg-"));
  const port = 55000 + Math.floor(Math.random() * 5000);
  const server = new EmbeddedPostgres({
    databaseDir: dir,
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
    onLog: () => {},
  });
  await server.initialise();
  await server.start();
  await server.createDatabase("prlens_test");
  const url = `postgres://postgres:postgres@localhost:${port}/prlens_test`;
  await runner({
    databaseUrl: url,
    dir: path.join(backendDir, "migrations"),
    direction: "up",
    migrationsTable: "pgmigrations",
    log: () => {},
  });
  const { db, pool } = createDb(url);
  return {
    db,
    pool,
    url,
    async stop() {
      await pool.end();
      await server.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
