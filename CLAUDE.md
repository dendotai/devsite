# devsite

## Branches

Feature branches merge into `dev` via PR. `main` follows `dev`; keep them close.

## Releases

Every push to `main` runs semantic-release (`.github/workflows/publish.yml`).
Commit prefixes decide the published version: `fix:` → patch, `feat:` → minor,
`BREAKING CHANGE:` footer (or `!`) → major; other prefixes release nothing.
commitlint enforces the prefixes on every PR. `package.json` stays at `0.0.0`
on purpose — the real version lives in git tags and on npm; never bump it by
hand and never push a `v*` tag by hand.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary, plus `tracking`, `in-progress`, and priority labels `p0`–`p3`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
