# Architecture

```
Laptop (Edge)                                  Home server (always on)
┌────────────────────────────┐   Tailscale    ┌──────────────────────────────────────┐
│ Extension (WXT, TS, MV3)   │ ─────HTTP────▶ │ FastAPI (Python 3.12, uv)            │
│ • content script in player │  via background│ • subtitle ingest (pysubs2)          │
│   iframe: overlay, hover,  │  worker        │ • tokenizer + furigana (SudachiPy)   │
│   sync offset, hotkeys     │                │ • JMdict EN+DE lookup (SQLite)       │
│ • capture: canvas frame,   │                │ • known words / understanding %      │
│   captureStream+Media-     │                │ • FSRS scheduling (py-fsrs)    [P1]  │
│   Recorder line replay     │                │ • media transcode (ffmpeg)     [P1]  │
│ • AnkiConnect (localhost)  │                │ • LLM batch jobs (Ollama)      [P2]  │
└────────────────────────────┘                │ • STT queue (faster-whisper)   [P3]  │
Any device → Web app (served by FastAPI):     │ SQLite (data/sensei.sqlite)          │
  library, review, words, heatmap, settings   │ data/jmdict.sqlite, data/media/      │
                                              └──────────────────────────────────────┘
```

## Components
### Server (`server/`)
- `app/main.py`: app factory `create_app()`, routes, token auth, CORS (extension origins allowed).
- `app/subtitles.py`: decode (UTF-8 / Shift-JIS / EUC-JP / UTF-16), parse via pysubs2, strip ASS
  tags, drop comments/drawings/duplicate layers/non-Japanese lines.
- `app/nlp/tokenizer.py`: SudachiPy split mode **B** (learner-sized units). Each token has surface,
  lemma, hiragana reading, lemma reading, normalized form, POS, furigana segments, romaji, `is_content`.
- `app/nlp/kana.py`: kana conversion, furigana alignment (kanji runs get ruby, kana runs must match
  the reading), romaji (pykakasi).
- `app/dictionary.py`: builds/reads `data/jmdict.sqlite` from jmdict-simplified (eng + ger).
  Ranking: reading match → JMdict common → primary form.
- `app/ingest.py`: lines → tokens → `Word` rows (linked to JMdict) and understanding stats.
- `app/models.py` / `app/schemas.py`: DB tables / API contract.

### Extension (`extension/`), Phase 1
- WXT framework so one codebase builds Edge/Chrome (MV3) and Firefox.
- Content script with `all_frames: true` finds the largest playing `<video>` (players live in
  cross-origin iframes on streaming sites) and renders the overlay in a Shadow DOM over it.
- All server calls go through the **background service worker** (avoids mixed-content/CORS issues
  on https pages; holds the token).
- Timing: show line `L` when `video.currentTime*1000 ∈ [L.start_ms + offset, L.end_ms + offset)`.
  Offset hotkeys ±100 ms, and "sync: this line is now" sets offset; persisted via `PATCH /episodes/{id}`.
- Capture: draw the `<video>` to a canvas for the screenshot (works for hls.js/MSE players; fall back to
  `tabs.captureVisibleTab` + crop). For audio/clip, rewind to line start and record the replay with
  `video.captureStream()` + `MediaRecorder`, then upload raw media; the server transcodes.
- AnkiConnect lives on the laptop (`localhost:8765`), so the extension talks to it directly.

### Web app (`web/`), Phase 1
React + Vite + TypeScript + Tailwind, built to static files and served by FastAPI (one origin).
Pages: Home (the island), Library (episodes, upload subs, understanding %), Review (FSRS with scene
media), Words (filter by status), Kana, Stats (heatmap), Player, Settings. `src/scene/` is the
framework-free three.js island behind them: lazy-loaded, optional, fed by `lib/island.ts`.

## Data model (SQLite)
`Anime 1─* Episode 1─* SubtitleLine` (tokens as JSON) · `Word` (lemma+reading, jmdict_id, common) ·
`UserWord` (user_id, word_id, status: new/learning/known/ignored) · `Card` (word, source line, FSRS
state, due) · `ReviewLog` · `Media` (screenshot/audio/clip files under `data/media/`) ·
`ActivityDay` (heatmap). Every user-scoped row has `user_id` (=1 for now).

## Media budget
Screenshot WebP 640 px q70 (~40 KB) · audio Opus 32 kbps mono (~20 KB) · clip 360p low-fps VP9 webm,
no audio (~150–300 KB) ⇒ ~0.3 MB/card, ≈1.5 GB for 5 000 cards.

## Compute budget (home server, no GPU)
- Tokenizing an episode: < 1 s.
- Local LLM ~3B (Qwen2.5-3B Q4 via Ollama): ~3–6 tok/s → batch-translate an episode's ~300 lines
  in ~20–40 min, cached. The endpoint is configurable (OpenAI-compatible) so it can point at the
  laptop's Ollama for higher quality / on-demand explanations.
- STT (Phase 3): faster-whisper small/kotoba-whisper int8 on CPU ≈ 0.5–2× episode length, overnight queue.
