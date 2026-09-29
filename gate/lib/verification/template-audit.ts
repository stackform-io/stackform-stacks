/**
 * The security and retention assertions, run against a synthesised CloudFormation
 * template (SF-443).
 *
 * These were done by hand after the first end-to-end runs — open the template, check
 * the database is not public, check the task has no public IP, check no password ended
 * up in the container environment, check nothing retains on delete. Every one of them
 * is a property of the template, so none of them needs an account, a deploy, or thirty
 * minutes of RDS creation to answer. Running them before the deploy also means a stack
 * that would fail them never costs money to find out.
 *
 * Deliberately reads the raw template JSON rather than the construct tree: the defects
 * this exists to catch — a database in a public subnet, a connection string carrying a
 * password, a snapshot-on-delete policy — are all invisible at the TypeScript level and
 * only real once synthesised.
 */

import type { AssertionResult } from "./assertions.ts";

/** The shape of a synthesised template, narrowed to what these rules read. */
interface CfnResource {
  Type?: string;
  Properties?: Record<string, unknown>;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
}

export interface CfnTemplate {
  Resources?: Record<string, CfnResource>;
}

/**
 * Environment variable names whose values must never be literals.
 *
 * Substring matching on purpose: `DB_PASSWORD`, `RDS_PASSWORD` and `APP_DB_PASSWORD`
 * are all the same mistake, and an allow-list of exact names would miss whichever one
 * a generated stack invents.
 */
const SECRET_NAME_FRAGMENTS = ["PASSWORD", "SECRET", "TOKEN", "PRIVATE_KEY", "CREDENTIAL", "PASSWD"];

/** Ports the internet is allowed to reach. Everything else open to 0.0.0.0/0 is a finding. */
const PUBLIC_PORTS = new Set([80, 443]);

/** Delete-time policies that leave something behind. CDK defaults RDS to "Snapshot". */
const RESIDUE_POLICIES = new Set(["Retain", "RetainExceptOnCreate", "Snapshot"]);

/**
 * Every resource in the template, skipping entries that are not objects.
 *
 * `Resources` is typed as a map of resource objects, but nothing guarantees that of a
 * template read off disk or downloaded from S3: a `null` entry, or a `Resources` that is
 * not a map at all, both reach `r.Type` and throw. Every caller reads a property off the
 * value, so a non-object entry has nothing to contribute.
 *
 * This matters more since these assertions began running inside the pre-flight gate: the
 * engine wraps that gate and, on an exception, degrades to logging and deploys anyway —
 * so a throw in here is not a missed finding but a disabled gate, and one malformed entry
 * would retire every rule for that deploy. `preflight.ts` guards its own traversal for
 * exactly this reason.
 */
function resources(template: CfnTemplate): Array<[string, CfnResource]> {
  const declared = (template as { Resources?: unknown })?.Resources;
  if (!declared || typeof declared !== "object" || Array.isArray(declared)) return [];

  return Object.entries(declared).filter(
    (entry): entry is [string, CfnResource] => !!entry[1] && typeof entry[1] === "object" && !Array.isArray(entry[1]),
  );
}

function resourcesOfType(template: CfnTemplate, type: string): Array<[string, CfnResource]> {
  return resources(template).filter(([, r]) => r.Type === type);
}

/**
 * Read a property that is *supposed* to be a list of objects.
 *
 * A template is not guaranteed to spell one as an array: an escape hatch or a
 * `Fn::If` renders `SecurityGroupIngress: { "Fn::If": [...] }`, and a hand-written
 * template can leave a null hole in an otherwise real list. Iterating either throws,
 * and a throw here is worse than a missed finding — `runPreflightGate`'s wrapper
 * catches it, reports "could not run", and retires *every* pre-flight rule for that
 * deploy. Same reasoning as `resources()`: skip what cannot be read, keep checking
 * the rest.
 */
function objectList<T extends object>(value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is T => !!entry && typeof entry === "object" && !Array.isArray(entry));
}

/**
 * True when a value is a literal string rather than a CloudFormation intrinsic.
 *
 * `{ "Ref": ... }`, `{ "Fn::GetAtt": ... }` and friends are references resolved at
 * deploy time and are not the leak being looked for. A plain string is.
 */
function isLiteral(value: unknown): value is string {
  return typeof value === "string";
}

function looksSecret(name: string): boolean {
  const upper = name.toUpperCase();
  return SECRET_NAME_FRAGMENTS.some((fragment) => upper.includes(fragment));
}

function pass(id: string, detail: string): AssertionResult {
  return { id, passed: true, detail };
}

function fail(id: string, detail: string): AssertionResult {
  return { id, passed: false, detail };
}

/**
 * The stack held nothing this rule inspects.
 *
 * Distinct from a pass because the rule established nothing. Saying
 * "0 database instance(s), all encrypted at rest" is a claim about a database that was
 * never opened — and on an Aurora stack, which is `AWS::RDS::DBCluster` rather than
 * `AWS::RDS::DBInstance`, that sentence passed a cluster that was unencrypted and
 * publicly accessible.
 *
 * The detail names what was looked for, so a reader who knows the stack has a database
 * can see immediately that the rule is reading the wrong resource type.
 */
function notApplicable(id: string, lookedFor: string): AssertionResult {
  return { id, passed: true, applicable: false, detail: `No ${lookedFor} in this template — nothing to check` };
}

function auditDatabaseExposure(template: CfnTemplate): AssertionResult {
  const instances = resourcesOfType(template, "AWS::RDS::DBInstance");
  if (instances.length === 0) return notApplicable("SEC-DB-NOT-PUBLIC", "AWS::RDS::DBInstance");

  const exposed = instances.filter(([, r]) => r.Properties?.PubliclyAccessible === true).map(([id]) => id);

  return exposed.length === 0
    ? pass("SEC-DB-NOT-PUBLIC", `${instances.length} database instance(s), none publicly accessible`)
    : fail("SEC-DB-NOT-PUBLIC", `Publicly accessible: ${exposed.join(", ")}`);
}

function auditDatabaseEncryption(template: CfnTemplate): AssertionResult {
  const instances = resourcesOfType(template, "AWS::RDS::DBInstance");
  if (instances.length === 0) return notApplicable("SEC-DB-ENCRYPTED", "AWS::RDS::DBInstance");

  // A read replica or an instance restored from a snapshot inherits encryption from its
  // source and legitimately omits the property, so those are not flagged.
  const unencrypted = instances
    .filter(([, r]) => {
      const props = r.Properties ?? {};
      if (props.SourceDBInstanceIdentifier || props.DBSnapshotIdentifier) return false;
      return props.StorageEncrypted !== true;
    })
    .map(([id]) => id);

  return unencrypted.length === 0
    ? pass("SEC-DB-ENCRYPTED", `${instances.length} database instance(s), all encrypted at rest`)
    : fail("SEC-DB-ENCRYPTED", `Storage encryption not enabled: ${unencrypted.join(", ")}`);
}

function auditTaskNetworking(template: CfnTemplate): AssertionResult {
  const services = resourcesOfType(template, "AWS::ECS::Service");
  if (services.length === 0) return notApplicable("SEC-TASK-NOT-PUBLIC", "AWS::ECS::Service");

  const publicServices = services
    .filter(([, r]) => {
      const networkConfig = r.Properties?.NetworkConfiguration as
        | { AwsvpcConfiguration?: { AssignPublicIp?: string } }
        | undefined;
      return networkConfig?.AwsvpcConfiguration?.AssignPublicIp === "ENABLED";
    })
    .map(([id]) => id);

  return publicServices.length === 0
    ? pass("SEC-TASK-NOT-PUBLIC", `${services.length} service(s), none assigning public IPs`)
    : fail("SEC-TASK-NOT-PUBLIC", `AssignPublicIp ENABLED: ${publicServices.join(", ")}`);
}

function auditContainerSecrets(template: CfnTemplate): AssertionResult {
  const findings: string[] = [];
  const taskDefinitions = resourcesOfType(template, "AWS::ECS::TaskDefinition");
  if (taskDefinitions.length === 0) return notApplicable("SEC-NO-PLAINTEXT-SECRET", "AWS::ECS::TaskDefinition");

  for (const [logicalId, resource] of taskDefinitions) {
    const containers = objectList<{
      Name?: string;
      Environment?: unknown;
    }>(resource.Properties?.ContainerDefinitions);

    for (const container of containers) {
      for (const entry of objectList<{ Name?: string; Value?: unknown }>(container.Environment)) {
        if (!entry.Name || !looksSecret(entry.Name)) continue;
        if (!isLiteral(entry.Value)) continue;

        // An empty value is not a leaked secret. CDK emits one whenever a container
        // declares the variable and supplies the real value through `secrets`: the
        // Sentry catalogue stack writes `SENTRY_SECRET_KEY: ""` next to an
        // `ecs.Secret.fromSecretsManager` for the same name, and the synthesised
        // container definition carries both. Reading the placeholder as the secret
        // failed four task definitions in a stack that handles the secret correctly.
        //
        // Deliberately not extended to "the name also appears in `Secrets`". A
        // *non-empty* literal alongside a secret of the same name is ambiguous about
        // which one the container gets, and the whole point of this rule is to be told
        // about that rather than to reason past it.
        if (entry.Value.trim() === "") continue;

        // The name is reported, never the value — this runs in CI logs.
        findings.push(`${logicalId}/${container.Name ?? "container"}:${entry.Name}`);
      }
    }
  }

  return findings.length === 0
    ? pass("SEC-NO-PLAINTEXT-SECRET", "No secret-named container variable carries a literal value")
    : fail("SEC-NO-PLAINTEXT-SECRET", `Literal value in: ${findings.join(", ")}`);
}

function auditIngress(template: CfnTemplate): AssertionResult {
  const findings: string[] = [];
  const standalone = resourcesOfType(template, "AWS::EC2::SecurityGroupIngress");
  const groups = resourcesOfType(template, "AWS::EC2::SecurityGroup");
  if (standalone.length === 0 && groups.length === 0) {
    return notApplicable("SEC-NO-WIDE-INGRESS", "security group");
  }

  const consider = (logicalId: string, rule: Record<string, unknown>) => {
    const openToWorld = rule.CidrIp === "0.0.0.0/0" || rule.CidrIpv6 === "::/0";
    if (!openToWorld) return;

    const from = rule.FromPort;
    const to = rule.ToPort;
    // A rule with no ports is "all traffic" — worse than a wide single port, not better.
    if (typeof from !== "number" || typeof to !== "number") {
      findings.push(`${logicalId}: all ports`);
      return;
    }
    if (from === to && PUBLIC_PORTS.has(from)) return;
    findings.push(`${logicalId}: ${from}-${to}`);
  };

  for (const [logicalId, resource] of standalone) {
    consider(logicalId, resource.Properties ?? {});
  }

  // Inline rules on the group itself, which is how CDK renders `allowFrom` at
  // construction time rather than as a separate resource.
  for (const [logicalId, resource] of groups) {
    const inline = objectList<Record<string, unknown>>(resource.Properties?.SecurityGroupIngress);
    for (const rule of inline) consider(logicalId, rule);
  }

  return findings.length === 0
    ? pass("SEC-NO-WIDE-INGRESS", "No world-open ingress outside ports 80 and 443")
    : fail("SEC-NO-WIDE-INGRESS", `World-open ingress: ${findings.join(", ")}`);
}

function auditRetention(template: CfnTemplate): AssertionResult {
  const retained: string[] = [];

  for (const [logicalId, resource] of resources(template)) {
    for (const policy of [resource.DeletionPolicy, resource.UpdateReplacePolicy]) {
      if (policy && RESIDUE_POLICIES.has(policy)) {
        retained.push(`${logicalId} (${resource.Type ?? "unknown"}: ${policy})`);
        break;
      }
    }
  }

  return retained.length === 0
    ? pass("TEARDOWN-NO-RETAINED-DATA", "Nothing retains or snapshots on delete")
    : fail("TEARDOWN-NO-RETAINED-DATA", `Survives teardown: ${retained.join(", ")}`);
}

/**
 * Run every template-level assertion.
 *
 * Returns one result per assertion, always — a check that found nothing to look at
 * reports a pass with that stated, rather than being omitted. `buildReport` treats an
 * omitted assertion as not run, and not run is not a pass.
 */
export function auditTemplate(template: CfnTemplate): AssertionResult[] {
  return [
    auditDatabaseExposure(template),
    auditDatabaseEncryption(template),
    auditTaskNetworking(template),
    auditContainerSecrets(template),
    auditIngress(template),
    auditRetention(template),
  ];
}
