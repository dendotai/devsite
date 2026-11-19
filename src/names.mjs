// The one place a project's devSite.name is read, checked, and turned into host names.

// Hosts go into command arguments (openssl -servername), Caddyfile site addresses, and devsite.d filenames, so a name that is not a plain hostname must never get past this check — a project package.json is not trusted input on a run that holds sudo.
export const HOSTNAME_RE =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/** @param {string} name */
// Lowercase: Caddy keeps a route's hosts in lowercase, so a mixed-case name would never match the route `devsite init` wrote.
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
  if (name !== undefined && (typeof name !== "string" || !HOSTNAME_RE.test(name))) {
    throw new Error(`devSite.name ${JSON.stringify(name)} in ${where} is not a plain hostname`);
  }
  if (typeof name === "string" && /\.(internal|localhost)$/i.test(name)) {
    throw new Error(
      `devSite.name ${JSON.stringify(name)} in ${where} carries a suffix devsite adds itself: write ${JSON.stringify(name.replace(/\.(internal|localhost)$/i, ""))}`,
    );
  }
  return name;
}
