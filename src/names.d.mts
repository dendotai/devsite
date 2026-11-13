export function hostsOf(name: string): { internal: string; localhost: string };
export function devSiteName(
  pkg: { devSite?: { name?: unknown; host?: unknown } },
  where: string,
): string | undefined;
