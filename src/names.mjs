// The one place a project's devSite.name is read, checked, and turned into host names.

// Hosts are interpolated into `bash -c` command strings (verify) and into devsite.d filenames, so a name that is not a plain hostname must never get past this check — a project package.json is not trusted input on a run that holds sudo.
export const HOSTNAME_RE =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/** @param {string} name */
export const hostsOf = (name) => ({ internal: `${name}.internal`, localhost: `${name}.localhost` });

/**
 * The project's devSite.name, or undefined when the package declares none. The field replaced `devSite.host` in 1.0, so the old field throws instead of being read.
 *
 * @param {{ devSite?: { name?: unknown, host?: unknown } }} pkg
 * @param {string} where
 * @returns {string | undefined}
 */
export function devSiteName(pkg, where) {
  if (pkg.devSite?.host !== undefined) {
    throw new Error(
      `devSite.host in ${where} is replaced by devSite.name: write { "name": "myapp" } for https://myapp.internal and https://myapp.localhost`,
    );
  }
  const name = pkg.devSite?.name;
  if (name !== undefined && (typeof name !== "string" || !HOSTNAME_RE.test(name))) {
    throw new Error(`devSite.name ${JSON.stringify(name)} in ${where} is not a plain hostname`);
  }
  return name;
}
