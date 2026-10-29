/**
 * Drizzle table definitions used for type-safe queries. The SQL migrations in ../../migrations
 * own the schema (node-pg-migrate, see DATABASE.md); these definitions must mirror them.
 * The "schema" test fails if a column here and in the migrated database disagree.
 */
import { boolean, doublePrecision, integer, jsonb, pgTable, serial, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { PrTriage, TriageEvaluation, TriageSetSummary } from "@prlens/shared";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const triageSets = pgTable("triage_sets", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  generatedAt: ts("generated_at").notNull(),
  model: text("model").notNull(),
  threshold: doublePrecision("threshold").notNull(),
  alpha: doublePrecision("alpha").notNull(),
  summary: jsonb("summary").$type<TriageSetSummary>().notNull(),
  evaluation: jsonb("evaluation").$type<TriageEvaluation>(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const triagePrs = pgTable("triage_prs", {
  id: serial("id").primaryKey(),
  setId: uuid("set_id")
    .notNull()
    .references(() => triageSets.id, { onDelete: "cascade" }),
  prId: text("pr_id").notNull(),
  repo: text("repo").notNull(),
  title: text("title").notNull(),
  openedAt: text("opened_at").notNull(),
  reviewCount: integer("review_count").notNull(),
  skipCount: integer("skip_count").notNull(),
  readLines: integer("read_lines").notNull(),
  totalLines: integer("total_lines").notNull(),
  caughtByTriage: boolean("caught_by_triage"),
  payload: jsonb("payload").$type<PrTriage>().notNull(),
});

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: text("status", { enum: ["queued", "running", "succeeded", "failed", "cancelled"] })
    .notNull()
    .default("queued"),
  action: text("action").notNull(),
  title: text("title").notNull(),
  lane: text("lane", { enum: ["models", "cpu", "ops"] }).notNull().default("cpu"),
  args: text("args").array().notNull().default([]),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  note: text("note"),
  log: text("log").notNull().default(""),
  error: text("error"),
  prId: text("pr_id"),
  pid: integer("pid"),
  createdAt: ts("created_at").notNull().defaultNow(),
  startedAt: ts("started_at"),
  finishedAt: ts("finished_at"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const tables = { triageSets, triagePrs, jobs };
