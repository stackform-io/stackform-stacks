#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { SentryEc2Stack } from "../lib/sentry-ec2-stack";
import { SentryFargateStack } from "../lib/sentry-fargate-stack";

import { applyPrmAttribution } from "./prm-attribution";

const app = new cdk.App();

// AWS Partner Revenue Measurement (PRM) — app-wide tag + Lambda User Agent attribution.
applyPrmAttribution(app);

// Read configuration from CDK context (injected by deploy engine)
const toolConfig = app.node.tryGetContext("toolConfig") || {};

// Tier selection: "starter" (EC2) or "optimized" (Fargate)
const ALLOWED_TIERS = ["starter", "optimized"];
const tier = (toolConfig.tier || "starter").toLowerCase();
if (!ALLOWED_TIERS.includes(tier)) {
  throw new Error(`tier must be one of: ${ALLOWED_TIERS.join(", ")}`);
}

// Shared validations
const ALLOWED_PROFILES = ["errors-only", "full"];
const ALLOWED_VPC_MODES = ["new", "existing"];
const ALLOWED_SUBNET_TYPES = ["public", "private"];

const sentryProfile = toolConfig.sentryProfile || "errors-only";
if (!ALLOWED_PROFILES.includes(sentryProfile)) {
  throw new Error(`sentryProfile must be one of: ${ALLOWED_PROFILES.join(", ")}`);
}

const vpcMode = toolConfig.vpcMode || "new";
if (!ALLOWED_VPC_MODES.includes(vpcMode)) {
  throw new Error(`vpcMode must be one of: ${ALLOWED_VPC_MODES.join(", ")}`);
}

const vpcId = toolConfig.vpcId;
const subnetType = toolConfig.subnetType || (tier === "optimized" ? "private" : "public");
if (!ALLOWED_SUBNET_TYPES.includes(subnetType)) {
  throw new Error(`subnetType must be one of: ${ALLOWED_SUBNET_TYPES.join(", ")}`);
}

const domainName = toolConfig.domainName;
const hostedZoneId = toolConfig.hostedZoneId;

// Env var overrides from deploy form Advanced section
const envVarOverrides: Record<string, string> | undefined =
  toolConfig.envVarOverrides && typeof toolConfig.envVarOverrides === "object" ? toolConfig.envVarOverrides : undefined;

if (tier === "optimized") {
  // ========================================
  // Optimized tier: ECS Fargate + RDS + ElastiCache
  // ========================================
  const webCpu = Number(toolConfig.webCpu) || 512;
  const webMemory = Number(toolConfig.webMemory) || 1024;
  const workerCpu = Number(toolConfig.workerCpu) || 256;
  const workerMemory = Number(toolConfig.workerMemory) || 512;
  const webDesiredCount = Number(toolConfig.webDesiredCount) || 1;
  const dbInstanceType = toolConfig.dbInstanceType || "db.t3.medium";
  const dbMultiAz = toolConfig.dbMultiAz === true || toolConfig.dbMultiAz === "true";
  const cacheNodeType = toolConfig.cacheNodeType || "cache.t3.micro";

  new SentryFargateStack(app, "SentryStack", {
    webCpu,
    webMemory,
    workerCpu,
    workerMemory,
    webDesiredCount,
    dbInstanceType,
    dbMultiAz,
    cacheNodeType,
    vpcMode,
    vpcId,
    subnetType,
    domainName,
    hostedZoneId,
    sentryProfile,
    envVarOverrides,
    description: `Self-hosted Sentry Optimized (Fargate + RDS + ElastiCache) — ${sentryProfile} profile`,
  });
} else {
  // ========================================
  // Starter tier: Single EC2 + Docker Compose
  // ========================================
  const ALLOWED_INSTANCES = ["t3.xlarge", "m6i.xlarge", "m6i.2xlarge"];
  const instanceType = toolConfig.instanceType || "t3.xlarge";
  if (!ALLOWED_INSTANCES.includes(instanceType)) {
    throw new Error(`instanceType must be one of: ${ALLOWED_INSTANCES.join(", ")}`);
  }

  const volumeSizeGb = Number(toolConfig.volumeSizeGb) || 100;
  if (volumeSizeGb < 50 || volumeSizeGb > 500) {
    throw new Error("volumeSizeGb must be between 50 and 500");
  }

  const sshKeyName = toolConfig.sshKeyName;

  const sentryEventRetentionDays = Number(toolConfig.sentryEventRetentionDays) || 30;
  if (sentryEventRetentionDays < 7 || sentryEventRetentionDays > 90) {
    throw new Error("sentryEventRetentionDays must be between 7 and 90");
  }

  new SentryEc2Stack(app, "SentryStack", {
    instanceType,
    volumeSizeGb,
    sentryProfile,
    vpcMode,
    vpcId,
    subnetType,
    sshKeyName,
    domainName,
    hostedZoneId,
    sentryEventRetentionDays,
    envVarOverrides,
    description: `Self-hosted Sentry Starter (EC2 docker-compose) — ${sentryProfile} profile on ${instanceType}`,
  });
}
