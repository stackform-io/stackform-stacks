import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { checkImage, compare, imagesIn, parseImage, versionOf } from "../scripts/lib/images.ts";

const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "check-images.ts");

/**
 * The registry tests query Docker Hub and GHCR. Set OFFLINE=1 to skip them; everything
 * else runs without a network.
 */
const offline = process.env.OFFLINE === "1";

/** An app directory whose synthesised templates name `images`, as preflight.ts leaves them. */
function appWith(...images: unknown[]): string {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "check-images-"));
  const dir = path.join(app, "cdk.out", "preflight", "defaults");
  fs.mkdirSync(dir, { recursive: true });
  const template = {
    Resources: {
      Task: {
        Type: "AWS::ECS::TaskDefinition",
        Properties: { ContainerDefinitions: images.map((Image) => ({ Name: "app", Image })) },
      },
      Bucket: { Type: "AWS::S3::Bucket", Properties: {} },
    },
  };
  fs.writeFileSync(path.join(dir, "App.template.json"), JSON.stringify(template));
  return app;
}

describe("parseImage", () => {
  it("defaults to Docker Hub and library/ for an official image", () => {
    assert.deepEqual(parseImage("nginx:1.27.0"), {
      registry: "registry-1.docker.io",
      repository: "library/nginx",
      tag: "1.27.0",
    });
  });

  it("reads a Docker Hub user image", () => {
    assert.deepEqual(parseImage("louislam/uptime-kuma:2.5.5-slim"), {
      registry: "registry-1.docker.io",
      repository: "louislam/uptime-kuma",
      tag: "2.5.5-slim",
    });
  });

  it("reads another registry, with a nested repository", () => {
    assert.deepEqual(parseImage("ghcr.io/berriai/litellm-database:v1.102.1"), {
      registry: "ghcr.io",
      repository: "berriai/litellm-database",
      tag: "v1.102.1",
    });
  });

  it("tells a registry port from a tag", () => {
    assert.deepEqual(parseImage("localhost:5000/team/app"), {
      registry: "localhost:5000",
      repository: "team/app",
    });
  });

  it("reads a digest, with or without a tag", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    assert.deepEqual(parseImage(`nginx@${digest}`), {
      registry: "registry-1.docker.io",
      repository: "library/nginx",
      digest,
    });
    assert.equal(parseImage(`nginx:1.27.0@${digest}`).tag, "1.27.0");
  });

  it("has no tag for an untagged image", () => {
    assert.equal(parseImage("nginx").tag, undefined);
  });
});

describe("versionOf", () => {
  it("reads plain, v-prefixed and suffixed release tags", () => {
    assert.deepEqual(versionOf("24.11.1")?.numbers, [24, 11, 1]);
    assert.deepEqual(versionOf("v1.102.1")?.numbers, [1, 102, 1]);
    assert.deepEqual(versionOf("3.8.6-python3.12")?.numbers, [3, 8, 6]);
    assert.equal(versionOf("3.8.6-python3.12")?.suffix, "-python3.12");
  });

  it("gives tags of different shapes different shapes", () => {
    const shapes = ["2.5.5", "2.5.5-slim", "v2.5.5", "2.5"].map((tag) => versionOf(tag)?.shape);
    assert.equal(new Set(shapes).size, shapes.length);
  });

  it("gives the same shape to releases of one line", () => {
    assert.equal(versionOf("2.5.5-slim")?.shape, versionOf("2.10.0-slim")?.shape);
  });

  it("ignores pre-releases and non-version tags", () => {
    for (const tag of ["3.0.0-rc1", "3.0.0-beta.2", "latest", "nightly", "c24d832", "sha-c24d832-python3.12"]) {
      assert.equal(versionOf(tag), undefined, tag);
    }
  });
});

describe("compare", () => {
  it("orders by number, not text", () => {
    assert.ok(compare([3, 10, 0], [3, 9, 9]) > 0);
    assert.ok(compare([1, 2], [1, 2, 1]) < 0);
    assert.equal(compare([2, 0, 0], [2]), 0);
  });
});

describe("imagesIn", () => {
  it("finds every plain-string container image, once", () => {
    const app = appWith("nginx:1.27.0", "nginx:1.27.0", "louislam/uptime-kuma:2.5.5-slim");
    assert.deepEqual([...imagesIn(path.join(app, "cdk.out", "preflight"))].sort(), [
      "louislam/uptime-kuma:2.5.5-slim",
      "nginx:1.27.0",
    ]);
  });

  it("skips a CDK-built image, which is not a plain string", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a CloudFormation Fn::Sub, not JavaScript
    const app = appWith({ "Fn::Sub": "${AWS::AccountId}.dkr.ecr.${AWS::Region}.amazonaws.com/asset:abc" });
    assert.equal(imagesIn(path.join(app, "cdk.out", "preflight")).size, 0);
  });
});

describe("checkImage: pinning", () => {
  it("fails latest", async () => {
    const { blocking } = await checkImage("louislam/uptime-kuma:latest");
    assert.match(blocking.join(), /latest/);
  });

  it("fails an untagged image", async () => {
    const { blocking } = await checkImage("nginx");
    assert.match(blocking.join(), /no tag/);
  });
});

describe("checkImage: registries", { skip: offline && "OFFLINE=1" }, () => {
  it("passes a published Docker Hub tag, and reports a newer release", async () => {
    const { blocking, advisory } = await checkImage("nginx:1.27.0");
    assert.deepEqual(blocking, []);
    assert.match(advisory.join(), /is available/);
  });

  it("passes a published GHCR tag", async () => {
    const { blocking } = await checkImage("ghcr.io/umami-software/umami:3.4.0");
    assert.deepEqual(blocking, []);
  });

  it("fails a tag the registry does not have", async () => {
    const hub = await checkImage("louislam/uptime-kuma:9.9.9");
    const ghcr = await checkImage("ghcr.io/umami-software/umami:0.0.0-removed");
    assert.match(hub.blocking.join(), /has no 9\.9\.9/);
    assert.match(ghcr.blocking.join(), /has no 0\.0\.0-removed/);
  });

  it("finds a newer release in a repository with a tag per nightly build", async () => {
    // getsentry/sentry has over 100,000 tags, nearly all nightly commit hashes.
    const { advisory } = await checkImage("getsentry/sentry:24.11.1");
    assert.match(advisory.join(), /^2\d\.\d+\.\d+ is available/);
  });
});

describe("check-images.ts", () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf-8" });

  it("exits 1 when an image is not pinned", () => {
    const result = run(appWith("louislam/uptime-kuma:latest"));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /::error::.*latest/);
  });

  it("exits 2 when the app has not been synthesised", () => {
    const result = run(fs.mkdtempSync(path.join(os.tmpdir(), "check-images-")));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /run node scripts\/preflight\.ts/);
  });

  it("exits 2 with no app", () => {
    assert.equal(run().status, 2);
  });
});
