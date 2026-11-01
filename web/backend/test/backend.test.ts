import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adaptiveBound, adaptiveState, logit, type AdaptiveFeedback, type AdaptiveState, type PrFeedback, type PrTriage, type TriageList } from "@prlens/shared";
import { buildApp } from "../src/app";
import { tables } from "../src/db/schema";
import { importTriage } from "../src/import/triage";
import { startTestDb } from "./pg";

const here = path.dirname(fileURLToPath(import.meta.url));
type Fixture = {
  name: string;
  generated_at: string;
  threshold: number;
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
    const params = { url: "https://github.com/mahmoud/boltons/pull/677", model: "spark_open", explain: true };
    const noToken = await post({ action: "triage-pr", params });
    expect(noToken.statusCode).toBe(400);
    expect(noToken.json().error).toMatch(/plan this step first/);
    const token = confirmToken("triage-pr", params);
    expect((await post({ action: "triage-pr", params: { ...params, model: "wonder" }, confirmToken: token })).statusCode).toBe(400);
    expect((await post({ action: "triage-pr", params, confirmToken: token })).statusCode).toBe(201);
    expect(queued[0]!.lane).toBe("models");
    // the one-line notes are on by default
    expect(queued[0]!.args.slice(0, 8)).toEqual(["-m", "prlens", "triage-pr", params.url, "--model", "spark_open", "--explain", "--yes"]);
    expect(queued[0]!.args).toHaveLength(8); // no reviews of this repository yet: its language's calibrated threshold
    expect(queued[0]!.title).toBe("Triage mahmoud/boltons/pull/677");

    const badUrl = { url: "https://github.com/o/r/pull/1; rm -rf /", model: "spark_open" };
    expect((await post({ action: "triage-pr", params: badUrl, confirmToken: confirmToken("triage-pr", badUrl) })).statusCode).toBe(400);
    expect((await post({ action: "nope", params: {} })).statusCode).toBe(400);
    expect((await post({ action: "fit", params: { language: "typescript", model: "spark_open", alpha: 0.2 } })).statusCode).toBe(201);
    expect(queued[1]!.args).toEqual(["-m", "prlens", "fit", "--language", "typescript", "--model", "spark_open", "--alpha", "0.2", "--save"]);
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
    const s = adaptiveState("o/r", 0.06, seq.map((missed, i) => ({ prId: `p${i}`, outcome: missed ? ("bug_skipped" as const) : ("bug_reviewed" as const), at: `2026-10-28T00:00:0${i}Z` })));
    expect(s.threshold).toBeCloseTo(0.04515123590044897, 12); // prlens.adaptive.Adaptive, same sequence
    expect(adaptiveBound(200, 0.06)).toBeCloseTo(0.22941769511682544, 12);
    expect(adaptiveBound(60, 0.06)).toBeCloseTo(0.29805898372275147, 12);
    expect(s.history.map((h) => h.prId)).toEqual(seq.map((_, i) => `p${i}`));
  });

  it("keeps its guarantee against an adversary that makes every skipping PR a miss", () => {
    const fb: AdaptiveFeedback[] = [];
    let state: AdaptiveState = adaptiveState("o/r", 0.3, fb);
    for (let i = 0; i < 1500; i++) {
      fb.push({ prId: `p${i}`, outcome: state.threshold > 0 ? "bug_skipped" : "bug_reviewed", at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() });
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

  it("starts a repository's threshold at its own language's calibrated one", async () => {
    const raw = await fixture();
    const ts = structuredClone(raw);
    ts.name = "eval-typescript";
    ts.threshold = 0.031;
    await importTriage(t.db, ts);
    const live = structuredClone(raw);
    live.name = "live-ts";
    delete live.evaluation;
    const base = { ...live.prs[0]!, source: "live" as const, groundTruth: undefined, repo: "acme/web", language: "typescript" };
    live.prs = [{ ...base, id: "github:acme/web#1", number: 1 }];
    await importTriage(t.db, live);
    const app = buildApp({ db: t.db });
    const state = (await app.inject({ method: "GET", url: "/api/adaptive?scope=acme/web" })).json() as AdaptiveState;
    expect(state.threshold).toBeCloseTo(0.031, 9);
    const list = (await app.inject({ method: "GET", url: "/api/triage/prs" })).json() as TriageList;
    expect(list.prs.find((p) => p.id === "github:acme/web#1")?.language).toBe("typescript");
    await app.close();
  });

  it("records outcomes per repository and moves that repository's threshold", async () => {
    const raw = await fixture();
    const live = structuredClone(raw);
    live.name = "live-fb";
    live.generated_at = "2032-01-01T00:00:00+00:00";
    delete live.evaluation;
    const base = { ...live.prs[0]!, source: "live" as const, groundTruth: undefined, repo: "acme/api" };
    live.prs = [1, 2, 3].map((n) => ({ ...base, id: `github:acme/api#${n}`, number: n }));
    await importTriage(t.db, live);
    const app = buildApp({ db: t.db });
    const post = (n: number, body: object) =>
      app.inject({ method: "POST", url: `/api/triage/prs/${encodeURIComponent(`github:acme/api#${n}`)}/feedback`, headers, payload: body });

    const before = (await app.inject({ method: "GET", url: "/api/adaptive?scope=acme/api" })).json() as AdaptiveState;
    expect(before.n).toBe(0);
    const skippedId = base.skipped[0]!.id;
    // a bug in skipped code tightens
    const missed = (await post(1, { outcome: "bug_skipped", itemIds: [skippedId] })).json() as { adaptive: AdaptiveState };
    expect(missed.adaptive.n).toBe(1);
    expect(missed.adaptive.threshold).toBeLessThan(before.threshold);
    // no bug surfaced: recorded, no update
    const none = (await post(3, { outcome: "no_bug" })).json() as { feedback: PrFeedback; adaptive: AdaptiveState };
    expect(none.feedback.outcome).toBe("no_bug");
    expect(none.adaptive.n).toBe(1);
    expect(none.adaptive.noBug).toBe(1);
    expect(none.adaptive.threshold).toBe(missed.adaptive.threshold);
    // a bug in reviewed code loosens
    const caught = (await post(2, { outcome: "bug_reviewed" })).json() as { adaptive: AdaptiveState };
    expect(caught.adaptive.threshold).toBeGreaterThan(missed.adaptive.threshold);
    // reporting the same PR again changes its outcome in place: still one update per PR, same place in the order
    const changed = (await post(1, { outcome: "bug_reviewed" })).json() as { adaptive: AdaptiveState };
    expect(changed.adaptive.n).toBe(2);
    expect(changed.adaptive.history.map((h) => h.prId)).toEqual(["github:acme/api#1", "github:acme/api#2"]);
    expect(changed.adaptive.misses).toBe(0);

    expect((await post(2, { outcome: "bug_skipped", itemIds: ["not-a-skipped-item"] })).statusCode).toBe(400);
    expect((await post(2, { outcome: "bug_reviewed", itemIds: [skippedId] })).statusCode).toBe(400);
    expect((await post(2, { missed: true })).statusCode).toBe(400);
    const all = (await app.inject({ method: "GET", url: "/api/adaptive" })).json() as AdaptiveState[];
    expect(all.map((a) => a.scope)).toContain("acme/api");
    await app.close();
  });
});

describe("bug-conditional updates", () => {
  const at = (i: number) => `2032-01-0${i}T00:00:00Z`;
  it("a PR with no bug does not move the threshold", () => {
    const s = adaptiveState("o/r", 0.06, [{ prId: "1", outcome: "no_bug", at: at(1) }]);
    expect(s.threshold).toBeCloseTo(0.06, 12);
    expect([s.n, s.noBug, s.history.length]).toEqual([0, 1, 0]);
  });
  it("a bug in skipped code tightens and a bug in reviewed code loosens", () => {
    const tight = adaptiveState("o/r", 0.06, [{ prId: "1", outcome: "bug_skipped", at: at(1) }]);
    const loose = adaptiveState("o/r", 0.06, [{ prId: "1", outcome: "bug_reviewed", at: at(1) }]);
    expect(tight.threshold).toBeLessThan(0.06);
    expect(loose.threshold).toBeGreaterThan(0.06);
    expect([tight.misses, loose.misses]).toEqual([1, 0]);
  });
  it("each PR updates at most once", () => {
    const once = adaptiveState("o/r", 0.06, [{ prId: "1", outcome: "bug_skipped", at: at(1) }]);
    const twice = adaptiveState("o/r", 0.06, [
      { prId: "1", outcome: "bug_skipped", at: at(1) },
      { prId: "1", outcome: "bug_skipped", at: at(2) },
      { prId: "1", outcome: "bug_reviewed", at: at(3) },
    ]);
    expect(twice.threshold).toBe(once.threshold);
    expect(twice.n).toBe(1);
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
