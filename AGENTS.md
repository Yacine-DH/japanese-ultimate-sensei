# AGENTS.md: rules for every AI agent working in this repo

Two agents build this project for one human (the owner):
- **Claude Code**: lead. Owns `server/`, architecture, `docs/` (except where a task says otherwise).
- **Antigravity**: owns `extension/` and `web/`.

The owner relays between agents when needed. **Files in the repo are how we communicate**, so keep them current.

## Before you start any work
1. Read `docs/VISION.md` (product), `docs/ARCHITECTURE.md` (how it fits), `docs/API.md` (contract).
2. Open `docs/TASKS.md`, pick an **open** task in your area whose dependencies are done, and
   **claim it** by changing `[ ]` → `[~]` and adding `(<agent>, <YYYY-MM-DD>)`. Commit that claim.
3. Never work on a task claimed by the other agent. If you need something from the other side,
   add a task to `TASKS.md` under "Requests" and tell the owner.

## Git workflow (avoid stepping on each other)
- One branch per task: `claude/<task-id>-<slug>` or `antigravity/<task-id>-<slug>`.
- Work in **your own git worktree** so two agents never share a working directory:
  `git worktree add ../sensei-antigravity -b antigravity/E-1-scaffold master`
- Small commits, imperative messages, prefix with the task id: `E-1: scaffold WXT extension`.
- Merge to `master` only when the task's tests pass. Rebase on `master` before merging.
- Don't commit secrets, `.env`, `data/`, `media/`, `node_modules/`, build output.

## API contract rules
- `server/app/schemas.py` is the single source of truth; `docs/openapi.json` is generated from it:
  `cd server && uv run python -m app.export_openapi`
- Frontends **only** use endpoints documented in `docs/API.md` / `openapi.json`. If you need a
  new endpoint or field, add a request in `TASKS.md`. Don't edit `server/` from a frontend task.
- Generate TS types from `docs/openapi.json` (e.g. `openapi-typescript`) instead of hand-writing them.
- Breaking changes need a note in `docs/DECISIONS.md`.

## Code conventions
- **Python (server):** 3.12, uv, type hints, ruff (`uv run ruff check . && uv run ruff format .`),
  pytest for everything non-trivial (`uv run pytest`). Times in ms (int). Japanese readings in hiragana.
- **TypeScript (extension, web):** strict mode, ESLint + Prettier, pnpm (or npm), Vitest for logic.
  Keep pure logic (subtitle timing, furigana rendering, highlight ranking) in framework-free modules
  with unit tests.
- UI text in English. Japanese test strings are fine (and encouraged) in tests.
- Prefer boring, well-known libraries; add a line to `docs/DECISIONS.md` for any new major dependency.

## Environment facts
- Dev machine = the owner's **home server**: i5-7200U, 7 GB RAM, **no GPU**. Heavy ML runs as
  cached batch jobs only. Node.js is **not installed** yet (owner action: install Node 22 LTS).
- Server reachable over Tailscale; the owner watches on a laptop in **Edge** (Chromium), sometimes Firefox.
- Auth: `Authorization: Bearer <SENSEI_API_TOKEN>` (or `X-Sensei-Token`) on every endpoint but `/health`.

## Definition of done
Tests pass · lint clean · task box ticked `[x]` in `docs/TASKS.md` with a one-line note ·
docs updated if behaviour or the contract changed.
