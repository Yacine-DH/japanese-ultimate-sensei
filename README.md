# Japanese Ultimate Sensei 先生

Learn Japanese **from the anime you already watch**. A browser extension puts Japanese subtitles
(furigana, romaji toggle, hover dictionary) on top of the episode. One click saves a word together
with the exact scene (screenshot, the line's audio, a short clip). A built-in spaced-repetition
review (that also syncs with Anki) then makes it stick. Progress is a GitHub-style activity heatmap
and a "% of this episode I understand" meter.

> Status: **Phase 0 (foundation)**. Server skeleton: subtitle ingest → tokens + furigana → JMdict
> (EN + DE) → known-word tracking → understanding %. See [docs/TASKS.md](docs/TASKS.md).

## Layout
| Path | What | Owner |
|---|---|---|
| `server/` | FastAPI backend on the home server (Python 3.12, uv) | Claude |
| `extension/` | Browser extension, WXT, Edge/Chromium + Firefox | Antigravity |
| `web/` | Web app (React + Vite + TS): library, review, stats | Antigravity |
| `docs/` | Vision, architecture, decisions, API contract, task board | everyone |

## Quick start (server)
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh      # once, if uv is missing
cd server
uv sync                                               # installs Python 3.12 + deps
uv run python -m app.dictionary_setup                 # downloads JMdict EN+DE → data/jmdict.sqlite
uv run pytest                                         # tests
cp .env.example .env                                  # then set SENSEI_API_TOKEN (≥ 16 chars, required)
# or skip this: deploy/install-service.sh generates the token for you
uv run uvicorn app.main:create_app --factory --host 0.0.0.0 --port 8000
```
### Run it for real (background service)
```bash
(cd web && pnpm install && pnpm build)                # web app → served by the server at /
bash deploy/install-service.sh                        # starts now + on boot, restarts on crash
bash deploy/update.sh                                 # later: pull, rebuild, restart
journalctl --user -u sensei -f                        # logs
```
Open `http://<server-tailscale-name>:8000/` for the web app; the extension uses the same URL.

Then from the laptop (Tailscale): `curl http://<server-tailscale-name>:8000/health`.
Interactive API docs: `http://<server>:8000/docs`.

Try it:
```bash
curl -H "Authorization: Bearer $TOKEN" -F anime_title="Frieren" -F episode_number=1 \
     -F subtitle=@frieren_01.ja.ass http://localhost:8000/episodes
```

## Docs
- [Vision & decisions](docs/VISION.md): what we're building and why
- [Architecture](docs/ARCHITECTURE.md): components, data flow, data model
- [API contract](docs/API.md) + [`openapi.json`](docs/openapi.json)
- [Decision log](docs/DECISIONS.md)
- [Task board](docs/TASKS.md) and [agent conventions](AGENTS.md)

## Attribution
- [JMdict](https://www.edrdg.org/jmdict/j_jmdict.html) © Electronic Dictionary Research and
  Development Group, used under [CC BY-SA 4.0](https://www.edrdg.org/edrdg/licence.html), via
  [jmdict-simplified](https://github.com/scriptin/jmdict-simplified).
- [SudachiPy / SudachiDict](https://github.com/WorksApplications/sudachi.rs) (Apache-2.0).
