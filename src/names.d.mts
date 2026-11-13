export function internalHost(name: string): string;
export function localhostHost(name: string): string;
export function devSiteName(
  pkg: { devSite?: { name?: unknown; host?: unknown } },
  where: string,
): string | undefined;
