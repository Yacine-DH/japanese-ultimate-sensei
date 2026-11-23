# Decision log

Newest first. One entry per decision that would surprise someone later.


### 2026-11-23: Auto-sync by recognizing the speech (Claude, #147)
- **ASR first, voice activity as fallback.** VAD correlation only knows *when* someone talks;
  on SAO S1E19 (miruro stream vs. Amazon WEBRip subs, true offset ≈ +14 s) it found no clear
  match (confidence 3.7, runner-up 3.1) and suggested −103.6 s. Now the sample is cut at
  pauses, each chunk is transcribed, text and lines are compared as hiragana (Sudachi
  readings, so kanji choice doesn't matter), and lines heard clearly (≥ 60 % of their kana in
  order, ≥ 5 kana, unique in the window) become anchors. The biggest group agreeing within
  1.5 s (≥ 3 lines, ≥ half of all anchors) gives the median offset, refined to 10 ms with the
  VAD correlation within ±0.5 s. Fewer anchors → the old VAD path, unchanged.
- **Model: ReazonSpeech k2 v2** (`sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01`, int8 ONNX,
  155 MB, **Apache-2.0**) through **`sherpa-onnx`** (new dependency, Apache-2.0, wheels for
  Linux/Windows) on the CPU, so it works without the Precision. Downloaded by
  `python -m app.asr_setup` into `data/models/` (only plain files, int8 only). Optional:
  without the library or the model, `load_recognizer` returns None and auto-sync is VAD-only.
- **Measured on barkhaus (i5-7200U, 2 threads):** model load 2.5 s (once, on the first sync),
  recognition of a 45 s sample 2.4 s, peak RSS 506 MB. Real-speech check: the model's five
  Japanese test recordings in a 45 s sample with a music bed and noise, true offset 14 200 ms:
  4 lines recognized, all agreeing → 14 488 ms, refined to 14 280 ms; VAD alone on the same
  sample: "no clear match" (confidence 3.9). Optional test: `SENSEI_TEST_ASR_MODEL=<model dir
  with test_wavs/> uv run pytest tests/test_asr_sync.py`.
- **Still to watch:** a real episode with the server model installed (SAO S1E19 is a good case).
### 2026-11-23: Piecewise subtitle offsets (sync points) (Claude, #137)
- Extends "one offset per episode": an episode has `sub_offset_ms` plus optional
  **sync points** `{at_ms (video time), offset_ms}`, each valid until the next. The 10-episode
  check showed why: the same episode from different sources differs by constant offsets
  (Netflix ≈ +1 s vs SubsPlease/Amazon in 3 of 6 shows, Dandadan Amazon +4.1 s, Bleach TV
  +100 s), and a stream that has an eyecatch or recap the file lacks shifts by a few seconds
  from that point on.
- Auto-sync decides: the first confident result sets the base; later ones within 1.5 s
  refine the stretch they fall in; more than 1.5 s off inserts a point at the sample start.
  Clients that ignore `sync_points` keep working with `sub_offset_ms` (old behaviour).

### 2026-11-23: Anki note type grows by appending fields, same model id (Claude, #130)
- `SentenceEN` / `SentenceDE` were added at the **end** of the "Sensei Japanese" fields and
  `MODEL_ID` stays the same. A new id would make Anki treat it as a different note type and
  duplicate every re-exported note. With appended fields, Anki's .apkg import ("merge note
  types") and AnkiConnect `modelFieldAdd` upgrade an existing note type in place. Rule from now
  on: never reorder or rename fields, only append.

### 2026-11-22: One-click extension updates + GitHub releases (Claude, #140)
- **Native messaging host as the updater.** Edge won't let an unpacked extension rewrite itself, and
  off-store packed installs need enterprise policy (domain-joined Windows). A per-user native
  messaging host (`com.sensei.updater`, HKCU, no admin) downloads the zip from the home server, checks
  sha256 + manifest key, mirrors it into the extension folder; the extension then reloads itself.
  Only the Sensei extension ID may call it; server URL and folder come from its own config, never
  from the message. One-time setup: `install-updater.ps1` (finds the folder from Edge's preferences).
- **Extension version = `0.1.N`**, N = commits touching `extension/` (set at deploy via
  `SENSEI_EXT_VERSION`), so it only moves when the extension changes.
- **A GitHub release per extension version** (`v0.1.N`, both zips, notes from merged PRs), made by
  `deploy/update.sh`. The repo is private, so the laptop updates from the home server, not GitHub.

### 2026-11-22: Automatic subtitle sync (Claude)
- **`POST /episodes/{id}/sync`: ffsubsync-style, on a short sample.** The extension records
  30–90 s of the stream's audio; the server cross-correlates "someone is talking" with "a line is
  on screen" over ±2 min. One offset per episode (no drift/cut handling yet).
- **webrtcvad-wheels** (MIT, tiny C extension) for voice activity, **plus loudness relative to the
  surrounding second**: VAD alone calls background music speech. No numpy: pure Python runs in
  about 1 s per minute of audio on the home server.
- **Confidence = peak height in standard deviations over all other offsets** (≥ 4.5, and ≥ 1
  above the runner-up offset). Only offsets that put lines over ≥ 20 % of the sample count, and
  the baseline always spans ±60 s (Antigravity's review of #100: OP/ED and narrow searches
  faked sharp peaks). Only confident results are applied. Tuned on synthetic audio with music; revisit
  the threshold with real episodes (the response returns `confidence` and `correlation`).

### 2026-11-21: Frequency + homophones (Claude)
- **wordfreq** (CC BY-SA 4.0, Japanese data incl. subtitles; needs `mecab-python3`+ipadic, pip
  wheels) gives `Word.zipf`, the main "worth learning first" signal. Replaces the JMdict
  `common` flag for highlight ranking. First schema migration: `0002` adds `word.zipf`.
- **JMdict linking prefers Sudachi's normalized (kanji) form for kana lemmas**, so kana words
  link to the right homophone (いる → 居る not 射る, もの → 物). Kanji lemmas match themselves
  first: normalization merges distinct words (斬る → 切る, 妬く → 焼く); found by Antigravity's
  headless review of PR #79.
- **Colloquial readings override** Sudachi's dictionary defaults for a few words (私 → わたし,
  明日 → あした); context-free, so they also change the word key, and `merge_reading_fixes`
  (run by reprocess) moves statuses/cards from the old key. 何's なに/なん is **display only**
  (reading, furigana, romaji): its key stays Sudachi's, so it's one word in every context
  (なん before particles/auxiliaries starting with d/t/n sounds and as a counter prefix).
  Both refinements came from Antigravity's headless review of PR #85. Lookups accept `word_id` to return that link
  first. `python -m app.reprocess` re-links existing words.
- JLPT levels: not added (no clean, well-licensed list in a package yet).

### 2026-11-21: Anki import (Claude)
- `.apkg` read directly with sqlite3 (+ `zstandard` for Anki ≥ 2.1.50's `collection.anki21b`);
  schema 11 (JSON in `col`) and 18 (`notetypes`/`fields`/`decks` tables) both supported.
- Mature = interval ≥ 21 days (Anki's definition) → known; studied but younger → learning.
- Imported words are tokenized like subtitle words so the (lemma, reading) key matches future
  episodes; multi-word entries are reported, not guessed.

### 2026-11-21: Migrations + backups (Claude)
- **Alembic, run automatically at server start** (`app/db.migrate`), with a SQLite backup into
  `data/backups/` before any pending migration. Databases from before migrations (made by
  `create_all`) are stamped as baseline `0001`. `render_as_batch` for SQLite ALTERs.
- **New models/columns need a migration**: `cd server && uv run alembic revision --autogenerate -m "…"`,
  review it; `test_migrations.py` fails if models and migrations drift.
- **Nightly backup** (systemd timer, 04:00, keep 14) on the same disk: protects against bad
  migrations/bugs, not disk failure. Off-site copy is a later owner decision.

### 2026-11-21: Media storage + signed URLs (Claude)
- **ffmpeg CLI via subprocess** (no Pillow/PyAV): one tool for images, audio and video, already on the server.
- **Clips have no audio track**: the line audio is stored separately (Opus) and reused for
  listening cards and Anki, which keeps clips GIF-like and small.
- **Signed media URLs** (`/media/{id}?sig=HMAC(token, id)`): `<img>`/`<audio>` can't send an auth
  header. The signature is per file, never reveals the token, and rotating the token revokes it.
- **Agent channel** `/home/yacine/orca/projects/sensei-channel.md` (outside git) for direct
  Claude ⇄ Antigravity messages; issues/PRs stay the record.

### 2026-11-19: Web app served by the API server, same origin (Claude)
- The SPA's routes (`/words`, `/episodes/:id`) overlap API paths. Instead of an `/api` prefix
  (breaking both clients) the server serves `index.html` for **browser page loads**
  (`Sec-Fetch-Mode: navigate`, or `Accept: text/html` without that header) and the API for
  everything else. Files in `web/dist` are served directly. `/docs` stays the API docs.
- Runs as a systemd **user** service (`deploy/install-service.sh`); `deploy/update.sh` = pull,
  sync, build, restart.

### 2026-11-19: Server hardening + learner-facing token data (Claude)
- **Token required at startup (#11).** An empty `SENSEI_API_TOKEN` now aborts startup instead of
  silently disabling auth; `SENSEI_ALLOW_NO_AUTH=true` is the explicit dev opt-out.
- **Names are not vocabulary (#9).** Sudachi tags most anime names (フリーレン) as plain nouns but
  out-of-vocabulary, so "OOV katakana noun" counts as a name alongside 固有名詞. Names get
  `is_content=false`, `is_proper_noun=true` and still have a `word_id` for lookups.
- **FSRS via `fsrs` (py-fsrs 6) (#15).** One card per word; FSRS state as JSON on `Card.fsrs_json`.
  A word auto-graduates to `known` at stability ≥ 21 days (≈ Anki "mature") and returns to
  `learning` on a lapse.
- **Line romaji is computed at read time (#8)** from stored tokens, so it improves without
  reprocessing. Things stored at ingest (names, JMdict links) need `POST /episodes/{id}/reprocess`.

### 2026-11-17: Frontend foundation choices (Antigravity)
- **WXT + framework-free Shadow DOM for the video overlay (`extension/`).** Keeps the content script tiny (~30 KB) inside streaming-site player iframes and fullscreen containers while sharing strict TypeScript modules (`timing`, `furigana`, `highlight`, `video`) tested with Vitest + happy-dom.
- **`openapi-typescript` from `docs/openapi.json`.** Both `extension/src/api/schema.d.ts` and `web/src/api/schema.d.ts` are generated directly from the server's OpenAPI 3.1 schema.
- **Vite + React 18 + Tailwind v4 + React Router + TanStack Query (`web/`).** Dark-mode SPA built to `web/dist` so FastAPI can serve it from the same origin in S-7.

### 2026-11-17: Foundation choices (Claude)
- **Extension over the streaming site, not our own player (v0.1).** The owner watches on free
  sites. Their players are usually hls.js/MSE, so canvas and `captureStream` capture work from a content
  script. A built-in player for downloaded files is Phase 3 (needed for STT anyway).
- **Japanese subtitle files before STT.** Fan JP subs (Jimaku) are far more accurate than CPU
  Whisper, and the home server has no GPU.
- **SudachiPy, split mode B.** Pip-installable dictionary, good lemmas + normalized forms, unit
  size suits learners (mode A is too fine, mode C glues compounds). Alternative: fugashi+UniDic.
- **jmdict-simplified → our own SQLite.** Small, offline, fast lookups; EN + DE from the
  per-language releases, merged by entry id with senses stored per language.
- **Frequency ranking = JMdict `common` flag for now.** `wordfreq` for Japanese needs MeCab; we
  revisit with a proper frequency list (e.g. JPDB/Netflix corpus) when building "missed words".
- **SQLite + SQLModel, no migrations yet.** Single user, schema still moving. Add Alembic before
  real data matters (before v0.1 is used daily).
- **App factory (`uvicorn --factory`).** No import-time side effects; tests build isolated apps.
- **Auth = one static bearer token** (Tailscale is the real perimeter). Accounts are deferred.
- **Python 3.12 pinned via uv.** The system has 3.14, where NLP wheels lag.

### 2026-11-22: Speech-to-text runs on the laptop GPU behind an OpenAI-style endpoint (Claude)
- The home server has ~2 GB free RAM and no GPU: a good Japanese model (whisper large-v3 turbo /
  kotoba-whisper) doesn't fit next to the app. So the server only extracts audio (ffmpeg) and
  calls any OpenAI-compatible `/v1/audio/transcriptions` server with `response_format=srt`
  (whisper.cpp `whisper-server` on the Precision, same Tailscale-only setup as Ollama).
- The SRT goes through the normal subtitle import, so tokens, furigana, words and translations
  work the same as for Jimaku files. No new Python dependency.
- Input for now: an uploaded episode file (built-in player / downloads). Recording a whole
  stream's audio in the extension is left for later.
