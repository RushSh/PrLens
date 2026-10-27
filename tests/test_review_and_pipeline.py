from pathlib import Path

from bugcensus.match import dedupe
from bugcensus.pipeline import format_report, run_census
from bugcensus.review import FakeReviewer, Finding, parse_findings

EXAMPLE = Path(__file__).parent.parent / "examples" / "billing.py"


def test_parse_findings_handles_fences_and_prose():
    text = 'Here you go:\n```json\n{"findings": [{"start_line": 7, "end_line": 8, "explanation": "x"}]}\n```'
    fs = parse_findings(text, "spark")
    assert len(fs) == 1 and fs[0].start_line == 7 and fs[0].end_line == 8


def test_parse_findings_bad_json():
    assert parse_findings("no json here", "spark") == []
    assert parse_findings('{"findings": [{"start_line": "abc"}]}', "spark") == []


def test_dedupe_groups_overlapping():
    fs = [Finding("a", 10, 12), Finding("b", 11, 11), Finding("c", 30, 30)]
    assert len(dedupe(fs)) == 2


def test_pipeline_dry_run_never_touches_file(tmp_path):
    target = tmp_path / "billing.py"
    target.write_text(EXAMPLE.read_text())
    before = target.read_text()
    reviewers = [FakeReviewer("fake-a", 0.7, 1), FakeReviewer("fake-b", 0.5, 2)]
    rep = run_census(target, reviewers, out_dir=tmp_path / "runs")
    assert target.read_text() == before
    assert rep["decoys_planted"] >= 4
    assert 0 <= rep["decoys_missed_by_all"] <= rep["decoys_planted"]
    assert rep["estimate"] is not None
    assert "Still hidden" in format_report(rep)
    assert list((tmp_path / "runs").glob("*.json"))


def test_parse_findings_ignores_reasoning_channel():
    raw = ('to=self<|message|>maybe {"findings": [{"start_line": 99}]} hmm<|eom|>'
           '<|start|>assistant to=user<|message|>```json\n{"findings": [{"start_line": 3, "end_line": 4}]}\n```')
    fs = parse_findings(raw, "glimmer")
    assert [(f.start_line, f.end_line) for f in fs] == [(3, 4)]


def test_glimmer_is_local_and_needs_no_key(monkeypatch):
    from bugcensus.config import registry
    monkeypatch.delenv("GLIMMER_API_KEY", raising=False)
    g = registry()["glimmer"]
    assert g.local and g.open_weights and g.api_key == "local"


def test_wide_findings_do_not_catch_decoys():
    from types import SimpleNamespace
    from bugcensus.match import caught_by
    d = SimpleNamespace(final_line=14, line=14)
    wide = Finding("glimmer", 11, 17, "logic", "low", "whole function")
    tight = Finding("spark", 14, 14, "logic", "high", "guard removed")
    assert caught_by(d, [wide]) == []
    assert caught_by(d, [wide, tight]) == ["spark"]


def test_failed_copy_review_is_not_counted_as_missed_decoys(tmp_path):
    from bugcensus.review import ReviewResult

    class BreaksOnB(FakeReviewer):
        def review(self, filename, source, version, context=""):
            if version == "copy-B":
                return ReviewResult(self.name, version, error="reply cut off at the token limit")
            return super().review(filename, source, version, context)

    src = Path(__file__).resolve().parents[1] / "examples" / "billing.py"
    rep = run_census(src, [BreaksOnB("fake", catch_prob=1.0, seed=1)], line_ranges=None, out_dir=tmp_path)
    b = [d for d in rep["decoys"] if d["copy"] == "copy-B"]
    assert b and all(d["not_reviewed"] for d in b)
    assert rep["decoys_missed_by_all"] == 0
    assert rep["decoys_planted"] == len(rep["decoys"]) - len(b)
    assert "NOT REVIEWED" in format_report(rep)


def test_verdict_never_clear_while_found_bugs_remain():
    from bugcensus.pipeline import _verdict
    from bugcensus.estimate import census
    est = census(found=1, decoys=40, decoys_missed=0)
    assert est.status == "CLEAR"
    assert _verdict(1, est) == "FIX 1 FOUND BUG"
    assert _verdict(0, census(found=0, decoys=40, decoys_missed=0)) == "CLEAR"


def test_decoys_avoid_lines_the_original_review_flagged(tmp_path):
    from bugcensus.review import ReviewResult

    class FlagsLine45(FakeReviewer):
        def review(self, filename, source, version, context=""):
            res = super().review(filename, source, version, context)
            if version == "original":
                res.findings.append(Finding(self.name, 45, 45, "logic", "high", "off by one"))
            return res

    src = Path(__file__).resolve().parents[1] / "examples" / "billing.py"
    rep = run_census(src, [FlagsLine45("fake", catch_prob=1.0, seed=1)], out_dir=tmp_path)
    assert 45 in rep["decoy_free_lines"]
    assert all(not d["decoy"].split(" line ")[1].startswith(("44:", "45:", "46:")) for d in rep["decoys"])


def test_fireworks_glimmer_request_settings(monkeypatch):
    from bugcensus.config import describe, effort_for, max_tokens_for, registry

    monkeypatch.setenv("FIREWORKS_REASONING_EFFORT", "")
    fw = registry()["glimmer_fw"]
    assert fw.provider == "fireworks" and fw.open_weights and not fw.local
    assert effort_for(fw) is None and max_tokens_for(fw) == 12000
    monkeypatch.setenv("FIREWORKS_REASONING_EFFORT", "low")
    assert describe(fw)["reasoning_effort"] == "low"
    assert max_tokens_for(registry()["spark"]) is None


def test_run_report_records_models_and_reviews(tmp_path):
    src = Path(__file__).resolve().parents[1] / "examples" / "billing.py"
    rep = run_census(src, [FakeReviewer("fake", catch_prob=1.0, seed=1)], out_dir=tmp_path)
    assert rep["schema_version"] == 2 and len(rep["run_id"]) == 32
    assert rep["models"][0]["provider"] == "fake"
    assert {r["version"] for r in rep["reviews"]} == {"original", "copy-A", "copy-B"}
    assert rep["source"].startswith(src.read_text()[:20])
    assert all({"kind", "function", "line"} <= set(d) for d in rep["decoys"])
