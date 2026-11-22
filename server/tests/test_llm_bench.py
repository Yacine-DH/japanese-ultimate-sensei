import httpx

from app.llm import LLM
from app.llm_bench import report, run_model

from .test_llm import calls, fake_llm


def test_bench_runs_and_reports():
    calls.clear()
    llm = LLM("http://llm.local/v1", "qwen2.5:3b", transport=httpx.MockTransport(fake_llm))
    texts = [f"お腹が空いた{i}" for i in range(14)]  # two batches (12 + 2)
    res = run_model(llm, texts, explain_idx=3, lang="de")
    assert not res.error and res.failed == 0
    assert res.lines[13] == ("EN 1", "DE 1")  # index inside its batch → line index
    assert res.explanation.startswith("**Translation:**")
    md = report("ep.srt", texts, 280, [res], explain_idx=3)
    assert "| qwen2.5:3b |" in md and "## German" in md and "| 13 | お腹が空いた13 | DE 1 |" in md
    assert "Explain this line: お腹が空いた3" in md
