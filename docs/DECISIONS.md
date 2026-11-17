# Decision log

Newest first. One entry per decision that would surprise someone later.

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
