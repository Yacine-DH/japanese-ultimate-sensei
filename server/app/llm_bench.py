"""Compare LLM models on real subtitle lines: speed, failures and side-by-side EN/DE output.

Uses the same prompts, batch size and context as the episode translator, so the numbers predict
real translation times. Writes a Markdown report to read and judge the quality by eye.

Run (from server/):
  uv run python -m app.llm_bench --models qwen2.5:3b,qwen2.5:7b --jimaku "Sousou no Frieren" --episode 2
  uv run python -m app.llm_bench --models gemma3:4b --file ep2.srt --base-url http://laptop:11434/v1

The base URL defaults to SENSEI_LLM_BASE_URL from server/.env.
"""

import argparse
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

from app.config import get_settings
from app.jimaku import Jimaku, extract_subtitle, rank
from app.llm import LLM, LLMError, explain_line, name_candidates, translate_batch
from app.nlp.tokenizer import tokenize
from app.subtitles import parse_bytes
from app.translate_jobs import BATCH, CONTEXT


@dataclass
class Result:
    model: str
    load_s: float = 0.0
    translate_s: float = 0.0
    explain_s: float = 0.0
    completion_tokens: int = 0
    failed: int = 0
    error: str = ""
    lines: dict[int, tuple[str, str]] = field(default_factory=dict)
    explanation: str = ""

    def tokens_per_s(self) -> float:
        return self.completion_tokens / self.translate_s if self.translate_s else 0.0


def fetch_jimaku(api_key: str, query: str, episode: int) -> tuple[str, bytes]:
    jimaku = Jimaku(api_key)
    entries = jimaku.search(query)
    if not entries:
        sys.exit(f"no Jimaku entry for {query!r}")
    entry = entries[0]
    files = rank(jimaku.files(entry["id"], episode), episode)
    pick = next((f for f in files if f.recommended), None)
    if pick is None:
        sys.exit(f"no recommended subtitle file for episode {episode} of {entry.get('name')}")
    print(f"Jimaku: {entry.get('name')} · {pick.name}", file=sys.stderr)
    return extract_subtitle(pick.name, jimaku.download(entry["id"], pick.name), episode)


def run_model(
    llm: LLM,
    texts: list[str],
    explain_idx: int,
    lang: str,
    names: list[str] | None = None,
    explain_tokens: list[dict] | None = None,
) -> Result:
    res = Result(model=llm.model)
    try:
        t = time.monotonic()
        llm.chat("Reply with OK.", "OK?")  # loads the model into memory; timed apart
        res.load_s = time.monotonic() - t
        t = time.monotonic()
        for start in range(0, len(texts), BATCH):
            batch = texts[start : start + BATCH]
            context = texts[max(0, start - CONTEXT) : start]
            got = translate_batch(llm, batch, context, names)
            res.completion_tokens += int(llm.last_usage.get("completion_tokens") or 0)
            res.failed += len(batch) - len(got)
            res.lines.update({start + k: v for k, v in got.items()})
            print(f"  {llm.model}: {min(start + BATCH, len(texts))}/{len(texts)}", file=sys.stderr)
        res.translate_s = time.monotonic() - t
        t = time.monotonic()
        i = explain_idx
        res.explanation = explain_line(
            llm, texts[i], texts[max(0, i - 2) : i], texts[i + 1 : i + 3], lang, explain_tokens
        )
        res.explain_s = time.monotonic() - t
    except LLMError as e:
        res.error = str(e)
    return res


def _cell(s: str) -> str:
    return s.replace("|", "\\|").replace("\n", " ") or "—"


def report(
    source: str, texts: list[str], total_lines: int, results: list[Result], explain_idx: int
) -> str:
    out = [
        f"# LLM benchmark: {source}",
        "",
        f"{len(texts)} of {total_lines} lines, batches of {BATCH}.",
        "",
    ]
    out += ["| Model | Load | Translate | per line | tokens/s | failed | Explain | est. episode |",
            "|---|---|---|---|---|---|---|---|"]  # fmt: skip
    for r in results:
        if r.error and not r.lines:
            out.append(f"| {r.model} | error: {_cell(r.error)} | | | | | | |")
            continue
        per_line = r.translate_s / len(texts) if texts else 0
        out.append(
            f"| {r.model} | {r.load_s:.0f} s | {r.translate_s:.0f} s | {per_line:.1f} s "
            f"| {r.tokens_per_s():.1f} | {r.failed} | {r.explain_s:.0f} s "
            f"| {per_line * total_lines / 60:.0f} min |"
        )
    for lang, k in (("English", 0), ("German", 1)):
        out += ["", f"## {lang}", "", "| # | Japanese | " + " | ".join(r.model for r in results) + " |",
                "|---|---|" + "---|" * len(results)]  # fmt: skip
        for i, text in enumerate(texts):
            cells = [_cell(r.lines.get(i, ("", ""))[k]) for r in results]
            out.append(f"| {i} | {_cell(text)} | " + " | ".join(cells) + " |")
    out += ["", f"## Explain this line: {texts[explain_idx]}"]
    for r in results:
        out += [
            "",
            f"### {r.model} ({r.explain_s:.0f} s)",
            "",
            r.explanation or f"_{r.error or 'no answer'}_",
        ]
    return "\n".join(out) + "\n"


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--models", required=True, help="comma-separated model names")
    p.add_argument("--base-url", help="OpenAI-compatible base URL (default: SENSEI_LLM_BASE_URL)")
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--file", type=Path, help="local .srt/.ass file")
    src.add_argument("--jimaku", metavar="QUERY", help="anime title to fetch from jimaku.cc")
    p.add_argument("--episode", type=int, default=1)
    p.add_argument("--lines", type=int, default=36, help="how many lines to translate")
    p.add_argument("--skip", type=int, default=0, help="skip the first N lines (opening song)")
    p.add_argument("--explain-lang", choices=("en", "de"), default="en")
    p.add_argument("--out", type=Path, default=Path("llm-bench.md"))
    args = p.parse_args(argv)

    settings = get_settings()
    base_url = args.base_url or settings.llm_base_url
    if not base_url:
        sys.exit("no --base-url and SENSEI_LLM_BASE_URL is not set")
    if args.file:
        name, raw = args.file.name, args.file.read_bytes()
    else:
        name, raw = fetch_jimaku(settings.jimaku_api_key, args.jimaku, args.episode)
    all_lines = [line.text for line in parse_bytes(raw)]
    texts = all_lines[args.skip : args.skip + args.lines]
    if not texts:
        sys.exit("no Japanese lines in that range")
    explain_idx = max(range(len(texts)), key=lambda i: len(texts[i]))  # the meatiest line
    # Same hints as the server: names from the whole episode, readings for the explained line.
    names = name_candidates([[t.to_dict() for t in tokenize(x)] for x in all_lines])
    explain_tokens = [t.to_dict() for t in tokenize(texts[explain_idx])]
    print(f"names: {', '.join(names) or '-'}", file=sys.stderr)

    results = []
    for model in [m.strip() for m in args.models.split(",") if m.strip()]:
        llm = LLM(base_url, model, settings.llm_api_key, timeout=settings.llm_timeout_s)
        ok, detail = llm.status()
        if not ok:
            print(f"{model}: {detail}", file=sys.stderr)
            results.append(Result(model=model, error=detail))
            continue
        print(f"{model}: running", file=sys.stderr)
        results.append(run_model(llm, texts, explain_idx, args.explain_lang, names, explain_tokens))
    args.out.write_text(report(name, texts, len(all_lines), results, explain_idx), encoding="utf-8")
    print(f"report: {args.out.resolve()}", file=sys.stderr)


if __name__ == "__main__":
    main()
