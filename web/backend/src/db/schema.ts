/**
 * Drizzle table definitions used for type-safe queries. The SQL migrations in ../../migrations
 * own the schema (node-pg-migrate, see DATABASE.md); these definitions must mirror them.
 * test/schema.test.ts fails if a column here and in the migrated database disagree.
 */
import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: text("status", { enum: ["queued", "running", "succeeded", "failed", "cancelled"] })
    .notNull()
    .default("queued"),
  filePath: text("file_path").notNull(),
  panel: text("panel").array().notNull(),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  note: text("note"),
  log: text("log").notNull().default(""),
  error: text("error"),
  runId: uuid("run_id"),
  pid: integer("pid"),
  createdAt: ts("created_at").notNull().defaultNow(),
  startedAt: ts("started_at"),
  finishedAt: ts("finished_at"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const runs = pgTable("runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  runKey: text("run_key").notNull().unique(),
  jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
  schemaVersion: integer("schema_version").notNull(),
  filePath: text("file_path").notNull(),
  source: text("source"),
  startedAt: ts("started_at"),
  finishedAt: ts("finished_at"),
  seconds: doublePrecision("seconds"),
  gitSha: text("git_sha"),
  promptSha: text("prompt_sha"),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  changedLines: integer("changed_lines"),
  foundCounted: integer("found_counted").notNull(),
  foundIsVerified: boolean("found_is_verified").notNull().default(false),
  decoysCounted: integer("decoys_counted").notNull(),
  decoysMissed: integer("decoys_missed").notNull(),
  decoysNotReviewed: integer("decoys_not_reviewed").notNull().default(0),
  expectedHidden: doublePrecision("expected_hidden"),
  pClean: doublePrecision("p_clean"),
  intervalLow: integer("interval_low"),
  intervalHigh: integer("interval_high"),
  qMean: doublePrecision("q_mean"),
  hiddenStatus: text("hidden_status"),
  verdict: text("verdict").notNull(),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  errors: text("errors").array().notNull().default([]),
  metadataInferred: boolean("metadata_inferred").notNull().default(false),
  note: text("note"),
  raw: jsonb("raw").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const runModels = pgTable("run_models", {
  id: serial("id").primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  reviewer: text("reviewer").notNull(),
  modelId: text("model_id").notNull(),
  provider: text("provider").notNull(),
  endpoint: text("endpoint"),
  openWeights: boolean("open_weights").notNull().default(false),
  reasoningEffort: text("reasoning_effort"),
  maxTokens: integer("max_tokens"),
  inferred: boolean("inferred").notNull().default(false),
});

export const reviews = pgTable("reviews", {
  id: serial("id").primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  reviewer: text("reviewer").notNull(),
  version: text("version").notNull(),
  findingsCount: integer("findings_count"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  seconds: doublePrecision("seconds"),
  finishReason: text("finish_reason"),
  error: text("error"),
  inferred: boolean("inferred").notNull().default(false),
});

export const findings = pgTable("findings", {
  id: serial("id").primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  reviewer: text("reviewer").notNull(),
  version: text("version").notNull(),
  startLine: integer("start_line").notNull(),
  endLine: integer("end_line").notNull(),
  category: text("category"),
  explanation: text("explanation"),
});

export const suspectedBugs = pgTable("suspected_bugs", {
  id: serial("id").primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  startLine: integer("start_line").notNull(),
  endLine: integer("end_line").notNull(),
  reviewers: text("reviewers").array().notNull(),
  explanations: text("explanations").array().notNull(),
});

type Brief = { reviewer: string; lines: [number, number]; explanation?: string | null };

export const decoys = pgTable("decoys", {
  id: serial("id").primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  copyName: text("copy_name").notNull(),
  kind: text("kind"),
  functionName: text("function_name"),
  line: integer("line"),
  lineInCopy: integer("line_in_copy"),
  description: text("description").notNull(),
  caughtBy: text("caught_by").array().notNull().default([]),
  notReviewed: boolean("not_reviewed").notNull().default(false),
  matched: jsonb("matched").$type<Brief[]>().notNull().default([]),
  tooWide: jsonb("too_wide").$type<Brief[]>().notNull().default([]),
});

export const realismExperiments = pgTable("realism_experiments", {
  id: uuid("id").primaryKey().defaultRandom(),
  expKey: text("exp_key").notNull().unique(),
  name: text("name").notNull(),
  analyzedAt: ts("analyzed_at").notNull(),
  bugs: integer("bugs").notNull(),
  units: integer("units").notNull(),
  repos: integer("repos").notNull(),
  maxSpan: integer("max_span").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  models: jsonb("models").notNull(),
  missAll: jsonb("miss_all").$type<Record<string, { rate: number; n: number }>>().notNull(),
  raw: jsonb("raw").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const realismReviewerStats = pgTable("realism_reviewer_stats", {
  id: serial("id").primaryKey(),
  experimentId: uuid("experiment_id")
    .notNull()
    .references(() => realismExperiments.id, { onDelete: "cascade" }),
  reviewer: text("reviewer").notNull(),
  realRate: doublePrecision("real_rate").notNull(),
  realN: integer("real_n").notNull(),
  decoyRate: doublePrecision("decoy_rate").notNull(),
  decoyN: integer("decoy_n").notNull(),
  gapLogit: doublePrecision("gap_logit").notNull(),
  ciLow: doublePrecision("ci_low").notNull(),
  ciHigh: doublePrecision("ci_high").notNull(),
});

export const realismFamilies = pgTable("realism_families", {
  id: serial("id").primaryKey(),
  experimentId: uuid("experiment_id")
    .notNull()
    .references(() => realismExperiments.id, { onDelete: "cascade" }),
  family: text("family").notNull(),
  rate: doublePrecision("rate").notNull(),
  n: integer("n").notNull(),
});

export const tables = {
  jobs,
  runs,
  runModels,
  reviews,
  findings,
  suspectedBugs,
  decoys,
  realismExperiments,
  realismReviewerStats,
  realismFamilies,
};
