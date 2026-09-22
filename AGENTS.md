# Repository Guidelines

## Project Structure & Module Organization

npm workspaces monorepo (ESM everywhere):

- `packages/shared/` — geometry (game ⇄ pixel ⇄ Leaflet), puzzle index, scoring, region inference. Imported by both frontends and the server; bundled per-entry by `packages/shared/scripts/build.mjs`.
- `apps/game/` — player site (Vue 3 + Leaflet). `apps/admin/` — question-bank admin.
- `server/` — Fastify + better-sqlite3 API; also serves both frontends and all assets.
- `scripts/` — data-ops and QA scripts. `deploy/` — Dockerfile, compose, entrypoint. `docs/` — `deployment.md`, `api-contract.md`.
- Data: `packages/shared/data/*.json` (puzzle snapshot, calibration, region positions, 400-point region reference). Runtime data stays outside git: `data/`, and the mounted `tiles/`, `seed-images/`, `data-json/`.

## Build, Test, and Development Commands

```bash
npm ci                 # Node 22 (better-sqlite3 has no Node 24 prebuild)
npm run dev            # API :8787 + game site in parallel
npm run dev:admin      # admin site :5175
npm run build          # shared → game → admin
npm run qa             # geometry self-check + API end-to-end (self-contained)
npm run qa:all         # adds browser suites (needs dev servers + local Chrome)
npm run tiles:fetch    # basemap tiles into ../MapSource/tiles
npm run classify:regions -- --cv --report=rows.json   # dry-run by default; --apply writes
npm run region:preview --png                          # region map for visual review
```

## Coding Style & Naming Conventions

- 2-space indent, single quotes, no semicolons; Vue SFCs use `<script setup>`.
- Components `PascalCase.vue`; composables `useThing.js`; scripts `verb-noun.mjs`.
- Comments in Chinese and explain *why*, not *what*. No ESLint/Prettier configured — match surrounding code.

## Testing Guidelines

- No unit-test framework: checks are Node scripts (`scripts/qa-*.mjs`, `scripts/verify-*.mjs`, `apps/admin/scripts/selfcheck.mjs`) that print `check(...)` lines and dump screenshots to `output/`.
- Browser suites use `playwright-core` with the locally installed Chrome.
- Touching geometry, the API contract, or the admin flow? Extend the matching script.

## Commit & Pull Request Guidelines

- Commits: `<type>(<scope>): <中文摘要>`, e.g. `fix(admin): 去掉右下角重复的 Leaflet 缩放控件` (`feat|fix|docs|chore|build`); body = one bullet per change, say why.
- PRs: behavior change, commands you ran, linked issue, screenshots for UI work, and deploy impact (image rebuild vs data-only).

## Security & Configuration Tips

- `ADMIN_PASSWORD` and friends live only in `deploy/.env` / 宝塔 env box — never commit them.
- The image is program-only: never bake tiles, screenshots or content JSON into it (or git); the container entrypoint downloads whatever the four mounted directories are missing.
- `/admin/` needs Basic Auth / IP allowlist, HTTPS, and `COOKIE_SECURE=true`.
