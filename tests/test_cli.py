import pytest

from prlens import cli
from prlens.llm import final_answer


def test_every_step_resolves_to_a_module_with_main():
    import importlib

    for step, (module, _) in cli.STEPS.items():
        assert callable(importlib.import_module(f"prlens.{module}").main), step


def test_unknown_step_prints_help(capsys):
    with pytest.raises(SystemExit) as e:
        cli.main(["nope"])
    assert e.value.code == 2 and "prlens <step>" in capsys.readouterr().out


def test_final_answer_drops_the_reasoning_channel():
    assert final_answer("thinking...<|channel|>final<|message|>{\"risk\": 0.2}<|end|>") == '{"risk": 0.2}'


def test_live_url_and_id():
    from prlens.live import URL_RE, pr_id

    assert URL_RE.match("https://github.com/mahmoud/boltons/issues/412") is None
    assert URL_RE.match("https://github.com/mahmoud/boltons/pull/412; rm -rf /") is None
    m = URL_RE.match("https://github.com/mahmoud/boltons/pull/412/files")
    assert m and pr_id(m.group(1), m.group(2), int(m.group(3))) == "github:mahmoud/boltons#412"


def test_models_lists_every_registry_entry_without_calling_them(monkeypatch):
    from prlens import models
    from prlens.config import registry

    monkeypatch.setattr(models.urllib.request, "urlopen", lambda *a, **k: (_ for _ in ()).throw(OSError("down")))
    rows = models.status()
    assert {r["reviewer"] for r in rows} == set(registry())
    assert all(isinstance(r["ready"], bool) and r["why"] for r in rows)
