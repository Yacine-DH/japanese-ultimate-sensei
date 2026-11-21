# AGENTS.md: rules for every AI agent working in this repo

Two agents build this project for one human (the owner):
- **Claude Code**: lead. Owns `server/`, architecture, `docs/` (except where a task says otherwise).
- **Antigravity**: owns `extension/` and `web/`.

**Files are how we communicate**, so keep them current:
- **Agent channel: `/home/yacine/orca/projects/sensei-channel.md`** (outside git, shared by both
  agents on the home server). Direct messages: "merged X, you can start Y", questions, answers.
  **Read it at the start of every session, before claiming work, and after every PR you merge.**
  Append only; rules at the top of that file. No secrets.
- GitHub issues/PRs hold specs, bugs and history (see below). The owner can still relay.

## Before you start any work
0. Read the **agent channel** (path above) for new messages.
1. Read `docs/VISION.md` (product), `docs/ARCHITECTURE.md` (how it fits), `docs/API.md` (contract).
2. Open `docs/TASKS.md`, pick an **open** task in your area whose dependencies are done, and
   **claim it** by changing `[ ]` → `[~]` and adding `(<agent>, <YYYY-MM-DD>)`. Commit that claim.
3. Never work on a task claimed by the other agent. If you need something from the other side,
   open an issue with their `agent:*` label and post a line in the agent channel.

## Git workflow (avoid stepping on each other)
- One branch per task: `claude/<task-id>-<slug>` or `antigravity/<task-id>-<slug>`.
- Work in **your own git worktree** so two agents never share a working directory:
  `git worktree add ../sensei-antigravity -b antigravity/E-1-scaffold master`
- Small commits, imperative messages, prefix with the task id: `E-1: scaffold WXT extension`.
- Merge to `master` only when the task's tests pass. Rebase on `master` before merging.
- Don't commit secrets, `.env`, `data/`, `media/`, `node_modules/`, build output.

## GitHub (from 2026-11-17)
Repo: https://github.com/Yacine-DH/japanese-ultimate-sensei (private, default branch `master`). `gh` is
logged in on the server.
- **Issues hold the details** (bug reports, specs, acceptance criteria). Filter by label
  `agent:claude` / `agent:antigravity`, `area:*`, milestone `v0.1 core loop` / `Phase 2` / `Phase 3`.
  `docs/TASKS.md` stays the quick claim board; put the issue number next to a task (`E-4 (#20)`).
- Claim = assign yourself on the issue **and** mark `[~]` in TASKS.md.
- Every branch lands via a **pull request** to `master` whose description includes `Closes #N`,
  plus test/lint/build output. The other agent reviews when the owner asks; otherwise self-merge once green.
- Found a bug in the other agent's area? Open an issue with label `review-finding` and their
  `agent:*` label. Don't fix it in their code.

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
  cached batch jobs only. Node 22 + pnpm are in `~/.local/bin`.
- Live server: systemd user service `sensei` on :8000 (`journalctl --user -u sensei -f`), serving
  `web/dist` at `/`. Deploy with `bash deploy/update.sh` from the main checkout (branch `live`).
- Server reachable over Tailscale; the owner watches on a laptop in **Edge** (Chromium), sometimes Firefox.
- Auth: `Authorization: Bearer <SENSEI_API_TOKEN>` (or `X-Sensei-Token`) on every endpoint but `/health`.

## Definition of done
Tests pass · lint clean · task box ticked `[x]` in `docs/TASKS.md` with a one-line note ·
docs updated if behaviour or the contract changed.
