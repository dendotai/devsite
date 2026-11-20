# devsite

## Branches

Feature branches merge into `dev` via PR. `main` follows `dev`; keep them close.

## Releases

The full process lives in `RELEASING.md`. Agent essentials: commit prefixes decide the published version (`fix:` → patch, `feat:` → minor, `BREAKING CHANGE:` footer or `!` → major; other prefixes release nothing). A release PR (`dev` → `main`) is titled `Release TBD` with a `## What's Changed` commit list; the publish run retitles it to the released version. Merge release PRs with a merge commit, never squash. `package.json` stays at `0.0.0` — never bump it by hand and never push a `v*` tag by hand.

## Git hooks

`.githooks/` holds one file per git hook, and the `prepare` script points git at the folder on every `bun install`; it does nothing in CI or in a folder with no git repo. Each file is a fixed header and one call of the root script named after it (`check:pre-commit` for `.githooks/pre-commit`), so what a hook runs is set in `package.json`. The files and `tests/githooks.test.ts` come from the Stack template and stay as it ships them.

`commit-msg` runs `commitlint`, `pre-commit` runs `lint`, and `pre-push` runs `typecheck` and `test`. A hook runs only a check that takes seconds; the build stays in CI. Never pass `--no-verify`: fix what the hook reports.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary, plus `tracking`, `in-progress`, and priority labels `p0`–`p3`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
