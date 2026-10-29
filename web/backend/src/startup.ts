/**
 * What the backend does on start so nobody has to run `migrate` or `import` by hand:
 *   1. create the database if it does not exist yet (needs a user allowed to create databases);
 *   2. apply any pending migrations (the same SQL files `npm run migrate` uses);
 *   3. import every saved triage set, then watch data/ and import new or changed ones.
 */
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runner as migrate } from "node-pg-migrate";
import pg from "pg";
import type { Db } from "./db/client";
import { databaseUrl, env } from "./env";
import { importRepository, type ImportSummary } from "./import/files";

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export async function ensureDatabase(url: string = databaseUrl(), log: (m: string) => void = console.log): Promise<void> {
  const target = new URL(url);
  const dbName = decodeURIComponent(target.pathname.slice(1));
  const probe = new pg.Client({ connectionString: url });
  try {
    await probe.connect();
    await probe.end();
    return;
  } catch (err) {
    await probe.end().catch(() => {});
    if ((err as { code?: string }).code !== "3D000") throw err; // anything but "database does not exist"
  }
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    log(`created database ${dbName}`);
  } finally {
    await client.end();
  }
}

export async function migrateUp(url: string = databaseUrl(), log: (m: string) => void = console.log): Promise<string[]> {
  const applied = await migrate({
    databaseUrl: url,
    dir: migrationsDir,
    direction: "up",
    migrationsTable: "pgmigrations",
    log: () => {},
  });
  const names = applied.map((m) => m.name);
  if (names.length) log(`applied migrations: ${names.join(", ")}`);
  return names;
}

/** Import everything now, then again whenever files under data/ change (debounced). */
export function autoImport(
  db: Db,
  root: string = env.PRLENS_ROOT,
  log: (m: string) => void = console.log,
): { now: () => Promise<ImportSummary>; stop: () => void } {
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<ImportSummary> | null = null;
  let again = false;

  const now = async (): Promise<ImportSummary> => {
    if (running) {
      again = true;
      return running;
    }
    running = importRepository(db, root).then((s) => {
      if (s.triage || s.failed.length) {
        log(`auto-import: ${s.triage} triage sets` +
          (s.failed.length ? `, ${s.failed.length} failed (${s.failed.map((f) => f.file).join(", ")})` : ""));
      }
      return s;
    });
    try {
      return await running;
    } finally {
      running = null;
      if (again) {
        again = false;
        schedule();
      }
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void now().catch((e) => log(`auto-import failed: ${String(e)}`)), 1500);
  };

  const watchers: FSWatcher[] = [];
  for (const dir of ["data"]) {
    try {
      watchers.push(
        watch(path.join(root, dir), (_event, file) => {
          if (file && String(file).endsWith(".json")) schedule();
        }),
      );
    } catch {
      // folder does not exist yet: the periodic sweep below picks things up once it does
    }
  }
  const sweep = setInterval(schedule, 60_000);
  return {
    now,
    stop: () => {
      clearInterval(sweep);
      if (timer) clearTimeout(timer);
      for (const w of watchers) w.close();
    },
  };
}
