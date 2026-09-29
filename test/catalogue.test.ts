import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

const ROOT = path.join(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "check-catalogue.ts");

const check = (root: string) => spawnSync(process.execPath, [SCRIPT, root], { encoding: "utf-8" });

/** A repository root holding a copy of apps/umami, with `edit` applied to its tool.json. */
function catalogueWith(edit: (tool: Record<string, unknown>) => void, readme?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalogue-"));
  fs.cpSync(path.join(ROOT, "apps", "umami"), path.join(root, "apps", "umami"), {
    recursive: true,
    filter: (source) => !source.includes("node_modules") && !source.includes("cdk.out"),
  });
  const toolPath = path.join(root, "apps", "umami", "tool.json");
  const tool = JSON.parse(fs.readFileSync(toolPath, "utf-8")) as Record<string, unknown>;
  edit(tool);
  fs.writeFileSync(toolPath, JSON.stringify(tool));
  fs.writeFileSync(
    path.join(root, "README.md"),
    readme ?? "[![Deploy to Stackform](x)](https://dev.stackform.io/start/deploy?template=umami)\n",
  );
  return root;
}

describe("check-catalogue.ts", () => {
  it("passes this repository", () => {
    const result = check(ROOT);
    assert.equal(result.status, 0, result.stderr);
  });

  it("passes a copy of one valid app", () => {
    const result = check(catalogueWith(() => {}));
    assert.equal(result.status, 0, result.stderr);
  });

  it("fails a slug that does not match the directory", () => {
    const result = check(catalogueWith((tool) => (tool.slug = "other")));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /slug "other" must match the directory name/);
  });

  it("fails an unknown visibility", () => {
    const result = check(catalogueWith((tool) => (tool.visibility = "SECRET")));
    assert.match(result.stderr, /visibility must be one of/);
  });

  it("fails a number field with no bounds", () => {
    const result = check(
      catalogueWith((tool) => {
        tool.configSchema = {
          type: "object",
          properties: { size: { type: "number", title: "Size", description: "How big", default: 1 } },
        };
      }),
    );
    assert.match(result.stderr, /must be bounded by enum or minimum\/maximum/);
  });

  it("fails an app with no deploy button in the README", () => {
    const result = check(catalogueWith(() => {}, "# Stacks\n"));
    assert.match(result.stderr, /no deploy button for \?template=umami/);
  });

  it("fails a deploy button for an app that does not exist", () => {
    const readme =
      "[x](https://dev.stackform.io/start/deploy?template=umami)\n[x](https://dev.stackform.io/start/deploy?template=gone)\n";
    const result = check(catalogueWith(() => {}, readme));
    assert.match(result.stderr, /deploy button for "gone", which has no directory/);
  });
});
