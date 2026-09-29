import { Aspects, type IAspect, Tags } from "aws-cdk-lib";
import { CfnFunction } from "aws-cdk-lib/aws-lambda";
import type { IConstruct } from "constructs";

/**
 * AWS Partner Revenue Measurement (PRM) attribution.
 *
 * Applies both PRM attribution methods app-wide:
 *  1. Resource tagging  — adds `aws-apn-id = pc:<product-code>` to every taggable
 *     resource (durable, drift-free; this is the IaC source of truth for the tag
 *     that was also backfilled via the CLI).
 *  2. User Agent        — sets `AWS_SDK_UA_APP_ID` on every Lambda function so the
 *     SDK calls they make are attributed to AH2 in CloudTrail `userAgent`.
 *
 * Product code: 65tte4ihd3t7xvrhm6ptevw6b (AH2 AWS Marketplace listing).
 */
const PRODUCT_CODE = "65tte4ihd3t7xvrhm6ptevw6b";
export const PRM_TAG_KEY = "aws-apn-id";
export const PRM_TAG_VALUE = `pc:${PRODUCT_CODE}`;
// The trailing `$` is the required end delimiter for the PRM User Agent format.
export const PRM_UA_APP_ID = `APN_1.1/pc_${PRODUCT_CODE}$`;

/** Adds AWS_SDK_UA_APP_ID to every Lambda function in the construct tree. */
class PrmUserAgentAspect implements IAspect {
  public visit(node: IConstruct): void {
    if (!(node instanceof CfnFunction)) {
      return;
    }
    // Deep property override: set only this nested key so all other environment
    // variables are preserved. Do NOT read node.environment and merge — the L2
    // Function renders it as a lazy token, so a read-merge sees zero existing
    // variables and silently clobbers them all, including ones that CDK custom-
    // resource provider Lambdas read at deploy time (e.g. USER_ON_EVENT_FUNCTION_ARN),
    // which breaks deployments.
    node.addPropertyOverride("Environment.Variables.AWS_SDK_UA_APP_ID", PRM_UA_APP_ID);
  }
}

/**
 * Wire PRM attribution into a CDK App (or any construct scope). Call once from
 * the app entry point, after the app is created.
 */
export function applyPrmAttribution(scope: IConstruct): void {
  Tags.of(scope).add(PRM_TAG_KEY, PRM_TAG_VALUE);
  Aspects.of(scope).add(new PrmUserAgentAspect());
}
