/**
 * Print, as a JSON array, the apps the pre-flight gate should grade.
 *
 * Usage:
 *   node scripts/changed-apps.ts                # every app
 *   node scripts/changed-apps.ts <base-ref>     # the apps changed since <base-ref>
 *
 * Runs against the repository in the working directory. With a base ref, an app is
 * graded when a file under `apps/<slug>/` changed; every app is graded when anything
 * they share changed — the gate, the scripts, the workflows or the root tooling — since
 * that can change the result for a stack nobody touched. An app the PR deleted is left
 * out: there is nothing left to synthesise.
 *
 * The diff is taken from the merge base (`<base-ref>...HEAD`), so changes that landed
 * on the base branch after the PR branched off are not counted as the PR's.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const SHARED = [/^gate\//, /^scripts\//, /^\.github\/workflows\//, /^(package|package-lock|tsconfig|biome)\.json$/];
const APP_FILE = /^apps\/([^/]+)\//;

const root = process.cwd();
const appsDir = path.join(root, "apps");
const allApps = fs
  .readdirSync(appsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

function changedFiles(baseRef: string): string[] {
  const output = execFileSync("git", ["diff", "--name-only", `${baseRef}...HEAD`], { cwd: root, encoding: "utf-8" });
  return output.split("\n").filter((line) => line.length > 0);
}

function appsToGrade(baseRef: string | undefined): string[] {
  if (baseRef === undefined) return allApps;

  const files = changedFiles(baseRef);
  if (files.some((file) => SHARED.some((pattern) => pattern.test(file)))) return allApps;

  const changed = new Set(files.map((file) => APP_FILE.exec(file)?.[1]).filter((slug) => slug !== undefined));
  return allApps.filter((slug) => changed.has(slug));
}

const apps = appsToGrade(process.argv[2]);
console.error(`Grading ${apps.length} of ${allApps.length} app(s): ${apps.join(", ") || "none"}`);
console.log(JSON.stringify(apps));
