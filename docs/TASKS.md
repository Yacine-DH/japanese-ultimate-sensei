# Task board

Legend: `[ ]` open · `[~]` claimed `(agent, date)` · `[x]` done · **deps** must be `[x]` first.
Areas: **S** = server (Claude) · **E** = extension (Antigravity) · **W** = web app (Antigravity) · **O** = owner.
Protocol: see [AGENTS.md](../AGENTS.md). Claim → branch → PR/merge → tick.

## Owner actions
- [x] **O-1** Install `uv` on the server: `curl -LsSf https://astral.sh/uv/install.sh | sh`
- [x] **O-2** Install Node.js 22 LTS on the server (e.g. `fnm install 22` or nvm), plus `pnpm` (`corepack enable`) (antigravity, 2026-11-17: Node v22.23.5 + pnpm 12.21.0 installed in `~/.local/bin`)
- [x] **O-3** Make a free [jimaku.cc](https://jimaku.cc) account and API key → `SENSEI_JIMAKU_API_KEY` in `server/.env`
- [x] **O-4** `SENSEI_API_TOKEN` in `server/.env`, required since #11; `bash deploy/install-service.sh` generates it (claude, 2026-11-19: set on the home server)
- [ ] **O-5** Tell Claude your laptop specs (CPU/GPU/RAM), which decides which LLM runs where

## Phase 0: Foundation
- [x] **S-0** Repo, docs, agent conventions, server skeleton: subtitle ingest, Sudachi tokens + furigana + romaji, JMdict EN/DE, word status, understanding %, token auth, tests (claude, 2026-11-17)
- [x] **S-0b** Tests green (29), real JMdict built (219k entries, EN+DE), `docs/openapi.json` exported; fixed romaji for small っ and particles (claude, 2026-11-17)

## Phase 1: v0.1 core loop
### Server (Claude)
- [x] **S-1** (#13) Jimaku integration: `GET /subs/search?q=` (AniList/Jimaku), `POST /episodes/from-jimaku` (download + ingest). deps: O-3 (claude, 2026-11-21: `/subs/search`, `/subs/{id}/files` ranked + recommended, `/episodes/from-jimaku` with zip support)
- [x] **S-2** (#14) Media: `POST /media` (multipart screenshot/audio/clip upload) → ffmpeg transcode (WebP/Opus/VP9 360p) → `GET /media/{id}` (claude, 2026-11-21: signed URLs for <img>/<audio>, clips transcoded in background)
- [x] **S-3** (#15) Cards + FSRS: `POST /cards` (word + line + media ids), `GET /reviews/due`, `POST /reviews` (rating), sets UserWord → learning/known (claude, 2026-11-19: py-fsrs, one card per word, auto-known at stability ≥ 21 d, `next_due` per rating, activity counters)
- [x] **S-4** (#16) Known-words import: from Anki (.apkg/.txt export, choose field) and plain word lists (claude, 2026-11-21: .apkg any version incl. zstd, AnkiConnect cards, word lists, dry run)
- [x] **S-5** (#17) Anki export: `.apkg` (genanki) with media; card JSON for AnkiConnect push (claude, 2026-11-21: stable GUIDs, MP3 audio, `/anki/model` for createModel)
- [x] **S-6** (#18) Activity tracking: `POST /activity/watch` (minutes), auto-count reviews/words; `GET /activity?from=&to=` for heatmap (claude, 2026-11-21: + streaks, `GET /anime`, `GET /anime/{id}/progress` daily trend)
- [x] **S-7** (#19) Serve `web/dist` at `/` from FastAPI; Alembic migrations; systemd user service (claude, 2026-11-21: web serving, service/update scripts, Alembic auto-migrate on start with pre-migration backup, nightly backups ×14)

### Extension (Antigravity)
- [x] **E-1** Scaffold `extension/` with WXT + TypeScript (strict) + Vitest. Options page: server URL (default `http://<tailscale-host>:8000`), API token, gloss language (EN/DE), romaji on/off. Background worker exposes a typed `api.call(path, init)` proxy that adds the token. Popup shows `/health` status. Builds for Edge/Chrome **and** Firefox. Types generated from `docs/openapi.json`. deps: O-2 (antigravity, 2026-11-17: WXT Chrome MV3 + Firefox MV2 builds, OpenAPI types, background proxy, options & popup, 6 unit tests)
- [x] **E-2** Video detection + overlay: content script (`all_frames`) finds the largest visible `<video>`, mounts a Shadow-DOM overlay above it (fullscreen-safe). Renders the current line from `GET /episodes/{id}/lines` with `<ruby>` furigana (hide ruby when `status` is known/ignored), optional romaji line. Timing per ARCHITECTURE.md with `sub_offset_ms`; hotkeys `[` / `]` = ∓100 ms, `\` = "sync this line now"; persist via `PATCH /episodes/{id}`. Pure timing logic unit-tested. deps: E-1 (antigravity, 2026-11-17: Shadow DOM overlay, video detector, furigana/romaji renderer, offset hotkeys + PATCH persistence, unit tests)
- [x] **E-3** Hover/learn: unknown **content** tokens get a highlight (limit to the top N per line, ranked `common` first, N configurable, default 3). Hovering pauses the video and shows a popup from `GET /dictionary/lookup?q=<lemma>&reading=<lemma_reading>` (EN/DE per setting) with buttons Known / Ignore / Save. Known/Ignore → `POST /words/{id}/status`. Resume on mouse-leave. deps: E-2 (antigravity, 2026-11-17: top-N common-first unknown content token highlighting, hover pause/resume, EN/DE dictionary popup, Known/Ignore/Save status actions, 15 unit tests)
- [x] **E-4** (#20, #2) Episode picker (popup): list episodes (`GET /episodes`), upload a JP subtitle file (`POST /episodes`), and remember a mapping *page URL pattern → episode id* in `storage.local`; later Jimaku search (S-1). deps: E-1 (antigravity, 2026-11-17: per-tab + URL-pattern episode attachment, next-episode auto-suggestion, popup episode search & subtitle upload, 19 unit tests)
- [x] **E-5** (#21) Save with capture: on Save, capture a canvas screenshot (fallback `captureVisibleTab` + crop), rewind to `line.start_ms`, record the line via `captureStream()` + `MediaRecorder` (webm), resume; upload to `POST /media`, then `POST /cards`. deps: E-3, S-2, S-3 (antigravity, 2026-11-21: framework-free capture.ts with canvas + tainted-canvas captureVisibleTab crop fallback, Chrome/Firefox captureStream + dual audio/clip MediaRecorder, POST /media + POST /cards wiring, "Saved ✓" thumbnail toast, unit tests)
- [x] **E-6** (#22) AnkiConnect push (optional per settings) of saved cards using S-5's card JSON. deps: E-5, S-5 (antigravity, 2026-11-21: AnkiConnect client + persistent offline queue/retry in background, model/deck auto-creation + storeMediaFile + addNote, Options card with test & sync controls, plus web .apkg export button, unit tests)

### Web app (Antigravity)
- [x] **W-1** Scaffold `web/`: Vite + React + TS + Tailwind + React Router + TanStack Query; API client generated from `docs/openapi.json`; settings page (token). Dark mode. deps: O-2 (antigravity, 2026-11-17: Vite + React 18 + Tailwind v4 + React Router + TanStack Query dark-mode SPA, OpenAPI types, settings + health check, unit tests)
- [x] **W-2** (#23) Library: anime → episodes, upload subtitle, understanding % bar per episode, episode detail with the transcript (furigana, word status colours, click a word → lookup + status). deps: W-1 (antigravity, 2026-11-19: grouped anime library, subtitle upload, per-episode understanding % bar, full interactive transcript with EN/DE dictionary inspector & pre-study filter, unit tests)
- [x] **W-3** (#24) Review: FSRS session with screenshot, play line audio/clip, reveal meaning + sentence, rate Again/Hard/Good/Easy (keys 1–4). deps: W-1, S-3 (antigravity, 2026-11-19: mobile-friendly FSRS review queue with next_due interval labels, EN+DE glosses, sentence furigana + romaji, media preview/placeholder, graduation celebration, Space/1–4/R shortcuts, unit tests)
- [x] **W-4** (#25) Words: table filterable by status / anime, bulk mark known. deps: W-1 (antigravity, 2026-11-19: vocabulary table with status/anime/episode/search filters, frequency column, multi-select bulk status bar via POST /words/bulk-status, dictionary inspector & add-card action, unit tests)
- [x] **W-5** (#26, #65) Stats: GitHub-style activity heatmap + understanding % trend per anime. deps: W-1, S-6 (antigravity, 2026-11-21: extension watch-time heartbeat accumulator POST /activity/watch + web 365-day activity heatmap, streaks, and per-anime understanding % SVG trend chart + episode breakdown, unit tests)

### Server fixes (Claude)
- [x] **#8** line-level `LineOut.romaji` with grouped words (claude, 2026-11-19)
- [x] **#9** `TokenOut.is_proper_noun`; names excluded from understanding % (claude, 2026-11-19)
- [x] **#10** `POST /episodes/{id}/reprocess` + `python -m app.reprocess` (claude, 2026-11-19)
- [x] **#11** server refuses to start without a ≥16-char token; `SENSEI_ALLOW_NO_AUTH=true` dev opt-out (claude, 2026-11-19)

## Phase 2
- [x] **S-8** (#27) "Words you missed": `GET /episodes/{id}/missed` ranked by frequency (add a real frequency list) (claude, 2026-11-21: wordfreq zipf on words/tokens, `/missed`, better JMdict homophone linking; JLPT level not yet)
- [~] **S-9** (#28) LLM layer (OpenAI-compatible; Ollama on server by default): batch line translations EN/DE + grammar notes, cached per line. deps: O-5 (claude, 2026-11-21: endpoints + jobs + cache done; model/host choice pending O-5)
- [x] **E-7** (#29) Post-episode "missed words" panel with bulk add. deps: S-8 (antigravity, 2026-11-21: auto-triggered + on-demand Shadow DOM missed-words panel in extension + MissedWordsPanel on web EpisodeDetailPage with bulk Save Cards / Known / Ignore, plus Zipf highlight ranking, word_id dictionary lookups, and Words sort=frequency, unit tests)
- [x] **E-9/W-9** (#87) LLM line translations + "Explain this line" grammar notes in web + extension overlay. deps: S-9 (antigravity, 2026-11-21: `/llm/status` graceful degradation, web Translate Episode polling progress bar + collapsible EN/DE line translations + sticky Markdown Explain Line panel, extension overlay translation setting off/EN/DE + reveal-line & explain-line hotkeys with video pause & spinner, unit tests)

## Phase 3
- [ ] **S-10** STT fallback: episode audio (server fetch or extension upload) → faster-whisper / kotoba-whisper, overnight queue
- [x] **S-11** (#31) Audio-based automatic subtitle sync (claude, 2026-11-22: `POST /episodes/{id}/sync`, VAD + loudness vs line timing, cross-correlation ±2 min, confidence-gated apply)
- [x] **E-10** (#99) Extension Auto-sync button: record 45 s of audio → `POST /episodes/{id}/sync`, apply/toast. deps: S-11 (antigravity, 2026-11-22: pure `auto-sync.ts` state machine + 45 s audio-only `MediaRecorder` reading `video_start_ms` in `onstart`, popup & overlay hover Auto-sync buttons + `Y` hotkey + `Esc` cancel, applied/not-applied interactive "Use anyway" toast, unit tests)
- [x] **S-12** (#106) `POST /episodes/auto`: find + import an episode from a title guess or a remembered anime (claude, 2026-11-22: `anime.jimaku_entry_id`, migration 0004, returns existing episodes without downloading)
- [x] **E-11** (#107) Open an episode page → subtitles attach by themselves (remember site prefix → anime, auto next episode, one-click first match). deps: S-12 (antigravity, 2026-11-22: pure `auto-attach.ts` decision module, persistent `prefixPattern → anime_id` mappings, background auto-attach via `POST /episodes/auto` with attached/404-manual-search overlay toasts, one-click popup suggestion card with "Wrong anime? Search manually", unit tests)
- [x] **E-12** (#110) Painless extension updates: stable Chromium manifest `key` & Firefox `gecko.id`, build-time git short commit stamp, popup `/downloads/version.json` update notice with one-line PowerShell command + **Reload extension** button, and Options version line (antigravity, 2026-11-22: stable IDs in `wxt.config.ts`, `VITE_SENSEI_BUILD_COMMIT` stamp, pure `update.ts` helpers, popup update banner + copy/reload controls, Options version line, unit tests)
- [x] **W-6** (#32) Built-in player for downloaded files (same overlay component as the extension) (antigravity, 2026-11-22: local blob video player at /player and /episodes/:id/watch with fullscreen-safe furigana + Zipf highlight overlay, hover/click word_id dictionary popup, untainted canvas/audio card capture, timing/replay/LLM hotkeys, watch heartbeats, synced transcript sidebar, and post-watch missed words, unit tests)

## Requests (cross-team)
- [x] **R-1** (#12) (claude, 2026-11-19: `GET /words` + `POST /words/bulk-status`, see API.md) from antigravity: need `GET /words?status=&anime_id=&q=&limit=&offset=` and `POST /words/bulk-status` (`{"word_ids": int[], "status": WordStatus}`) because **W-4** requires a vocabulary table filterable by status/anime and bulk mark known, whereas `docs/API.md` currently only exposes single-word `GET /words/{id}` and `POST /words/{id}/status`.
