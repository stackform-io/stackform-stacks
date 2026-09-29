/**
 * Run the static pre-flight gate over synthesised CloudFormation templates (SF-441).
 *
 * Takes templates that already exist — `cdk synth` output, or a `cdk.out` directory —
 * and reports pass/fail per assertion, exiting non-zero when anything blocking failed.
 * `scripts/preflight.ts` synthesises every variant of an app and calls this; run it
 * directly for a `cdk.out` you already have in front of you.
 *
 * Usage:
 *   node gate/scripts/preflight-gate.ts cdk.out/MyStack.template.json
 *   node gate/scripts/preflight-gate.ts cdk.out/            # every *.template.json
 *   node gate/scripts/preflight-gate.ts --json cdk.out/     # machine-readable
 *
 * Runs on Node's built-in type stripping (Node 22.18 or later), so there is nothing to
 * install; imports name their `.ts` files for the same reason.
 *
 * The JSON form is the one the self-repair loop consumes (SF-448): one object per
 * stack, each carrying the full result list rather than a summary, so the agent is
 * told which rule failed and why rather than just that something did.
 *
 * ## What this is pointed at
 *
 * App stacks — the ones behind a Deploy to Stackform button. The thresholds are tuned
 * for them: an infrastructure stack that serves no app fails on `AppUrl`, which is
 * right for an app and a false rejection for anything else. A gate wired over the
 * wrong stacks produces noise, the noise gets suppressed, and a suppressed gate still
 * reads as protection on the board while protecting nothing.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { type AssertionResult, buildReport, getAssertion } from "../lib/verification/assertions.ts";
import { runPreflightGate } from "../lib/verification/preflight.ts";
import type { CfnTemplate } from "../lib/verification/template-audit.ts";

interface StackResult {
  stack: string;
  passed: boolean;
  blockingFailures: AssertionResult[];
  advisoryFailures: AssertionResult[];
  /**
   * Pre-flight assertions nothing reported on.
   *
   * A *blocking* one fails the stack, because an unrun check is indistinguishable from a
   * pass and must not be counted as one. An unrun advisory check is listed but does not
   * fail it — an advisory assertion that fails outright does not either, and its absence
   * should not be treated more harshly than its failure.
   */
  notRun: string[];
  /**
   * Assertions that ran and found nothing they inspect.
   *
   * Neither a pass nor a failure: the rule established nothing. Carried in the JSON so
   * the self-repair loop can tell "this stack is clean" from "these rules never looked at
   * it", which are very different inputs to a repair decision.
   */
  notApplicable: string[];
  results: AssertionResult[];
}

/** Every `*.template.json` under a directory, at any depth. */
function templatesUnder(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return templatesUnder(full);
      return entry.isFile() && entry.name.endsWith(".template.json") ? [full] : [];
    })
    .sort();
}

/**
 * Every template file implied by a path, whether it names a file or a directory.
 *
 * A path that does not exist is a setup error, not a gate failure. Letting `statSync`
 * throw exits 1, which is the code a stack that failed the gate uses — so a typo in a
 * CI argument would be reported as "this stack is unsafe" rather than "you pointed me
 * at nothing". Exit 2 is what the rest of this script uses to say the same thing.
 *
 * The walk recurses because a `Stage` writes its stacks to `cdk.out/assembly-<Stage>/`
 * rather than to `cdk.out/` itself. A single-level read found nothing there, and the
 * shape that made it dangerous is the mixed one: an app with a top-level stack *and* a
 * Stage graded the top-level stack, reported "1 stack(s) graded, 0 failed" and exited 0
 * without ever opening the stacks under the stage. The engine fixed the same bug by
 * moving to `stacksRecursively`; this is that fix on the on-demand side.
 */
function templateFiles(target: string): string[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    console.error(`No such file or directory: ${target}`);
    process.exit(2);
  }
  if (stat.isFile()) return [target];

  return templatesUnder(target);
}

/**
 * Stack name as CDK writes it: `<StackName>.template.json`.
 *
 * Nested assemblies are prefixed with the directory they were found in, because two
 * stages can each hold a stack of the same name and a report listing `Api` twice tells
 * you nothing about which one failed.
 */
function stackNameOf(file: string, root: string): string {
  const name = path.basename(file).replace(/\.template\.json$/, "");
  const nested = path.dirname(path.relative(root, file));

  return nested === "." || nested === "" || nested.startsWith("..") ? name : `${nested}/${name}`;
}

function gradeTemplate(file: string, root: string): StackResult {
  // A file that cannot be read or parsed is the same class of problem as a path that
  // does not exist: the gate has not established anything about this stack, so it must
  // not report the code that means "this stack is unsafe". A truncated or half-written
  // template is the realistic cause, and exiting 1 for it sends CI hunting for an IAM
  // defect that is not there.
  let template: CfnTemplate;
  try {
    template = JSON.parse(fs.readFileSync(file, "utf-8")) as CfnTemplate;
  } catch (error) {
    console.error(`Could not read ${file} as JSON: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  const results = runPreflightGate(template);

  // This is the publishing context, so the declared severities apply verbatim and
  // `buildReport` needs no policy: a candidate graded here has not been published yet,
  // and refusing it costs nobody a deploy. The engine relaxes them for live deploys
  // (see `effectiveSeverity`) — this is the one place that must not.

  // Scoped to the stage that ran, so the rest of the checklist is not counted as
  // missing — but the pre-flight checks themselves still have to be there. Grading
  // locally instead would drop that: a gate that silently reported only some of its
  // rules would report PASS, which is the failure the assertion model exists to stop.
  const report = buildReport(results, { categories: ["preflight", "security"] });

  return {
    stack: stackNameOf(file, root),
    passed: report.passed,
    blockingFailures: report.blockingFailures,
    advisoryFailures: report.advisoryFailures,
    notRun: report.notRun,
    notApplicable: report.notApplicable,
    results,
  };
}

function printHuman(stacks: StackResult[]): void {
  for (const stack of stacks) {
    const verdict = stack.passed ? "PASS" : "FAIL";
    console.log(`\n${verdict}  ${stack.stack}`);

    for (const result of stack.results) {
      if (result.passed) continue;
      const spec = getAssertion(result.id);
      const label = spec.severity === "blocking" ? "blocking" : "advisory";
      console.log(`  [${label}] ${result.id}: ${spec.title}`);
      console.log(`      ${result.detail}`);
    }

    for (const id of stack.notRun) {
      const spec = getAssertion(id);
      // Say which kind, because only a blocking one accounts for a FAIL above. Printing
      // "an unrun check is not a pass" under a PASS header, with nothing to say why the
      // verdict stood, reads as a contradiction rather than as the note it is.
      const blocking = spec.severity === "blocking";
      console.log(`  [not run${blocking ? "" : ", advisory"}] ${id}: ${spec.title}`);
      console.log(
        blocking
          ? `      The gate did not report on this. An unrun blocking check is not a pass.`
          : `      The gate did not report on this. Advisory, so it does not fail the stack.`,
      );
    }

    // Listed, not hidden. A rule that found nothing to inspect has established nothing,
    // and the reader is the only one who can tell whether that is because the stack has
    // no database or because the rule is reading the wrong resource type.
    for (const id of stack.notApplicable) {
      const result = stack.results.find((r) => r.id === id);
      console.log(`  [n/a] ${id}: ${getAssertion(id).title}`);
      console.log(`      ${result?.detail ?? "Nothing in this template to check"}`);
    }

    if (stack.blockingFailures.length === 0 && stack.advisoryFailures.length === 0 && stack.notRun.length === 0) {
      const checked = stack.results.length - stack.notApplicable.length;
      console.log(
        stack.notApplicable.length > 0
          ? `  ${checked} check(s) passed, ${stack.notApplicable.length} had nothing to inspect`
          : `  all ${stack.results.length} checks passed`,
      );
    }
  }

  const failed = stacks.filter((s) => !s.passed).length;
  console.log(
    `\n${stacks.length} stack(s) graded, ${failed} failed` +
      (failed > 0 ? " — these would have cost a real deploy to discover." : ""),
  );
}

const USAGE = "Usage: node gate/scripts/preflight-gate.ts [--json] <template.json | cdk.out dir> ...";

function main(): void {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith("--"));
  const targets = args.filter((a) => !a.startsWith("--"));

  // An unrecognised flag used to be dropped silently, so `--josn cdk.out` printed the
  // human report and the caller's JSON parse failed with nothing to explain why.
  const unknown = flags.filter((flag) => flag !== "--json");
  if (unknown.length > 0) {
    console.error(`Unknown option(s): ${unknown.join(", ")}\n${USAGE}`);
    process.exit(2);
  }

  const asJson = flags.includes("--json");

  if (targets.length === 0) {
    console.error(USAGE);
    process.exit(2);
  }

  const files = targets.flatMap((target) => templateFiles(target).map((file) => ({ file, root: target })));
  if (files.length === 0) {
    // Silently grading nothing and exiting 0 would make a misconfigured CI step look
    // like a passing gate, which is the one outcome worse than a failure.
    console.error(`No *.template.json found in: ${targets.join(", ")}`);
    process.exit(2);
  }

  const stacks = files.map(({ file, root }) => gradeTemplate(file, root));

  if (asJson) {
    console.log(JSON.stringify({ stacks }, null, 2));
  } else {
    printHuman(stacks);
  }

  // Set rather than exit. Node's stdout is asynchronous when it is a pipe, and
  // `process.exit` does not flush what is still buffered — so a multi-stack `--json`
  // report piped to the self-repair loop could arrive truncated, and the consumer would
  // see invalid JSON with nothing to indicate the gate had actually finished. Letting
  // the process end on its own drains the buffer first.
  //
  // The error paths above still call `process.exit` deliberately: they write to stderr
  // and need to stop before grading continues.
  process.exitCode = stacks.every((s) => s.passed) ? 0 : 1;
}

try {
  main();
} catch (error) {
  // Anything reaching here is a bug in the gate rather than a verdict about a stack, and
  // the two must not share an exit code: a crash that exits 1 tells CI a candidate is
  // unsafe, which is a claim the gate has not made. A stack trace on stderr is for
  // whoever debugs it; the exit code is for whoever automated it.
  console.error(
    `Pre-flight gate failed to run: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exit(2);
}
