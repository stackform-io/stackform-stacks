import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import type { Construct } from "constructs";

/**
 * Pinned upstream release. Bump deliberately: the container migrates the database on
 * boot, so a new tag is a schema change on the customer's data, not just a new binary.
 *
 * The `-slim` variant leaves out Chromium and the embedded MariaDB. Neither is used
 * here — the database is RDS — and the "real browser" monitor type they enable needs
 * more memory than this task is sized for.
 */
export const UPTIME_KUMA_VERSION = "2.5.5";
export const UPTIME_KUMA_IMAGE = `louislam/uptime-kuma:${UPTIME_KUMA_VERSION}-slim`;

export const UPTIME_KUMA_PORT = 3001;
/**
 * Unauthenticated, and answers `{"type":"entryPage",...}` with a 200 once the server is
 * listening — which it only does after the database is connected and migrated. The root
 * path would redirect (302) to the setup wizard or the dashboard instead.
 */
export const HEALTH_PATH = "/api/entry-page";
const DB_NAME = "kuma";
export const MARIADB_VERSION = "11.8.8";

/**
 * Characters kept out of the generated database password.
 *
 * Uptime Kuma reads the password from its own variable, not from a URL, so nothing in
 * this stack needs these gone. They are excluded for whoever has to connect by hand
 * during a recovery: a password that survives a shell command line and a MySQL URL
 * unescaped is one fewer thing to get wrong at the worst moment.
 *
 * Deliberately *not* every punctuation character: Secrets Manager requires each
 * character type it has not been told to skip to appear in the password, and refuses to
 * generate one — "All characters of the desired type have been excluded" — when the
 * exclusions leave no punctuation to pick. That failed Umami's first real deploy
 * (SF-436). The four left in are RFC 3986's unreserved characters (`-` `.` `_` `~`).
 */
export const PASSWORD_EXCLUDED_CHARACTERS = " !\"#$%&'()*+,/:;<=>?@[\\]^`{|}";

/** Where the start command writes the RDS certificate authorities for the driver. */
export const RDS_CA_FILE = "/tmp/rds-ca.pem";

/**
 * Writes the RDS certificate authorities to a file, points Uptime Kuma at it, then runs
 * the image's own start command (its CMD, `node server/server.js`, under the image's
 * dumb-init — see the entry point below).
 *
 * The database connection is TLS, and verified: MariaDB 11.8 on RDS refuses unencrypted
 * connections, and with `UPTIME_KUMA_DB_SSL=true` Uptime Kuma hands mysql2
 * `rejectUnauthorized: true` with no way to turn it off. Node does not ship the RDS
 * certificate authority, so without a CA every connection fails verification.
 *
 * The CAs come from `aws-ssl-profiles`, which the image already carries as a mysql2
 * dependency — no download at boot, nothing to reach but the database. Uptime Kuma reads
 * `UPTIME_KUMA_DB_CA_FILE` itself; the CA is public, so it is not a secret either way.
 * If a future image drops the package, `node -e` fails and the task exits saying so
 * rather than connecting unverified.
 */
export const START_COMMAND = [
  `node -e 'process.stdout.write(require("aws-ssl-profiles").ca.join("\\n"))' > ${RDS_CA_FILE}`,
  `export UPTIME_KUMA_DB_CA_FILE=${RDS_CA_FILE}`,
  "exec node server/server.js",
].join(" && ");

export interface UptimeKumaStackProps extends cdk.StackProps {
  /** Fargate CPU units for the Uptime Kuma task. Default 512. */
  cpu?: number;
  /** Fargate memory for the Uptime Kuma task, in MiB. Default 1024. */
  memoryMiB?: number;

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
   * monitoring history with it. Verification runs, which deploy and tear down
   * deliberately and must leave nothing behind (TEARDOWN-NO-RETAINED-DATA), opt in.
   */
  destroyDataOnDelete?: boolean;
}

/**
 * Self-hosted Uptime Kuma: one Fargate task behind an ALB, on RDS MariaDB.
 *
 * Uptime Kuma is a single-process, stateful server — it schedules every monitor itself
 * and upstream does not support running two against one database — so there is exactly
 * one task, and deployments stop the old task before starting the new one.
 *
 * No EFS. With MariaDB holding monitors, heartbeats, users and settings, `/app/data`
 * keeps only `db-config.json` (rewritten from the environment on every boot), uploaded
 * status-page logos, and files for features that cannot work on Fargate anyway (Docker
 * host TLS, browser screenshots). Losing a logo on task replacement is a re-upload; an
 * encrypted file system with mount targets, access points and its own teardown story
 * is not worth that.
 */
export class UptimeKumaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: UptimeKumaStackProps = {}) {
    super(scope, id, props);

    const {
      cpu = 512,
      memoryMiB = 1024,
      dbInstanceType = "db.t4g.micro",
      dbMultiAz = false,
      domainName,
      hostedZoneId,
      destroyDataOnDelete = false,
    } = props;

    // One NAT gateway: the task needs egress to pull the image from Docker Hub and, more
    // to the point, to reach whatever it monitors. A second one buys AZ-level egress
    // redundancy for a service that is itself a single task in a single AZ.
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "Private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: "Data", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const albSg = new ec2.SecurityGroup(this, "AlbSG", { vpc, description: "Uptime Kuma load balancer" });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "HTTP");
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS");

    // Outbound stays open: probing arbitrary hosts and ports is the application.
    const taskSg = new ec2.SecurityGroup(this, "TaskSG", { vpc, description: "Uptime Kuma task" });
    taskSg.addIngressRule(albSg, ec2.Port.tcp(UPTIME_KUMA_PORT), "From the load balancer");

    const dbSg = new ec2.SecurityGroup(this, "DbSG", {
      vpc,
      description: "Uptime Kuma database",
      allowAllOutbound: false,
    });
    dbSg.addIngressRule(taskSg, ec2.Port.tcp(3306), "MariaDB from the Uptime Kuma task");

    const dataRemovalPolicy = destroyDataOnDelete ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.SNAPSHOT;

    const db = new rds.DatabaseInstance(this, "Database", {
      // MariaDB because it is the external database Uptime Kuma 2 supports (it has no
      // PostgreSQL driver). 11.8 is the current LTS and, unlike 11.4, sets
      // require_secure_transport=ON by default. A full minor, because CloudFormation's
      // schema only lists full versions and the advisory pass rejects a bare "11.8"; RDS
      // still applies later minors itself (auto minor version upgrade is on).
      engine: rds.DatabaseInstanceEngine.mariaDb({ version: rds.MariaDbEngineVersion.of(MARIADB_VERSION, "11.8") }),
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
      credentials: rds.Credentials.fromGeneratedSecret("kuma", {
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
    taskDef.addContainer("UptimeKuma", {
      image: ecs.ContainerImage.fromRegistry(UPTIME_KUMA_IMAGE),
      // The image's own entry point, kept so dumb-init still reaps the ping and
      // traceroute children the monitors spawn and forwards SIGTERM to node on stop.
      entryPoint: ["/usr/bin/dumb-init", "--", "sh", "-c"],
      command: [START_COMMAND],
      portMappings: [{ containerPort: UPTIME_KUMA_PORT }],
      // Setting UPTIME_KUMA_DB_TYPE skips the database-setup wizard entirely: Uptime Kuma
      // writes these into data/db-config.json on every boot, so an ephemeral /app/data
      // is re-seeded rather than lost.
      environment: {
        UPTIME_KUMA_DB_TYPE: "mariadb",
        UPTIME_KUMA_DB_HOSTNAME: db.dbInstanceEndpointAddress,
        UPTIME_KUMA_DB_PORT: db.dbInstanceEndpointPort,
        UPTIME_KUMA_DB_NAME: DB_NAME,
        UPTIME_KUMA_DB_SSL: "true",
      },
      // Read directly by Uptime Kuma, so unlike Umami nothing has to compose a URL.
      secrets: {
        UPTIME_KUMA_DB_USERNAME: ecs.Secret.fromSecretsManager(dbSecret, "username"),
        UPTIME_KUMA_DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, "password"),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "uptime-kuma" }),
    });

    const service = new ecs.FargateService(this, "Service", {
      cluster,
      taskDefinition: taskDef,
      // Not configurable. A second task would run every monitor twice, send every alert
      // twice and race the first on migrations.
      desiredCount: 1,
      securityGroups: [taskSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      // The first boot creates the schema in an empty database before the server listens.
      healthCheckGracePeriod: cdk.Duration.minutes(5),
      // A task that can never become healthy fails the deploy in minutes and rolls back,
      // instead of CloudFormation waiting out its three-hour stabilisation timeout.
      circuitBreaker: { rollback: true },
      // Stop the old task before starting the new one, so there is never a moment with
      // two schedulers on one database. An update costs a minute or two of downtime.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
    });
    // The service must not start before its database exists to migrate.
    service.node.addDependency(db);

    // The dashboard is a Socket.IO app. ALBs pass WebSocket upgrades through without
    // configuration, and Socket.IO pings every 25 seconds, inside the default 60-second
    // idle timeout. No stickiness: there is only ever one target.
    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const targetProps: elbv2.AddApplicationTargetsProps = {
      port: UPTIME_KUMA_PORT,
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
      // One task, replaced rather than rolled: waiting the default five minutes for
      // connections to a task that is already being stopped only lengthens the outage.
      deregistrationDelay: cdk.Duration.seconds(10),
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
      alb.addListener("Https", { port: 443, certificates: [certificate] }).addTargets("UptimeKuma", targetProps);
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
      alb.addListener("Http", { port: 80 }).addTargets("UptimeKuma", targetProps);
      appUrl = `http://${alb.loadBalancerDnsName}`;
    }

    new cdk.CfnOutput(this, "AppUrl", { value: appUrl, description: "Uptime Kuma dashboard URL" });
    // Uptime Kuma has no default login: its setup page makes whoever submits it first the
    // admin. The page is public the moment the task is healthy, so the output says so.
    new cdk.CfnOutput(this, "FirstVisitCreatesAdmin", {
      value: "Open AppUrl now - the first visitor to the setup page becomes the admin",
      description: "Uptime Kuma has no default account; claim it before anyone else does",
    });
    new cdk.CfnOutput(this, "LogGroupName", {
      value: logGroup.logGroupName,
      description: "Uptime Kuma container logs",
    });
    new cdk.CfnOutput(this, "DatabaseEndpoint", {
      value: `${db.dbInstanceEndpointAddress}:${db.dbInstanceEndpointPort}`,
      description: "RDS MariaDB endpoint (private)",
    });
  }
}
