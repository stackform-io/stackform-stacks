import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

const GATE = path.join(import.meta.dirname, "..", "gate", "scripts", "preflight-gate.ts");

/** A directory holding one synthesised template, named `<stack>.template.json`. */
function templates(stack: string, template: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
  fs.writeFileSync(path.join(dir, `${stack}.template.json`), JSON.stringify(template));
  return dir;
}

const gate = (...args: string[]) => spawnSync(process.execPath, [GATE, ...args], { encoding: "utf-8" });

describe("preflight-gate.ts", () => {
  it("fails a stack with no AppUrl output", () => {
    const result = gate(templates("NoUrl", { Resources: { Bucket: { Type: "AWS::S3::Bucket" } } }));
    assert.equal(result.status, 1);
    assert.match(result.stdout, /PREFLIGHT-APPURL/);
  });

  it("fails a role that allows every action", () => {
    const result = gate(
      templates("Admin", {
        Resources: {
          Policy: {
            Type: "AWS::IAM::Policy",
            Properties: {
              PolicyName: "all",
              PolicyDocument: { Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }] },
            },
          },
        },
        Outputs: { AppUrl: { Value: "http://example.com" } },
      }),
    );
    assert.equal(result.status, 1);
    assert.match(result.stdout, /PREFLIGHT-NO-WILDCARD-ACTION/);
  });

  it("reports machine-readable results with --json", () => {
    const result = gate("--json", templates("NoUrl", { Resources: { Bucket: { Type: "AWS::S3::Bucket" } } }));
    const report: unknown = JSON.parse(result.stdout);
    assert.ok(Array.isArray(report) || (typeof report === "object" && report !== null));
    assert.match(result.stdout, /"PREFLIGHT-APPURL"/);
  });
});
