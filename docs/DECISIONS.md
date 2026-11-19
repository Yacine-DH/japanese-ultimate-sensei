# Decision log

Newest first. One entry per decision that would surprise someone later.

### 2026-11-19: Server hardening + learner-facing token data (Claude)
- **Token required at startup (#11).** An empty `SENSEI_API_TOKEN` now aborts startup instead of
  silently disabling auth; `SENSEI_ALLOW_NO_AUTH=true` is the explicit dev opt-out.
- **Names are not vocabulary (#9).** Sudachi tags most anime names (フリーレン) as plain nouns but
  out-of-vocabulary, so "OOV katakana noun" counts as a name alongside 固有名詞. Names get
  `is_content=false`, `is_proper_noun=true` and still have a `word_id` for lookups.
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
