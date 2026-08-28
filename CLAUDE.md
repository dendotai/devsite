# devsite

## Branches

Feature branches merge into `dev` via PR. `main` follows `dev`; keep them close.

## Releases

The full process lives in `RELEASING.md`. Agent essentials: commit prefixes
decide the published version (`fix:` → patch, `feat:` → minor, `BREAKING
CHANGE:` footer or `!` → major; other prefixes release nothing). A release PR
(`dev` → `main`) is titled `Release TBD` with a `## What's Changed` commit
list; the publish run retitles it to the released version. Merge release PRs
with a merge commit, never squash. `package.json` stays at `0.0.0` — never
bump it by hand and never push a `v*` tag by hand.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary, plus `tracking`, `in-progress`, and priority labels `p0`–`p3`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
