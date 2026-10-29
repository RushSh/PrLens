from prlens.hunks import parse_diff, path_category, regions, review_rules, skip_category

OLD = "def f(a, b):\n    return a + b\n\n\ndef g(x):\n    return x\n"


def one_hunk(diff):
    files = parse_diff(diff)
    return files[0].hunks[0]


def test_parse_keeps_line_numbers():
    h = one_hunk("diff --git a/m.py b/m.py\n--- a/m.py\n+++ b/m.py\n@@ -1,2 +1,2 @@\n-def f(a, b):\n+def f(a, b, c=0):\n     return a + b\n")
    assert (h.added, h.removed) == (1, 1)
    assert [l.new for l in h.lines if l.kind == "add"] == [1]


def test_formatting_only_is_proven_and_logic_is_not():
    fmt = one_hunk("diff --git a/m.py b/m.py\n--- a/m.py\n+++ b/m.py\n@@ -2,1 +2,1 @@\n-    return a + b\n+    return (a +  b)  # sum\n")
    assert skip_category(fmt, OLD)[0] == "formatting"
    bug = one_hunk("diff --git a/m.py b/m.py\n--- a/m.py\n+++ b/m.py\n@@ -2,1 +2,1 @@\n-    return a + b\n+    return a - b\n")
    assert skip_category(bug, OLD) is None


def test_paths():
    assert path_category("poetry.lock") == "dependency_lock"
    assert path_category("docs/index.rst") == "docs"
    assert path_category(".github/workflows/ci.yml") == "config"
    assert path_category("src/pkg/core.py") is None


def test_public_signature_change_forces_review_but_new_def_does_not():
    changed = one_hunk("diff --git a/m.py b/m.py\n--- a/m.py\n+++ b/m.py\n@@ -1,2 +1,2 @@\n-def f(a, b):\n+def f(a, b, c):\n     return a + b\n")
    assert [r[0] for r in review_rules(changed)] == ["public_api"]
    added = one_hunk("diff --git a/m.py b/m.py\n--- a/m.py\n+++ b/m.py\n@@ -6,0 +7,2 @@\n+def h():\n+    return 1\n")
    assert review_rules(added) == []


def test_regions_split_long_runs():
    body = "".join(f"+    x{i} = {i}\n" for i in range(60))
    h = one_hunk(f"diff --git a/m.py b/m.py\n--- a/m.py\n+++ b/m.py\n@@ -1,0 +1,60 @@\n{body}")
    rs = regions(h)
    assert sum(r.added for r in rs) == 60 and max(r.added for r in rs) <= 35


def test_a_class_replaced_by_an_assignment_elsewhere_in_the_pr_is_not_a_removal():
    from prlens.hunks import defs_in

    gone = one_hunk("diff --git a/m.py b/m.py\n--- a/m.py\n+++ b/m.py\n@@ -1,2 +1,0 @@\n-class Token(tuple):\n-    pass\n")
    elsewhere = one_hunk("diff --git a/m.py b/m.py\n--- a/m.py\n+++ b/m.py\n@@ -9,0 +9,1 @@\n+Token = namedtuple('Token', 'a b')\n")
    assert [r[0] for r in review_rules(gone)] == ["public_api"]
    assert review_rules(gone, defs_in(elsewhere.lines, "add")) == []
