import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

/**
 * Pinned upstream release. Bump deliberately: the container migrates the database on
 * boot, so a new tag is a schema change on the customer's data, not just a new binary.
 */
export const UMAMI_VERSION = "3.4.0";
export const UMAMI_IMAGE = `ghcr.io/umami-software/umami:${UMAMI_VERSION}`;

export const UMAMI_PORT = 3000;
/** Returns `{"ok":true}` without touching the database — liveness, not readiness. */
export const HEALTH_PATH = "/api/heartbeat";
const DB_NAME = "umami";

/**
 * Characters kept out of the generated database password. The container composes the
 * connection URLs at start-up with a plain shell substitution and no percent-encoding,
 * so anything that could mean something inside a URL or a double-quoted shell string is
 * excluded rather than escaped.
 *
 * Deliberately *not* every punctuation character: Secrets Manager requires each
 * character type it has not been told to skip to appear in the password, and refuses to
 * generate one — "All characters of the desired type have been excluded" — when the
 * exclusions leave no punctuation to pick. That failed the first real deploy (SF-436).
 * The four left in are RFC 3986's unreserved characters (`-` `.` `_` `~`): legal in a
 * URL's userinfo without encoding, and inert inside double quotes in sh.
 */
export const PASSWORD_EXCLUDED_CHARACTERS = " !\"#$%&'()*+,/:;<=>?@[\\]^`{|}";

/**
 * The image's own start script, run after the connection URLs are composed from the
 * discrete variables and secrets below — so the password reaches the process as an ECS
 * secret and never appears in the template or the task definition's environment.
 *
 * Two URLs because two drivers read them:
 * - `DATABASE_URL` is read by node-postgres (Prisma's `pg` adapter) for the app and for
 *   check-db.js's connection test. RDS for PostgreSQL 15+ refuses unencrypted
 *   connections, and node-postgres treats `sslmode=require` as full verification, which
 *   fails against the RDS certificate authority Node does not ship. `no-verify` encrypts
 *   without verifying.
 * - `DIRECT_DATABASE_URL` is what check-db.js hands to `prisma migrate deploy`. Prisma's
 *   schema engine does not know `no-verify`, and its `require` already accepts the RDS
 *   certificate.
 *
 * `$VAR` rather than `${VAR}`: this is a shell string, and `${` would be read as a CDK
 * token by anyone skimming it.
 */
export const START_COMMAND = [
  'BASE="postgresql://$DB_USERNAME:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME"',
  'export DATABASE_URL="$BASE?sslmode=no-verify"',
  'export DIRECT_DATABASE_URL="$BASE?sslmode=require"',
  "exec sh scripts/start-docker.sh",
].join(" && ");

export interface UmamiStackProps extends cdk.StackProps {
  /** Fargate CPU units for the Umami task. Default 512. */
  cpu?: number;
  /** Fargate memory for the Umami task, in MiB. Default 1024. */
  memoryMiB?: number;
  /** Number of Umami tasks. Default 1. Migrations run on every boot and take a lock. */
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
   * Off by default — deleting a stack should never silently take the customer's
   * analytics with it. Verification runs, which deploy and tear down deliberately and
   * must leave nothing behind (TEARDOWN-NO-RETAINED-DATA), opt in.
   */
  destroyDataOnDelete?: boolean;
}

/**
 * Self-hosted Umami: one Fargate service behind an ALB, on RDS PostgreSQL.
 *
 * The walking skeleton for the Deploy-to-Stackform shortlist (SF-436), so it is
 * deliberately the plainest correct shape: tasks and database in private subnets, the
 * load balancer the only thing the internet can reach, secrets from Secrets Manager.
 * Umami needs no Redis or object storage at this size.
 */
export class UmamiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: UmamiStackProps = {}) {
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

    // One NAT gateway: the tasks need egress to pull the image from ghcr.io, and a
    // second one buys AZ-level egress redundancy an analytics dashboard does not need.
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "Private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: "Data", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const albSg = new ec2.SecurityGroup(this, "AlbSG", { vpc, description: "Umami load balancer" });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "HTTP");
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS");

    const taskSg = new ec2.SecurityGroup(this, "TaskSG", { vpc, description: "Umami tasks" });
    taskSg.addIngressRule(albSg, ec2.Port.tcp(UMAMI_PORT), "From the load balancer");

    const dbSg = new ec2.SecurityGroup(this, "DbSG", {
      vpc,
      description: "Umami database",
      allowAllOutbound: false,
    });
    dbSg.addIngressRule(taskSg, ec2.Port.tcp(5432), "Postgres from Umami tasks");

    // Signs Umami's auth tokens and salts visitor hashes. Umami falls back to a hash of
    // DATABASE_URL when this is unset, which would tie both to the database password.
    const appSecret = new secretsmanager.Secret(this, "AppSecret", {
      description: "Umami APP_SECRET",
      generateSecretString: {
        secretStringTemplate: "{}",
        generateStringKey: "appSecret",
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
      credentials: rds.Credentials.fromGeneratedSecret("umami", {
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
    taskDef.addContainer("Umami", {
      image: ecs.ContainerImage.fromRegistry(UMAMI_IMAGE),
      entryPoint: ["sh", "-c"],
      command: [START_COMMAND],
      portMappings: [{ containerPort: UMAMI_PORT }],
      environment: {
        DB_HOST: db.dbInstanceEndpointAddress,
        DB_PORT: db.dbInstanceEndpointPort,
        DB_NAME,
        DISABLE_TELEMETRY: "1",
      },
      secrets: {
        DB_USERNAME: ecs.Secret.fromSecretsManager(dbSecret, "username"),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, "password"),
        APP_SECRET: ecs.Secret.fromSecretsManager(appSecret, "appSecret"),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "umami" }),
    });

    const service = new ecs.FargateService(this, "Service", {
      cluster,
      taskDefinition: taskDef,
      desiredCount,
      securityGroups: [taskSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      // The first boot migrates an empty database before the server listens.
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
    });

    const targetProps: elbv2.AddApplicationTargetsProps = {
      port: UMAMI_PORT,
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
      alb.addListener("Https", { port: 443, certificates: [certificate] }).addTargets("Umami", targetProps);
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
      alb.addListener("Http", { port: 80 }).addTargets("Umami", targetProps);
      appUrl = `http://${alb.loadBalancerDnsName}`;
    }

    new cdk.CfnOutput(this, "AppUrl", { value: appUrl, description: "Umami dashboard URL" });
    new cdk.CfnOutput(this, "DefaultLogin", {
      value: "admin / umami - change it immediately under Settings > Profile",
      description: "Umami creates this account on first boot",
    });
    new cdk.CfnOutput(this, "LogGroupName", { value: logGroup.logGroupName, description: "Umami container logs" });
    new cdk.CfnOutput(this, "DatabaseEndpoint", {
      value: `${db.dbInstanceEndpointAddress}:${db.dbInstanceEndpointPort}`,
      description: "RDS PostgreSQL endpoint (private)",
    });
  }
}
