/**
 * The static pre-flight gate (SF-441).
 *
 * The cheap filter in front of the expensive one. A real deploy takes 10-25 minutes
 * and spends money; everything here is answerable from the synthesised template in
 * milliseconds. Once the generation agent is producing candidates in volume, most
 * rejects should never reach AWS at all.
 *
 * ## Why this does not lean on cdk-nag
 *
 * cdk-nag runs as an Aspect inside the synth it is checking, and anything it reports
 * can be silenced from inside that same app with `NagSuppressions`. For hand-written
 * stacks that is a reasonable trade. For stacks an agent authors it is not: the thing
 * being judged would be able to edit its own verdict, and a self-repair loop optimising
 * for a green gate will find that affordance quickly.
 *
 * So the load-bearing checks are here, reading the emitted template out-of-band, where
 * nothing in the candidate stack can reach them. cdk-nag is still worth running as an
 * advisory pass alongside this — it knows far more rules than this module ever will —
 * but it cannot be what decides whether a stack ships.
 *
 * ## Why the IAM rules are shaped the way they are
 *
 * A gate that produces false rejections gets suppressed or switched off, so the hard
 * failures are confined to shapes that are unambiguous: full administrative access, and
 * privilege escalation. Breadth that AWS itself forces on you — most List and Describe
 * calls simply have no resource to scope to — is recorded as advisory rather than
 * failed. That split is the "agreed threshold" the ticket asks for.
 *
 * ## What these rules deliberately do not read
 *
 * **`Condition` blocks are ignored when judging permissions.** A statement granting
 * `iam:*` on `"*"` still fails even where `aws:PrincipalOrgID` narrows it to the
 * organisation. That makes the gate stricter than the policy really is, which is the
 * safe direction for a veto but is a false-rejection source — so if a legitimate stack
 * is ever refused over a properly conditioned statement, this is the reason, and the
 * fix is to teach the rule about the specific condition key rather than to suppress it.
 *
 * `PREFLIGHT-NO-PUBLIC-TRUST` is the one place a `Condition` changes the output, and
 * only the wording: there, ignoring conditions would make the gate *looser* rather than
 * stricter, so the finding stands and says whether one was present.
 *
 * **Deploy-time parameter overrides are not modelled.** Parameter defaults are resolved,
 * because the template states them; a value supplied at deploy time is not knowable here.
 */

import {
  type AssertionResult,
  type AssertionSeverity,
  buildReport,
  getAssertion,
  type VerificationReport,
} from "./assertions.ts";
import { auditTemplate, type CfnTemplate } from "./template-audit.ts";

/** Output name the functional assertions read to know what to probe. */
const APP_URL_OUTPUT = "AppUrl";

/**
 * Managed policies that confer account-wide power.
 *
 * Matched on the policy name at the end of the ARN, so it holds for both
 * `arn:aws:iam::aws:policy/AdministratorAccess` and any partition.
 */
const ADMIN_MANAGED_POLICIES = new Set([
  "AdministratorAccess",
  "PowerUserAccess",
  "IAMFullAccess",
  // Control of the organisation is control of every account in it, including the ability
  // to grant itself anything in any of them.
  "AWSOrganizationsFullAccess",
  // A job-function policy, so the ARN reads `job-function/SystemAdministrator` — the
  // name is still the last path segment, which is what this matches on.
  "SystemAdministrator",
]);

/**
 * Resource types that can carry a managed policy or an inline one.
 *
 * Roles are what a Fargate stack normally creates, and checking only those was the
 * original shape of this rule. A generated stack that wants static credentials — an
 * application uploading to S3 with an access key rather than a task role — creates an
 * `AWS::IAM::User` instead, and an admin policy attached there is the same defect with
 * a worse blast radius, because the credentials outlive the task.
 */
const POLICY_HOLDERS = new Set(["AWS::IAM::Role", "AWS::IAM::User", "AWS::IAM::Group"]);

/**
 * Resource types whose `PolicyDocument` property is a policy in its own right.
 *
 * `AWS::IAM::Policy` and `AWS::IAM::ManagedPolicy` are what CDK's L2 constructs emit, and
 * for a while that was the whole list. The `RolePolicy` / `UserPolicy` / `GroupPolicy`
 * trio are equally real CloudFormation — `aws-cdk-lib` ships `CfnRolePolicy` and friends
 * — and carry exactly the same `PolicyDocument`. Nothing that reaches this gate is
 * guaranteed to have come from an L2 construct: raw CloudFormation arrives through
 * `CfnInclude`, and a generated stack writes whatever it writes.
 */
const INLINE_POLICY_RESOURCES = new Set([
  "AWS::IAM::Policy",
  "AWS::IAM::ManagedPolicy",
  "AWS::IAM::RolePolicy",
  "AWS::IAM::UserPolicy",
  "AWS::IAM::GroupPolicy",
]);

/**
 * Services where `Resource: "*"` is a privilege-escalation primitive rather than a
 * convenience: it lets a compromised task mint, assume, or read further access.
 *
 * `ssm` sits here for the same reason `secretsmanager` does. This platform's own
 * convention is that secrets travel as SSM parameter paths rather than as literal
 * values, so SecureString parameters hold exactly the material Secrets Manager holds,
 * and unscoped read access to them is the same defect under a different service name.
 * Listing one without the other made the rule easy to satisfy and no safer.
 *
 * `lambda` is deliberately absent. `lambda:CreateFunction` with a `PassRole` is a real
 * escalation chain, but `iam:PassRole` on an unscoped resource is already blocking here,
 * which breaks the chain at the link that matters — and `lambda:InvokeFunction` over
 * `"*"` is ordinary enough in an application stack that listing the service would cost
 * false rejections without closing anything the `iam` entry leaves open.
 */
const ESCALATION_SERVICES = new Set(["iam", "sts", "kms", "organizations", "secretsmanager", "ssm"]);

interface PolicyStatement {
  Effect?: string;
  Action?: string | string[];
  NotAction?: string | string[];
  Resource?: unknown;
  NotResource?: unknown;
  /** Trust policies only: who may assume the role. */
  Principal?: unknown;
  NotPrincipal?: unknown;
  Condition?: unknown;
}

interface PolicyDocument {
  Statement?: PolicyStatement | PolicyStatement[];
}

/** Where a finding came from, so a failure names something a person can open. */
interface Finding {
  logicalId: string;
  detail: string;
}

/**
 * Expand a value that may be an `Fn::If` into the branches it can render as.
 *
 * A condition is not resolvable from the template alone, so both branches have to be
 * graded: a stack that attaches AdministratorAccess in the branch we did not look at
 * has still shipped AdministratorAccess. Anything else is returned unchanged.
 */
function intrinsicBranches(value: unknown): unknown[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const branches = (value as { "Fn::If"?: [string, unknown, unknown] })["Fn::If"];
    if (branches) return [branches[1], branches[2]].flatMap(intrinsicBranches);
  }
  return [value];
}

/**
 * Read a template property that should be a list.
 *
 * `ManagedPolicyArns` and `Policies` are lists in the schema, but a template that went
 * through `addPropertyOverride`, or raw CloudFormation pulled in with `CfnInclude`, can
 * carry an intrinsic in that slot instead. Casting straight to an array and iterating
 * throws `TypeError: object is not iterable`, and an exception thrown inside the gate is
 * a worse outcome than any finding it could have reported — so the intrinsic is expanded
 * and anything still not a list contributes nothing.
 */
function listProperty(value: unknown): unknown[] {
  return intrinsicBranches(value).flatMap((branch) => (Array.isArray(branch) ? branch : []));
}

/**
 * Every resource in the template, skipping entries that are not objects.
 *
 * `Resources` is typed as a map of resource objects, but nothing guarantees that of a
 * template read off disk or downloaded from S3: a `null` entry, or a `Resources` that is
 * not a map at all, both reach `resource.Type` and throw. Every caller here reads a
 * property off the value, so a non-object entry has nothing to contribute — and dropping
 * it is strictly better than the alternative, where one malformed entry throws and the
 * engine's catch degrades the whole gate to logging.
 */
function resources(template: CfnTemplate): Array<[string, { Type?: string; Properties?: Record<string, unknown> }]> {
  const declared = (template as { Resources?: unknown })?.Resources;
  if (!declared || typeof declared !== "object" || Array.isArray(declared)) return [];

  return Object.entries(declared).filter(
    (entry): entry is [string, { Type?: string; Properties?: Record<string, unknown> }] =>
      !!entry[1] && typeof entry[1] === "object" && !Array.isArray(entry[1]),
  );
}

/**
 * Collect every inline policy document in the template, with the logical id of the
 * resource carrying it.
 *
 * Covers every standalone policy resource (`INLINE_POLICY_RESOURCES`) and inline
 * `Policies` on a role, user or group. Missing any of these would leave a hole exactly
 * where someone is most likely to hide breadth.
 */
function policyDocuments(template: CfnTemplate): Array<[string, PolicyDocument]> {
  const documents: Array<[string, PolicyDocument]> = [];

  for (const [logicalId, resource] of resources(template)) {
    const props = resource.Properties ?? {};

    if (INLINE_POLICY_RESOURCES.has(resource.Type ?? "")) {
      if (props.PolicyDocument) documents.push([logicalId, props.PolicyDocument as PolicyDocument]);
    }

    if (POLICY_HOLDERS.has(resource.Type ?? "")) {
      // `listProperty` expands an intrinsic standing in for the whole list; each element
      // is expanded too, because `Fn::If` is how a template makes a single inline policy
      // conditional — the other branch being `{"Ref": "AWS::NoValue"}`, which drops out
      // here for having no PolicyDocument.
      for (const entry of listProperty(props.Policies).flatMap(intrinsicBranches)) {
        const inline = entry as { PolicyName?: string; PolicyDocument?: PolicyDocument };
        if (inline && typeof inline === "object" && inline.PolicyDocument) {
          documents.push([`${logicalId}/${inline.PolicyName ?? "inline"}`, inline.PolicyDocument]);
        }
      }
    }
  }

  return documents;
}

/**
 * Does this statement grant, rather than deny?
 *
 * `Effect` is compared case-insensitively, and an `Effect` that is not a literal string
 * is treated as a grant. That second part is the important one: a condition is not
 * resolvable from the template, so `{"Fn::If": ["C", "Allow", "Deny"]}` is a statement
 * that allows under some condition, and the gate cannot prove otherwise. Reading it as
 * a plain object — which is what a `===` against "Allow" does — drops the statement
 * from the traversal entirely, so an `Action: "*"` beneath it is never seen. Erring
 * towards Allow can only over-report, and over-reporting here surfaces as a finding a
 * person reads rather than as a deploy that shipped.
 */
function grantsAccess(statement: PolicyStatement): boolean {
  return intrinsicBranches(statement.Effect).some((effect) =>
    typeof effect === "string" ? effect.toLowerCase() === "allow" : true,
  );
}

/**
 * Every granting statement a policy document can render as.
 *
 * Each of the four levels here is a place a template can put an `Fn::If`, and each one
 * used to end the traversal silently: the document itself, the `Statement` list, a
 * single statement inside that list, and the `Effect` that decides whether it counts.
 * Wrapping a non-list `Statement` in an array — which is what the old traversal did —
 * yields one pseudo-statement with no `Action` and no `Effect`, read as an empty Allow
 * that contributes nothing: a clean pass for a policy granting `"*"` on `"*"`.
 *
 * This is the same treatment `checkAdminManagedPolicies` already applied to
 * `ManagedPolicyArns`; it simply never reached the rules that do most of the work.
 */
function allowStatements(document: unknown): PolicyStatement[] {
  return intrinsicBranches(document)
    .flatMap((doc) => intrinsicBranches((doc as PolicyDocument | undefined)?.Statement))
    .flatMap((statements) => (Array.isArray(statements) ? statements : [statements]))
    .flatMap((statement) => intrinsicBranches(statement))
    .filter(
      (statement): statement is PolicyStatement =>
        !!statement && typeof statement === "object" && !Array.isArray(statement),
    )
    .filter(grantsAccess);
}

/**
 * Every literal string an `Action` or `Resource` slot can render as.
 *
 * Both slots are `string | string[]` in the schema and neither is reliably either one in
 * a real template: `{"Fn::If": ["C", "*", "s3:GetObject"]}` and `{"Fn::Join": ["", ["*"]]}`
 * are both legal, and both used to be discarded — the first as an object that is not a
 * list, the second by a `typeof value === "string"` filter. Discarding them is not a
 * missed detail but a switched-off rule: an `Action` nothing can read grants nothing as
 * far as the gate is concerned.
 *
 * Values that render to no literal text — a `Ref` to a parameter, a `GetAtt` — drop out
 * rather than becoming an empty string, so they neither match `"*"` nor count as a
 * scoped resource that would make a statement look narrower than it is.
 */
function literalList(value: unknown): string[] {
  return intrinsicBranches(value)
    .flatMap((branch) => (Array.isArray(branch) ? branch : [branch]))
    .flatMap((entry) => intrinsicBranches(entry))
    .map((entry) => (typeof entry === "string" ? entry : literalFragments(entry)))
    .filter((rendered) => rendered.length > 0);
}

/**
 * Does this resource cover every resource of its kind?
 *
 * `"*"` is the obvious case. The one that matters more is the ARN that means the same
 * thing: `arn:aws:iam::123456789012:role/*` is every role in the account, and for
 * `iam:PassRole` that is the escalation this gate exists to catch. Requiring a literal
 * star let the rule be evaded by writing the ARN out, which is also the more natural way
 * to write it — so most of the misses here would have been accidental rather than
 * deliberate, and no less exploitable for it.
 *
 * The line is drawn at whether anything narrows the star. A star sitting directly under
 * the resource type covers every resource of that type; a star with a prefix or a path
 * in front of it does not, and both halves of that distinction are load-bearing:
 *
 *   arn:aws:iam::123:role/*                        every role            → unscoped
 *   arn:aws:secretsmanager:eu-west-1:123:secret:*  every secret          → unscoped
 *   arn:aws:ssm:eu-west-1:123:parameter/*          every parameter       → unscoped
 *   arn:aws:iam::123:role/my-app-*                 one app's roles       → scoped
 *   arn:aws:secretsmanager:eu-west-1:123:secret:db-AbCdEf  one secret    → scoped
 *   arn:aws:ssm:eu-west-1:123:parameter/sentry/*   one app's parameters  → scoped
 *
 * The last three are why this is not a looser pattern, and each was found by a stack we
 * already ship rather than imagined. Secrets Manager appends a random six-character
 * suffix to every secret ARN, so `secret:db-*` is the ordinary, correct way to name one
 * secret. SSM parameters are a hierarchy, so `parameter/<app>/*` is how an application
 * is granted its own subtree and nothing else — the catalogue's own Sentry stack does
 * exactly that, and an earlier version of this rule failed it.
 */
function grantsEveryResourceOfItsType(resource: string): boolean {
  if (resource === "*") return true;
  if (!resource.startsWith("arn:")) return false;

  // arn:partition:service:region:account:resource — the resource portion may itself
  // contain colons (`secret:name`), so it is everything past the fifth.
  const resourcePart = resource.split(":").slice(5).join(":");
  if (resourcePart === "") return false;

  // Segments are split on both separators because AWS uses them interchangeably to
  // divide type from name: `role/name`, `secret:name`, `parameter/path/name`.
  const segments = resourcePart.split(/[/:]/);

  // Unscoped means the star is the whole resource portion (`*`) or stands alone directly
  // beneath the type (`role/*`). A third segment means something narrowed it.
  return segments[segments.length - 1] === "*" && segments.length <= 2;
}

/** Service prefix of an action, e.g. `iam` from `iam:PassRole`. */
function serviceOf(action: string): string {
  return action.split(":")[0]?.toLowerCase() ?? "";
}

function pass(id: string, detail: string): AssertionResult {
  return { id, passed: true, detail };
}

function fail(id: string, findings: Finding[]): AssertionResult {
  const shown = findings.slice(0, 8).map((f) => `${f.logicalId} (${f.detail})`);
  const remainder = findings.length - shown.length;
  return {
    id,
    passed: false,
    detail: remainder > 0 ? `${shown.join("; ")} and ${remainder} more` : shown.join("; "),
  };
}

function checkTemplateProduced(template: CfnTemplate): AssertionResult {
  const count = resources(template).length;
  return count > 0
    ? pass("PREFLIGHT-TEMPLATE", `${count} resource(s) synthesised`)
    : { id: "PREFLIGHT-TEMPLATE", passed: false, detail: "Template contains no resources" };
}

function checkAppUrl(template: CfnTemplate): AssertionResult {
  const outputs = (template as { Outputs?: Record<string, unknown> }).Outputs ?? {};
  const names = Object.keys(outputs);

  if (Object.hasOwn(outputs, APP_URL_OUTPUT)) {
    return pass("PREFLIGHT-APPURL", `${APP_URL_OUTPUT} output present`);
  }

  // Name what was exported. The usual cause is a stack calling it ServiceUrl or
  // LoadBalancerDns, and saying so turns a rejection into a one-line fix.
  return {
    id: "PREFLIGHT-APPURL",
    passed: false,
    detail: `No "${APP_URL_OUTPUT}" output. Exported: ${names.length > 0 ? names.join(", ") : "(nothing)"}`,
  };
}

/**
 * Best-effort literal rendering of a value that may be a CloudFormation intrinsic.
 *
 * Managed policy ARNs are almost never plain strings in a synthesised template:
 * `ManagedPolicy.fromAwsManagedPolicyName` emits
 * `{"Fn::Join": ["", ["arn:", {"Ref": "AWS::Partition"}, ":iam::aws:policy/AdministratorAccess"]]}`.
 * Reading only `typeof value === "string"` therefore misses the single most common
 * way an administrative policy is attached — which is how the first version of this
 * check passed a stack that grants AdministratorAccess.
 *
 * `Fn::Sub` is the other shape that carries a literal name, and it is the one a stack
 * reaches for when it writes the ARN out by hand:
 * `{"Fn::Sub": "arn:${AWS::Partition}:iam::aws:policy/AdministratorAccess"}`. Its
 * substitution variables are not resolvable here, so they drop out and the surrounding
 * literal text — which is where the policy name lives — is kept.
 *
 * Unresolvable parts (a `Ref` to a pseudo-parameter, a `GetAtt`) contribute nothing,
 * which is fine: the policy name lives in the literal tail either way.
 */
function literalFragments(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(literalFragments).join("");
  if (value && typeof value === "object") {
    // `Fn::Join`'s arguments are only *conventionally* `[string, unknown[]]`. The second
    // one is legally any function returning a list — `{"Ref": "SomeListParameter"}`,
    // `Fn::Split`, `Fn::GetAZs` — and the whole intrinsic can be malformed in a template
    // that still reaches us. Destructuring a non-iterable, or calling `.map` on an
    // object, throws; and a throw here is not a missed finding but a disabled gate,
    // because the engine's catch degrades to logging. Anything not statically a list
    // contributes no literal text, which is the same answer as for any other
    // unresolvable intrinsic.
    const join = (value as { "Fn::Join"?: unknown })["Fn::Join"];
    if (join !== undefined) {
      const [delimiter, parts] = Array.isArray(join) ? join : [];
      return (Array.isArray(parts) ? parts : [])
        .map(literalFragments)
        .join(typeof delimiter === "string" ? delimiter : "");
    }

    // `Fn::Sub` is either a template string or [template, variables]; only the template
    // carries literal text. `${...}` resolves at deploy time, so it contributes nothing.
    const sub = (value as { "Fn::Sub"?: unknown })["Fn::Sub"];
    if (sub !== undefined) {
      const body = Array.isArray(sub) ? sub[0] : sub;
      return typeof body === "string" ? body.replace(/\$\{[^}]*\}/g, "") : "";
    }

    // Any other intrinsic resolves at deploy time and carries no literal name.
    return "";
  }
  return "";
}

function checkAdminManagedPolicies(template: CfnTemplate): AssertionResult {
  const findings: Finding[] = [];

  for (const [logicalId, resource] of resources(template)) {
    if (!POLICY_HOLDERS.has(resource.Type ?? "")) continue;

    for (const arn of listProperty(resource.Properties?.ManagedPolicyArns)) {
      // Both branches of a conditional ARN are graded: a policy attached only when a
      // condition holds is still a policy this stack can attach.
      for (const branch of intrinsicBranches(arn)) {
        const rendered = literalFragments(branch);
        const name = rendered.split("/").pop() ?? "";
        if (ADMIN_MANAGED_POLICIES.has(name)) {
          findings.push({ logicalId, detail: name });
        }
      }
    }
  }

  return findings.length === 0
    ? pass("PREFLIGHT-NO-ADMIN-POLICY", "No account-wide administrative managed policy attached")
    : fail("PREFLIGHT-NO-ADMIN-POLICY", findings);
}

/**
 * Walk every allow statement once, classifying the breadth it grants.
 *
 * Returns the three IAM assertions together because they share a traversal and, more
 * importantly, share a definition of what counts as broad — splitting them into
 * separate passes is how two rules end up disagreeing.
 */
function checkIamBreadth(template: CfnTemplate): AssertionResult[] {
  const wildcardActions: Finding[] = [];
  const escalationWildcards: Finding[] = [];
  const broadResources: Finding[] = [];

  for (const [logicalId, document] of policyDocuments(template)) {
    for (const statement of allowStatements(document)) {
      const actions = literalList(statement.Action);

      // NotAction with Allow grants everything except the listed actions — broader
      // than any Action list, and easy to miss if you only look at Action.
      if (statement.NotAction !== undefined) {
        wildcardActions.push({ logicalId, detail: "NotAction with Effect Allow" });
      }

      const resourceList = literalList(statement.Resource);

      // `NotResource` with Allow is the resource-side mirror of `NotAction`: it grants
      // every resource except the ones listed, so a statement can hold `iam:PassRole`
      // over effectively every role while `Resource` is absent entirely. Reading only
      // `Resource` leaves the escalation rule evadable by a one-word substitution, which
      // matters here precisely because the stacks being graded may be optimising for a
      // green gate.
      const exemptsResources = statement.NotResource !== undefined;

      // Two thresholds, because the two rules are answering different questions.
      //
      // The advisory rule asks whether a stack could have scoped something and did not,
      // and a literal `"*"` is the shape that asks for review. Widening it to every
      // wildcard ARN would bury the signal under prefix-scoped ARNs that are already
      // about as narrow as they can be.
      //
      // The escalation rule asks whether a compromised task could mint further access,
      // and there `arn:aws:iam::123456789012:role/*` is `"*"` by another spelling — it
      // is every role in the account, and it is the more natural way to write it than
      // the bare star this rule used to require.
      const grantsLiteralStar = resourceList.some((r) => r === "*") || exemptsResources;
      const unscoped = resourceList.find(grantsEveryResourceOfItsType);
      const grantsEveryResource = unscoped !== undefined || exemptsResources;
      const notResourceScope = "every resource but a NotResource list";

      for (const action of actions) {
        if (action === "*") {
          wildcardActions.push({ logicalId, detail: 'Action "*"' });
          continue;
        }

        const service = serviceOf(action);
        if (ESCALATION_SERVICES.has(service)) {
          // Name the ARN that triggered it rather than printing "*": the whole point of
          // this threshold is that the offending resource often is not a bare star, and
          // a finding a reader cannot locate is a finding they will dismiss.
          if (grantsEveryResource) {
            const scope = exemptsResources ? notResourceScope : unscoped;
            escalationWildcards.push({ logicalId, detail: `${action} on ${scope}` });
          }
        } else if (grantsLiteralStar) {
          broadResources.push({ logicalId, detail: `${action} on ${exemptsResources ? notResourceScope : "*"}` });
        }
      }
    }
  }

  return [
    wildcardActions.length === 0
      ? pass("PREFLIGHT-NO-WILDCARD-ACTION", "No statement allows every action")
      : fail("PREFLIGHT-NO-WILDCARD-ACTION", wildcardActions),
    escalationWildcards.length === 0
      ? pass("PREFLIGHT-NO-WILDCARD-RESOURCE", "No privilege-escalating action granted on every resource")
      : fail("PREFLIGHT-NO-WILDCARD-RESOURCE", escalationWildcards),
    broadResources.length === 0
      ? pass("PREFLIGHT-SCOPED-RESOURCES", "No unscoped resources outside the actions that require it")
      : fail("PREFLIGHT-SCOPED-RESOURCES", broadResources),
  ];
}

/** Is this object a CloudFormation intrinsic rather than a map of real keys? */
function isIntrinsic(value: object): boolean {
  const [key, ...rest] = Object.keys(value);
  return key !== undefined && rest.length === 0 && (key === "Ref" || key.startsWith("Fn::"));
}

/**
 * Every principal a trust-policy `Principal` names.
 *
 * `Principal` is the one slot in IAM that is a map rather than a list: `"*"` on its own,
 * or `{"AWS": "*"}`, or `{"Service": [...]}`, or several of those keys at once. Each
 * value is then an ordinary string-or-list that may be wrapped in an intrinsic, so the
 * map's values recurse back through here and land in `literalList` like any other slot.
 *
 * The `isIntrinsic` guard is what keeps the two cases apart: without it, the values of
 * `{"Fn::If": [...]}` would be read as if `Fn::If` were a principal type.
 */
function principalLiterals(principal: unknown): string[] {
  return intrinsicBranches(principal).flatMap((branch) => {
    if (branch && typeof branch === "object" && !Array.isArray(branch) && !isIntrinsic(branch)) {
      return Object.values(branch as Record<string, unknown>).flatMap(principalLiterals);
    }
    return literalList(branch);
  });
}

/**
 * Roles that anyone can assume.
 *
 * This is separate from `checkIamBreadth` because a trust policy is a different shape
 * with a different question. Its statements have no `Resource`, and the permission rules
 * would score a role trusting the world as narrow — correctly, in their own terms, since
 * the breadth is in who may become the role rather than in what the role may do. Reading
 * trust policies through those rules would answer the wrong question quietly.
 *
 * A `Condition` is reported rather than excused. Elsewhere this module ignores conditions
 * and that makes it stricter; here it would make it looser, and the asymmetry is not one
 * to resolve silently — `Principal: "*"` narrowed by `sts:ExternalId` is a real pattern,
 * but so is a token condition added to get past a gate. The finding says which case it
 * is, so whoever reads it can tell in one line, and the severity stays uniform.
 */
function checkTrustPolicies(template: CfnTemplate): AssertionResult {
  const findings: Finding[] = [];

  for (const [logicalId, resource] of resources(template)) {
    if (resource.Type !== "AWS::IAM::Role") continue;

    for (const statement of allowStatements(resource.Properties?.AssumeRolePolicyDocument)) {
      const conditioned = statement.Condition !== undefined ? ", narrowed by a Condition" : "";

      // `NotPrincipal` with Allow trusts everyone except those listed — the principal-side
      // mirror of `NotAction`, and the same reasoning applies.
      if (statement.NotPrincipal !== undefined) {
        findings.push({ logicalId, detail: `NotPrincipal with Effect Allow${conditioned}` });
        continue;
      }

      if (principalLiterals(statement.Principal).includes("*")) {
        findings.push({ logicalId, detail: `Principal "*"${conditioned}` });
      }
    }
  }

  return findings.length === 0
    ? pass("PREFLIGHT-NO-PUBLIC-TRUST", "No role trusts an arbitrary principal")
    : fail("PREFLIGHT-NO-PUBLIC-TRUST", findings);
}

/**
 * Parameter defaults that can be read as literal text, keyed by parameter name.
 *
 * A parameter with no `Default` resolves only at deploy time and is left alone.
 * A `List<...>` or `CommaDelimitedList` default is one string holding several values,
 * which is how `ManagedPolicyArns` would carry them, so it is split back into a list.
 */
function parameterDefaults(template: CfnTemplate): Map<string, string | string[]> {
  const declared = (template as { Parameters?: unknown })?.Parameters;
  const defaults = new Map<string, string | string[]>();
  if (!declared || typeof declared !== "object" || Array.isArray(declared)) return defaults;

  for (const [name, spec] of Object.entries(declared)) {
    if (!spec || typeof spec !== "object") continue;

    const { Default: fallback, Type: type } = spec as { Default?: unknown; Type?: unknown };
    if (typeof fallback !== "string") continue;

    const isList = typeof type === "string" && type.toLowerCase().includes("list");
    defaults.set(name, isList ? fallback.split(",").map((entry) => entry.trim()) : fallback);
  }

  return defaults;
}

/**
 * Replace `{"Ref": "SomeParameter"}` with that parameter's declared default.
 *
 * `literalFragments` treats every unresolvable intrinsic as contributing no text, which
 * is right for a `GetAtt` or a pseudo-parameter but wrong for this one case: a `Ref` to a
 * parameter whose default is written a few lines up in the same template *is* statically
 * resolvable, and reading it as nothing let an administrative ARN through under a
 * parameter name. Resolving it once here means every check sees the literal, rather than
 * each of them growing a parameter table of its own.
 *
 * A `Ref` naming a resource or a pseudo-parameter has no entry and is left untouched, so
 * `{"Ref": "AWS::Partition"}` and `{"Ref": "AWS::NoValue"}` still mean what they meant.
 *
 * This resolves what the template says it will use absent an override. A deploy-time
 * override can still substitute something else; that is not knowable from the template
 * and is not what this claims to answer.
 */
function resolveParameterRefs(value: unknown, defaults: Map<string, string | string[]>): unknown {
  if (Array.isArray(value)) return value.map((entry) => resolveParameterRefs(entry, defaults));

  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "Ref") {
      const name = (value as { Ref?: unknown }).Ref;
      if (typeof name === "string" && defaults.has(name)) return defaults.get(name);
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveParameterRefs(entry, defaults)]),
    );
  }

  return value;
}

/** Does this value reference a resource declared in this template? */
function referencesTemplateResource(value: unknown, logicalIds: ReadonlySet<string>): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const ref = (value as { Ref?: unknown }).Ref;
  if (typeof ref === "string") return logicalIds.has(ref);

  const getAtt = (value as { "Fn::GetAtt"?: unknown })["Fn::GetAtt"];
  if (Array.isArray(getAtt) && typeof getAtt[0] === "string") return logicalIds.has(getAtt[0]);
  if (typeof getAtt === "string") return logicalIds.has(getAtt.split(".")[0] ?? "");

  return false;
}

/**
 * Permissions the stack confers by naming something the template does not contain.
 *
 * Two shapes, both invisible to every other rule here because every other rule reads
 * what is written down:
 *
 * A managed policy ARN that renders to no literal text — `Fn::ImportValue`, or a `Ref`
 * to a parameter with no default — is attached to a role without the gate ever learning
 * what it grants. An ARN referring to a `ManagedPolicy` *in this template* is not opaque:
 * its document is read by `policyDocuments`, so flagging it would be noise.
 *
 * An `AWS::IAM::UserToGroupAddition` naming a group the template does not declare puts a
 * user into whatever that group already holds. `POLICY_HOLDERS` was widened to users and
 * groups on the argument that a static credential outlives the task it replaced; this is
 * that same argument one step further, where the policy is not in the template at all.
 *
 * Advisory, because both are legitimate and neither is decidable from the template. The
 * claim is that someone has to look, not that the stack is wrong.
 */
function checkOpaqueGrants(template: CfnTemplate): AssertionResult {
  const findings: Finding[] = [];
  const logicalIds = new Set(resources(template).map(([logicalId]) => logicalId));

  for (const [logicalId, resource] of resources(template)) {
    const props = resource.Properties ?? {};

    if (POLICY_HOLDERS.has(resource.Type ?? "")) {
      for (const arn of listProperty(props.ManagedPolicyArns).flatMap(intrinsicBranches)) {
        if (typeof arn === "string" || literalFragments(arn) !== "") continue;
        if (referencesTemplateResource(arn, logicalIds)) continue;

        findings.push({ logicalId, detail: "managed policy ARN not readable from the template" });
      }
    }

    if (resource.Type === "AWS::IAM::UserToGroupAddition") {
      const group = props.GroupName;
      if (!referencesTemplateResource(group, logicalIds)) {
        const named = typeof group === "string" ? `"${group}"` : "a group";
        findings.push({ logicalId, detail: `adds users to ${named}, which this template does not declare` });
      }
    }
  }

  return findings.length === 0
    ? pass("PREFLIGHT-NO-OPAQUE-GRANT", "Every grant is readable from the template")
    : fail("PREFLIGHT-NO-OPAQUE-GRANT", findings);
}

/**
 * The static security assertions from SF-443, scoped to the question this gate asks.
 *
 * `auditTemplate` has existed since SF-443, declared `blocking`, tested, and copied into
 * the engine image — and called from nothing but its own tests. `SEC-DB-NOT-PUBLIC` and
 * `SEC-NO-PLAINTEXT-SECRET` are answerable from exactly the template this gate is already
 * holding, so a reader of `assertions.ts` would reasonably conclude they were enforced
 * before a deploy. They were not.
 *
 * `TEARDOWN-NO-RETAINED-DATA` is deliberately excluded. It asks whether the verification
 * lab was left clean, which is a real question at teardown and the wrong one here: a
 * `Snapshot` on a database and `Retain` on a file store are how you avoid destroying a
 * customer's data with their stack. The catalogue's Sentry Fargate template sets both, on
 * purpose. Including the teardown category would have failed it — and the category is
 * precisely what tells the two questions apart, so this filters on that rather than on a
 * list of ids that would drift.
 */
/**
 * Assertions that must read the template as written, before parameter resolution.
 *
 * `SEC-NO-PLAINTEXT-SECRET` asks whether a secret is *hard-coded*, and answers it by
 * testing whether the value is a literal string rather than an intrinsic. Resolving
 * `{"Ref": "DbPassword"}` into that parameter's default turns the one shape the rule
 * reads as safe into the one shape it reads as a leak — so a stack that correctly takes
 * its password as a parameter fails a blocking rule and is refused a deploy, over a
 * default that a deploy-time override replaces.
 *
 * Every other security assertion is better off with defaults substituted in, which is
 * why this is a list of ids rather than a decision about the whole audit.
 */
const AUDITS_READING_THE_RAW_TEMPLATE = new Set(["SEC-NO-PLAINTEXT-SECRET"]);

function securityAudit(raw: CfnTemplate, resolved: CfnTemplate): AssertionResult[] {
  const isSecurity = (result: AssertionResult) => getAssertion(result.id).category === "security";
  const results = auditTemplate(resolved).filter(isSecurity);
  if (raw === resolved) return results;

  const fromRaw = new Map(
    auditTemplate(raw)
      .filter(isSecurity)
      .map((result) => [result.id, result]),
  );
  return results.map((result) =>
    AUDITS_READING_THE_RAW_TEMPLATE.has(result.id) ? (fromRaw.get(result.id) ?? result) : result,
  );
}

/**
 * Run the full static gate over a synthesised template.
 *
 * Returns one result per pre-flight assertion, always — a check that found nothing to
 * look at reports a pass saying so, because `buildReport` treats an omitted assertion
 * as not run, and not run is not a pass.
 */
export function runPreflightGate(raw: CfnTemplate): AssertionResult[] {
  // Resolved once, before anything reads the template, so no individual check has to
  // know that parameters exist.
  const defaults = parameterDefaults(raw);
  const template = defaults.size === 0 ? raw : (resolveParameterRefs(raw, defaults) as CfnTemplate);

  return [
    checkTemplateProduced(template),
    checkAppUrl(template),
    checkAdminManagedPolicies(template),
    checkTrustPolicies(template),
    checkOpaqueGrants(template),
    ...checkIamBreadth(template),
    ...securityAudit(raw, template),
  ];
}

/**
 * Who authored the stack being graded.
 *
 * The rules are the same everywhere; what a failure is allowed to *do* is not. The
 * rationale these assertions are written from — an over-permissive role shipped to a
 * hundred people who clicked a README button — is an argument about what we publish,
 * and it does not transfer to a customer's own CDK app.
 */
export type PreflightContext =
  /** A candidate stack in CI, before it is published to the catalogue. */
  | "publish"
  /** One of our catalogue templates, deploying into a customer's account. */
  | "template-deploy"
  /** A stack the customer wrote, or one we generated from their application. */
  | "customer-deploy";

/**
 * Assertions that encode the verification harness's contract rather than a property
 * that makes a deploy unsafe.
 */
const HARNESS_CONTRACT: ReadonlySet<string> = new Set(["PREFLIGHT-APPURL"]);

/**
 * What a failed assertion may do in a given context.
 *
 * Declared severity is the publishing severity: it is the strictest reading, and the
 * one the CI gate applies verbatim. The two deploy contexts relax it, for reasons that
 * are about blast radius rather than about the rules being wrong:
 *
 * - A catalogue template still blocks on the security rules, because that stack is ours
 *   and it is about to run in someone else's account. It does not block on the harness
 *   contract: refusing a deploy because a stack exports `ServiceURL` instead of `AppUrl`
 *   is a platform outage wearing the costume of a security control.
 * - A customer's own stack blocks on nothing. They asked us to deploy their
 *   infrastructure, not to audit it, and a stack that deployed yesterday must not start
 *   failing today because we shipped a gate. Findings are still logged, so the signal
 *   survives even where the veto does not.
 *
 * An assertion declared advisory is advisory everywhere — this can only relax.
 */
export function effectiveSeverity(id: string, context: PreflightContext): AssertionSeverity {
  if (getAssertion(id).severity === "advisory") return "advisory";

  switch (context) {
    case "publish":
      return "blocking";
    case "template-deploy":
      return HARNESS_CONTRACT.has(id) ? "advisory" : "blocking";
    case "customer-deploy":
      return "advisory";
  }
}

/** One stack out of a synthesised assembly, as the CDK toolkit reports it. */
export interface AssemblyStack {
  stackName: string;
  template: unknown;
}

/** A finding the engine should log, carrying the severity it has in this context. */
export interface PreflightFinding {
  stack: string;
  id: string;
  detail: string;
  severity: AssertionSeverity;
}

export interface PreflightVerdict {
  /** The full report per stack, for callers that want the detail. */
  grades: Array<{ stack: string; report: VerificationReport }>;
  /** Everything worth logging: failures and checks that never ran. */
  findings: PreflightFinding[];
  /** The subset that may refuse the deploy in this context. */
  blockers: PreflightFinding[];
  /** Total assertions reported on, across every stack. */
  checks: number;
  /**
   * How many of those found nothing to inspect.
   *
   * Logged rather than folded into the pass count, because "18 checks passed" over a
   * stack where six of them had no resource of their type to read overstates what was
   * established. A number that looks wrong against the stack is the cheapest signal that
   * a rule is reading the wrong resource type.
   */
  notApplicable: number;
  /**
   * True when the assembly held no stacks at all.
   *
   * Surfaced rather than folded into a pass: every path that grades an assembly has
   * just synthesised one, so an empty assembly means the gate lost its input — and a
   * gate that grades nothing looks exactly like a gate that passed.
   */
  gradedNothing: boolean;
}

/**
 * Grade a synthesised assembly, in the context of whoever wrote it.
 *
 * Lives here rather than in the engine for two reasons. The engine entrypoint runs
 * `main()` on import, so nothing in it can be unit-tested; and grading is parsing
 * hostile input, which is the code most in need of tests. The engine keeps only what is
 * genuinely its own: turning these findings into log lines, and deciding to throw.
 *
 * Checks that never ran are reported alongside checks that failed. `buildReport` exists
 * to make that distinction survive — an assertion nothing reported on is indistinguish-
 * able from one that passed, so it must not be counted as one.
 */
export function gradeAssembly(stacks: readonly AssemblyStack[], context: PreflightContext): PreflightVerdict {
  const grades = stacks.map((stack) => ({
    stack: stack.stackName,
    // Scoped to pre-flight so the deploy-time and teardown assertions, which have
    // nothing to probe at synthesis, are not counted as missing.
    report: buildReport(runPreflightGate(stack.template as CfnTemplate), { categories: ["preflight", "security"] }),
  }));

  const findings: PreflightFinding[] = grades.flatMap(({ stack, report }) => [
    ...report.results
      .filter((result) => !result.passed)
      .map((result) => ({
        stack,
        id: result.id,
        detail: result.detail,
        severity: effectiveSeverity(result.id, context),
      })),
    ...report.notRun.map((id) => ({
      stack,
      id,
      detail: "did not run, and an unrun check is not a pass",
      severity: effectiveSeverity(id, context),
    })),
  ]);

  return {
    grades,
    findings,
    blockers: findings.filter((finding) => finding.severity === "blocking"),
    checks: grades.reduce((total, { report }) => total + report.results.length, 0),
    notApplicable: grades.reduce((total, { report }) => total + report.notApplicable.length, 0),
    gradedNothing: grades.length === 0,
  };
}
