#!/usr/bin/env node
/**
 * Synthesise every deploy-form variant of an app and run the SF-441 pre-flight gate
 * over the templates.
 *
 * Usage:
 *   node scripts/preflight.mjs apps/umami [apps/sentry ...]
 *
 * Needs the platform repository checked out, because the gate lives there
 * (`lib/verification/`), so there is one gate and nothing to keep in sync. Point
 * STACKFORM_CDK_DIR at it; it defaults to a sibling `../stackform-cdk` checkout.
 *
 * Variants: the defaults (no `toolConfig`) always run. `apps/<slug>/preflight.json`
 * adds the other shapes a customer can pick — a custom domain, another tier — because
 * grading one configuration grades one template out of several.
 *
 * `toolConfig` goes into `cdk.json` context exactly as the deploy engine writes it
 * (TemplateStrategy.applyConfiguration), not through `cdk synth -c`: the CLI passes
 * `-c` values as strings, so an object would arrive as text and the stack would
 * quietly synthesise its defaults instead.
 *
 * Exit codes follow the gate CLI: 0 all passed, 1 a stack failed, 2 setup error.
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CDK_DIR = path.resolve(process.env.STACKFORM_CDK_DIR ?? path.join(ROOT, "..", "stackform-cdk"));
const GATE_CLI = path.join(CDK_DIR, "scripts", "preflight-gate.ts");
const CDK_CLI = `aws-cdk@${process.env.CDK_CLI_VERSION ?? "2"}`;
const TSX = `tsx@${process.env.TSX_VERSION ?? "4"}`;

function fail(message, code = 2) {
  console.error(message);
  process.exit(code);
}

/** The variants to synthesise: defaults first, then whatever preflight.json declares. */
function variantsOf(appDir) {
  const file = path.join(appDir, "preflight.json");
  if (!fs.existsSync(file)) return { defaults: {} };

  const { variants = {} } = JSON.parse(fs.readFileSync(file, "utf-8"));
  if ("defaults" in variants) fail(`${file}: "defaults" is reserved; it always runs with no toolConfig.`);
  return { defaults: {}, ...variants };
}

/** Synthesise one variant into cdk.out/preflight/<variant>, leaving cdk.json as it was. */
function synth(appDir, variant, toolConfig, outDir) {
  const cdkJsonPath = path.join(appDir, "cdk.json");
  const original = fs.readFileSync(cdkJsonPath, "utf-8");
  const cdkJson = JSON.parse(original);
  cdkJson.context = { ...cdkJson.context, toolConfig };

  fs.writeFileSync(cdkJsonPath, JSON.stringify(cdkJson, null, 2));
  try {
    const result = spawnSync("npx", ["--yes", CDK_CLI, "synth", "--quiet", "--output", outDir], {
      cwd: appDir,
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, CDK_DISABLE_VERSION_CHECK: "1" },
    });
    return result.status === 0;
  } finally {
    fs.writeFileSync(cdkJsonPath, original);
  }
}

/**
 * CloudFormation hands back anything outside printable ASCII in an output as "?", so a
 * first-login note with an em dash reaches the customer mangled. The catalogue test in
 * stackform-cdk checks the same thing; the gate CLI does not.
 */
function nonAsciiOutputs(outDir) {
  return fs
    .readdirSync(outDir)
    .filter((name) => name.endsWith(".template.json"))
    .flatMap((name) => {
      const outputs = JSON.parse(fs.readFileSync(path.join(outDir, name), "utf-8")).Outputs ?? {};
      return Object.entries(outputs).flatMap(([key, output]) =>
        [output.Value, output.Description]
          .filter((text) => typeof text === "string" && /[^\x20-\x7E]/.test(text))
          .map((text) => `${name}: ${key}: ${text}`),
      );
    });
}

function main() {
  const targets = process.argv.slice(2);
  if (targets.length === 0) fail("Usage: node scripts/preflight.mjs apps/<slug> [apps/<slug> ...]");
  if (!fs.existsSync(GATE_CLI)) {
    fail(`Gate not found at ${GATE_CLI}. Check out stackform-cdk and set STACKFORM_CDK_DIR.`);
  }

  let failed = false;

  for (const target of targets) {
    const appDir = path.resolve(target);
    if (!fs.existsSync(path.join(appDir, "cdk.json"))) fail(`${target} is not an app: no cdk.json`);

    const gateDir = path.join(appDir, "cdk.out", "preflight");
    fs.rmSync(gateDir, { recursive: true, force: true });

    for (const [variant, toolConfig] of Object.entries(variantsOf(appDir))) {
      console.log(`\n==> ${path.basename(appDir)} / ${variant}: synth ${JSON.stringify(toolConfig)}`);
      const outDir = path.join(gateDir, variant);
      if (!synth(appDir, variant, toolConfig, outDir)) {
        console.error(`::error::${path.basename(appDir)} / ${variant}: cdk synth failed`);
        failed = true;
        continue;
      }

      const mangled = nonAsciiOutputs(outDir);
      if (mangled.length > 0) {
        console.error(`::error::${path.basename(appDir)} / ${variant}: outputs must be plain ASCII`);
        mangled.forEach((line) => console.error(`  ${line}`));
        failed = true;
      }
    }

    if (!fs.existsSync(gateDir)) continue;

    console.log(`\n==> ${path.basename(appDir)}: pre-flight gate`);
    try {
      execFileSync("npx", ["--yes", TSX, GATE_CLI, gateDir], { stdio: "inherit" });
    } catch (error) {
      if (error.status === 2) fail("The gate could not run (exit 2). See above.");
      failed = true;
    }
  }

  process.exitCode = failed ? 1 : 0;
}

main();
