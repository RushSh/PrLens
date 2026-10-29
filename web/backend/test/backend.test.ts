import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adaptiveBound, adaptiveState, logit, type AdaptiveState, type PrTriage, type TriageList } from "@prlens/shared";
import { buildApp } from "../src/app";
import { tables } from "../src/db/schema";
import { importTriage } from "../src/import/triage";
import { startTestDb } from "./pg";

const here = path.dirname(fileURLToPath(import.meta.url));
type Fixture = {
  name: string;
  generated_at: string;
  prs: PrTriage[];
  evaluation?: unknown;
};
const fixture = async (): Promise<Fixture> =>
  JSON.parse(await readFile(path.join(here, "fixtures", "triage.json"), "utf8")) as Fixture;
const headers = { "x-prlens-client": "1" };

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

describe("triage", () => {
  it("imports a set once, replaces it when re-exported, and serves the list and each PR", async () => {
    const raw = await fixture();
    const first = await importTriage(t.db, raw);
    const again = await importTriage(t.db, raw);
    expect(first.created).toBe(true);
    expect(again).toEqual({ id: first.id, created: false });
    expect((await importTriage(t.db, { ...raw, generated_at: "2030-01-01T00:00:00+00:00" })).created).toBe(true);

    const app = buildApp({ db: t.db });
    const body = (await app.inject({ method: "GET", url: "/api/triage/prs" })).json() as TriageList;
    expect(body.sets.map((s) => s.name)).toContain(raw.name);
    const mine = body.prs.filter((p) => p.set === raw.name);
    expect(mine.map((p) => p.id).sort()).toEqual(raw.prs.map((p) => p.id).sort());
    expect(mine.every((p) => p.readLines <= p.totalLines && p.caughtByTriage !== null)).toBe(true);

    const id = raw.prs[0]!.id;
    const one = await app.inject({ method: "GET", url: `/api/triage/prs/${encodeURIComponent(id)}` });
    expect(one.statusCode).toBe(200);
    const pr = one.json() as PrTriage;
    expect(pr.source).toBe("eval");
    expect(pr.groundTruth?.bugItemIds.length).toBeGreaterThan(0);
    expect((await app.inject({ method: "GET", url: "/api/triage/prs/nope" })).statusCode).toBe(404);
    const set = await app.inject({ method: "GET", url: `/api/triage/sets/${raw.name}` });
    expect(set.statusCode).toBe(200);
    await app.close();
  });

  it("lists live PRs before the evaluation set, and keeps the evaluation curve with its set", async () => {
    const raw = await fixture();
    const live = structuredClone(raw);
    live.name = "live";
    live.generated_at = "2031-01-01T00:00:00+00:00";
    delete live.evaluation;
    live.prs = [{ ...live.prs[0]!, id: "github:o/r#7", number: 7, source: "live", url: "https://github.com/o/r/pull/7", groundTruth: undefined }];
    await importTriage(t.db, live);
    const app = buildApp({ db: t.db });
    const body = (await app.inject({ method: "GET", url: "/api/triage/prs" })).json() as TriageList;
    expect(body.prs[0]!.id).toBe("github:o/r#7");
    expect(body.prs[0]!.caughtByTriage).toBeNull();
    expect(body.sets.find((s) => s.name === "live")?.evaluation).toBeNull();
    await app.close();
  });

  it("refuses a triage file whose items do not match the contract", async () => {
    const bad = structuredClone(await fixture());
    (bad.prs[0]!.toReview[0] as unknown as { priority: string }).priority = "urgent";
    await expect(importTriage(t.db, { ...bad, name: "bad" })).rejects.toThrow();
  });
});

describe("api and pipeline", () => {
  it("rejects writes without the client header", async () => {
    const app = buildApp({ db: t.db });
    const blocked = await app.inject({ method: "POST", url: "/api/import/files", payload: {} });
    expect(blocked.statusCode).toBe(403);
    await app.close();
  });

  it("refuses a paid step without a confirmation for exactly these settings, and anything off the allow-list", async () => {
    const { confirmToken } = await import("../src/pipeline");
    const queued: { args: string[]; lane: string; title: string }[] = [];
    const runner = { enqueue: async (j: (typeof queued)[number]) => (queued.push(j), "00000000-0000-0000-0000-000000000001") };
    const root = path.resolve(here, "..", "..", "..");
    const app = buildApp({ db: t.db, runner: runner as never, root });
    const actions = (await app.inject({ method: "GET", url: "/api/pipeline/actions" })).json() as { id: string; paid: boolean }[];
    expect(actions.find((a) => a.id === "triage-pr")?.paid).toBe(true);
    expect(actions.find((a) => a.id === "fit")?.paid).toBe(false);

    const post = (body: object) => app.inject({ method: "POST", url: "/api/pipeline/run", headers, payload: body });
    const params = { url: "https://github.com/mahmoud/boltons/pull/677", model: "spark_open" };
    const noToken = await post({ action: "triage-pr", params });
    expect(noToken.statusCode).toBe(400);
    expect(noToken.json().error).toMatch(/plan this step first/);
    const token = confirmToken("triage-pr", params);
    expect((await post({ action: "triage-pr", params: { ...params, model: "wonder" }, confirmToken: token })).statusCode).toBe(400);
    expect((await post({ action: "triage-pr", params, confirmToken: token })).statusCode).toBe(201);
    expect(queued[0]!.lane).toBe("models");
    expect(queued[0]!.args.slice(0, 7)).toEqual(["-m", "prlens", "triage-pr", params.url, "--model", "spark_open", "--yes"]);
    expect(queued[0]!.args.slice(7, 8)).toEqual(["--threshold"]); // the repository's adaptive threshold
    expect(queued[0]!.title).toBe("Triage mahmoud/boltons/pull/677");

    const badUrl = { url: "https://github.com/o/r/pull/1; rm -rf /", model: "spark_open" };
    expect((await post({ action: "triage-pr", params: badUrl, confirmToken: confirmToken("triage-pr", badUrl) })).statusCode).toBe(400);
    expect((await post({ action: "nope", params: {} })).statusCode).toBe(400);
    expect((await post({ action: "fit", params: { model: "spark_open", alpha: 0.2 } })).statusCode).toBe(201);
    expect(queued[1]!.args).toEqual(["-m", "prlens", "fit", "--model", "spark_open", "--alpha", "0.2", "--save"]);
    await app.close();
  });

  it("creates a missing database and applies every migration on start", async () => {
    const { ensureDatabase, migrateUp } = await import("../src/startup");
    const url = t.url.replace(/\/prlens_test$/, "/prlens_fresh");
    const logs: string[] = [];
    await ensureDatabase(url, (m) => logs.push(m));
    const applied = await migrateUp(url, (m) => logs.push(m));
    expect(logs[0]).toMatch(/created database prlens_fresh/);
    expect(applied.length).toBeGreaterThanOrEqual(1);
    expect(await migrateUp(url, () => {})).toEqual([]); // second start: nothing to do
  });
});

describe("adaptive threshold", () => {
  it("matches the Python implementation step for step", () => {
    const seq = [true, false, false, true, false, false, false];
    const s = adaptiveState("o/r", 0.06, seq.map((missed, i) => ({ prId: `p${i}`, missed, at: `2026-10-28T00:00:0${i}Z` })));
    expect(s.threshold).toBeCloseTo(0.04515123590044897, 12); // prlens.adaptive.Adaptive, same sequence
    expect(adaptiveBound(200, 0.06)).toBeCloseTo(0.22941769511682544, 12);
    expect(adaptiveBound(60, 0.06)).toBeCloseTo(0.29805898372275147, 12);
    expect(s.history.map((h) => h.prId)).toEqual(seq.map((_, i) => `p${i}`));
  });

  it("keeps its guarantee against an adversary that makes every skipping PR a miss", () => {
    const fb: { prId: string; missed: boolean; at: string }[] = [];
    let state: AdaptiveState = adaptiveState("o/r", 0.3, fb);
    for (let i = 0; i < 1500; i++) {
      fb.push({ prId: `p${i}`, missed: state.threshold > 0, at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() });
      if (i % 50 === 49) {
        state = adaptiveState("o/r", 0.3, fb);
        expect(state.missRate!).toBeLessThanOrEqual(state.bound + 1e-12);
      } else {
        state = adaptiveState("o/r", 0.3, fb);
      }
    }
    expect(Math.abs(state.missRate! - 0.2)).toBeLessThan(0.01);
    expect(logit(0.5)).toBe(0);
  });

  it("records outcomes per repository and moves that repository's threshold", async () => {
    const raw = await fixture();
    const live = structuredClone(raw);
    live.name = "live-fb";
    live.generated_at = "2032-01-01T00:00:00+00:00";
    delete live.evaluation;
    const base = { ...live.prs[0]!, source: "live" as const, groundTruth: undefined, repo: "acme/api" };
    live.prs = [1, 2].map((n) => ({ ...base, id: `github:acme/api#${n}`, number: n }));
    await importTriage(t.db, live);
    const app = buildApp({ db: t.db });
    const post = (n: number, body: object) =>
      app.inject({ method: "POST", url: `/api/triage/prs/${encodeURIComponent(`github:acme/api#${n}`)}/feedback`, headers, payload: body });

    const before = (await app.inject({ method: "GET", url: "/api/adaptive?scope=acme/api" })).json() as AdaptiveState;
    expect(before.n).toBe(0);
    const skippedId = base.skipped[0]!.id;
    const missed = (await post(1, { missed: true, itemIds: [skippedId] })).json() as { adaptive: AdaptiveState };
    expect(missed.adaptive.n).toBe(1);
    expect(missed.adaptive.threshold).toBeLessThan(before.threshold);
    const clean = (await post(2, { missed: false })).json() as { adaptive: AdaptiveState };
    expect(clean.adaptive.threshold).toBeGreaterThan(missed.adaptive.threshold);
    // changing an outcome keeps its place in the order
    const changed = (await post(1, { missed: false })).json() as { adaptive: AdaptiveState };
    expect(changed.adaptive.history.map((h) => h.prId)).toEqual(["github:acme/api#1", "github:acme/api#2"]);
    expect(changed.adaptive.misses).toBe(0);

    expect((await post(2, { missed: true, itemIds: ["not-a-skipped-item"] })).statusCode).toBe(400);
    expect((await post(2, { missed: false, itemIds: [skippedId] })).statusCode).toBe(400);
    const all = (await app.inject({ method: "GET", url: "/api/adaptive" })).json() as AdaptiveState[];
    expect(all.map((a) => a.scope)).toContain("acme/api");
    await app.close();
  });
});

describe("guarantee wording", () => {
  it("says when the ceiling becomes meaningful, and the count is exact", async () => {
    const { prsForBound, guaranteeText } = await import("@prlens/shared");
    const n = prsForBound(0.3, 0.06);
    expect(adaptiveBound(n, 0.06)).toBeLessThanOrEqual(0.3);
    expect(adaptiveBound(n - 1, 0.06)).toBeGreaterThan(0.3);
    expect(guaranteeText({ n: 1, bound: 1, threshold0: 0.06, alpha: 0.2, eta: 0.5, floor: 0.005 })).toMatch(`once ${n} PRs`);
    expect(guaranteeText({ n: 200, bound: adaptiveBound(200, 0.06), threshold0: 0.06, alpha: 0.2, eta: 0.5, floor: 0.005 })).toMatch(/≤ 23%/);
  });
});
