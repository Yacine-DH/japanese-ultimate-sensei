# Task board

Legend: `[ ]` open · `[~]` claimed `(agent, date)` · `[x]` done · **deps** must be `[x]` first.
Areas: **S** = server (Claude) · **E** = extension (Antigravity) · **W** = web app (Antigravity) · **O** = owner.
Protocol: see [AGENTS.md](../AGENTS.md). Claim → branch → PR/merge → tick.

## Owner actions
- [x] **O-1** Install `uv` on the server: `curl -LsSf https://astral.sh/uv/install.sh | sh`
- [x] **O-2** Install Node.js 22 LTS on the server (e.g. `fnm install 22` or nvm), plus `pnpm` (`corepack enable`) (antigravity, 2026-11-17: Node v22.23.5 + pnpm 12.21.0 installed in `~/.local/bin`)
- [x] **O-3** Make a free [jimaku.cc](https://jimaku.cc) account and API key → `SENSEI_JIMAKU_API_KEY` in `server/.env`
- [x] **O-4** `SENSEI_API_TOKEN` in `server/.env`, required since #11; `bash deploy/install-service.sh` generates it (claude, 2026-11-19: set on the home server)
- [x] **O-5** Tell Claude your laptop specs (CPU/GPU/RAM), which decides which LLM runs where (claude, 2026-11-22: Dell Precision, ~4 GB VRAM GPU, Ollama over Tailscale)
- [ ] **O-6** (#131) Set up whisper-server on the Precision (setup notes sent in chat), then tell Claude

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
- [x] **S-9** (#28) LLM layer (OpenAI-compatible; Ollama on server by default): batch line translations EN/DE + grammar notes, cached per line. deps: O-5 (claude, 2026-11-21: endpoints + jobs + cache done; model/host choice pending O-5) · done 2026-11-22: gemma3:4b on the Precision chosen by `app.llm_bench`, see README
- [x] **E-7** (#29) Post-episode "missed words" panel with bulk add. deps: S-8 (antigravity, 2026-11-21: auto-triggered + on-demand Shadow DOM missed-words panel in extension + MissedWordsPanel on web EpisodeDetailPage with bulk Save Cards / Known / Ignore, plus Zipf highlight ranking, word_id dictionary lookups, and Words sort=frequency, unit tests)
- [x] **E-9/W-9** (#87) LLM line translations + "Explain this line" grammar notes in web + extension overlay. deps: S-9 (antigravity, 2026-11-21: `/llm/status` graceful degradation, web Translate Episode polling progress bar + collapsible EN/DE line translations + sticky Markdown Explain Line panel, extension overlay translation setting off/EN/DE + reveal-line & explain-line hotkeys with video pause & spinner, unit tests)

## Phase 3
- [x] **S-10** (#30) STT fallback (claude, 2026-11-22: `POST /stt/jobs` uploads an episode file → ffmpeg 16 kHz WAV → OpenAI-compatible `/v1/audio/transcriptions` (whisper-server on the laptop GPU) as SRT → normal import + translations)
- [x] **W-7** (#118) Web: transcribe an episode file (import page + built-in player), job status. deps: S-10 (antigravity, 2026-11-22: regenerated OpenAPI types with `SttStatus`/`SttJobOut`, XHR multipart upload with live progress & cancel, pure `lib/stt.ts` status/polling/elapsed/filename helpers, reusable `TranscribePanel` with 5-step stepper + Transcriptions list + graceful `/stt/status` degradation wired into Library, Built-in Player, and Settings, unit tests)
- [x] **S-11** (#31) Audio-based automatic subtitle sync (claude, 2026-11-22: `POST /episodes/{id}/sync`, VAD + loudness vs line timing, cross-correlation ±2 min, confidence-gated apply)
- [x] **E-10** (#99) Extension Auto-sync button: record 45 s of audio → `POST /episodes/{id}/sync`, apply/toast. deps: S-11 (antigravity, 2026-11-22: pure `auto-sync.ts` state machine + 45 s audio-only `MediaRecorder` reading `video_start_ms` in `onstart`, popup & overlay hover Auto-sync buttons + `Y` hotkey + `Esc` cancel, applied/not-applied interactive "Use anyway" toast, unit tests)
- [x] **S-12** (#106) `POST /episodes/auto`: find + import an episode from a title guess or a remembered anime (claude, 2026-11-22: `anime.jimaku_entry_id`, migration 0004, returns existing episodes without downloading)
- [x] **E-11** (#107) Open an episode page → subtitles attach by themselves (remember site prefix → anime, auto next episode, one-click first match). deps: S-12 (antigravity, 2026-11-22: pure `auto-attach.ts` decision module, persistent `prefixPattern → anime_id` mappings, background auto-attach via `POST /episodes/auto` with attached/404-manual-search overlay toasts, one-click popup suggestion card with "Wrong anime? Search manually", unit tests)
- [x] **E-11b** (#113) Fix stale tab title on SPA next-episode navigation + forget series prefix mapping on detach (antigravity, 2026-11-22: pure `advanceTabTitleWatch` SPA stale-title guard with 5 s timeout fallback + `removeMappingsForDetach` dropping `animeMappings[prefixPattern]` on detach, unit tests)
- [x] **S-13** (#104) LLM prompts: names stay names, explanations use the dictionary's readings, German-in-English answers dropped (claude, 2026-11-22)
- [x] **E-12** (#110) Painless extension updates: stable Chromium manifest `key` & Firefox `gecko.id`, build-time git short commit stamp, popup `/downloads/version.json` update notice with one-line PowerShell command + **Reload extension** button, and Options version line (antigravity, 2026-11-22: stable IDs in `wxt.config.ts`, `VITE_SENSEI_BUILD_COMMIT` stamp, pure `update.ts` helpers, popup update banner + copy/reload controls, Options version line, unit tests)
- [x] **E-12b** (#117) Stamp & compare `extension_commit`, self-contained PowerShell update one-liner with configurable extension folder (antigravity, 2026-11-22: `git log -1 --format=%h --abbrev=7 -- .` build stamp, `extension_commit` comparison with `commit` fallback, configurable "Extension folder on this PC" option + dynamic self-contained PowerShell one-liner in popup, unit tests)
- [x] **E-13** (#111) Draggable Japanese overlay (position saved per site relative to video box, double-click / popup reset) + romaji toggle hotkey & popup toggle (antigravity, 2026-11-22: pure `overlay-position.ts` fraction↔px & clamping helpers, hover drag grip + double-click reset + per-host persistence across reloads/fullscreen/iframes, `toggleRomaji` hotkey `Alt+R` + popup Show romaji toggle & Reset overlay position button, unit tests)
- [x] **E-14** (#124) Extension toolbar & manifest icon (`先生` / `先` deep-red `#c0392b` hanko stamp at 16, 32, 48, 128 px) for Chrome MV3 and Firefox MV2, plus popup header icon (antigravity, 2026-11-22: reproducible ImageMagick generator `extension/scripts/generate-icons.sh`, committed 8-bit PNGs in `extension/public/icon/`, `manifest.icons` + `action`/`browser_action.default_icon` in `wxt.config.ts` preserving stable manifest key, popup header brand icon, unit tests)
- [x] **W-6** (#32) Built-in player for downloaded files (same overlay component as the extension) (antigravity, 2026-11-22: local blob video player at /player and /episodes/:id/watch with fullscreen-safe furigana + Zipf highlight overlay, hover/click word_id dictionary popup, untainted canvas/audio card capture, timing/replay/LLM hotkeys, watch heartbeats, synced transcript sidebar, and post-watch missed words, unit tests)

## Audit 2026-11-22 (Claude)
- [x] **S-14** (#127) Server tests must not read the real `server/.env` (bug) (claude, 2026-11-23: autouse fixture turns off the env file and clears `SENSEI_*`)
- [x] **S-15** (#128) Re-importing the same anime + episode replaces subtitles in place instead of duplicating (bug) (claude, 2026-11-23: 200 + `replaced`, offset reset, cards relinked by sentence, translation cancelled)
- [x] **S-16** (#129) Auto-translate on import + resume pending translations after restart (claude, 2026-11-23: `SENSEI_LLM_AUTO_TRANSLATE`, startup resume, unreachable → retry 1–30 min, `retry_at`)
- [x] **S-17** (#130) Sentence translation EN/DE on Anki cards (export + AnkiConnect) (claude, 2026-11-23: `SentenceEN`/`SentenceDE` appended, same model id, back template)
- [ ] **E-19** (#154) AnkiConnect: add missing fields (SentenceEN/DE) + templates to an existing note type. deps: S-17
- [ ] **S-18** (#131) Verify STT end to end with a real whisper-server. deps: O-6
- [x] **W-10** (#132) Review page: sentence translation on the answer side (antigravity, 2026-11-23: pure `formatReviewSentenceTranslation` respecting EN/DE gloss language with fallback and null omission, shown below the furigana sentence in `ReviewPage.tsx` after reveal, unit tests)
- [ ] **W-11** (#133) Web app 先生 favicon + installable PWA for phone reviews
- [ ] **W-12/E-15** (#134) "Prep this episode": 10 most useful words before watching
- [ ] **E-16** (#135) Popup: translation progress for the attached episode. deps: S-16
- [ ] **S-19** (#137) Piecewise sync points (subtitles survive cuts)
- [ ] **E-17** (#138) Background re-sync + sync points in the extension. deps: S-19
- [ ] **S-20** (#139) Netflix [cc] subtitles: 漢字(よみ) as furigana, speaker labels / sound effects apart
- [ ] **S-22** (#147) Auto-sync by recognizing Japanese speech (ReazonSpeech k2 on the server CPU), VAD as fallback. deps: S-19
- [x] **S-21** (#140) One-click updater (native messaging host) + GitHub releases (claude, 2026-11-22: `scripts/install-updater.ps1`, `scripts/sensei-updater/`, `scripts/release.sh`, version 0.1.N)
- [x] **E-18** (#141) Popup **Update now** via the updater + version from `SENSEI_EXT_VERSION`. deps: S-21 (antigravity, 2026-11-22: Chrome-only `nativeMessaging` permission, `SENSEI_EXT_VERSION` manifest version with `0.1.0` fallback + popup footer version, pure `native-updater.ts` state machine for `Update now` / progress / auto-reload / one-time setup / fallback error, Options `Check updater` button via `{action: 'status'}`, unit tests)
- [x] **E-18b** (#144) Run native update from the background worker so closing the popup mid-update cannot cancel the host or lose reload (antigravity, 2026-11-23: `BackgroundNativeUpdater` in `native-updater.ts` keeping `interpretUpdateResponse`, background runtime messages `SENSEI_START_NATIVE_UPDATE` / `SENSEI_GET_NATIVE_UPDATE_STATE` / `SENSEI_NATIVE_UPDATE_STATE_CHANGED`, popup subscribes + polls progress, unit tests)

## Requests (cross-team)
- [x] **R-1** (#12) (claude, 2026-11-19: `GET /words` + `POST /words/bulk-status`, see API.md) from antigravity: need `GET /words?status=&anime_id=&q=&limit=&offset=` and `POST /words/bulk-status` (`{"word_ids": int[], "status": WordStatus}`) because **W-4** requires a vocabulary table filterable by status/anime and bulk mark known, whereas `docs/API.md` currently only exposes single-word `GET /words/{id}` and `POST /words/{id}/status`.
