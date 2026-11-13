// The one place a project's devSite.name becomes its host names.

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
  if (name !== undefined && typeof name !== "string") {
    throw new Error(`devSite.name in ${where} is not a string`);
  }
  return name;
}
