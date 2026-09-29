/**
 * What a verification run must check (SF-443).
 *
 * The epic's decision 2 says verification means a real functional check — deploy,
 * answer on HTTP, destroy cleanly — not `CREATE_COMPLETE`. A stack that reaches
 * CREATE_COMPLETE and then 502s is worse than one that fails outright: it gets a
 * button merged into someone's README.
 *
 * The first verification runs were done by hand, and the list of things checked lived
 * in a person's head and in a calendar entry. It lives here instead, as data, so that
 * the checklist and the thing that runs cannot drift: every assertion the harness can
 * report is declared below, and a result carrying an id that is not in this table is a
 * programming error rather than a silently unreported check.
 *
 * Severity is about what a failure means for publishing, not how alarming it reads.
 * `blocking` failures must stop a stack from ever reaching a README button. `advisory`
 * failures are recorded and surfaced, and are the ones a human decides about.
 */

export type AssertionCategory = "preflight" | "functional" | "security" | "teardown";

export type AssertionSeverity = "blocking" | "advisory";

export interface AssertionSpec {
  /** Stable identifier. Referenced by results, reports and tickets — do not renumber. */
  id: string;
  category: AssertionCategory;
  severity: AssertionSeverity;
  /** One line, phrased as the property that must hold. */
  title: string;
  /** Why this is checked. Written for whoever reads a failure six months from now. */
  rationale: string;
}

export const VERIFICATION_ASSERTIONS: readonly AssertionSpec[] = [
  // ---- Pre-flight ---------------------------------------------------------
  // The cheap filter in front of the expensive one (SF-441). Everything here is
  // answerable from the synthesised template, before a deploy that takes 10-25
  // minutes and spends money. Once the generation agent is producing candidates in
  // volume, most rejects should never touch AWS at all.
  {
    id: "PREFLIGHT-TEMPLATE",
    category: "preflight",
    severity: "blocking",
    title: "Synthesis produced a template with at least one resource",
    rationale:
      "A stack that does not synthesise, or synthesises to nothing, cannot be deployed or verified. " +
      "Catching it here costs nothing and makes every later assertion meaningful.",
  },
  {
    id: "PREFLIGHT-APPURL",
    category: "preflight",
    severity: "blocking",
    title: "The stack exports an AppUrl output",
    rationale:
      "The functional assertions read AppUrl to know what to probe. Without it a stack cannot be " +
      "verified at all, so it fails here rather than after a deploy that was paid for.",
  },
  {
    id: "PREFLIGHT-NO-ADMIN-POLICY",
    category: "preflight",
    severity: "blocking",
    title: "No role, user or group attaches an account-wide administrative managed policy",
    rationale:
      "A stack granting its task role AdministratorAccess synthesises, deploys, answers on HTTP and " +
      "destroys cleanly — it passes every other gate. These stacks are generated and deployed into " +
      "customers' accounts, so an over-permissive role shipped to a hundred users is far worse than " +
      "one in our lab. Users and groups are read too: a stack wanting static credentials creates one " +
      "instead of a role, and the credential outlives the task that would have held the role.",
  },
  {
    id: "PREFLIGHT-NO-WILDCARD-ACTION",
    category: "preflight",
    severity: "blocking",
    title: "No IAM policy statement allows every action",
    rationale:
      'Action "*" is administrative access however the resource is scoped, and it is never something ' +
      "a generated application stack legitimately needs.",
  },
  {
    id: "PREFLIGHT-NO-WILDCARD-RESOURCE",
    category: "preflight",
    severity: "blocking",
    title: "No sensitive action is granted on every resource",
    rationale:
      "Unscoped access to iam, sts, kms, organizations, secretsmanager or ssm is the privilege-" +
      "escalation shape: it lets a compromised task mint or assume further access. Unscoped means " +
      'Resource "*" or an ARN that spells the same thing, such as iam role/* — requiring a literal ' +
      "star let the rule be evaded by writing the ARN out. Scoped to those services deliberately, " +
      "because a blanket ban would fail valid stacks and get suppressed.",
  },
  {
    id: "PREFLIGHT-NO-PUBLIC-TRUST",
    category: "preflight",
    severity: "blocking",
    title: "No role can be assumed by an arbitrary principal",
    rationale:
      'A trust policy naming Principal "*" — or {"AWS": "*"} — lets any AWS account on earth assume ' +
      "the role and inherit everything it can do. It is the one IAM defect that does not need a " +
      "compromise first: the role is reachable from outside the account the day it is created. The " +
      "permission rules read what a role may do and would score such a role as narrow, because the " +
      "breadth is in who may become it, not in what it holds.",
  },
  {
    id: "PREFLIGHT-NO-OPAQUE-GRANT",
    category: "preflight",
    severity: "advisory",
    title: "Every permission the stack grants can be read from the template",
    rationale:
      "A stack can confer access by naming something the template does not contain: a managed policy " +
      "arriving through Fn::ImportValue, or a user added to a pre-existing account group, which grants " +
      "whatever that group holds without a policy appearing anywhere. The other rules read what is " +
      "written down, so these are invisible to them — a stack could hold AdministratorAccess through a " +
      "group named in one line. Advisory rather than blocking because both are legitimate patterns and " +
      "neither is decidable from the template: this says a human has to look, not that it is wrong.",
  },
  {
    id: "PREFLIGHT-SCOPED-RESOURCES",
    category: "preflight",
    severity: "advisory",
    title: "Actions that could be resource-scoped are",
    rationale:
      'Many List and Describe calls require Resource "*" and AWS offers no alternative, so this ' +
      "cannot be a hard failure without producing false rejections — which is how a gate gets " +
      "switched off. Recorded for review instead.",
  },

  // ---- Functional ---------------------------------------------------------
  {
    id: "FUNC-LIVENESS",
    category: "functional",
    severity: "blocking",
    title: "The service answers 200 on its liveness path, serving the content it promised",
    rationale:
      "CREATE_COMPLETE only says CloudFormation finished, and a 200 only says something is " +
      "listening. A default nginx page returns 200; so does an install wizard. The stack's " +
      "declared content marker must appear in the body, and a failure distinguishes a service " +
      "that never came up from one that came up wrong — those need different people to look.",
  },
  {
    id: "FUNC-READINESS",
    category: "functional",
    severity: "blocking",
    title: "The service answers 200 on its readiness path",
    rationale:
      "Readiness is where an app reports its dependencies. It is the cheapest signal that the " +
      "inferred database was reachable from the task, which is the failure the addon path shipped " +
      "with for months.",
  },
  {
    id: "FUNC-PERSISTENCE",
    category: "functional",
    severity: "blocking",
    title: "A write followed by a read returns the written record",
    rationale:
      "Proves migrations ran and the credentials injected as ECS secrets actually authenticate. A " +
      "liveness probe passes without the database ever being touched.",
  },

  // ---- Security -----------------------------------------------------------
  // Audited against the synthesised template rather than the live account: these are
  // properties of what we are about to publish, and catching them before the deploy
  // costs nothing.
  {
    id: "SEC-DB-NOT-PUBLIC",
    category: "security",
    severity: "blocking",
    title: "No database instance is publicly accessible",
    rationale: "A generated stack that exposes its database to the internet must never reach a README button.",
  },
  {
    id: "SEC-DB-ENCRYPTED",
    category: "security",
    severity: "blocking",
    title: "Every database instance has storage encryption enabled",
    rationale: "Cheap, and the absence of it is a finding in every customer's own audit.",
  },
  {
    id: "SEC-TASK-NOT-PUBLIC",
    category: "security",
    severity: "blocking",
    title: "No ECS service assigns public IPs to its tasks",
    rationale:
      "Tasks belong in private subnets behind the load balancer. A public task IP bypasses the " +
      "balancer's security group entirely.",
  },
  {
    id: "SEC-NO-PLAINTEXT-SECRET",
    category: "security",
    severity: "blocking",
    title: "No secret-named container variable carries a literal value",
    rationale:
      "Container environment is readable by anyone who can describe the task definition, and it is " +
      "in the CloudFormation template in clear. Secrets belong in the task definition's `secrets` " +
      "block, resolved from Secrets Manager at start-up.",
  },
  {
    id: "SEC-NO-WIDE-INGRESS",
    category: "security",
    severity: "blocking",
    title: "No security group allows 0.0.0.0/0 on a port other than 80 or 443",
    rationale:
      "Public HTTP(S) on the load balancer is the point of the deploy. Everything else open to the " +
      "world — a database port above all — is not.",
  },

  // ---- Teardown -----------------------------------------------------------
  {
    id: "TEARDOWN-NO-RETAINED-DATA",
    category: "teardown",
    severity: "blocking",
    title: "No data resource is set to retain or snapshot on delete",
    rationale:
      "CDK defaults RDS to snapshot-on-delete. The first verification run left two RDS snapshots " +
      "behind and the stack still reported DELETE_COMPLETE — residue that costs money and holds " +
      "whatever the verification wrote, found only because the account was swept by hand.",
  },
  {
    id: "TEARDOWN-STACKS-GONE",
    category: "teardown",
    severity: "blocking",
    title: "Every stack the run created is gone",
    rationale: "The floor, not the ceiling. Asserted so a teardown that silently no-ops is visible.",
  },
  {
    id: "TEARDOWN-BASELINE-RESTORED",
    category: "teardown",
    severity: "blocking",
    title: "The account inventory matches the pre-run baseline",
    rationale:
      "The property actually wanted. A stack-name-keyed sweep cannot see RDS snapshots, KMS keys " +
      "pending deletion, orphaned ENIs, log groups, or anything the application itself created " +
      "while running with a task role. Diffing inventory before and after does.",
  },
] as const;

/** Every declared assertion id, for validating results. */
export const ASSERTION_IDS: ReadonlySet<string> = new Set(VERIFICATION_ASSERTIONS.map((a) => a.id));

export function getAssertion(id: string): AssertionSpec {
  const spec = VERIFICATION_ASSERTIONS.find((a) => a.id === id);
  if (!spec) {
    throw new Error(`Unknown assertion id "${id}". Declare it in VERIFICATION_ASSERTIONS before reporting it.`);
  }
  return spec;
}

export interface AssertionResult {
  id: string;
  passed: boolean;
  /** What was observed. Shown verbatim in the report, so make it specific. */
  detail: string;
  /**
   * False when the stack held nothing this assertion inspects.
   *
   * "I checked and it is fine" and "there was nothing to check" are different claims, and
   * a report that renders them identically tells the reader something it has not
   * established. `SEC-DB-ENCRYPTED` reads `AWS::RDS::DBInstance`; on an Aurora stack —
   * which is `AWS::RDS::DBCluster` — it found no instances and said
   * "0 database instance(s), all encrypted at rest". That sentence is a claim about a
   * database it never opened, and it passed a cluster that was unencrypted and publicly
   * accessible.
   *
   * This is the same distinction `notRun` draws between assertions, applied inside one:
   * absence of evidence is recorded as absence, not as evidence.
   *
   * It does not fail a stack. A stack with no database legitimately has nothing to
   * encrypt, and the honest report of that is "not applicable" rather than either verdict.
   * What it buys is that a *silently* narrow rule becomes a visible one — if a stack
   * plainly has a database and the report says this was not applicable, the rule is
   * reading the wrong resource type and someone can see it.
   *
   * Omitted means true, so an assertion that always has something to inspect says nothing.
   */
  applicable?: boolean;
}

export interface VerificationReport {
  results: AssertionResult[];
  /**
   * False when a blocking assertion failed, or when a blocking assertion in scope was
   * never reported on. Advisory outcomes are recorded but never flip it.
   */
  passed: boolean;
  blockingFailures: AssertionResult[];
  advisoryFailures: AssertionResult[];
  /** In-scope assertions that nothing reported on — an unrun check is not a pass. */
  notRun: string[];
  /**
   * Assertions that ran and found nothing they inspect.
   *
   * Reported separately from passes so a reader can tell "checked, fine" from "nothing to
   * check". Neither fails a stack; the difference is what the report is entitled to claim.
   * A long list here on a stack that obviously has databases and services is the signal
   * that the rules are reading the wrong resource types.
   */
  notApplicable: string[];
}

export interface ReportScope {
  /**
   * Categories this run was responsible for. Assertions outside them are not expected
   * and do not count as unrun.
   *
   * A runner covers one stage: a pre-flight pass has no deploy to probe, a teardown
   * sweep runs after the service is gone. Without this, every assertion belonging to
   * another stage lands in `notRun` and the run can never report `passed`, which
   * pushes callers into computing their own verdict — and the first thing lost when
   * they do is the unrun-is-not-a-pass guarantee this module exists to provide.
   *
   * Omit it to demand the whole checklist, which is what a full verification run wants.
   */
  categories?: readonly AssertionCategory[];
}

/**
 * Fold results into a report.
 *
 * Unreported assertions are surfaced rather than ignored. A harness that skips a check
 * because a port was unavailable would otherwise look identical to one that ran it and
 * passed, which is how "verified" stops meaning anything.
 */
export function buildReport(results: AssertionResult[], scope: ReportScope = {}): VerificationReport {
  for (const result of results) {
    if (!ASSERTION_IDS.has(result.id)) {
      throw new Error(`Result reported for undeclared assertion "${result.id}".`);
    }
  }

  const inScope = scope.categories
    ? VERIFICATION_ASSERTIONS.filter((a) => scope.categories!.includes(a.category))
    : VERIFICATION_ASSERTIONS;

  if (inScope.length === 0) {
    throw new Error(`Report scope matched no declared assertions: ${JSON.stringify(scope.categories)}.`);
  }

  const failures = results.filter((r) => !r.passed);
  const blockingFailures = failures.filter((r) => getAssertion(r.id).severity === "blocking");
  const advisoryFailures = failures.filter((r) => getAssertion(r.id).severity === "advisory");
  const reported = new Set(results.map((r) => r.id));
  const notRun = inScope.map((a) => a.id).filter((id) => !reported.has(id));

  // Ran, but found nothing to inspect. Not a failure — a stack with no database has
  // nothing to encrypt — but not a pass either, because the rule established nothing.
  // Kept out of the verdict and surfaced in the report, which is the whole point: a
  // reader can compare it against what the stack visibly contains.
  // Scoped like `notRun`: a caller that hands a full run's results to a report covering
  // one stage should not be told about n/a ids from categories the report disclaims.
  const inScopeIds = new Set(inScope.map((a) => a.id));
  const notApplicable = results.filter((r) => r.applicable === false && inScopeIds.has(r.id)).map((r) => r.id);

  // An unrun *blocking* check is the case this guards: it is indistinguishable from a
  // pass in a report, so it must not be one. An unrun advisory check is recorded in
  // `notRun` but does not block — an advisory assertion that fails outright does not,
  // and its absence should not be treated more harshly than its failure.
  const blockingNotRun = notRun.filter((id) => getAssertion(id).severity === "blocking");

  return {
    results,
    passed: blockingFailures.length === 0 && blockingNotRun.length === 0,
    blockingFailures,
    advisoryFailures,
    notRun,
    notApplicable,
  };
}
