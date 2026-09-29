/**
 * Synthesise every deploy-form variant of an app and run the SF-441 pre-flight gate
 * over the templates.
 *
 * Usage:
 *   node scripts/preflight.ts apps/umami [apps/sentry ...]
 *
 * The gate is the one in `gate/`, next to this script. CI runs this script from the
 * PR's base branch, so a PR is graded by the gate it targets, not one it edits.
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

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

type ToolConfig = Record<string, unknown>;

const GATE_CLI = path.join(import.meta.dirname, "..", "gate", "scripts", "preflight-gate.ts");
const CDK_CLI = `aws-cdk@${process.env.CDK_CLI_VERSION ?? "2"}`;

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The variants to synthesise: defaults first, then whatever preflight.json declares. */
function variantsOf(appDir: string): Record<string, ToolConfig> {
  const file = path.join(appDir, "preflight.json");
  if (!fs.existsSync(file)) return { defaults: {} };

  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
  const variants = isObject(parsed) && parsed.variants !== undefined ? parsed.variants : {};
  if (!isObject(variants)) fail(`${file}: "variants" must be an object of name -> toolConfig.`);
  if ("defaults" in variants) fail(`${file}: "defaults" is reserved; it always runs with no toolConfig.`);

  const result: Record<string, ToolConfig> = { defaults: {} };
  for (const [name, toolConfig] of Object.entries(variants)) {
    if (!isObject(toolConfig)) fail(`${file}: variant "${name}" must be an object.`);
    result[name] = toolConfig;
  }
  return result;
}

/** Synthesise one variant into cdk.out/preflight/<variant>, leaving cdk.json as it was. */
function synth(appDir: string, toolConfig: ToolConfig, outDir: string): boolean {
  const cdkJsonPath = path.join(appDir, "cdk.json");
  const original = fs.readFileSync(cdkJsonPath, "utf-8");
  const cdkJson: unknown = JSON.parse(original);
  if (!isObject(cdkJson)) fail(`${cdkJsonPath} must be a JSON object.`);
  const context = isObject(cdkJson.context) ? cdkJson.context : {};

  fs.writeFileSync(cdkJsonPath, JSON.stringify({ ...cdkJson, context: { ...context, toolConfig } }, null, 2));
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
 * first-login note with an em dash reaches the customer mangled. The gate does not
 * check this, so it is checked here.
 */
function nonAsciiOutputs(outDir: string): string[] {
  return fs
    .readdirSync(outDir)
    .filter((name) => name.endsWith(".template.json"))
    .flatMap((name) => {
      const template: unknown = JSON.parse(fs.readFileSync(path.join(outDir, name), "utf-8"));
      const outputs = isObject(template) && isObject(template.Outputs) ? template.Outputs : {};
      return Object.entries(outputs).flatMap(([key, output]) =>
        (isObject(output) ? [output.Value, output.Description] : [])
          .filter((text): text is string => typeof text === "string" && /[^\x20-\x7E]/.test(text))
          .map((text) => `${name}: ${key}: ${text}`),
      );
    });
}

function main(): void {
  const targets = process.argv.slice(2);
  if (targets.length === 0) fail("Usage: node scripts/preflight.ts apps/<slug> [apps/<slug> ...]");
  if (!fs.existsSync(GATE_CLI)) fail(`Gate not found at ${GATE_CLI}.`);

  let failed = false;

  for (const target of targets) {
    const appDir = path.resolve(target);
    const app = path.basename(appDir);
    if (!fs.existsSync(path.join(appDir, "cdk.json"))) fail(`${target} is not an app: no cdk.json`);

    const gateDir = path.join(appDir, "cdk.out", "preflight");
    fs.rmSync(gateDir, { recursive: true, force: true });

    for (const [variant, toolConfig] of Object.entries(variantsOf(appDir))) {
      console.log(`\n==> ${app} / ${variant}: synth ${JSON.stringify(toolConfig)}`);
      const outDir = path.join(gateDir, variant);
      if (!synth(appDir, toolConfig, outDir)) {
        console.error(`::error::${app} / ${variant}: cdk synth failed`);
        failed = true;
        continue;
      }

      const mangled = nonAsciiOutputs(outDir);
      if (mangled.length > 0) {
        console.error(`::error::${app} / ${variant}: outputs must be plain ASCII`);
        for (const line of mangled) console.error(`  ${line}`);
        failed = true;
      }
    }

    if (!fs.existsSync(gateDir)) continue;

    console.log(`\n==> ${app}: pre-flight gate`);
    const gate = spawnSync(process.execPath, [GATE_CLI, gateDir], { stdio: "inherit" });
    if (gate.status === 2 || gate.status === null) fail("The gate could not run (exit 2). See above.");
    if (gate.status !== 0) failed = true;
  }

  process.exitCode = failed ? 1 : 0;
}

main();
