import subprocess

from prlens.hunks import parse_diff, review_rules, skip_category
from prlens.languages import CSHARP, TYPESCRIPT, formatting_proof, is_test, language_of, public_names


def hunk(diff, path):
    return parse_diff(f"diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n{diff}")[0].hunks[0]


def test_language_and_test_detection():
    assert language_of("src/a.ts").name == "typescript"
    assert language_of("src/types.d.ts") is None
    assert language_of("src/Foo.cs").name == "csharp"
    for path in ("src/__tests__/a.ts", "test/parse.test.ts", "src/a.spec.tsx", "tests/test_x.py",
                 "src/Humanizer.Tests/DateHumanizeTests.cs", "Markdig.Tests/TestParser.cs"):
        assert is_test(path), path
    for path in ("src/parse.ts", "src/Humanizer/DateHumanize.cs", "lib/attest.py"):
        assert not is_test(path), path


def test_typescript_formatting_proof():
    old = "export function f(a: number) {\n  return a + 1; // one\n}\n"
    assert formatting_proof("a.ts", old, "export function f(a: number) {\n    return a + 1;\n}\n") == "formatting"
    assert formatting_proof("a.ts", old, "export function f(a: number) {\n  return a - 1;\n}\n") is None
    # a string's contents are code, not layout
    assert formatting_proof("a.ts", 'const s = "a  b";\n', 'const s = "a b";\n') is None
    # a line break after `return` changes meaning (automatic semicolon insertion)
    assert formatting_proof("a.ts", "function f() { return a }\n", "function f() { return\n a }\n") is None


def test_csharp_formatting_proof():
    old = "public int F(int a)\n{\n    return a + 1; /* one */\n}\n"
    assert formatting_proof("A.cs", old, "public int F(int a) { return a + 1; }\n") == "formatting"
    assert formatting_proof("A.cs", old, "public int F(int a) { return a + 2; }\n") is None
    assert formatting_proof("A.cs", 'var s = @"a  b";', 'var s = @"a b";') is None


def test_public_api_rules():
    assert public_names(TYPESCRIPT, ["export function parse(x: string) {", "function helper() {"]) == {"parse"}
    assert public_names(CSHARP, ["    public static string Humanize(this DateTime d)", "    private int Count()"]) == {"Humanize"}
    ts = hunk("@@ -1,1 +1,1 @@\n-export function parse(x: string) {\n+export function parse(x: string, strict = false) {\n", "src/parse.ts")
    assert [r[0] for r in review_rules(ts)] == ["public_api"]
    cs = hunk("@@ -3,1 +3,0 @@\n-    public static string Humanize(this DateTime d)\n", "src/Humanizer/A.cs")
    assert [r[0] for r in review_rules(cs)] == ["public_api"]
    test_file = hunk("@@ -1,1 +1,1 @@\n-export function parse(x) {\n+export function parse(x, y) {\n", "test/parse.test.ts")
    assert review_rules(test_file) == []


def test_security_rule_for_typescript_and_csharp():
    ts = hunk("@@ -1,0 +1,1 @@\n+  el.innerHTML = userInput;\n", "src/view.ts")
    cs = hunk("@@ -1,0 +1,1 @@\n+        Process.Start(cmd);\n", "src/Run.cs")
    assert [r[0] for r in review_rules(ts)] == ["security_sensitive"]
    assert [r[0] for r in review_rules(cs)] == ["security_sensitive"]


def test_typescript_skips_and_test_code_is_scored():
    old = "export const a = 1;\nexport const b = 2;\n"
    fmt = hunk("@@ -1,1 +1,1 @@\n-export const a = 1;\n+export const a = 1 ;\n", "src/c.ts")
    assert skip_category(fmt, old)[0] == "formatting"
    assert skip_category(hunk("@@ -1,0 +1,1 @@\n+export type X = 1;\n", "src/types.d.ts"), None)[0] == "generated"
    assert skip_category(hunk("@@ -1,0 +1,1 @@\n+it('x', () => {});\n", "test/a.test.ts"), None) is None
    assert skip_category(hunk("@@ -1,0 +1,1 @@\n+{}\n", "test/fixtures/data.json"), None)[0] == "test_fixture"


def test_mine_finds_a_typescript_fix_with_a_test(tmp_path):
    from prlens.mine import mine_repo

    src = tmp_path / "src_repo"
    src.mkdir()
    run = lambda *a: subprocess.run(["git", *a], cwd=src, check=True, capture_output=True)  # noqa: E731
    run("init", "-q")
    run("config", "user.email", "t@t")
    run("config", "user.name", "t")
    (src / "src").mkdir()
    (src / "test").mkdir()
    (src / "src" / "add.ts").write_text("export function add(a: number, b: number) {\n  return a - b;\n}\n")
    run("add", ".")
    run("commit", "-qm", "add")
    (src / "src" / "add.ts").write_text("export function add(a: number, b: number) {\n  return a + b;\n}\n")
    (src / "test" / "add.test.ts").write_text("import { add } from '../src/add';\ntest('add', () => expect(add(1, 2)).toBe(3));\n")
    run("add", ".")
    run("commit", "-qm", "fix: add subtracted")
    rows = mine_repo(str(src), tmp_path / "work", "2000-01-01", 40, "typescript")
    assert len(rows) == 1 and rows[0]["src_files"] == ["src/add.ts"] and rows[0]["test_files"] == ["test/add.test.ts"]
    assert rows[0]["language"] == "typescript"
