/**
 * Turning a triaged PR into what the GitHub-style views show: files, their hunks, and which lines belong to which
 * review or skipped item. Safe to import from server and client components.
 */
import {
  SKIP_CATEGORIES,
  type DiffLine,
  type PrTriage,
  type ReviewItem,
  type SkipCategory,
  type SkippedItem,
} from "@prlens/shared";

// ---- links

/** PR ids hold characters that are awkward in a URL path (github:o/r#7), so pages use a reversible key. */
export function prKey(id: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(id)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function prIdFromKey(key: string): string | null {
  try {
    const b64 = key.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
    const id = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    return id && prKey(id) === key ? id : null;
  } catch {
    return null;
  }
}

export function prHref(id: string, tab?: "files" | "checks", anchor?: string): string {
  return `/pr/${prKey(id)}${tab ? `/${tab}` : ""}${anchor ? `#${anchor}` : ""}`;
}

export const itemAnchor = (itemId: string) => `item-${itemId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
export const fileAnchor = (path: string) => `file-${path.replace(/[^A-Za-z0-9_-]/g, "_")}`;

// ---- labels

export function prRef(pr: { number: number | null; branch: string }): string {
  return pr.number !== null ? `#${pr.number}` : pr.branch;
}

export const skipLabel = (c: SkipCategory) => SKIP_CATEGORIES[c].label;

// ---- files view

export interface ViewLine extends DiffLine {
  /** The review or skipped item this line belongs to (lines the item flags). */
  itemId?: string;
}

export interface ViewHunk {
  id: string;
  header: string;
  newStart: number;
  lines: ViewLine[];
  /** Set when the whole hunk was skipped without a model (docs, formatting, config...). */
  skipItem?: SkippedItem;
}

export interface FileView {
  path: string;
  added: number;
  removed: number;
  hunks: ViewHunk[];
  review: ReviewItem[];
  skipped: SkippedItem[];
  /** Nothing in the file needs review. */
  allSkipped: boolean;
}

const lineKey = (l: DiffLine) => `${l.kind}:${l.oldNo ?? ""}:${l.newNo ?? ""}`;
const newStart = (header: string) => Number(/\+(\d+)/.exec(header)?.[1] ?? 0);
const hunkOf = (itemId: string) => itemId.replace(/\.\d+$/, "");

/** Files in path order, each with its hunks in line order and every item placed on its lines. */
export function buildFiles(pr: PrTriage): FileView[] {
  const items: (ReviewItem | SkippedItem)[] = [...pr.toReview, ...pr.skipped];
  const byFile = new Map<string, FileView>();
  const file = (path: string) => {
    let f = byFile.get(path);
    if (!f) {
      f = { path, added: 0, removed: 0, hunks: [], review: [], skipped: [], allSkipped: false };
      byFile.set(path, f);
    }
    return f;
  };
  for (const it of items) {
    const f = file(it.file);
    f.added += it.added;
    f.removed += it.removed;
    if (it.tier === "review") f.review.push(it);
    else f.skipped.push(it);
  }

  const covered = new Set<string>();
  // whole scored hunks (exported with the PR): put each region's flagged lines on them
  for (const h of pr.hunks ?? []) {
    const mine = items.filter((it) => hunkOf(it.id) === h.id && it.id !== h.id);
    const owner = new Map<string, string>();
    for (const it of mine) {
      for (const l of it.diff) if (l.flagged) owner.set(lineKey(l), it.id);
      covered.add(it.id);
    }
    file(h.file).hunks.push({
      id: h.id,
      header: h.header,
      newStart: newStart(h.header),
      lines: h.diff.map((l) => ({ ...l, itemId: owner.get(lineKey(l)) })),
    });
  }
  // everything else is its own hunk: no-model skips (whole hunks), and items of PRs exported without hunks
  for (const it of items) {
    if (covered.has(it.id)) continue;
    const anyFlag = it.diff.some((l) => l.flagged);
    file(it.file).hunks.push({
      id: it.id,
      header: it.header,
      newStart: newStart(it.header),
      lines: it.diff.map((l) => ({ ...l, itemId: (anyFlag ? l.flagged : l.kind !== "ctx") ? it.id : undefined })),
      skipItem: it.tier === "skip" && !/\.\d+$/.test(it.id) ? it : undefined,
    });
  }

  const files = [...byFile.values()].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of files) {
    f.hunks.sort((a, b) => a.newStart - b.newStart);
    f.allSkipped = f.review.length === 0;
  }
  return files;
}

/** Consecutive lines of a hunk grouped by the item they belong to. */
export function segments(lines: ViewLine[]): { itemId?: string; lines: ViewLine[] }[] {
  const out: { itemId?: string; lines: ViewLine[] }[] = [];
  for (const l of lines) {
    const last = out[out.length - 1];
    if (last && last.itemId === l.itemId) last.lines.push(l);
    else out.push({ itemId: l.itemId, lines: [l] });
  }
  return out;
}

/** First changed line of an item, for "file.py:123"-style references. */
export function itemLine(it: { diff: DiffLine[] }): number | null {
  const l = it.diff.find((x) => x.flagged && (x.newNo ?? x.oldNo)) ?? it.diff.find((x) => x.kind !== "ctx");
  return l ? (l.newNo ?? l.oldNo) : null;
}
