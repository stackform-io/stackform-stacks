/**
 * Which apps a PR's changes call for the pre-flight gate to grade. See
 * scripts/changed-apps.ts.
 */

/** What every app depends on: a change here can change the result for any of them. */
export const SHARED = [
  /^gate\//,
  /^scripts\//,
  /^\.github\/workflows\//,
  /^(package|package-lock|tsconfig|biome)\.json$/,
];

const APP_FILE = /^apps\/([^/]+)\//;

/**
 * The apps to grade, out of `allApps`: all of them when `changedFiles` is undefined (no
 * base to compare with) or touches anything shared, otherwise the ones with a changed
 * file. An app the PR deleted is not in `allApps`, so it is left out.
 */
export function appsToGrade(changedFiles: string[] | undefined, allApps: string[]): string[] {
  if (changedFiles === undefined) return allApps;
  if (changedFiles.some((file) => SHARED.some((pattern) => pattern.test(file)))) return allApps;

  const changed = new Set(changedFiles.map((file) => APP_FILE.exec(file)?.[1]).filter((slug) => slug !== undefined));
  return allApps.filter((slug) => changed.has(slug));
}
