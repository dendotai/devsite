// The devSite names a repo declares, which doctor checks.
import { existsSync, globSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { devSiteName } from "./names.mjs";

export type RepoProject = { name: string; project: string };

export function discoverProjects(repoRoot: string): RepoProject[] {
  const candidates = [join(repoRoot, "package.json")];
  for (const dir of ["apps", "packages"]) {
    const base = join(repoRoot, dir);
    if (!existsSync(base)) continue;
    for (const rel of globSync("*/package.json", { cwd: base })) {
      candidates.push(join(base, rel));
    }
  }
  const found: RepoProject[] = [];
  // Keyed lowercase: DNS is case-insensitive, so two names that differ in case are one name.
  const claimed = new Map<string, string>();
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const pkg = JSON.parse(readFileSync(path, "utf8")) as {
      name?: string;
      devSite?: { name?: unknown };
    };
    const declared = devSiteName(pkg, path);
    if (!declared) continue;
    const name = declared.toLowerCase();
    const project = pkg.name ?? relative(repoRoot, path);
    const owner = claimed.get(name);
    if (owner !== undefined) {
      throw new Error(
        `devSite.name ${JSON.stringify(name)} is declared by both ${owner} and ${project} — every project needs its own name`,
      );
    }
    claimed.set(name, project);
    found.push({ name, project });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}
