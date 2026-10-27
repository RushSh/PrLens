/** Helpers for runs saved before model details were recorded (before Oct 27 2026). */
import { readFile } from "node:fs/promises";

export interface UsageEntry {
  ts: number;
  model: string;
  version: string;
  input_tokens: number | null;
  output_tokens: number | null;
  seconds: number | null;
}

/** Registry defaults in use on Oct 26-27 2026 (src/bugcensus/config.py at that time). */
const DEFAULTS: Record<string, { modelId: string; provider: string; endpoint: string | null; openWeights: boolean; effort: string | null }> = {
  spark: { modelId: "muse-spark-1.3", provider: "meta", endpoint: "api.meta.ai", openWeights: false, effort: "low" },
  wonder: { modelId: "muse-wonder-1.0", provider: "meta", endpoint: "api.meta.ai", openWeights: false, effort: "low" },
  glimmer: {
    modelId: "mlx-community/Muse-Glimmer-30B-4bit",
    provider: "mlx-local",
    endpoint: "localhost:8080",
    openWeights: true,
    effort: null,
  },
  spark_open: {
    modelId: "meta-models/muse-spark-open-1026",
    provider: "baseten",
    endpoint: "inference.baseten.co",
    openWeights: true,
    effort: "low",
  },
};

export function inferModel(reviewer: string) {
  const d = DEFAULTS[reviewer];
  return {
    reviewer,
    modelId: d?.modelId ?? reviewer,
    provider: d?.provider ?? (reviewer.startsWith("fake") ? "fake" : "unknown"),
    endpoint: d?.endpoint ?? null,
    openWeights: d?.openWeights ?? false,
    reasoningEffort: d?.effort ?? null,
    maxTokens: null,
    inferred: true,
  };
}

export async function readUsageLog(file: string): Promise<UsageEntry[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const out: UsageEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Partial<UsageEntry>;
      if (typeof e.ts === "number" && typeof e.model === "string" && typeof e.version === "string") {
        out.push({
          ts: e.ts,
          model: e.model,
          version: e.version,
          input_tokens: e.input_tokens ?? null,
          output_tokens: e.output_tokens ?? null,
          seconds: e.seconds ?? null,
        });
      }
    } catch {
      // a partial last line while a run is writing; skip it
    }
  }
  return out;
}
