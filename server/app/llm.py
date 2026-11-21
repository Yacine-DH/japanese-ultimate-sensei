"""LLM layer: any OpenAI-compatible chat endpoint (Ollama, llama.cpp, LM Studio, vLLM…).

Point it at the home server or the laptop with SENSEI_LLM_BASE_URL / SENSEI_LLM_MODEL.
Used for batch line translations (EN + DE, cached on the line) and on-demand grammar notes.
"""

import json
import re

import httpx

TRANSLATE_SYSTEM = """You translate Japanese anime subtitles for a beginner learner (German and English speaker).
Translate each numbered line naturally but faithfully, keeping the meaning and tone of the
Japanese, not inventing content. Use the previous lines only as context. Keep character names
in romaji. Reply with JSON only, exactly:
{"lines": [{"i": <number>, "en": "<English>", "de": "<German>"}, ...]}"""

EXPLAIN_SYSTEM = """You are a patient Japanese teacher for a beginner (about JLPT N5). Explain the
given anime subtitle line in {lang}: 1) a natural translation, 2) a word-by-word breakdown
(word – reading – meaning), 3) the grammar points used (e.g. 〜てしまう, 〜じゃない, sentence-final
particles) with one short explanation each. Be concise, use Markdown bullet lists, no preamble."""


class LLMError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


class LLM:
    def __init__(
        self,
        base_url: str,
        model: str,
        api_key: str = "",
        timeout: float = 600,
        transport: httpx.BaseTransport | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self.http = httpx.Client(timeout=timeout, headers=headers, transport=transport)

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.model)

    def status(self) -> tuple[bool, str]:
        if not self.configured:
            return False, "not configured (SENSEI_LLM_BASE_URL + SENSEI_LLM_MODEL)"
        try:
            r = self.http.get(f"{self.base_url}/models", timeout=5)
        except httpx.HTTPError as e:
            return False, f"unreachable: {e}"
        if r.status_code >= 400:
            return False, f"error {r.status_code}"
        ids = [m.get("id") for m in (r.json().get("data") or []) if isinstance(m, dict)]
        if ids and self.model not in ids:
            return False, f"model '{self.model}' not available (have: {', '.join(ids[:8])})"
        return True, "ok"

    def chat(self, system: str, user: str, json_mode: bool = False) -> str:
        if not self.configured:
            raise LLMError("LLM not configured (SENSEI_LLM_BASE_URL + SENSEI_LLM_MODEL)", 503)
        body: dict = {
            "model": self.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "temperature": 0.2,
            "stream": False,
        }
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        try:
            r = self.http.post(f"{self.base_url}/chat/completions", json=body)
        except httpx.HTTPError as e:
            raise LLMError(f"LLM unreachable: {e}") from e
        if r.status_code >= 400:
            raise LLMError(f"LLM error {r.status_code}: {r.text[:200]}")
        try:
            return r.json()["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, ValueError) as e:
            raise LLMError("unexpected LLM response") from e


def parse_translations(text: str, wanted: list[int]) -> dict[int, tuple[str, str]]:
    """{i: (en, de)} from the model's JSON (tolerates code fences / chatter around it)."""
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return {}
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError:
        return {}
    items = (
        data.get("lines", data if isinstance(data, list) else [])
        if isinstance(data, dict)
        else data
    )
    out: dict[int, tuple[str, str]] = {}
    for it in items if isinstance(items, list) else []:
        if not isinstance(it, dict):
            continue
        try:
            i = int(it.get("i"))
        except (TypeError, ValueError):
            continue
        en, de = str(it.get("en") or "").strip(), str(it.get("de") or "").strip()
        if i in wanted and (en or de):
            out[i] = (en, de)
    return out


def translate_batch(llm: LLM, lines: list[str], context: list[str]) -> dict[int, tuple[str, str]]:
    user = ""
    if context:
        user += "Previous lines (context, don't translate):\n" + "\n".join(context) + "\n\n"
    user += "Translate:\n" + "\n".join(f"{i}. {t}" for i, t in enumerate(lines))
    return parse_translations(
        llm.chat(TRANSLATE_SYSTEM, user, json_mode=True), list(range(len(lines)))
    )


def explain_line(llm: LLM, line: str, before: list[str], after: list[str], lang: str) -> str:
    language = {"en": "English", "de": "German"}[lang]
    user = ""
    if before or after:
        user += "Context:\n" + "\n".join([*before, f">>> {line}", *after]) + "\n\n"
    user += f"Explain this line: {line}"
    return llm.chat(EXPLAIN_SYSTEM.format(lang=language), user).strip()
