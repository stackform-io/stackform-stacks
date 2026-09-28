#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { UmamiStack } from "../lib/umami-stack";

import { applyPrmAttribution } from "./prm-attribution";

const app = new cdk.App();

// AWS Partner Revenue Measurement (PRM) — app-wide tag + Lambda User Agent attribution.
applyPrmAttribution(app);

// Read configuration from CDK context (injected by the deploy engine from the deploy form)
const toolConfig = app.node.tryGetContext("toolConfig") || {};

const ALLOWED_CPU = [256, 512, 1024, 2048];
const cpu = Number(toolConfig.cpu) || 512;
if (!ALLOWED_CPU.includes(cpu)) {
  throw new Error(`cpu must be one of: ${ALLOWED_CPU.join(", ")}`);
}

const ALLOWED_MEMORY = [512, 1024, 2048, 4096];
const memoryMiB = Number(toolConfig.memoryMiB) || 1024;
if (!ALLOWED_MEMORY.includes(memoryMiB)) {
  throw new Error(`memoryMiB must be one of: ${ALLOWED_MEMORY.join(", ")}`);
}

// Fargate accepts only these pairings. Refusing a bad one here fails the synth with a
// clear message, instead of CloudFormation rejecting the task definition mid-deploy.
const FARGATE_MEMORY_FOR_CPU: Record<number, number[]> = {
  256: [512, 1024, 2048],
  512: [1024, 2048, 4096],
  1024: [2048, 4096],
  2048: [4096],
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

new UmamiStack(app, "UmamiStack", {
  cpu,
  memoryMiB,
  desiredCount,
  dbInstanceType,
  dbMultiAz: asBoolean(toolConfig.dbMultiAz),
  domainName: toolConfig.domainName || undefined,
  hostedZoneId: toolConfig.hostedZoneId || undefined,
  destroyDataOnDelete: asBoolean(toolConfig.destroyDataOnDelete),
  description: `Self-hosted Umami analytics (Fargate + RDS PostgreSQL)`,
});
