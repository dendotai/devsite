// The one place a project's devSite.name is read, checked, and turned into host names.

// One DNS label, because Caddy's `*.internal` and `*.localhost` route matches one label. A name reaches the node's state and HTTP paths, so a name that is not a plain label must never get past this check.
export const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

/** @param {string} name */
// Lowercase: DNS is case-insensitive, and the node keys its state by the lowercase name.
export const hostsOf = (name) => {
  const base = name.toLowerCase();
  return { internal: `${base}.internal`, localhost: `${base}.localhost` };
};

/**
 * The project's devSite.name, or undefined when the package declares none.
 *
 * @param {{ devSite?: { name?: unknown } }} pkg
 * @param {string} where
 * @returns {string | undefined}
 */
export function devSiteName(pkg, where) {
  const name = pkg.devSite?.name;
  if (typeof name === "string" && /\.(internal|localhost)$/i.test(name)) {
    throw new Error(
      `devSite.name ${JSON.stringify(name)} in ${where} carries a suffix devsite adds itself: write ${JSON.stringify(name.replace(/\.(internal|localhost)$/i, ""))}`,
    );
  }
  if (name !== undefined && (typeof name !== "string" || !NAME_RE.test(name))) {
    throw new Error(
      `devSite.name ${JSON.stringify(name)} in ${where} is not one DNS label: use letters, digits, and inner hyphens, with no dots`,
    );
  }
  return name;
}
