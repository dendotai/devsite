// Commit prefixes are load-bearing: semantic-release derives the published
// version from them (fix -> patch, feat -> minor, BREAKING CHANGE -> major).
export default {
  extends: ["@commitlint/config-conventional"],
  // GitHub writes merge-commit messages; they never drive a release.
  ignores: [(message) => message.startsWith("Merge ")],
};
