import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elasticache from "aws-cdk-lib/aws-elasticache";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

/**
 * Pinned upstream release. Bump deliberately: the migration container upgrades the
 * database to whatever schema the new tag ships, so a new tag is a schema change on the
 * customer's data, not just a new binary. The `-python3.12` suffix pins the interpreter
 * too — a bare `3.8.6` tag follows upstream's default Python.
 */
export const PREFECT_VERSION = "3.8.6";
export const PREFECT_IMAGE = `prefecthq/prefect:${PREFECT_VERSION}-python3.12`;

export const PREFECT_PORT = 4200;
/**
 * Returns `true` without touching the database, and is exempt from the basic-auth
 * middleware — liveness, not readiness. A server that cannot reach the database never
 * gets this far: it registers block types against it before it starts listening.
 */
export const HEALTH_PATH = "/api/health";
const DB_NAME = "prefect";
const REDIS_PORT = 6379;

/** The user half of the `user:password` basic-auth string. */
export const AUTH_USERNAME = "admin";

/**
 * Characters kept out of the generated database password.
 *
 * Prefect builds its connection URL itself from the discrete settings, through
 * SQLAlchemy's URL object, which escapes whatever it is given — so nothing here is
 * load-bearing for this stack. They are excluded anyway so the password stays safe to
 * paste into a hand-written `psql` URL or a shell when debugging.
 *
 * Deliberately *not* every punctuation character: Secrets Manager requires each
 * character type it has not been told to skip to appear in the password, and refuses to
 * generate one — "All characters of the desired type have been excluded" — when the
 * exclusions leave no punctuation to pick. That failed Umami's first real deploy
 * (SF-436). The four left in are RFC 3986's unreserved characters (`-` `.` `_` `~`).
 */
export const PASSWORD_EXCLUDED_CHARACTERS = " !\"#$%&'()*+,/:;<=>?@[\\]^`{|}";

/**
 * The web tier's start command, run as the image's CMD so its own entrypoint (tini, then
 * `entrypoint.sh`, which `exec`s its arguments) still wraps it.
 *
 * The one thing it composes is the basic-auth string. Prefect wants it as a single
 * `user:password` value, and Secrets Manager can only generate a field, not prefix one —
 * so the two halves arrive as ECS secrets and are joined here, keeping the password out
 * of the template and the task environment.
 *
 * `--no-services` because the background services run in their own task: see the
 * stack's doc comment.
 *
 * `$VAR` rather than `${VAR}`: this is a shell string, and `${` would be read as a CDK
 * token by anyone skimming it.
 */
export const API_START_COMMAND = [
  'export PREFECT_SERVER_API_AUTH_STRING="$API_AUTH_USERNAME:$API_AUTH_PASSWORD"',
  `exec prefect server start --host 0.0.0.0 --port ${PREFECT_PORT} --no-services`,
].join(" && ");

/** The only process that migrates the database. See the stack's doc comment. */
export const MIGRATE_COMMAND = ["prefect", "server", "database", "upgrade", "-y"];
export const SERVICES_COMMAND = ["prefect", "server", "services", "start"];

export interface PrefectStackProps extends cdk.StackProps {
  /** Fargate CPU units for each Prefect task (web and background services). Default 512. */
  cpu?: number;
  /** Fargate memory for each Prefect task, in MiB. Default 1024. */
  memoryMiB?: number;
  /**
   * Number of web (API + UI) tasks. Default 1. The background services task is always
   * exactly one — see the stack's doc comment.
   */
  desiredCount?: number;

  /** RDS instance class, with or without the `db.` prefix. Default `db.t4g.micro`. */
  dbInstanceType?: string;
  /** Standby in a second AZ. Doubles the database cost. Default false. */
  dbMultiAz?: boolean;

  /** Optional custom domain. HTTPS via ACM when set together with `hostedZoneId`. */
  domainName?: string;
  hostedZoneId?: string;

  /**
   * Delete the database with the stack instead of keeping a final snapshot.
   *
   * Off by default — deleting a stack should never silently take the customer's flow
   * run history with it. Verification runs, which deploy and tear down deliberately and
   * must leave nothing behind (TEARDOWN-NO-RETAINED-DATA), opt in.
   */
  destroyDataOnDelete?: boolean;
}

/**
 * Self-hosted Prefect server: the web tier and the background services as two Fargate
 * services, on RDS PostgreSQL, with Redis carrying events between them.
 *
 * The split follows upstream's own production guidance ("Scale self-hosted Prefect"):
 * `prefect server start --no-services` behind the load balancer, and one
 * `prefect server services start` process for the scheduler, late-run detection,
 * automations and the event persister. Splitting them is not free — out of the box the
 * two halves talk through an *in-process* message broker and lease store, so events the
 * API receives would never reach the process that persists them, and concurrency leases
 * the API grants would never be revoked. Redis replaces both, which is why it is here.
 *
 * Exactly one process migrates, because Prefect's migrations take no lock:
 * - `MIGRATE_ON_START` is off everywhere; the web tier never migrates, however many
 *   tasks it runs.
 * - The background services task runs a non-essential `Migrate` container first, and
 *   its `Services` container starts only once that exits cleanly. That service is pinned
 *   to one task and replaced stop-then-start, so there is never a second migrator — nor a
 *   second scheduler, which with Prefect's default in-memory coordination would schedule
 *   every run twice.
 * - The web service depends on the services service, so on create and on every image
 *   bump CloudFormation migrates the schema before the new web tier rolls out.
 *
 * The OSS server has no user accounts. Prefect's built-in basic auth is therefore
 * mandatory here, not an option: the credential is generated in Secrets Manager, and the
 * UI prompts for it.
 */
export class PrefectStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PrefectStackProps = {}) {
    super(scope, id, props);

    const {
      cpu = 512,
      memoryMiB = 1024,
      desiredCount = 1,
      dbInstanceType = "db.t4g.micro",
      dbMultiAz = false,
      domainName,
      hostedZoneId,
      destroyDataOnDelete = false,
    } = props;

    // One NAT gateway: the tasks need egress to pull the image from Docker Hub, and a
    // second one buys AZ-level egress redundancy a single-tenant orchestrator does not need.
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "Private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: "Data", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const albSg = new ec2.SecurityGroup(this, "AlbSG", { vpc, description: "Prefect load balancer" });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "HTTP");
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS");

    const apiSg = new ec2.SecurityGroup(this, "ApiSG", { vpc, description: "Prefect web tasks" });
    apiSg.addIngressRule(albSg, ec2.Port.tcp(PREFECT_PORT), "From the load balancer");

    // Nothing connects to the background services; they only connect out.
    const servicesSg = new ec2.SecurityGroup(this, "ServicesSG", { vpc, description: "Prefect background services" });

    const dbSg = new ec2.SecurityGroup(this, "DbSG", {
      vpc,
      description: "Prefect database",
      allowAllOutbound: false,
    });
    const redisSg = new ec2.SecurityGroup(this, "RedisSG", {
      vpc,
      description: "Prefect event broker",
      allowAllOutbound: false,
    });
    for (const [peer, name] of [
      [apiSg, "web"],
      [servicesSg, "background services"],
    ] as const) {
      dbSg.addIngressRule(peer, ec2.Port.tcp(5432), `Postgres from Prefect ${name}`);
      redisSg.addIngressRule(peer, ec2.Port.tcp(REDIS_PORT), `Redis from Prefect ${name}`);
    }

    // Alphanumeric only: it is typed into the UI's sign-in box and into clients' env.
    const authSecret = new secretsmanager.Secret(this, "AuthSecret", {
      description: "Prefect server basic auth — sign in with <username>:<password>",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: AUTH_USERNAME }),
        generateStringKey: "password",
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    // ElastiCache allows only `! & # $ ^ < > -` in an AUTH token; none is worth the risk.
    const redisSecret = new secretsmanager.Secret(this, "RedisAuthSecret", {
      description: "Prefect Redis AUTH token",
      generateSecretString: {
        secretStringTemplate: "{}",
        generateStringKey: "authToken",
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
      credentials: rds.Credentials.fromGeneratedSecret("prefect", {
        excludeCharacters: PASSWORD_EXCLUDED_CHARACTERS,
      }),
      backupRetention: cdk.Duration.days(7),
      deleteAutomatedBackups: destroyDataOnDelete,
      deletionProtection: false,
      removalPolicy: dataRemovalPolicy,
    });
    const dbSecret = db.secret!;

    // Holds events in flight and concurrency leases — nothing that outlives a restart
    // matters, so one node, no snapshots, and nothing to keep on delete.
    const redisSubnets = new elasticache.CfnSubnetGroup(this, "RedisSubnets", {
      description: "Prefect event broker",
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
    });
    const redis = new elasticache.CfnReplicationGroup(this, "Redis", {
      replicationGroupDescription: "Prefect event broker",
      engine: "redis",
      engineVersion: "7.1",
      cacheNodeType: "cache.t4g.micro",
      numCacheClusters: 1,
      automaticFailoverEnabled: false,
      cacheSubnetGroupName: redisSubnets.ref,
      securityGroupIds: [redisSg.securityGroupId],
      port: REDIS_PORT,
      atRestEncryptionEnabled: true,
      transitEncryptionEnabled: true,
      // A dynamic reference: CloudFormation resolves it at deploy time, so the token
      // itself never appears in the template.
      authToken: redisSecret.secretValueFromJson("authToken").unsafeUnwrap(),
    });

    const cluster = new ecs.Cluster(this, "Cluster", { vpc });

    const logGroup = new logs.LogGroup(this, "Logs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });
    const useCustomDomain = Boolean(domainName && hostedZoneId);
    // Known before any listener exists: the UI is told where its API lives through the
    // environment, and the ALB's DNS name is a deploy-time token, which is fine there.
    const appUrl = useCustomDomain ? `https://${domainName}` : `http://${alb.loadBalancerDnsName}`;
    const apiUrl = `${appUrl}/api`;

    /**
     * Database settings every process shares. Discrete settings rather than a URL:
     * Prefect composes `postgresql+asyncpg://…` itself, so no shell has to.
     *
     * `PGSSLMODE`: RDS for PostgreSQL 15+ refuses unencrypted connections, and Prefect's
     * own TLS switch (`…_CONNECT_ARGS_TLS_ENABLED`) always verifies the certificate
     * against the system trust store, which does not carry the RDS certificate
     * authority. asyncpg reads `PGSSLMODE` when it is handed no `ssl` argument — which
     * Prefect only passes when that switch is on — and `require` encrypts without
     * verifying, the same trade Umami makes with `no-verify`.
     */
    const dbEnvironment = {
      PREFECT_SERVER_DATABASE_DRIVER: "postgresql+asyncpg",
      PREFECT_SERVER_DATABASE_HOST: db.dbInstanceEndpointAddress,
      PREFECT_SERVER_DATABASE_PORT: db.dbInstanceEndpointPort,
      PREFECT_SERVER_DATABASE_NAME: DB_NAME,
      PREFECT_SERVER_DATABASE_MIGRATE_ON_START: "false",
      PGSSLMODE: "require",
      PREFECT_SERVER_ANALYTICS_ENABLED: "false",
    };
    const dbSecrets = {
      PREFECT_SERVER_DATABASE_USER: ecs.Secret.fromSecretsManager(dbSecret, "username"),
      PREFECT_SERVER_DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, "password"),
    };

    /**
     * Redis as the events broker, events cache, causal ordering and lease store — the
     * four in-process defaults that stop working once the web tier and the services run
     * apart. The `redis` extra that provides `prefect_redis` ships in the official image.
     *
     * The empty username sends ElastiCache the single-argument `AUTH <token>` it
     * documents; prefect-redis would otherwise send `AUTH default <token>`.
     *
     * Docket stays on its in-memory default on purpose: upstream only needs it in Redis
     * for more than one background-services process, and there is exactly one.
     */
    const redisEnvironment = {
      PREFECT_SERVER_EVENTS_MESSAGING_BROKER: "prefect_redis.messaging",
      PREFECT_SERVER_EVENTS_MESSAGING_CACHE: "prefect_redis.messaging",
      PREFECT_SERVER_EVENTS_CAUSAL_ORDERING: "prefect_redis.ordering",
      PREFECT_SERVER_CONCURRENCY_LEASE_STORAGE: "prefect_redis.lease_storage",
      PREFECT_REDIS_MESSAGING_HOST: redis.attrPrimaryEndPointAddress,
      PREFECT_REDIS_MESSAGING_PORT: redis.attrPrimaryEndPointPort,
      PREFECT_REDIS_MESSAGING_SSL: "true",
      PREFECT_REDIS_MESSAGING_USERNAME: "",
    };
    const redisSecrets = {
      PREFECT_REDIS_MESSAGING_PASSWORD: ecs.Secret.fromSecretsManager(redisSecret, "authToken"),
    };

    // --- Background services: migrate once, then run the loop services ---

    const servicesTaskDef = new ecs.FargateTaskDefinition(this, "ServicesTaskDef", {
      cpu,
      memoryLimitMiB: memoryMiB,
    });
    const migrate = servicesTaskDef.addContainer("Migrate", {
      image: ecs.ContainerImage.fromRegistry(PREFECT_IMAGE),
      command: MIGRATE_COMMAND,
      // Exits when the schema is current; the task must outlive it.
      essential: false,
      environment: dbEnvironment,
      secrets: dbSecrets,
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "migrate" }),
    });
    const services = servicesTaskDef.addContainer("Services", {
      image: ecs.ContainerImage.fromRegistry(PREFECT_IMAGE),
      command: SERVICES_COMMAND,
      environment: {
        ...dbEnvironment,
        ...redisEnvironment,
        // Links in automation notifications point here.
        PREFECT_UI_URL: appUrl,
      },
      secrets: { ...dbSecrets, ...redisSecrets },
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "services" }),
    });
    // A failed migration leaves this container unstarted, the task stops, and the
    // circuit breaker rolls the deploy back rather than running on a half-migrated schema.
    services.addContainerDependencies({ container: migrate, condition: ecs.ContainerDependencyCondition.SUCCESS });

    const servicesService = new ecs.FargateService(this, "ServicesService", {
      cluster,
      taskDefinition: servicesTaskDef,
      // Always one: the migrator and the scheduler must both be singletons.
      desiredCount: 1,
      securityGroups: [servicesSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      circuitBreaker: { rollback: true },
      // Stop the old task before starting the new one, so a deploy never overlaps two.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
    });
    servicesService.node.addDependency(db, redis);

    // --- Web tier: API + UI behind the load balancer ---

    const apiTaskDef = new ecs.FargateTaskDefinition(this, "ApiTaskDef", { cpu, memoryLimitMiB: memoryMiB });
    apiTaskDef.addContainer("Api", {
      image: ecs.ContainerImage.fromRegistry(PREFECT_IMAGE),
      command: ["sh", "-c", API_START_COMMAND],
      portMappings: [{ containerPort: PREFECT_PORT }],
      environment: {
        ...dbEnvironment,
        ...redisEnvironment,
        // Where the browser UI sends its API calls. Unset, it defaults to the bind
        // address (`http://0.0.0.0:4200/api`), which no browser can reach.
        PREFECT_SERVER_UI_API_URL: apiUrl,
        PREFECT_UI_URL: appUrl,
      },
      secrets: {
        ...dbSecrets,
        ...redisSecrets,
        API_AUTH_USERNAME: ecs.Secret.fromSecretsManager(authSecret, "username"),
        API_AUTH_PASSWORD: ecs.Secret.fromSecretsManager(authSecret, "password"),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "api" }),
    });

    const apiService = new ecs.FargateService(this, "ApiService", {
      cluster,
      taskDefinition: apiTaskDef,
      desiredCount,
      securityGroups: [apiSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      // Python start-up plus block-type registration against the database.
      healthCheckGracePeriod: cdk.Duration.minutes(2),
      // A task that can never become healthy fails the deploy in minutes and rolls back,
      // instead of CloudFormation waiting out its three-hour stabilisation timeout.
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
    });
    // The schema must be migrated before any web task reads it.
    apiService.node.addDependency(servicesService);

    const targetProps: elbv2.AddApplicationTargetsProps = {
      port: PREFECT_PORT,
      // CDK only infers a protocol for 80 and 443; without this, synthesis throws.
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [apiService],
      healthCheck: {
        path: HEALTH_PATH,
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    };

    if (useCustomDomain) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
        hostedZoneId: hostedZoneId!,
        zoneName: domainName!.split(".").slice(-2).join("."),
      });
      const certificate = new acm.Certificate(this, "Certificate", {
        domainName: domainName!,
        validation: acm.CertificateValidation.fromDns(zone),
      });
      alb.addListener("Https", { port: 443, certificates: [certificate] }).addTargets("Prefect", targetProps);
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
      alb.addListener("Http", { port: 80 }).addTargets("Prefect", targetProps);
    }

    new cdk.CfnOutput(this, "AppUrl", { value: appUrl, description: "Prefect UI URL" });
    new cdk.CfnOutput(this, "ApiUrl", {
      value: apiUrl,
      description: "Set as PREFECT_API_URL on workers and clients",
    });
    new cdk.CfnOutput(this, "AuthSecretArn", {
      value: authSecret.secretArn,
      description:
        "Secrets Manager secret holding the sign-in. Enter <username>:<password> in the UI; set the same string as PREFECT_API_AUTH_STRING on workers and clients",
    });
    new cdk.CfnOutput(this, "LogGroupName", { value: logGroup.logGroupName, description: "Prefect container logs" });
    new cdk.CfnOutput(this, "DatabaseEndpoint", {
      value: `${db.dbInstanceEndpointAddress}:${db.dbInstanceEndpointPort}`,
      description: "RDS PostgreSQL endpoint (private)",
    });
  }
}
