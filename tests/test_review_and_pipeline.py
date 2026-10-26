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
