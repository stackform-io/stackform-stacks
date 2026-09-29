/**
 * Check the container images an app deploys, as its synthesised templates name them.
 *
 * Usage:
 *   node scripts/check-images.ts apps/umami [apps/sentry ...]
 *
 * Run it after scripts/preflight.ts, which leaves each variant's templates under
 * `apps/<slug>/cdk.out/preflight/`. Every `AWS::ECS::TaskDefinition` container image is
 * checked, across every variant:
 *
 * - **Pinned** (blocking): a tag or digest, never `latest` or no tag at all. A floating
 *   tag deploys whatever upstream pushed last, so the same stack changes under a customer
 *   without a release here.
 * - **Exists** (blocking): the registry still serves that tag. `cdk synth` treats an
 *   image as a string, so a removed or mistyped tag would otherwise surface only when a
 *   customer's deploy fails to pull it.
 * - **Up to date** (advisory): the newest release with the same shape of tag (same `v`
 *   prefix, same suffix such as `-slim`). Reported, never failing: an upstream release
 *   should not block a promotion. Bounded, for repositories with a tag per nightly build.
 *
 * Registries are queried anonymously through the Docker Registry v2 API, answering the
 * registry's own auth challenge, so this works for any public registry and needs no
 * credentials — including on PRs from forks. Images whose name is not a plain string (a
 * CDK-built asset in ECR) are skipped.
 *
 * Exit codes: 0 all passed, 1 an image failed, 2 setup error (no templates, registry down).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { checkImage, imagesIn, SetupError } from "./lib/images.ts";

async function main(): Promise<void> {
  const targets = process.argv.slice(2);
  if (targets.length === 0) throw new SetupError("Usage: node scripts/check-images.ts apps/<slug> [apps/<slug> ...]");

  let failed = false;
  for (const target of targets) {
    const app = path.basename(path.resolve(target));
    const dir = path.join(target, "cdk.out", "preflight");
    if (!fs.existsSync(dir)) throw new SetupError(`${dir} not found: run node scripts/preflight.ts ${target} first`);

    const images = [...imagesIn(dir)].sort();
    console.log(`\n==> ${app}: ${images.length} image(s)`);
    if (images.length === 0) console.log("  none to check (no ECS task definition, or only CDK-built images)");

    for (const image of images) {
      const { blocking, advisory } = await checkImage(image);
      console.log(`${blocking.length > 0 ? "FAIL" : "PASS"}  ${image}`);
      for (const message of blocking) console.error(`::error::${app}: ${image}: ${message}`);
      for (const message of advisory) console.log(`::warning::${app}: ${image}: ${message}`);
      if (blocking.length > 0) failed = true;
    }
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error(error instanceof SetupError ? error.message : error);
  process.exitCode = 2;
});
