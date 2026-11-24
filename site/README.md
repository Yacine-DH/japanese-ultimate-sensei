# Public website (GitHub Pages)

The "Ink Dojo" landing page, in English (`/`) and Japanese (`/ja/`). Static: two HTML pages, one
script, one lazy-loaded three.js scene. No cookies, no analytics, nothing loaded from other sites.

```bash
cd site
pnpm install
node build.mjs          # → site/dist (open it through any static server)
pnpm test               # run after a build
```

- **Text:** `copy.en.mjs` and `copy.ja.mjs`. A test checks that both have the same structure.
- **Downloads:** put release zips into `site/downloads/` before building. The page shows version,
  size and SHA-256. `guard.mjs` stops the build if a zip contains private addresses or secrets.
- **Environment:** `SITE_URL` (default: the project Pages address), `SITE_REPO_PUBLIC=1` (shows the
  GitHub links), `SITE_VERSION`.
- **Share images:** `public/og-en.jpg` and `public/og-ja.jpg` are 1200×630 captures of the hero.

## Publishing
`.github/workflows/pages.yml` builds and tests on every pull request that touches `site/`, and
publishes **only when someone runs it by hand** (Actions → Website → Run workflow → publish).
Before the first run, the repository owner has to:

1. Make Pages available: GitHub Pages needs a public repository, or a paid plan for a private one.
   Pages sites are public either way.
2. Settings → Pages → Source: **GitHub Actions**.

Read this before making the repository public: the home server's hostname is in `scripts/`, tests,
docs and git history, and the repository has no license yet.
