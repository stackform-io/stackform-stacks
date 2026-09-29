import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { appsToGrade } from "../scripts/lib/changed-apps.ts";

const APPS = ["flagsmith", "sentry", "umami"];
const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "changed-apps.ts");

describe("appsToGrade", () => {
  it("grades every app with no base to compare with (a PR into main)", () => {
    assert.deepEqual(appsToGrade(undefined, APPS), APPS);
  });

  it("grades nothing when nothing changed", () => {
    assert.deepEqual(appsToGrade([], APPS), []);
  });

  it("grades only the app a PR changed", () => {
    assert.deepEqual(appsToGrade(["apps/umami/README.md"], APPS), ["umami"]);
  });

  it("grades each changed app once, in order", () => {
    const files = ["apps/umami/lib/umami-stack.ts", "apps/sentry/tool.json", "apps/umami/tool.json"];
    assert.deepEqual(appsToGrade(files, APPS), ["sentry", "umami"]);
  });

  it("grades nothing for a docs-only change", () => {
    assert.deepEqual(appsToGrade(["README.md", "CONTRIBUTING.md", "assets/buttons/x.svg"], APPS), []);
  });

  for (const shared of [
    "gate/lib/verification/assertions.ts",
    "scripts/preflight.ts",
    ".github/workflows/pr-validation.yml",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "biome.json",
  ]) {
    it(`grades every app when ${shared} changes`, () => {
      assert.deepEqual(appsToGrade([shared, "apps/umami/README.md"], APPS), APPS);
    });
  }

  it("leaves out an app the PR deleted", () => {
    assert.deepEqual(appsToGrade(["apps/removed/tool.json", "apps/umami/tool.json"], APPS), ["umami"]);
  });

  it("does not treat a nested package.json as shared", () => {
    assert.deepEqual(appsToGrade(["apps/umami/package.json"], APPS), ["umami"]);
  });
});

describe("changed-apps.ts", () => {
  /** A repository with the given apps, one commit in, and a function to commit more. */
  function repo(): { dir: string; commit: (file: string) => string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "changed-apps-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf-8" }).trim();
    git("init", "--quiet", "--initial-branch=develop");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    const commit = (file: string): string => {
      fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
      fs.appendFileSync(path.join(dir, file), "x\n");
      git("add", "--all");
      git("commit", "--quiet", "--message", file);
      return git("rev-parse", "HEAD");
    };
    for (const app of APPS) commit(`apps/${app}/tool.json`);
    return { dir, commit };
  }

  const run = (dir: string, ...args: string[]): unknown =>
    JSON.parse(execFileSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf-8", stdio: "pipe" }));

  it("diffs from the merge base, so changes on the base branch are not the PR's", () => {
    const { dir, commit } = repo();
    const base = commit("README.md");
    execFileSync("git", ["switch", "--quiet", "-c", "feature"], { cwd: dir });
    commit("apps/umami/README.md");
    execFileSync("git", ["switch", "--quiet", "develop"], { cwd: dir });
    const develop = commit("apps/sentry/README.md");
    execFileSync("git", ["switch", "--quiet", "feature"], { cwd: dir });

    assert.notEqual(base, develop);
    assert.deepEqual(run(dir, develop), ["umami"]);
  });

  it("grades every app with no base ref", () => {
    const { dir } = repo();
    assert.deepEqual(run(dir), APPS);
  });
});
