"""LLM layer: any OpenAI-compatible chat endpoint (Ollama, llama.cpp, LM Studio, vLLM…).

Point it at the home server or the laptop with SENSEI_LLM_BASE_URL / SENSEI_LLM_MODEL.
Used for batch line translations (EN + DE, cached on the line) and on-demand grammar notes.
"""

import json
import re

import httpx

TRANSLATE_SYSTEM = """You translate Japanese anime subtitles for a beginner learner (German and English speaker).
Translate each numbered line naturally but faithfully, keeping the meaning and tone of the
Japanese, not inventing content. Use the previous lines only as context. Character names stay
names: romanize katakana names (ハイター → Heiter), never replace them with a real person's name or
an ordinary word. Each "en" is English and each "de" is German. Reply with JSON only, exactly:
{"lines": [{"i": <number>, "en": "<English>", "de": "<German>"}, ...]}"""

EXPLAIN_SYSTEM = """You are a patient Japanese teacher for a beginner (about JLPT N5). Explain the
given anime subtitle line in {lang}: 1) a natural translation, 2) a word-by-word breakdown
(word – reading – meaning), 3) the grammar points used (e.g. 〜てしまう, 〜じゃない, sentence-final
particles) with one short explanation each. Be concise, use Markdown bullet lists, no preamble.
When the words of the line are given with their readings, follow that word split and copy those
readings exactly (they come from a dictionary; never guess a reading)."""

KATAKANA_NAME = re.compile(r"^[\u30a0-\u30ffー]{2,}$")
GERMAN_WORDS = frozenset(
    "der die das und ist nicht ich du sie es ein eine einen zu mit sich auf dass wird habe hat "
    "bin bist sind war wir ihr mich dich dir mir noch schon auch aber wenn".split()
)


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
        # A sleeping laptop over Tailscale never answers the connect: fail that fast (and retry
        # later), but give a slow model the full timeout to reply.
        self.http = httpx.Client(
            timeout=httpx.Timeout(timeout, connect=10), headers=headers, transport=transport
        )
        self.last_usage: dict = {}  # token counts of the last chat() call, if the server sends them

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
            data = r.json()
            self.last_usage = data.get("usage") or {}
            return data["choices"][0]["message"]["content"] or ""
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


def name_candidates(token_lists: list[list[dict]], min_count: int = 2) -> list[str]:
    """Katakana person names said at least `min_count` times (Sudachi's name tags are noisy:
    laughs and loanwords get tagged too, so rare ones are left out)."""
    counts: dict[str, int] = {}
    for tokens in token_lists:
        for t in tokens:
            surface = t.get("surface", "")
            if "人名" in (t.get("pos_detail") or []) and KATAKANA_NAME.match(surface):
                counts[surface] = counts.get(surface, 0) + 1
    return sorted((n for n, c in counts.items() if c >= min_count), key=lambda n: -counts[n])


def looks_german(text: str) -> bool:
    words = re.findall(r"[a-zäöüß]+", text.lower())
    hits = sum(w in GERMAN_WORDS for w in words)
    return hits >= 2 or (hits >= 1 and bool(re.search(r"[äöüß]", text.lower())))


def word_hints(tokens: list[dict]) -> str:
    """'決して (けっして, kesshite) · かなう (kanau) · …' from the line's tokens."""
    out = []
    for t in tokens:
        surface, reading = t.get("surface", ""), t.get("reading", "")
        if not surface.strip() or t.get("pos") in ("補助記号", "空白") or not reading:
            continue
        romaji = t.get("romaji") or ""
        parts = [reading] if reading != surface else []
        if romaji and romaji != surface:
            parts.append(romaji)
        lemma = t.get("lemma")
        hint = f"{surface} ({', '.join(parts)})" if parts else surface
        if lemma and lemma != surface:
            hint += f" [dictionary form {lemma}]"
        out.append(hint)
    return " · ".join(out)


def translate_batch(
    llm: LLM, lines: list[str], context: list[str], names: list[str] | None = None
) -> dict[int, tuple[str, str]]:
    user = ""
    if names:
        user += "Names in this episode (romanize, don't translate): " + ", ".join(names) + "\n\n"
    if context:
        user += "Previous lines (context, don't translate):\n" + "\n".join(context) + "\n\n"
    user += "Translate:\n" + "\n".join(f"{i}. {t}" for i, t in enumerate(lines))
    got = parse_translations(
        llm.chat(TRANSLATE_SYSTEM, user, json_mode=True), list(range(len(lines)))
    )
    # A small model sometimes answers in the wrong language or shifts lines; German in the
    # English field is the cheap tell. Dropped lines count as failed and are retried next run.
    return {i: (en, de) for i, (en, de) in got.items() if not looks_german(en)}


def explain_line(
    llm: LLM,
    line: str,
    before: list[str],
    after: list[str],
    lang: str,
    tokens: list[dict] | None = None,
) -> str:
    language = {"en": "English", "de": "German"}[lang]
    user = ""
    if before or after:
        user += "Context:\n" + "\n".join([*before, f">>> {line}", *after]) + "\n\n"
    if tokens and (hints := word_hints(tokens)):
        user += f"Words of the line with their readings: {hints}\n\n"
    user += f"Explain this line: {line}"
    return llm.chat(EXPLAIN_SYSTEM.format(lang=language), user).strip()
