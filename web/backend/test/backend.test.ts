import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AvailableModel } from "@bugcensus/shared";
import { buildApp } from "../src/app";
import { tables } from "../src/db/schema";
import { importCensus } from "../src/import/census";
import type { UsageEntry } from "../src/import/legacy";
import { importRealism } from "../src/import/realism";
import { resolveRepoFile, UserError } from "../src/jobs/runner";
import { getRun, listRealism, listRuns } from "../src/queries";
import { startTestDb } from "./pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(path.join(here, "fixtures", name), "utf8"));

let t: Awaited<ReturnType<typeof startTestDb>>;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

describe("schema", () => {
  it("drizzle definitions match the migrated database", async () => {
    for (const table of Object.values(tables)) {
      const cfg = getTableConfig(table);
      const { rows } = await t.pool.query<{ column_name: string; is_nullable: string }>(
        "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = $1",
        [cfg.name],
      );
      const db = new Map(rows.map((r) => [r.column_name, r.is_nullable === "NO"]));
      const ts = new Map(cfg.columns.map((c) => [c.name, c.notNull]));
      expect([...ts.keys()].sort(), cfg.name).toEqual([...db.keys()].sort());
      for (const [col, notNull] of ts) expect(notNull, `${cfg.name}.${col} NOT NULL`).toBe(db.get(col));
    }
  });
});

describe("import", () => {
  it("imports a current run once, with models, reviews, findings and decoys", async () => {
    const raw = await fixture("census_v2.json");
    const first = await importCensus(t.db, raw);
    const again = await importCensus(t.db, raw);
    expect(first.created).toBe(true);
    expect(again).toEqual({ id: first.id, created: false });

    const run = await getRun(t.db, first.id);
    expect(run?.models.map((m) => m.reviewer)).toEqual(["fake-a", "fake-b"]);
    expect(run?.reviews.length).toBe(6); // 2 reviewers x (original + 2 copies)
    expect(run?.decoys.length).toBeGreaterThan(0);
    expect(run?.decoys.every((d) => d.kind && d.functionName && d.line)).toBe(true);
    expect(run?.source).toContain("def average_order_value");
    expect(run?.metadataInferred).toBe(false);
  });

  it("imports a pre-Oct-27 run, rebuilding reviews from the usage log and flagging cut-off reviews", async () => {
    const raw = await fixture("census_legacy_cutoff.json");
    const usage = (await fixture("usage_legacy_cutoff.json")) as UsageEntry[];
    const res = await importCensus(t.db, raw, { fileName: "runs/billing-1793107163.json", usage });
    const run = await getRun(t.db, res.id);
    expect(run?.metadataInferred).toBe(true);
    expect(run?.models[0]).toMatchObject({ reviewer: "glimmer", provider: "mlx-local", inferred: true });
    expect(run?.reviews.map((r) => r.version)).toEqual(["original", "copy-A", "copy-B"]);
    const cut = run?.reviews.find((r) => r.version === "copy-B");
    expect(cut?.finishReason).toBe("length (inferred)");
    expect(run?.errors.some((e) => e.includes("cut off"))).toBe(true);
    expect(run?.finishedAt).toBe(new Date(1793107163 * 1000).toISOString());
  });

  it("refuses a run file without schema_version when no file name is given", async () => {
    await expect(importCensus(t.db, await fixture("census_legacy_cutoff.json"))).rejects.toThrow(/file/);
  });

  it("imports a realism analysis; re-importing the same analysis replaces it", async () => {
    const raw = await fixture("realism.json");
    await importRealism(t.db, raw);
    await importRealism(t.db, { ...(raw as object), analyzed_at: "2026-10-28T00:00:00+00:00" });
    const all = await listRealism(t.db);
    expect(all.length).toBe(1);
    const panel = all[0]!.reviewers.at(-1)!;
    expect(panel.reviewer).toBe("panel");
    expect(panel.realN).toBe(116);
  });

  it("filters runs by model", async () => {
    expect((await listRuns(t.db, { model: "mlx-community/Muse-Glimmer-30B-4bit" })).length).toBe(1);
    expect((await listRuns(t.db, { model: "no-such-model" })).length).toBe(0);
  });
});

describe("api", () => {
  const fakeModels = async (): Promise<AvailableModel[]> => [
    { reviewer: "spark", modelId: "muse-spark-1.3", provider: "meta", openWeights: false, reasoningEffort: "low", ready: true, why: "key set", costPerCall: 0.017, costNote: "" },
    { reviewer: "glimmer", modelId: "g", provider: "mlx-local", openWeights: true, reasoningEffort: null, ready: false, why: "local server not reachable", costPerCall: 0, costNote: "" },
  ];

  it("lists runs and rejects writes without the client header", async () => {
    const app = buildApp({ db: t.db, models: fakeModels });
    const list = await app.inject({ method: "GET", url: "/api/runs" });
    expect(list.statusCode).toBe(200);
    expect(list.json().length).toBe(2);
    const blocked = await app.inject({ method: "POST", url: "/api/import/census", payload: {} });
    expect(blocked.statusCode).toBe(403);
    await app.close();
  });

  it("validates a launch: unknown or not-ready reviewers are refused before anything starts", async () => {
    const enqueued: unknown[] = [];
    const runner = { enqueue: async (r: unknown) => (enqueued.push(r), "00000000-0000-0000-0000-000000000000") };
    const app = buildApp({ db: t.db, models: fakeModels, runner: runner as never });
    const headers = { "x-bugcensus-client": "1" };
    const post = (panel: string[]) =>
      app.inject({ method: "POST", url: "/api/jobs", headers, payload: { file: "examples/billing.py", panel } });
    expect((await post(["nope"])).json().error).toMatch(/unknown reviewer/);
    expect((await post(["glimmer"])).json().error).toMatch(/not ready/);
    expect((await post([])).statusCode).toBe(400);
    expect((await post(["spark", "spark"])).statusCode).toBe(201);
    expect(enqueued).toEqual([expect.objectContaining({ panel: ["spark"] })]);
    await app.close();
  });

  it("only allows Python files inside the repository", () => {
    const root = path.resolve(here, "..", "..", "..");
    expect(() => resolveRepoFile("../../etc/passwd", root)).toThrow(UserError);
    expect(() => resolveRepoFile("README.md", root)).toThrow(/Python/);
    expect(resolveRepoFile("examples/billing.py", root)).toBe(path.join("examples", "billing.py"));
  });
});

describe("calibration", () => {
  it("imports a calibration analysis with both estimator variants; re-import replaces it", async () => {
    const { importCalibration } = await import("../src/import/calibration");
    const { listCalibration } = await import("../src/queries");
    const raw = await fixture("calibration.json");
    expect((await importCalibration(t.db, raw)).created).toBe(true);
    expect((await importCalibration(t.db, raw)).created).toBe(false);
    const [exp] = await listCalibration(t.db);
    expect(exp?.dryRun).toBe(true);
    expect(exp?.variants.map((v) => v.name)).toEqual(["flat", "pooled"]);
    expect(exp?.variants[0]?.bins.length).toBeGreaterThan(2);
    const { rows } = await t.pool.query("SELECT count(*)::int AS n FROM calibration_units");
    expect(rows[0].n).toBe(exp?.nUnits);
  });
});

describe("startup and experiments", () => {
  it("creates a missing database and applies every migration on start", async () => {
    const { ensureDatabase, migrateUp } = await import("../src/startup");
    const url = t.url.replace(/\/bugcensus_test$/, "/bugcensus_fresh");
    const logs: string[] = [];
    await ensureDatabase(url, (m) => logs.push(m));
    const applied = await migrateUp(url, (m) => logs.push(m));
    expect(logs[0]).toMatch(/created database bugcensus_fresh/);
    expect(applied.length).toBeGreaterThanOrEqual(3);
    expect(await migrateUp(url, () => {})).toEqual([]);            // second start: nothing to do
    await ensureDatabase(url, (m) => logs.push(m));                // exists: no-op
    expect(logs.filter((l) => l.includes("created")).length).toBe(1);
  });

  it("lists actions and refuses a paid step without a confirmation for exactly these settings", async () => {
    const { confirmToken } = await import("../src/experiments");
    const queued: unknown[] = [];
    const runner = { enqueueExperiment: async (j: unknown) => (queued.push(j), "00000000-0000-0000-0000-000000000001") };
    const root = path.resolve(here, "..", "..", "..");
    const app = buildApp({ db: t.db, runner: runner as never, root });
    const headers = { "x-bugcensus-client": "1" };
    const actions = (await app.inject({ method: "GET", url: "/api/experiments/actions" })).json();
    const run = actions.find((a: { id: string }) => a.id === "calibration.run");
    expect(run.paid).toBe(true);
    expect(actions.find((a: { id: string }) => a.id === "calibration.dry_run").paid).toBe(false);

    const params = { units: "data/calibration_units.jsonl", tag: "t1", panel: ["spark"], copies: 2, workers: 4, fwTps: 950, limitUnits: 2 };
    const post = (body: object) => app.inject({ method: "POST", url: "/api/experiments/run", headers, payload: body });
    const noToken = await post({ action: "calibration.run", params });
    expect(noToken.statusCode).toBe(400);
    expect(noToken.json().error).toMatch(/plan this step first/);
    const token = confirmToken("calibration.run", params);
    expect((await post({ action: "calibration.run", params: { ...params, limitUnits: 0 }, confirmToken: token })).statusCode).toBe(400);
    expect((await post({ action: "calibration.run", params, confirmToken: token })).statusCode).toBe(201);
    const job = queued[0] as { args: string[]; lane: string };
    expect(job.lane).toBe("models");
    expect(job.args).toEqual(expect.arrayContaining(["scripts/calibration.py", "run", "--tag", "t1", "--yes", "--limit-units", "2"]));

    expect((await post({ action: "nope.nope", params: {} })).statusCode).toBe(400);
    expect((await post({ action: "calibration.run", params: { ...params, tag: "x; rm -rf /" }, confirmToken: token })).statusCode).toBe(400);
    expect((await post({ action: "calibration.dry_run", params: { pReal: 0.5, pDecoy: 0.5, seed: 1 } })).statusCode).toBe(201);
    await app.close();
  });
});
