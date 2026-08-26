// Commit prefixes are load-bearing: semantic-release derives the published
// version from them (fix -> patch, feat -> minor, BREAKING CHANGE -> major).
export default { extends: ["@commitlint/config-conventional"] };
