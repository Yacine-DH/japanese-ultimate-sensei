# Task board

Legend: `[ ]` open · `[~]` claimed `(agent, date)` · `[x]` done · **deps** must be `[x]` first.
Areas: **S** = server (Claude) · **E** = extension (Antigravity) · **W** = web app (Antigravity) · **O** = owner.
Protocol: see [AGENTS.md](../AGENTS.md). Claim → branch → PR/merge → tick.

## Owner actions
- [x] **O-1** Install `uv` on the server: `curl -LsSf https://astral.sh/uv/install.sh | sh`
- [ ] **O-2** Install Node.js 22 LTS on the server (e.g. `fnm install 22` or nvm), plus `pnpm` (`corepack enable`)
- [ ] **O-3** Make a free [jimaku.cc](https://jimaku.cc) account and API key → `SENSEI_JIMAKU_API_KEY` in `server/.env`
- [ ] **O-4** Set `SENSEI_API_TOKEN` in `server/.env` (any long random string: `openssl rand -hex 24`)
- [ ] **O-5** Tell Claude your laptop specs (CPU/GPU/RAM), which decides which LLM runs where

## Phase 0: Foundation
- [x] **S-0** Repo, docs, agent conventions, server skeleton: subtitle ingest, Sudachi tokens + furigana + romaji, JMdict EN/DE, word status, understanding %, token auth, tests (claude, 2026-11-17)
- [x] **S-0b** Tests green (29), real JMdict built (219k entries, EN+DE), `docs/openapi.json` exported; fixed romaji for small っ and particles (claude, 2026-11-17)

## Phase 1: v0.1 core loop
### Server (Claude)
- [ ] **S-1** Jimaku integration: `GET /subs/search?q=` (AniList/Jimaku), `POST /episodes/from-jimaku` (download + ingest). deps: O-3
- [ ] **S-2** Media: `POST /media` (multipart screenshot/audio/clip upload) → ffmpeg transcode (WebP/Opus/VP9 360p) → `GET /media/{id}`
- [ ] **S-3** Cards + FSRS: `POST /cards` (word + line + media ids), `GET /reviews/due`, `POST /reviews` (rating), sets UserWord → learning/known
- [ ] **S-4** Known-words import: from Anki (.apkg/.txt export, choose field) and plain word lists
- [ ] **S-5** Anki export: `.apkg` (genanki) with media; card JSON for AnkiConnect push
- [ ] **S-6** Activity tracking: `POST /activity/watch` (minutes), auto-count reviews/words; `GET /activity?from=&to=` for heatmap
- [ ] **S-7** Serve `web/dist` at `/` from FastAPI; Alembic migrations; systemd user service

### Extension (Antigravity)
- [ ] **E-1** Scaffold `extension/` with WXT + TypeScript (strict) + Vitest. Options page: server URL (default `http://<tailscale-host>:8000`), API token, gloss language (EN/DE), romaji on/off. Background worker exposes a typed `api.call(path, init)` proxy that adds the token. Popup shows `/health` status. Builds for Edge/Chrome **and** Firefox. Types generated from `docs/openapi.json`. deps: O-2
- [ ] **E-2** Video detection + overlay: content script (`all_frames`) finds the largest visible `<video>`, mounts a Shadow-DOM overlay above it (fullscreen-safe). Renders the current line from `GET /episodes/{id}/lines` with `<ruby>` furigana (hide ruby when `status` is known/ignored), optional romaji line. Timing per ARCHITECTURE.md with `sub_offset_ms`; hotkeys `[` / `]` = ∓100 ms, `\` = "sync this line now"; persist via `PATCH /episodes/{id}`. Pure timing logic unit-tested. deps: E-1
- [ ] **E-3** Hover/learn: unknown **content** tokens get a highlight (limit to the top N per line, ranked `common` first, N configurable, default 3). Hovering pauses the video and shows a popup from `GET /dictionary/lookup?q=<lemma>&reading=<lemma_reading>` (EN/DE per setting) with buttons Known / Ignore / Save. Known/Ignore → `POST /words/{id}/status`. Resume on mouse-leave. deps: E-2
- [ ] **E-4** Episode picker (popup): list episodes (`GET /episodes`), upload a JP subtitle file (`POST /episodes`), and remember a mapping *page URL pattern → episode id* in `storage.local`; later Jimaku search (S-1). deps: E-1
- [ ] **E-5** Save with capture: on Save, capture a canvas screenshot (fallback `captureVisibleTab` + crop), rewind to `line.start_ms`, record the line via `captureStream()` + `MediaRecorder` (webm), resume; upload to `POST /media`, then `POST /cards`. deps: E-3, S-2, S-3
- [ ] **E-6** AnkiConnect push (optional per settings) of saved cards using S-5's card JSON. deps: E-5, S-5

### Web app (Antigravity)
- [ ] **W-1** Scaffold `web/`: Vite + React + TS + Tailwind + React Router + TanStack Query; API client generated from `docs/openapi.json`; settings page (token). Dark mode. deps: O-2
- [ ] **W-2** Library: anime → episodes, upload subtitle, understanding % bar per episode, episode detail with the transcript (furigana, word status colours, click a word → lookup + status). deps: W-1
- [ ] **W-3** Review: FSRS session with screenshot, play line audio/clip, reveal meaning + sentence, rate Again/Hard/Good/Easy (keys 1–4). deps: W-1, S-3
- [ ] **W-4** Words: table filterable by status / anime, bulk mark known. deps: W-1
- [ ] **W-5** Stats: GitHub-style activity heatmap + understanding % trend per anime. deps: W-1, S-6

## Phase 2
- [ ] **S-8** "Words you missed": `GET /episodes/{id}/missed` ranked by frequency (add a real frequency list)
- [ ] **S-9** LLM layer (OpenAI-compatible; Ollama on server by default): batch line translations EN/DE + grammar notes, cached per line. deps: O-5
- [ ] **E-7** Post-episode "missed words" panel with bulk add. deps: S-8

## Phase 3
- [ ] **S-10** STT fallback: episode audio (server fetch or extension upload) → faster-whisper / kotoba-whisper, overnight queue
- [ ] **S-11** Audio-based automatic subtitle sync
- [ ] **W-6** Built-in player for downloaded files (same overlay component as the extension)

## Requests (cross-team)
_(add here: "**R-n** from <agent>: need X in endpoint Y because Z")_
