/**
 * Sample PRs for the PR Reviewer tab, until the triage backend is wired up.
 * Realistic in shape (an AI-agent PR, a mixed human/agent PR with a migration, a maintenance PR), but the scores,
 * signals and the skip bound are illustrative, not measured.
 */
import type { DiffLine, PrTriage, ReviewItem, SkippedItem } from "@prlens/shared";

/**
 * Build diff lines from a compact notation: each line starts with "+", "-" or " " (context);
 * a second character "!" marks a line the triage points at, e.g. "+!if i < n - 1:".
 */
function diff(oldStart: number, newStart: number, lines: string[]): DiffLine[] {
  let o = oldStart;
  let n = newStart;
  return lines.map((raw) => {
    const sign = raw[0];
    const flagged = raw[1] === "!";
    const text = raw.slice(flagged ? 2 : 1);
    if (sign === "+") return { kind: "add", oldNo: null, newNo: n++, text, flagged };
    if (sign === "-") return { kind: "del", oldNo: o++, newNo: null, text, flagged };
    return { kind: "ctx", oldNo: o++, newNo: n++, text, flagged };
  });
}

function counts(d: DiffLine[]) {
  return { added: d.filter((l) => l.kind === "add").length, removed: d.filter((l) => l.kind === "del").length };
}

function review(r: Omit<ReviewItem, "tier" | "added" | "removed">): ReviewItem {
  return { tier: "review", ...counts(r.diff), ...r };
}

function skip(s: Omit<SkippedItem, "tier" | "added" | "removed">): SkippedItem {
  return { tier: "skip", ...counts(s.diff), ...s };
}

const SAMPLE_BOUND = { missBound: 0.2, confidence: 0.9, calibratedOn: "sample value (calibration pending)" };

export const SAMPLE_PRS: PrTriage[] = [
  {
    id: "sample-boltons-412",
    number: 412,
    title: "Speed up IndexedSet.extend for large inputs",
    repo: "mahmoud/boltons (fork)",
    branch: "muse-code/indexedset-extend",
    author: { name: "Muse Code", kind: "ai_agent", agent: "Muse Code" },
    openedAt: "2026-10-28T14:12:00Z",
    taskSummary: "Make IndexedSet.extend fast for inputs of 100k+ items without changing behavior.",
    panel: ["spark", "glimmer", "spark_open"],
    source: "sample",
    guarantee: SAMPLE_BOUND,
    toReview: [
      review({
        id: "b412-1",
        file: "boltons/setutils.py",
        header: "@@ -214,12 +214,19 @@ def extend(self, values):",
        riskScore: 0.71,
        priority: "P0",
        forcedByRule: false,
        reasons: [
          { code: "bug_risk", detail: "New compaction loop shifts indexes after dead entries; the boundary check skips the last dead slot." },
          { code: "ai_finding", detail: "Spark: \"`dead_index < len(...) - 1` misses a dead entry at the end of the list.\" Glimmer did not flag it." },
        ],
        signals: [
          { name: "Spark Open risk score", value: "0.68", weight: 0.8 },
          { name: "Glimmer surprisal on changed lines", value: "top 4% of this PR", weight: 0.7 },
          { name: "Reviewers disagree", value: "1 of 2 flagged", weight: 0.5 },
          { name: "Line type", value: "boundary condition", weight: 0.6 },
        ],
        diff: diff(214, 214, [
          "     def extend(self, values):",
          "-        for v in values:",
          "-            self.add(v)",
          "+        values = [v for v in values if v not in self.item_index_map]",
          "+        if not values:",
          "+            return",
          "+        if self.dead_indices:",
          "+            for dead_index in sorted(self.dead_indices):",
          "+!                if dead_index < len(self.item_list) - 1:",
          "+                    self._compact_from(dead_index)",
          "+        start = len(self.item_list)",
          "+        self.item_list.extend(values)",
          "+        for i, v in enumerate(values, start):",
          "+            self.item_index_map[v] = i",
          "     def update(self, *others):",
        ]),
      }),
      review({
        id: "b412-2",
        file: "boltons/setutils.py",
        header: "@@ -61,7 +61,7 @@ class IndexedSet(MutableSet):",
        riskScore: 0.33,
        priority: "P0",
        forcedByRule: true,
        reasons: [
          { code: "public_api", detail: "Adds a `compact` keyword to the public constructor; callers passing positional arguments are unaffected, but the default changes when compaction runs." },
        ],
        signals: [{ name: "Rule", value: "public constructor signature changed", weight: 1 }],
        diff: diff(61, 61, [
          " class IndexedSet(MutableSet):",
          "-    def __init__(self, other=None):",
          "+!    def __init__(self, other=None, compact=True):",
          "         self.item_index_map = dict()",
        ]),
      }),
      review({
        id: "b412-3",
        file: "boltons/iterutils.py",
        header: "@@ -388,0 +389,14 @@ def chunked_iter(src, size, **kw):",
        riskScore: 0.42,
        priority: "P1",
        forcedByRule: false,
        reasons: [
          { code: "duplicates_existing", detail: "New `chunked_by_size` does what `chunked_iter(src, size)` in the same file already does." },
          { code: "intent_check", detail: "The task was to speed up IndexedSet.extend; a new public helper in iterutils was not asked for." },
        ],
        signals: [
          { name: "Similar function in codebase", value: "chunked_iter (iterutils.py:352), 91% similar", weight: 0.8 },
          { name: "Outside task scope", value: "new public function", weight: 0.6 },
        ],
        diff: diff(388, 389, [
          "+def chunked_by_size(iterable, size):",
          "+    \"\"\"Yield lists of at most *size* items from *iterable*.\"\"\"",
          "+    chunk = []",
          "+    for item in iterable:",
          "+        chunk.append(item)",
          "+        if len(chunk) == size:",
          "+            yield chunk",
          "+            chunk = []",
          "+    if chunk:",
          "+        yield chunk",
        ]),
      }),
      review({
        id: "b412-4",
        file: "tests/test_setutils.py",
        header: "@@ -142,0 +143,9 @@ def test_indexed_set_mutate():",
        riskScore: 0.38,
        priority: "P1",
        forcedByRule: false,
        reasons: [
          { code: "weak_tests", detail: "The new test only checks the length after extend; it would pass with the order or the indexes wrong, and never removes items first, so the compaction path is not exercised." },
        ],
        signals: [
          { name: "Assertions on behavior", value: "length only", weight: 0.7 },
          { name: "Changed lines covered", value: "6 of 11", weight: 0.5 },
        ],
        diff: diff(142, 143, [
          "+def test_extend_large():",
          "+    s = IndexedSet(range(10))",
          "+    s.extend(range(5, 100000))",
          "+!    assert len(s) == 100000",
          "+",
          "+def test_extend_empty():",
          "+    s = IndexedSet([1, 2])",
          "+    s.extend([])",
          "+    assert len(s) == 2",
        ]),
      }),
    ],
    skipped: [
      skip({
        id: "b412-s1",
        file: "boltons/setutils.py",
        header: "@@ -31,9 +31,9 @@",
        category: "formatting",
        reason: "Import order changed by isort; same imports.",
        riskScore: 0.01,
        diff: diff(31, 31, ["-from itertools import islice, chain", "-from collections.abc import MutableSet", "+from collections.abc import MutableSet", "+from itertools import chain, islice"]),
      }),
      skip({
        id: "b412-s2",
        file: "boltons/listutils.py",
        header: "@@ -120,6 +120,6 @@ def _expand(self, index):",
        category: "low_risk_refactor",
        reason: "Local variable renamed (`lsts` to `lists`) in one function; no other change.",
        riskScore: 0.03,
        diff: diff(120, 120, [
          "-        lsts = self.lists",
          "+        lists = self.lists",
          "-        for i, lst in enumerate(lsts):",
          "+        for i, lst in enumerate(lists):",
        ]),
      }),
      skip({
        id: "b412-s3",
        file: "docs/setutils.rst",
        header: "@@ -14,3 +14,6 @@",
        category: "docs",
        reason: "Documents the new keyword; no code.",
        riskScore: 0.01,
        diff: diff(14, 14, [" .. autoclass:: boltons.setutils.IndexedSet", "+", "+   Pass ``compact=False`` to keep dead slots until the next", "+   explicit :meth:`compact` call."]),
      }),
      skip({
        id: "b412-s4",
        file: "CHANGELOG.md",
        header: "@@ -1,3 +1,5 @@",
        category: "docs",
        reason: "Changelog entry.",
        riskScore: 0.0,
        diff: diff(1, 1, [" ## Unreleased", "+", "+- IndexedSet.extend is now much faster for large inputs."]),
      }),
      skip({
        id: "b412-s5",
        file: "tox.ini",
        header: "@@ -8,4 +8,4 @@",
        category: "config",
        reason: "Linter line length raised from 100 to 110; does not affect runtime.",
        riskScore: 0.01,
        diff: diff(8, 8, [" [flake8]", "-max-line-length = 100", "+max-line-length = 110"]),
      }),
    ],
  },
  {
    id: "sample-billing-88",
    number: 88,
    title: "Store invoice timestamps in UTC",
    repo: "acme/billing-api",
    branch: "rs/utc-invoices",
    author: { name: "Developer with Muse Code", kind: "human", agent: "Muse Code" },
    openedAt: "2026-10-28T16:40:00Z",
    taskSummary: "Store invoice created/paid times as timezone-aware UTC; convert to the customer's zone only for display.",
    panel: ["spark", "glimmer"],
    source: "sample",
    guarantee: SAMPLE_BOUND,
    toReview: [
      review({
        id: "b88-1",
        file: "migrations/0042_invoice_utc.py",
        header: "@@ -0,0 +1,18 @@",
        riskScore: 0.52,
        priority: "P0",
        forcedByRule: true,
        reasons: [
          { code: "data_migration", detail: "Rewrites every stored invoice timestamp; the backfill assumes server-local time was US/Eastern." },
          { code: "bug_risk", detail: "Rows written during the daylight-saving changeover map to two possible UTC times; `ambiguous=False` silently picks one." },
        ],
        signals: [
          { name: "Rule", value: "path matches migrations/", weight: 1 },
          { name: "Spark Open risk score", value: "0.49", weight: 0.6 },
        ],
        diff: diff(0, 1, [
          "+from django.db import migrations",
          "+import pytz",
          "+",
          "+EASTERN = pytz.timezone(\"US/Eastern\")",
          "+",
          "+def to_utc(apps, schema_editor):",
          "+    Invoice = apps.get_model(\"billing\", \"Invoice\")",
          "+    for inv in Invoice.objects.iterator():",
          "+!        local = EASTERN.localize(inv.created_at, is_dst=False)",
          "+        inv.created_at = local.astimezone(pytz.UTC)",
          "+        inv.save(update_fields=[\"created_at\"])",
        ]),
      }),
      review({
        id: "b88-2",
        file: "billing/views.py",
        header: "@@ -73,8 +73,8 @@ class InvoiceDetail(APIView):",
        riskScore: 0.46,
        priority: "P0",
        forcedByRule: true,
        reasons: [
          { code: "security_sensitive", detail: "The permission check moved below the object lookup; a missing invoice now returns 404 before the auth check, which reveals which invoice ids exist." },
          { code: "intent_check", detail: "Not part of the UTC task." },
        ],
        signals: [{ name: "Rule", value: "permission_classes / auth code touched", weight: 1 }],
        diff: diff(73, 73, [
          "     def get(self, request, pk):",
          "-        self.check_permissions(request)",
          "         invoice = get_object_or_404(Invoice, pk=pk)",
          "+!        self.check_permissions(request)",
          "         return Response(InvoiceSerializer(invoice).data)",
        ]),
      }),
      review({
        id: "b88-3",
        file: "billing/reports.py",
        header: "@@ -40,7 +40,7 @@ def overdue(invoices, today):",
        riskScore: 0.57,
        priority: "P1",
        forcedByRule: false,
        reasons: [
          { code: "bug_risk", detail: "Compares an aware UTC datetime with `today` built from a naive local date; overdue invoices near midnight shift by a day." },
          { code: "ai_finding", detail: "Both reviewers flagged the naive/aware comparison." },
        ],
        signals: [
          { name: "Spark Open risk score", value: "0.61", weight: 0.8 },
          { name: "Reviewers agree", value: "2 of 2 flagged", weight: 0.7 },
        ],
        diff: diff(40, 40, [
          " def overdue(invoices, today):",
          "-    cutoff = datetime.combine(today, time.min)",
          "+!    cutoff = datetime.combine(today, time.min).replace(tzinfo=timezone.utc)",
          "     return [i for i in invoices if i.due_at < cutoff and not i.paid_at]",
        ]),
      }),
    ],
    skipped: [
      skip({
        id: "b88-s1",
        file: "poetry.lock",
        header: "@@ -812,6 +812,6 @@",
        category: "dependency_lock",
        reason: "pytz pinned version resolved; no direct code change.",
        riskScore: 0.02,
        diff: diff(812, 812, [" [[package]]", " name = \"pytz\"", "-version = \"2024.1\"", "+version = \"2025.2\""]),
      }),
      skip({
        id: "b88-s2",
        file: "openapi/schema.json",
        header: "@@ -301,4 +301,5 @@",
        category: "generated",
        reason: "Regenerated from the serializers; review the serializer change instead.",
        riskScore: 0.02,
        diff: diff(301, 301, ["   \"created_at\": {", "     \"type\": \"string\",", "-    \"format\": \"date-time\"", "+    \"format\": \"date-time\",", "+    \"description\": \"UTC\""]),
      }),
      skip({
        id: "b88-s3",
        file: "billing/serializers.py",
        header: "@@ -12,10 +12,12 @@",
        category: "formatting",
        reason: "Black reformatted long lines; tokens unchanged.",
        riskScore: 0.01,
        diff: diff(12, 12, [
          "-    fields = [\"id\", \"customer\", \"amount\", \"created_at\", \"paid_at\", \"due_at\"]",
          "+    fields = [",
          "+        \"id\", \"customer\", \"amount\", \"created_at\", \"paid_at\", \"due_at\",",
          "+    ]",
        ]),
      }),
      skip({
        id: "b88-s4",
        file: "tests/fixtures/invoices.json",
        header: "@@ -1,6 +1,6 @@",
        category: "test_fixture",
        reason: "Fixture timestamps rewritten with a Z suffix.",
        riskScore: 0.03,
        diff: diff(1, 1, ["-  {\"id\": 1, \"created_at\": \"2026-03-08T01:30:00\"},", "+  {\"id\": 1, \"created_at\": \"2026-03-08T06:30:00Z\"},"]),
      }),
    ],
  },
  {
    id: "sample-cli-203",
    number: 203,
    title: "Bump dependencies and tidy docs",
    repo: "acme/deploy-cli",
    branch: "deps/oct-2026",
    author: { name: "Muse Code", kind: "ai_agent", agent: "Muse Code" },
    openedAt: "2026-10-28T09:05:00Z",
    taskSummary: "Monthly dependency bump; no behavior changes.",
    panel: ["spark", "glimmer"],
    source: "sample",
    guarantee: SAMPLE_BOUND,
    toReview: [
      review({
        id: "c203-1",
        file: "deploy_cli/config/defaults.yaml",
        header: "@@ -4,5 +4,5 @@",
        riskScore: 0.47,
        priority: "P1",
        forcedByRule: false,
        reasons: [
          { code: "intent_check", detail: "The task said no behavior changes, but this sets HTTP retries from 3 to 0. A config file, yet it changes what the tool does at runtime." },
        ],
        signals: [
          { name: "Config value read at runtime", value: "http.retries used in client.py:58", weight: 0.8 },
          { name: "Outside task scope", value: "behavior change in a 'no behavior change' PR", weight: 0.7 },
        ],
        diff: diff(4, 4, [" http:", "   timeout_seconds: 30", "-  retries: 3", "+!  retries: 0"]),
      }),
    ],
    skipped: [
      skip({
        id: "c203-s1",
        file: "requirements.lock",
        header: "@@ -20,9 +20,9 @@",
        category: "dependency_lock",
        reason: "Patch-level bumps only (click 8.1.7 to 8.1.8, rich 13.9.2 to 13.9.4).",
        riskScore: 0.02,
        diff: diff(20, 20, ["-click==8.1.7", "+click==8.1.8", "-rich==13.9.2", "+rich==13.9.4"]),
      }),
      skip({
        id: "c203-s2",
        file: "README.md",
        header: "@@ -30,6 +30,7 @@",
        category: "docs",
        reason: "Install instructions reworded.",
        riskScore: 0.0,
        diff: diff(30, 30, [" ## Install", "-pip install deploy-cli", "+Install with pipx (recommended):", "+    pipx install deploy-cli"]),
      }),
      skip({
        id: "c203-s3",
        file: ".github/workflows/ci.yml",
        header: "@@ -14,4 +14,4 @@",
        category: "config",
        reason: "CI Python matrix adds 3.13; does not change shipped code.",
        riskScore: 0.02,
        diff: diff(14, 14, ["     strategy:", "       matrix:", "-        python: [\"3.11\", \"3.12\"]", "+        python: [\"3.11\", \"3.12\", \"3.13\"]"]),
      }),
    ],
  },
];
