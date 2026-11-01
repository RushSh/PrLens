/** Validated settings from web/backend/.env (DB_* as in DATABASE.md, plus paths to the Python side). */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(here, "..");
config({ path: path.join(backendDir, ".env"), quiet: true });

const schema = z.object({
  DB_HOST: z.string().default("localhost"),
  DB_PORT: z.coerce.number().int().default(5432),
  DB_NAME: z.string().default("prlens"),
  DB_USER: z.string().default(process.env.USER ?? "postgres"),
  DB_PASSWORD: z.string().default(""),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default("127.0.0.1"),
  /** Repository root (where pyproject.toml and data/ live). */
  PRLENS_ROOT: z.string().default(path.resolve(backendDir, "../..")),
  /** Python with prlens installed; defaults to the repo's .venv. */
  PRLENS_PYTHON: z.string().optional(),
  NODE_ENV: z.string().default("development"),
});

const parsed = schema.parse(process.env);

export const env = {
  ...parsed,
  PRLENS_ROOT: path.resolve(parsed.PRLENS_ROOT),
  PRLENS_PYTHON:
    parsed.PRLENS_PYTHON ?? path.join(path.resolve(parsed.PRLENS_ROOT), ".venv", "bin", "python"),
  backendDir,
};

export function databaseUrl(): string {
  const auth = env.DB_PASSWORD
    ? `${encodeURIComponent(env.DB_USER)}:${encodeURIComponent(env.DB_PASSWORD)}`
    : encodeURIComponent(env.DB_USER);
  return `postgres://${auth}@${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`;
}
