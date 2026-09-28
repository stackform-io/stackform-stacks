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
import { Construct } from "constructs";

/**
 * Pinned upstream release. Bump deliberately: the container runs `prisma migrate deploy`
 * on boot, so a new tag is a schema change on the customer's data, not just a new binary.
 *
 * LiteLLM retired its `main-vX.Y.Z-stable` tags after 1.83.14; plain `vX.Y.Z` tags are
 * now the stable releases (`-rc.N` / `-dev.N` are not). This one is what `main-stable`
 * pointed at when it was pinned.
 *
 * The `-database` image is the one with the Prisma CLI and engines baked in, so the
 * migrations need no network access at boot.
 */
export const LITELLM_VERSION = "v1.102.1";
export const LITELLM_IMAGE = `ghcr.io/berriai/litellm-database:${LITELLM_VERSION}`;

export const LITELLM_PORT = 4000;
/**
 * Answers without authentication and without touching the database — liveness, not
 * readiness. `/health/readiness` also answers unauthenticated but turns 503 whenever the
 * database blips, which behind a load balancer would take every task out of service at
 * once. A database that is wrong at boot is caught by ENFORCE_PRISMA_MIGRATION_CHECK
 * instead, which exits the task.
 */
export const HEALTH_PATH = "/health/liveliness";
/**
 * Streamed completions (SSE) go quiet between tokens, and a non-streamed completion
 * sends nothing at all until it is finished — so the ALB's default 60 s cuts long
 * answers from reasoning models mid-flight. Ten minutes covers them with room to spare.
 */
export const ALB_IDLE_TIMEOUT_SECONDS = 600;
const DB_NAME = "litellm";

/**
 * Characters kept out of the generated database password.
 *
 * LiteLLM percent-encodes the password itself when it assembles its connection URL, so
 * this is not load-bearing for the app. It is kept, as in the Umami template, because
 * RDS refuses some of these in a master password outright, and because an operator who
 * copies the password into a hand-written connection URL (psql, a migration tool)
 * should not have to escape it.
 *
 * Deliberately *not* every punctuation character: Secrets Manager requires each
 * character type it has not been told to skip to appear in the password, and refuses to
 * generate one — "All characters of the desired type have been excluded" — when the
 * exclusions leave no punctuation to pick. That failed Umami's first real deploy
 * (SF-436). The four left in are RFC 3986's unreserved characters (`-` `.` `_` `~`):
 * legal in a URL's userinfo without encoding, and inert inside double quotes in sh.
 */
export const PASSWORD_EXCLUDED_CHARACTERS = " !\"#$%&'()*+,/:;<=>?@[\\]^`{|}";

export interface LiteLLMStackProps extends cdk.StackProps {
  /** Fargate CPU units for the LiteLLM task. Default 1024. */
  cpu?: number;
  /** Fargate memory for the LiteLLM task, in MiB. Default 2048 — it idles at ~530 MiB. */
  memoryMiB?: number;
  /** Number of LiteLLM tasks. Default 1. Migrations run on every boot and take a lock. */
  desiredCount?: number;

  /** RDS instance class, with or without the `db.` prefix. Default `db.t4g.micro`. */
  dbInstanceType?: string;
  /** Standby in a second AZ. Doubles the database cost. Default false. */
  dbMultiAz?: boolean;

  /** Optional custom domain. HTTPS via ACM when set together with `hostedZoneId`. */
  domainName?: string;
  hostedZoneId?: string;

  /**
   * Let the proxy call Amazon Bedrock models in this account with the task role, so a
   * Bedrock model can be added in the admin UI without pasting an access key.
   *
   * Off by default: it is a spend-bearing permission, and the customer should opt into it
   * on the deploy form rather than find it granted. Scoped to invoking models — see the
   * grant below for exactly which.
   */
  bedrockAccess?: boolean;

  /**
   * Delete the database with the stack instead of keeping a final snapshot.
   *
   * Off by default — deleting a stack should never silently take the customer's keys,
   * spend history and stored provider credentials with it. Verification runs, which
   * deploy and tear down deliberately and must leave nothing behind
   * (TEARDOWN-NO-RETAINED-DATA), opt in.
   */
  destroyDataOnDelete?: boolean;
}

/**
 * Self-hosted LiteLLM proxy: one Fargate service behind an ALB, on RDS PostgreSQL.
 *
 * Same shape as the Umami walking skeleton (SF-436): tasks and database in private
 * subnets, the load balancer the only thing the internet can reach, secrets from Secrets
 * Manager. No Redis: LiteLLM only needs it to share rate-limit and cache state between
 * several proxies, and a single-digit task count works without it.
 */
export class LiteLLMStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: LiteLLMStackProps = {}) {
    super(scope, id, props);

    const {
      cpu = 1024,
      memoryMiB = 2048,
      desiredCount = 1,
      dbInstanceType = "db.t4g.micro",
      dbMultiAz = false,
      domainName,
      hostedZoneId,
      bedrockAccess = false,
      destroyDataOnDelete = false,
    } = props;

    // One NAT gateway: the tasks need egress to pull the image from ghcr.io and to reach
    // the model providers they proxy, and a second one buys AZ-level egress redundancy
    // at a price a small team's gateway does not need.
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "Private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: "Data", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const albSg = new ec2.SecurityGroup(this, "AlbSG", { vpc, description: "LiteLLM load balancer" });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "HTTP");
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS");

    const taskSg = new ec2.SecurityGroup(this, "TaskSG", { vpc, description: "LiteLLM tasks" });
    taskSg.addIngressRule(albSg, ec2.Port.tcp(LITELLM_PORT), "From the load balancer");

    const dbSg = new ec2.SecurityGroup(this, "DbSG", {
      vpc,
      description: "LiteLLM database",
      allowAllOutbound: false,
    });
    dbSg.addIngressRule(taskSg, ec2.Port.tcp(5432), "Postgres from LiteLLM tasks");

    const dataRemovalPolicy = destroyDataOnDelete ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.SNAPSHOT;

    // The admin credential: API calls as proxy admin, and the admin UI's login password.
    // Upstream's docs suggest an `sk-` prefix, which Secrets Manager cannot generate; the
    // pinned release compares the master key verbatim (API and /login both verified
    // against the image), so the value in the secret is exactly what the user types.
    const masterKey = new secretsmanager.Secret(this, "MasterKey", {
      description: "LiteLLM master key (admin API key and admin UI password)",
      generateSecretString: {
        secretStringTemplate: "{}",
        generateStringKey: "masterKey",
        excludePunctuation: true,
        passwordLength: 48,
      },
    });

    // Encrypts the provider API keys LiteLLM stores in the database. It must never
    // change once the proxy has booted: a new value leaves every stored credential
    // undecryptable. So there is no rotation schedule, and the construct id and the
    // generation settings below must not be edited — either one makes CloudFormation
    // generate a fresh value on the next update. For the same reason it lives as long as
    // the data it protects: a final snapshot is useless without it, so it is retained
    // whenever the database is snapshotted.
    const saltKey = new secretsmanager.Secret(this, "SaltKey", {
      description: "LiteLLM salt key — encrypts stored provider credentials. Never change or rotate it.",
      generateSecretString: {
        secretStringTemplate: "{}",
        generateStringKey: "saltKey",
        excludePunctuation: true,
        passwordLength: 64,
      },
    });
    saltKey.applyRemovalPolicy(destroyDataOnDelete ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN);

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
      credentials: rds.Credentials.fromGeneratedSecret("litellm", {
        excludeCharacters: PASSWORD_EXCLUDED_CHARACTERS,
      }),
      backupRetention: cdk.Duration.days(7),
      deleteAutomatedBackups: destroyDataOnDelete,
      deletionProtection: false,
      removalPolicy: dataRemovalPolicy,
    });
    const dbSecret = db.secret!;

    const cluster = new ecs.Cluster(this, "Cluster", { vpc });

    const logGroup = new logs.LogGroup(this, "Logs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const taskDef = new ecs.FargateTaskDefinition(this, "TaskDef", { cpu, memoryLimitMiB: memoryMiB });
    // The image's own ENTRYPOINT (`docker/prod_entrypoint.sh`) and CMD (`--port 4000`)
    // are left alone. Unlike Umami, LiteLLM assembles its connection URL itself from the
    // discrete DATABASE_* variables — percent-encoding the credentials — before it runs
    // the migrations, so there is no shell string to compose and nothing to get wrong in
    // one. The password still reaches the process only as an ECS secret.
    taskDef.addContainer("LiteLLM", {
      image: ecs.ContainerImage.fromRegistry(LITELLM_IMAGE),
      portMappings: [{ containerPort: LITELLM_PORT }],
      environment: {
        // Host and port in one: the CLI's URL builder reads DATABASE_HOST verbatim and
        // ignores DATABASE_PORT.
        DATABASE_HOST: cdk.Fn.join(":", [db.dbInstanceEndpointAddress, db.dbInstanceEndpointPort]),
        DATABASE_NAME: DB_NAME,
        // RDS for PostgreSQL 15+ refuses unencrypted connections. Prisma — which both the
        // app and the on-boot `prisma migrate deploy` use — encrypts under `require`
        // without verifying the certificate, so it needs no RDS CA bundle, and unlike its
        // default `prefer` it never falls back to plaintext.
        DATABASE_SSLMODE: "require",
        // Exit when the boot migrations fail, so a task that cannot use its database is
        // replaced (and a bad deploy rolled back by the circuit breaker) instead of
        // serving a healthy liveness check over a schema it could not migrate.
        ENFORCE_PRISMA_MIGRATION_CHECK: "true",
        // Models, keys and teams are managed in the admin UI and kept in Postgres; there
        // is no config file in this deployment for them to live in instead.
        STORE_MODEL_IN_DB: "True",
        // LiteLLM falls back to us-west-2 for Bedrock models given no region.
        AWS_REGION: this.region,
      },
      secrets: {
        DATABASE_USERNAME: ecs.Secret.fromSecretsManager(dbSecret, "username"),
        DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, "password"),
        LITELLM_MASTER_KEY: ecs.Secret.fromSecretsManager(masterKey, "masterKey"),
        LITELLM_SALT_KEY: ecs.Secret.fromSecretsManager(saltKey, "saltKey"),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "litellm" }),
    });

    if (bedrockAccess) {
      // Invoke only — no model management, no Marketplace subscriptions. Two statements
      // because cross-region inference profiles, which most current models are only
      // reachable through on demand, are authorised twice: once on the profile, and
      // again on the foundation model in whichever region the profile routes the call to.
      const invoke = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"];
      taskDef.taskRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: invoke,
          resources: [
            `arn:${this.partition}:bedrock:${this.region}::foundation-model/*`,
            `arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/*`,
          ],
        }),
      );
      taskDef.taskRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: invoke,
          // Any region, including the empty one global profiles route to — but only as
          // the destination of a profile in this account and region.
          resources: [`arn:${this.partition}:bedrock:*::foundation-model/*`],
          conditions: {
            StringLike: {
              "bedrock:InferenceProfileArn": `arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/*`,
            },
          },
        }),
      );
    }

    const service = new ecs.FargateService(this, "Service", {
      cluster,
      taskDefinition: taskDef,
      desiredCount,
      securityGroups: [taskSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      // The first boot applies ~170 migrations to an empty database before it listens.
      healthCheckGracePeriod: cdk.Duration.minutes(3),
      // A task that can never become healthy fails the deploy in minutes and rolls back,
      // instead of CloudFormation waiting out its three-hour stabilisation timeout.
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
    });
    // The service must not start before its database exists to migrate.
    service.node.addDependency(db);

    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      idleTimeout: cdk.Duration.seconds(ALB_IDLE_TIMEOUT_SECONDS),
    });

    const targetProps: elbv2.AddApplicationTargetsProps = {
      port: LITELLM_PORT,
      // CDK only infers a protocol for 80 and 443; without this, synthesis throws.
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: {
        path: HEALTH_PATH,
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    };

    let appUrl: string;
    if (domainName && hostedZoneId) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
        hostedZoneId,
        zoneName: domainName.split(".").slice(-2).join("."),
      });
      const certificate = new acm.Certificate(this, "Certificate", {
        domainName,
        validation: acm.CertificateValidation.fromDns(zone),
      });
      alb.addListener("Https", { port: 443, certificates: [certificate] }).addTargets("LiteLLM", targetProps);
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
      appUrl = `https://${domainName}`;
    } else {
      // Plain HTTP: API keys cross the internet in clear until a custom domain is set.
      // The README says so; the deploy form offers the domain for exactly this reason.
      alb.addListener("Http", { port: 80 }).addTargets("LiteLLM", targetProps);
      appUrl = `http://${alb.loadBalancerDnsName}`;
    }

    new cdk.CfnOutput(this, "AppUrl", { value: appUrl, description: "LiteLLM proxy base URL (OpenAI-compatible API)" });
    new cdk.CfnOutput(this, "AdminUiUrl", {
      value: `${appUrl}/ui`,
      description: "LiteLLM admin UI - sign in as admin with the master key",
    });
    new cdk.CfnOutput(this, "MasterKeySecretArn", {
      value: masterKey.secretArn,
      description: "Secrets Manager secret holding the master key (JSON field masterKey)",
    });
    new cdk.CfnOutput(this, "LogGroupName", { value: logGroup.logGroupName, description: "LiteLLM container logs" });
    new cdk.CfnOutput(this, "DatabaseEndpoint", {
      value: `${db.dbInstanceEndpointAddress}:${db.dbInstanceEndpointPort}`,
      description: "RDS PostgreSQL endpoint (private)",
    });
  }
}
