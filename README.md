# dsh-plugin-product-manual · Product Manual Generator

> **English** | [中文](./README.zh-CN.md)

> A **product interview plugin** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (Cordis plugin system):
> it turns the fuzzy product idea in someone's head into a structured *Product Requirements Manual* through multi-turn dialogue — Markdown + PDF —
> plus a screenshot-ready "one-pager" summary.

## What it does

- **Interview protocol**: injects a "product interviewer" system prompt — only 1-2 user-facing questions per turn (who / what scenario / inputs / outputs / what counts as success),
  **never asks about the tech stack proactively**; questions that can be answered with options are presented as clickable choices.
- **8 chapters**: Product Positioning / Target Users / Usage Scenarios / Feature List (P0-P2) / Detailed Feature Requirements / Non-Functional Requirements /
  Explicitly Out of Scope / **Technical Route (derived backwards from features)** — the first seven chapters contain no technology choices.
- **Competitor research**: `manual_research` prefers the host `ctx.web` search service (covering WeChat / Zhihu / general web),
  **and falls back to the built-in GitHub API** (no host service or key required; set `GITHUB_TOKEN` to raise the rate limit),
  then explains "how others do it" and appends the results to the appendix "Reference Cases".
- **Full manual PDF**: Markdown → HTML → headless print with the local Edge; the filename is just the product name (e.g. `Alumni Mini Program.pdf`).
- **One-pager PDF**: 6 highlight cards (icons auto-assigned) + a three-step getting-started flow + who it is for, on a single A4 page — positive copy, ready to screenshot.
- **Feedback loop**: `manual_feedback` records reader comments in the appendix; update the chapters / one-pager copy and regenerate.

## Install into DSH (verified on a real deployment)

The DSH Web profile lives in `~/.dsh/profiles/web/`. Local plugins belong in `plugins/<package-name>/`,
and the host composition adds one row to the `insert` list in `cordis.patch.yml` (available to every session).

### 1. Place the plugin package

```bash
# Copy this package into the profile's plugins directory
cp -r . ~/.dsh/profiles/web/plugins/dsh-plugin-product-manual
# Keep index.js as the entry (this package's lib/index.js is the entry; rename it to index.js after copying)
```

The directory needs at least `index.js` and `package.json` (`"type":"module"`, `"main":"index.js"`).

### 2. Add a row to the patch

Edit `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: product-manual
      name: './plugins/dsh-plugin-product-manual/index.js'
```

### 3. Restart DSH

The patch is read at startup. After a restart every session gets
`manual_start` / `manual_update` / `manual_research` / `manual_onepager` / `manual_feedback` / `manual_status` / `manual_render`.

> Other installation options:
> - **As an npm package**: run `npm install dsh-plugin-product-manual` (or `pnpm add`) inside `~/.dsh/profiles/web/`,
>   then use the bare package name in the patch row: `name: dsh-plugin-product-manual` (bare names resolve from the profile directory).
> - **Absolute path row**: `name: E:\path\to\lib\index.js` (the loader converts absolute paths to file URLs).

## Usage

Tell the agent:

> I want to build an "alumni mini program". Please write the product manual for me.

The agent interviews you turn by turn; at any point say "let's see how others do it" to trigger research;
at the end it generates the full manual and the one-pager PDF and gives you the file paths plus clickable PDF links.

## Data layout (workspace)

```
product-manuals/
├── .current.json                 # pointer to the current manual (restored automatically after restart)
└── <manual-id>/
    ├── state.json                # 8 chapter contents, reference cases, feedback
    ├── <product name>.md / .pdf  # full manual
    └── <product name>-onepager.pdf
```

## Publish to GitHub

```bash
git init && git add -A
git commit -m "feat: product manual generator plugin"
git remote add origin https://github.com/<you>/dsh-plugin-product-manual.git
git push -u origin main
```

Publish to npm (so others can `npm i`):

```bash
npm publish
```

## Known boundaries / runtime requirements

- **Search**:
  - Prefers the host `ctx.web` search service (DeepSeek search in the reference deployment; covers WeChat mini-program cases / Zhihu / general web);
  - **Built-in fallback for the GitHub direction**: the plugin calls the GitHub REST API directly (`api.github.com/search/repositories`)
    with no host service; unauthenticated rate limit is 10 requests/minute, and setting `GITHUB_TOKEN` raises it;
  - Without a web search provider, non-GitHub directions return a clear notice (include `sources:["github"]` instead).
- **PDF**:
  - The plugin converts Markdown→HTML itself, then invokes a local Chromium-based browser with headless `--print-to-pdf`;
  - Browser lookup order: `DSH_PDF_BROWSER` / `DSH_CHROME` / `CHROME_PATH` env vars → common Windows/macOS/Linux install paths → `msedge`/`chrome`/`chromium` on `PATH`;
  - Process launch prefers the host `subprocess` service and falls back to `node:child_process`;
  - If no browser is found, Markdown is still produced and the reason appears in `warnings`.
- **Host-only plugin**: no client panel inside the Run card. Client UI would require a `dsh.client` bundle
  and is only scanned by host composition loader entries; this package is a pure host plugin.
- The PDF route prefix is randomized per plugin instance (`/product-manuals-<rand>`), so multiple sessions/instances do not collide.
- Tool arguments are validated by the plugin itself (not by `defineTool`'s automatic validation); outputs are not schema-enforced.

## Smoke tests

```bash
node test-research.mjs
node test-lazy.mjs
```

They load the plugin with fake contexts and verify: 7 tools registered, `manual_start` creates a manual,
**GitHub fallback search when no web service is present**, lazy service resolution, and status read-back.

## License

MIT
