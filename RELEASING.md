# Releasing

@den-ai/devsite is published to npm by CI. No release step runs on a laptop,
and no version number is ever written by hand.

## How a release happens

1. Feature PRs merge into `dev`. Releasable work accumulates there — nothing
   is published until a promotion.
2. Ask Claude to release ("release", "promote dev"). Claude opens a PR from
   `dev` into `main`:
   - title: `Release TBD` — the version does not exist yet, it is computed
     during the publish run;
   - body: `## What's Changed` with the commits since the last release tag
     (short hash + subject + PR reference; merge commits excluded).
3. Merge that PR **with a merge commit — never squash**. The commit prefixes
   are the version input; a squash would replace them with the PR title and
   release nothing.
4. The push to `main` runs `.github/workflows/publish.yml`:
   - the full CI gate again (typecheck, lint, tests, Node smoke run of the
     built CLI);
   - semantic-release computes the version from the commits since the last
     tag: `fix:` → patch, `feat:` → minor, `BREAKING CHANGE:` footer (or `!`)
     → major; other prefixes release nothing;
   - npm publish via trusted publishing (OIDC — no tokens exist anywhere),
     with provenance; `prepack` builds `dist/cli.js` so the published bin runs
     under plain Node;
   - the `vX.Y.Z` tag is pushed and the GitHub release notes are written;
   - the merged PR is retitled to `Release vX.Y.Z`.

## Invariants

- `package.json` stays at `0.0.0` on purpose. The real version lives in git
  tags and on npm. Never bump it by hand.
- Never push a `v*` tag by hand.
- commitlint checks every PR into `dev`, so the version math never meets a
  malformed commit message.
- A promotion with nothing releasable (only `chore:`/`ci:`/`docs:` commits) is
  harmless: the workflow exits without publishing, and the PR keeps its
  `Release TBD` title.
