#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { LiteLLMStack } from "../lib/litellm-stack";

import { applyPrmAttribution } from "./prm-attribution";

const app = new cdk.App();

// AWS Partner Revenue Measurement (PRM) — app-wide tag + Lambda User Agent attribution.
applyPrmAttribution(app);

// Read configuration from CDK context (injected by the deploy engine from the deploy form)
const toolConfig = app.node.tryGetContext("toolConfig") || {};

// No 256: the Python proxy idles at ~530 MiB and needs more than a quarter vCPU to boot
// and migrate inside the health-check grace period.
const ALLOWED_CPU = [512, 1024, 2048];
const cpu = Number(toolConfig.cpu) || 1024;
if (!ALLOWED_CPU.includes(cpu)) {
  throw new Error(`cpu must be one of: ${ALLOWED_CPU.join(", ")}`);
}

const ALLOWED_MEMORY = [1024, 2048, 4096, 8192];
const memoryMiB = Number(toolConfig.memoryMiB) || 2048;
if (!ALLOWED_MEMORY.includes(memoryMiB)) {
  throw new Error(`memoryMiB must be one of: ${ALLOWED_MEMORY.join(", ")}`);
}

// Fargate accepts only these pairings. Refusing a bad one here fails the synth with a
// clear message, instead of CloudFormation rejecting the task definition mid-deploy.
const FARGATE_MEMORY_FOR_CPU: Record<number, number[]> = {
  512: [1024, 2048, 4096],
  1024: [2048, 4096, 8192],
  2048: [4096, 8192],
};
if (!FARGATE_MEMORY_FOR_CPU[cpu].includes(memoryMiB)) {
  throw new Error(`cpu ${cpu} needs memoryMiB of ${FARGATE_MEMORY_FOR_CPU[cpu].join(", ")}`);
}

const desiredCount = Number(toolConfig.desiredCount) || 1;
if (!Number.isInteger(desiredCount) || desiredCount < 1 || desiredCount > 4) {
  throw new Error("desiredCount must be an integer between 1 and 4");
}

const ALLOWED_DB_INSTANCES = ["db.t4g.micro", "db.t4g.small", "db.t4g.medium"];
const dbInstanceType = toolConfig.dbInstanceType || "db.t4g.micro";
if (!ALLOWED_DB_INSTANCES.includes(dbInstanceType)) {
  throw new Error(`dbInstanceType must be one of: ${ALLOWED_DB_INSTANCES.join(", ")}`);
}

const asBoolean = (value: unknown) => value === true || value === "true";

new LiteLLMStack(app, "LiteLLMStack", {
  cpu,
  memoryMiB,
  desiredCount,
  dbInstanceType,
  dbMultiAz: asBoolean(toolConfig.dbMultiAz),
  domainName: toolConfig.domainName || undefined,
  hostedZoneId: toolConfig.hostedZoneId || undefined,
  bedrockAccess: asBoolean(toolConfig.bedrockAccess),
  destroyDataOnDelete: asBoolean(toolConfig.destroyDataOnDelete),
  description: `Self-hosted LiteLLM proxy (Fargate + RDS PostgreSQL)`,
});
