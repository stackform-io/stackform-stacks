import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

/**
 * Pinned upstream release. Bump deliberately: the migration task runs the new release's
 * Django migrations against the customer's database, so a new tag is a schema change on
 * their data, not just a new binary.
 */
export const FLAGSMITH_VERSION = "2.273.0";
/** The unified image: the API and the Django-served dashboard in one container. */
export const FLAGSMITH_IMAGE = `flagsmith/flagsmith:${FLAGSMITH_VERSION}`;

export const FLAGSMITH_PORT = 8000;
/**
 * Returns `{"status":"ok"}` without touching the database — liveness, not readiness.
 * The trailing slash matters: without it Django answers with a redirect, which the
 * target group counts as unhealthy.
 */
export const HEALTH_PATH = "/health/liveness/";
const DB_NAME = "flagsmith";

/**
 * How long the web and task-processor containers wait for the migration task to finish
 * before giving up and exiting. The first deploy migrates an empty database through
 * several hundred migrations; later ones are usually a no-op.
 */
export const MIGRATION_WAIT_SECONDS = 600;

/**
 * Characters kept out of the generated database password.
 *
 * Flagsmith reads its connection as discrete `DJANGO_DB_*` variables and psycopg2 quotes
 * the password itself, so nothing here composes a URL today. The exclusions are kept
 * anyway — they cost nothing, and they keep the password safe to paste into a
 * `DATABASE_URL` or a `psql` command line if an operator ever needs to.
 *
 * Deliberately *not* every punctuation character: Secrets Manager requires each
 * character type it has not been told to skip to appear in the password, and refuses to
 * generate one — "All characters of the desired type have been excluded" — when the
 * exclusions leave no punctuation to pick. That failed Umami's first real deploy
 * (SF-436). The four left in are RFC 3986's unreserved characters (`-` `.` `_` `~`):
 * legal in a URL's userinfo without encoding, and inert inside double quotes in sh.
 */
export const PASSWORD_EXCLUDED_CHARACTERS = " !\"#$%&'()*+,/:;<=>?@[\\]^`{|}";

/**
 * The image's entrypoint is the `flagsmith` CLI (`ENTRYPOINT ["flagsmith"]`). The
 * migration task uses it as-is with `migrate`, which migrates and then creates Django's
 * cache table.
 */
export const MIGRATE_COMMAND = ["migrate"];

/**
 * The long-running roles wait for the migration task before starting.
 *
 * The migration custom resource starts the task and returns — ECS RunTask does not wait
 * for it to finish — so "the web service is created after the migration" is not by
 * itself "the web service starts on a migrated database". `waitfordb --migrations`
 * closes that gap: it blocks until Django sees no unapplied migrations, and exits
 * non-zero after MIGRATION_WAIT_SECONDS, so a failed migration surfaces as tasks that
 * never become healthy and the circuit breaker rolls the deploy back.
 *
 * `exec` hands PID 1 to the real process so it receives ECS's SIGTERM on scale-in.
 */
const waitForMigrationsThen = (command: string) =>
  `flagsmith waitfordb --migrations --waitfor ${MIGRATION_WAIT_SECONDS} && exec flagsmith ${command}`;

/** `serve` is the upstream compose file's web command: wait for the database, then gunicorn. */
export const WEB_START_COMMAND = waitForMigrationsThen("serve");

/**
 * Not upstream's `run-task-processor`: that verb runs the migrations itself first, which
 * would race the migration task on an empty database. `start task-processor` is the
 * bare process it ends in, and still switches the CLI into task-processor mode.
 */
export const TASK_PROCESSOR_START_COMMAND = waitForMigrationsThen("start task-processor");

export interface FlagsmithStackProps extends cdk.StackProps {
  /** Fargate CPU units for the web/API task. Default 512. */
  cpu?: number;
  /** Fargate memory for the web/API task, in MiB. Default 2048. */
  memoryMiB?: number;
  /** Number of web/API tasks. Default 1. */
  desiredCount?: number;

  /** RDS instance class, with or without the `db.` prefix. Default `db.t4g.micro`. */
  dbInstanceType?: string;
  /** Standby in a second AZ. Doubles the database cost. Default false. */
  dbMultiAz?: boolean;

  /** Optional custom domain. HTTPS via ACM when set together with `hostedZoneId`. */
  domainName?: string;
  hostedZoneId?: string;

  /**
   * Accept sign-ups only from people holding an invite. Off by default because the first
   * sign-up is how the first account and organisation get created; turn it on once that
   * is done.
   */
  inviteOnly?: boolean;

  /**
   * Delete the database with the stack instead of keeping a final snapshot.
   *
   * Off by default — deleting a stack should never silently take the customer's flags
   * with it. Verification runs, which deploy and tear down deliberately and must leave
   * nothing behind (TEARDOWN-NO-RETAINED-DATA), opt in.
   */
  destroyDataOnDelete?: boolean;
}

/**
 * Self-hosted Flagsmith: a web/API service behind an ALB and a task-processor service,
 * on RDS PostgreSQL, with a one-off migration task run on every deploy.
 *
 * Same shape as the Umami skeleton (SF-436) — tasks and database in private subnets, the
 * load balancer the only thing the internet can reach, secrets from Secrets Manager —
 * plus the two things Flagsmith needs that Umami does not: migrations that run once
 * rather than in every web task, and a task processor for its asynchronous work
 * (audit logs, webhooks, analytics roll-ups). It needs no Redis at this size.
 */
export class FlagsmithStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FlagsmithStackProps = {}) {
    super(scope, id, props);

    const {
      cpu = 512,
      memoryMiB = 2048,
      desiredCount = 1,
      dbInstanceType = "db.t4g.micro",
      dbMultiAz = false,
      domainName,
      hostedZoneId,
      inviteOnly = false,
      destroyDataOnDelete = false,
    } = props;

    // One NAT gateway: the tasks need egress to pull the image from Docker Hub, and a
    // second one buys AZ-level egress redundancy a flag dashboard does not need.
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "Private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: "Data", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    const taskSubnets = vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS });

    const albSg = new ec2.SecurityGroup(this, "AlbSG", { vpc, description: "Flagsmith load balancer" });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "HTTP");
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS");

    const webSg = new ec2.SecurityGroup(this, "WebSG", { vpc, description: "Flagsmith web tasks" });
    webSg.addIngressRule(albSg, ec2.Port.tcp(FLAGSMITH_PORT), "From the load balancer");

    // The task processor and the migration task accept no connections. They get their own
    // group rather than sharing the web one, which the load balancer can reach — the task
    // processor runs gunicorn on :8000 too, for its own health endpoint.
    const workerSg = new ec2.SecurityGroup(this, "WorkerSG", {
      vpc,
      description: "Flagsmith task processor and migrations",
    });

    const dbSg = new ec2.SecurityGroup(this, "DbSG", {
      vpc,
      description: "Flagsmith database",
      allowAllOutbound: false,
    });
    dbSg.addIngressRule(webSg, ec2.Port.tcp(5432), "Postgres from Flagsmith web tasks");
    dbSg.addIngressRule(workerSg, ec2.Port.tcp(5432), "Postgres from the task processor and migrations");

    // Django's SECRET_KEY. Flagsmith falls back to a random key per process when it is
    // unset, so two tasks — or one task across a restart — would disagree about every
    // signed value, and signed-in users would be logged out on each deploy.
    const djangoSecret = new secretsmanager.Secret(this, "DjangoSecretKey", {
      description: "Flagsmith DJANGO_SECRET_KEY",
      generateSecretString: {
        secretStringTemplate: "{}",
        generateStringKey: "secretKey",
        excludePunctuation: true,
        passwordLength: 64,
      },
    });

    const dataRemovalPolicy = destroyDataOnDelete ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.SNAPSHOT;

    const db = new rds.DatabaseInstance(this, "Database", {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17 }),
      // RDS renders `db.` in front of the class it is handed, so a value that already
      // carries it would synthesise as `db.db.t4g.micro` (SF-501).
      instanceType: new ec2.InstanceType(dbInstanceType.replace(/^db\./, "")),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      multiAz: dbMultiAz,
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      storageEncrypted: true,
      databaseName: DB_NAME,
      credentials: rds.Credentials.fromGeneratedSecret("flagsmith", {
        excludeCharacters: PASSWORD_EXCLUDED_CHARACTERS,
      }),
      backupRetention: cdk.Duration.days(7),
      deleteAutomatedBackups: destroyDataOnDelete,
      deletionProtection: false,
      removalPolicy: dataRemovalPolicy,
    });
    const dbSecret = db.secret!;

    // Created before the tasks because the URL it will answer on is part of their
    // configuration: the CSRF origin, the domain in e-mailed links, and whether cookies
    // may be marked Secure.
    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });
    const https = Boolean(domainName && hostedZoneId);
    const appHost = https ? domainName! : alb.loadBalancerDnsName;
    const appUrl = `${https ? "https" : "http"}://${appHost}`;

    const cluster = new ecs.Cluster(this, "Cluster", { vpc });

    const logGroup = new logs.LogGroup(this, "Logs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Every role reads the same configuration: the migration task must migrate the same
    // database the services then serve from, and the task processor runs the same Django
    // settings as the API that queues its work.
    const environment: Record<string, string> = {
      // Discrete variables rather than DATABASE_URL, so the password travels as its own
      // ECS secret and nothing has to compose a URL around it in a shell.
      DJANGO_DB_HOST: db.dbInstanceEndpointAddress,
      DJANGO_DB_PORT: db.dbInstanceEndpointPort,
      DJANGO_DB_NAME: DB_NAME,
      // RDS for PostgreSQL 15+ refuses unencrypted connections. The DJANGO_DB_* settings
      // path passes no sslmode, so libpq reads this. libpq's `require` encrypts without
      // verifying the certificate authority — unlike node-postgres, where `require` means
      // full verification — so it connects against RDS with no CA bundle in the image.
      PGSSLMODE: "require",
      ENVIRONMENT: "production",
      // The load balancer health-checks each task on its private IP, which arrives as the
      // Host header, so a host allow-list would reject the health check. Links in e-mails
      // come from FLAGSMITH_DOMAIN rather than the Host header.
      DJANGO_ALLOWED_HOSTS: "*",
      DJANGO_CSRF_TRUSTED_ORIGINS: appUrl,
      FLAGSMITH_DOMAIN: appHost,
      // The dashboard keeps its session in a cookie. A Secure cookie is dropped by the
      // browser over plain HTTP, and SameSite=None — upstream's default — is refused
      // without Secure, so without a custom domain nobody could stay signed in. The
      // dashboard and API share an origin, so Lax loses nothing.
      USE_SECURE_COOKIES: https ? "true" : "false",
      COOKIE_SAME_SITE: "lax",
      // Hand asynchronous work to the task processor service instead of a thread inside
      // each web worker, which would lose it on every deploy.
      TASK_RUN_METHOD: "TASK_PROCESSOR",
      // Flag analytics in Postgres. Upstream's alternative is InfluxDB, which this stack
      // does not run.
      USE_POSTGRES_FOR_ANALYTICS: "true",
      ENABLE_TELEMETRY: "false",
      // Upstream serves GET /api/v1/users/init/ until the first user exists: it creates a
      // superuser and returns a password-reset link to whoever asked. On a public load
      // balancer that is anyone. The first account is made by signing up instead.
      ALLOW_ADMIN_INITIATION_VIA_URL: "false",
      // Not PREVENT_SIGNUP, which refuses invited users too and leaves no way to add a
      // teammate without e-mail.
      ALLOW_REGISTRATION_WITHOUT_INVITE: inviteOnly ? "false" : "true",
    };
    const secrets = {
      DJANGO_DB_USER: ecs.Secret.fromSecretsManager(dbSecret, "username"),
      DJANGO_DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, "password"),
      DJANGO_SECRET_KEY: ecs.Secret.fromSecretsManager(djangoSecret, "secretKey"),
    };
    const image = ecs.ContainerImage.fromRegistry(FLAGSMITH_IMAGE);

    // ---- Migrations ---------------------------------------------------------------

    const migrateTaskDef = new ecs.FargateTaskDefinition(this, "MigrateTaskDef", { cpu: 512, memoryLimitMiB: 1024 });
    migrateTaskDef.addContainer("Migrate", {
      image,
      command: MIGRATE_COMMAND,
      environment,
      secrets,
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "migrate" }),
    });

    const runMigrations: cr.AwsSdkCall = {
      service: "ECS",
      action: "runTask",
      parameters: {
        cluster: cluster.clusterArn,
        taskDefinition: migrateTaskDef.taskDefinitionArn,
        launchType: "FARGATE",
        count: 1,
        startedBy: "flagsmith-migrate",
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: taskSubnets.subnetIds,
            securityGroups: [workerSg.securityGroupId],
            assignPublicIp: "DISABLED",
          },
        },
      },
      // A fresh id on every synth makes CloudFormation see a change and run the task on
      // every deploy, as Sentry's does — including a retry of a deploy whose migration
      // failed. Migrating an up-to-date database is a no-op that costs a minute of Fargate.
      physicalResourceId: cr.PhysicalResourceId.of(`flagsmith-migrate-${Date.now()}`),
      // RunTask's full response describes the task at length, and a custom resource's
      // response to CloudFormation is capped at 4 KB.
      outputPaths: ["tasks.0.taskArn"],
    };

    const migration = new cr.AwsCustomResource(this, "Migration", {
      onCreate: runMigrations,
      onUpdate: runMigrations,
      // The SDK bundled with the Lambda runtime has RunTask; fetching the latest from npm
      // at deploy time would be one more thing that can fail.
      installLatestAwsSdk: false,
      // Without an explicit group the provider Lambda logs to an implicit /aws/lambda/…
      // group that outlives the stack — residue the teardown assertions flag, in exactly
      // the verification runs that must leave nothing behind.
      logGroup: new logs.LogGroup(this, "MigrationRunnerLogs", {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ["ecs:RunTask"],
          resources: [migrateTaskDef.taskDefinitionArn],
          conditions: { ArnEquals: { "ecs:cluster": cluster.clusterArn } },
        }),
        new iam.PolicyStatement({
          actions: ["iam:PassRole"],
          resources: [migrateTaskDef.taskRole.roleArn, migrateTaskDef.executionRole!.roleArn],
          conditions: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } },
        }),
      ]),
    });
    // The task needs its database, and a route out through the NAT gateway to pull the
    // image — the subnet ids alone do not wait for the route.
    migration.node.addDependency(db);
    migration.node.addDependency(taskSubnets.internetConnectivityEstablished);

    // ---- Web / API ----------------------------------------------------------------

    const webTaskDef = new ecs.FargateTaskDefinition(this, "WebTaskDef", { cpu, memoryLimitMiB: memoryMiB });
    webTaskDef.addContainer("Web", {
      image,
      entryPoint: ["sh", "-c"],
      command: [WEB_START_COMMAND],
      portMappings: [{ containerPort: FLAGSMITH_PORT }],
      environment,
      secrets,
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "web" }),
    });

    const webService = new ecs.FargateService(this, "WebService", {
      cluster,
      taskDefinition: webTaskDef,
      desiredCount,
      securityGroups: [webSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      // The first deploy's tasks sit in `waitfordb` until the migration task finishes, and
      // do not listen until then. The grace period covers that whole wait plus the boot.
      healthCheckGracePeriod: cdk.Duration.seconds(MIGRATION_WAIT_SECONDS + 120),
      // A task that can never become healthy fails the deploy and rolls back, instead of
      // CloudFormation waiting out its three-hour stabilisation timeout.
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
    });
    webService.node.addDependency(migration);

    // ---- Task processor -----------------------------------------------------------

    // Fixed size: it polls a Postgres queue for small jobs, and a knob on the deploy form
    // for it would be one more thing to get wrong.
    const processorTaskDef = new ecs.FargateTaskDefinition(this, "TaskProcessorTaskDef", {
      cpu: 256,
      memoryLimitMiB: 1024,
    });
    processorTaskDef.addContainer("TaskProcessor", {
      image,
      entryPoint: ["sh", "-c"],
      command: [TASK_PROCESSOR_START_COMMAND],
      environment,
      secrets,
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "task-processor" }),
    });

    const processorService = new ecs.FargateService(this, "TaskProcessorService", {
      cluster,
      taskDefinition: processorTaskDef,
      desiredCount: 1,
      securityGroups: [workerSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
    });
    processorService.node.addDependency(migration);

    // ---- Load balancer ------------------------------------------------------------

    const targetProps: elbv2.AddApplicationTargetsProps = {
      port: FLAGSMITH_PORT,
      // CDK only infers a protocol for 80 and 443; without this, synthesis throws.
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [webService],
      healthCheck: {
        path: HEALTH_PATH,
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    };

    if (https) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
        hostedZoneId: hostedZoneId!,
        zoneName: domainName!.split(".").slice(-2).join("."),
      });
      const certificate = new acm.Certificate(this, "Certificate", {
        domainName: domainName!,
        validation: acm.CertificateValidation.fromDns(zone),
      });
      alb.addListener("Https", { port: 443, certificates: [certificate] }).addTargets("Flagsmith", targetProps);
      alb.addListener("HttpRedirect", {
        port: 80,
        defaultAction: elbv2.ListenerAction.redirect({ protocol: "HTTPS", port: "443", permanent: true }),
      });
      new route53.ARecord(this, "Alias", {
        zone,
        // Fully qualified, so the record lands on the right name whatever the zone's
        // name really is — the two-label guess above is only a placeholder.
        recordName: `${domainName}.`,
        target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(alb)),
      });
    } else {
      alb.addListener("Http", { port: 80 }).addTargets("Flagsmith", targetProps);
    }

    new cdk.CfnOutput(this, "AppUrl", { value: appUrl, description: "Flagsmith dashboard and API URL" });
    new cdk.CfnOutput(this, "FirstLogin", {
      value:
        "Open the AppUrl and sign up - the first account creates your organisation. " +
        "Then redeploy with Invite-only Sign-up on, unless you want open registration.",
      description: "Flagsmith creates no default account",
    });
    new cdk.CfnOutput(this, "ApiUrl", {
      value: `${appUrl}/api/v1/`,
      description: "Point Flagsmith SDKs here (the SDK's api/apiUrl option)",
    });
    new cdk.CfnOutput(this, "LogGroupName", {
      value: logGroup.logGroupName,
      description: "Flagsmith container logs (streams: web, task-processor, migrate)",
    });
    new cdk.CfnOutput(this, "DatabaseEndpoint", {
      value: `${db.dbInstanceEndpointAddress}:${db.dbInstanceEndpointPort}`,
      description: "RDS PostgreSQL endpoint (private)",
    });
  }
}
