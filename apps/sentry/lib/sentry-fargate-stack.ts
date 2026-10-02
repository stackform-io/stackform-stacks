import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elasticache from "aws-cdk-lib/aws-elasticache";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as cr from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";

// Pinned Sentry self-hosted release (must match EC2 construct)
const SENTRY_RELEASE = "24.11.1";
const SENTRY_IMAGE = `getsentry/sentry:${SENTRY_RELEASE}`;

export interface SentryFargateStackProps extends cdk.StackProps {
  // Compute
  webCpu?: number; // default: 512
  webMemory?: number; // default: 1024
  workerCpu?: number; // default: 256
  workerMemory?: number; // default: 512
  webDesiredCount?: number; // default: 1

  // Database
  dbInstanceType?: string; // default: db.t3.medium
  dbMultiAz?: boolean; // default: false

  // Cache
  cacheNodeType?: string; // default: cache.t3.micro

  // VPC / Network
  vpcMode: "new" | "existing";
  vpcId?: string;
  subnetType: "public" | "private"; // default: private (recommended)

  // Domain / SSL
  domainName?: string;
  hostedZoneId?: string;

  // Sentry
  sentryProfile: "errors-only" | "full";

  // Env var overrides
  envVarOverrides?: Record<string, string>;
}

export class SentryFargateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SentryFargateStackProps) {
    super(scope, id, props);

    const {
      webCpu = 512,
      webMemory = 1024,
      workerCpu = 256,
      workerMemory = 512,
      webDesiredCount = 1,
      dbInstanceType = "db.t3.medium",
      dbMultiAz = false,
      cacheNodeType = "cache.t3.micro",
      vpcMode,
      vpcId,
      subnetType: _subnetType = "private",
      domainName,
      hostedZoneId,
      sentryProfile,
      envVarOverrides,
    } = props;

    // ========================================
    // VPC
    // ========================================
    let vpc: ec2.IVpc;
    if (vpcMode === "existing" && vpcId) {
      vpc = ec2.Vpc.fromLookup(this, "ExistingVpc", { vpcId });
    } else {
      vpc = new ec2.Vpc(this, "SentryVpc", {
        maxAzs: 2,
        natGateways: 1,
        subnetConfiguration: [
          {
            name: "Public",
            subnetType: ec2.SubnetType.PUBLIC,
            cidrMask: 24,
          },
          {
            name: "Private",
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
            cidrMask: 24,
          },
        ],
      });
    }

    // ========================================
    // Security Groups
    // ========================================
    const albSg = new ec2.SecurityGroup(this, "AlbSG", {
      vpc,
      description: "ALB security group",
      allowAllOutbound: true,
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "HTTP");
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS");

    const ecsSg = new ec2.SecurityGroup(this, "EcsSG", {
      vpc,
      description: "ECS Fargate tasks security group",
      allowAllOutbound: true,
    });
    ecsSg.addIngressRule(albSg, ec2.Port.tcp(9000), "From ALB to Sentry web");

    const dbSg = new ec2.SecurityGroup(this, "DbSG", {
      vpc,
      description: "RDS Postgres security group",
      allowAllOutbound: false,
    });
    dbSg.addIngressRule(ecsSg, ec2.Port.tcp(5432), "Postgres from ECS");

    const cacheSg = new ec2.SecurityGroup(this, "CacheSG", {
      vpc,
      description: "ElastiCache Redis security group",
      allowAllOutbound: false,
    });
    cacheSg.addIngressRule(ecsSg, ec2.Port.tcp(6379), "Redis from ECS");

    // ========================================
    // Secrets Manager
    // ========================================
    const sentrySecret = new secretsmanager.Secret(this, "SentrySecretKey", {
      description: "Sentry SECRET_KEY for cryptographic signing",
      generateSecretString: {
        secretStringTemplate: "{}",
        generateStringKey: "secretKey",
        excludePunctuation: true,
        passwordLength: 64,
      },
    });

    // ========================================
    // RDS Postgres
    // ========================================
    const dbInstance = new rds.DatabaseInstance(this, "SentryPostgres", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_15,
      }),
      // RDS renders `db.` in front of whatever instance type it is handed, so a value
      // that already carries the prefix synthesises as `db.db.t3.medium` and
      // CloudFormation rejects it (SF-501). The prop is documented as `db.t3.medium`,
      // so both spellings arrive in practice and both have to work.
      instanceType: new ec2.InstanceType(dbInstanceType.replace(/^db\./, "")),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [dbSg],
      multiAz: dbMultiAz,
      allocatedStorage: 50,
      maxAllocatedStorage: 200,
      storageEncrypted: true,
      databaseName: "sentry",
      credentials: rds.Credentials.fromGeneratedSecret("sentry", {
        secretName: `sentry/db-credentials`,
      }),
      backupRetention: cdk.Duration.days(7),
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });

    // ========================================
    // ElastiCache Redis
    // ========================================
    const cacheSubnetGroup = new elasticache.CfnSubnetGroup(this, "RedisCacheSubnetGroup", {
      description: "Sentry Redis subnet group",
      subnetIds: vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      }).subnetIds,
    });

    const redisCluster = new elasticache.CfnCacheCluster(this, "SentryRedis", {
      engine: "redis",
      cacheNodeType,
      numCacheNodes: 1,
      cacheSubnetGroupName: cacheSubnetGroup.ref,
      vpcSecurityGroupIds: [cacheSg.securityGroupId],
    });

    const redisEndpoint = `${redisCluster.attrRedisEndpointAddress}:${redisCluster.attrRedisEndpointPort}`;

    // ========================================
    // S3 Bucket (file storage)
    // ========================================
    const fileStorageBucket = new s3.Bucket(this, "SentryFileStorage", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          transitions: [
            {
              storageClass: s3.StorageClass.INTELLIGENT_TIERING,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
        },
      ],
    });

    // ========================================
    // ECS Cluster
    // ========================================
    const cluster = new ecs.Cluster(this, "SentryCluster", {
      vpc,
      containerInsights: true,
    });

    const logGroup = new logs.LogGroup(this, "SentryLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ========================================
    // Shared environment variables
    // ========================================
    const dbSecret = dbInstance.secret!;
    const dbHost = dbInstance.dbInstanceEndpointAddress;
    const dbPort = dbInstance.dbInstanceEndpointPort;

    // Build shared env vars for all Sentry services. SENTRY_SECRET_KEY is not here: each
    // container gets it as a secret, and ECS rejects a task definition that sets one name
    // as both an environment variable and a secret.
    const sharedEnv: Record<string, string> = {
      SENTRY_POSTGRES_HOST: dbHost,
      SENTRY_POSTGRES_PORT: dbPort,
      SENTRY_DB_NAME: "sentry",
      SENTRY_REDIS_HOST: redisCluster.attrRedisEndpointAddress,
      SENTRY_REDIS_PORT: redisCluster.attrRedisEndpointPort,
      SENTRY_FILESTORE_BACKEND: "s3",
      SENTRY_FILESTORE_OPTIONS_BUCKET_NAME: fileStorageBucket.bucketName,
      SENTRY_FILESTORE_OPTIONS_LOCATION: "files",
      ...(sentryProfile === "errors-only" ? { COMPOSE_PROFILES: "errors-only" } : {}),
      ...(envVarOverrides || {}),
    };

    // ========================================
    // Helper: create a Fargate service
    // ========================================
    const createService = (
      serviceName: string,
      image: string,
      command: string[],
      cpu: number,
      memory: number,
      desiredCount: number = 1,
      healthCheckPath?: string,
    ): ecs.FargateService => {
      const taskDef = new ecs.FargateTaskDefinition(this, `${serviceName}TaskDef`, {
        cpu,
        memoryLimitMiB: memory,
      });

      const container = taskDef.addContainer(`${serviceName}Container`, {
        image: ecs.ContainerImage.fromRegistry(image),
        command,
        environment: sharedEnv,
        secrets: {
          SENTRY_SECRET_KEY: ecs.Secret.fromSecretsManager(sentrySecret, "secretKey"),
          SENTRY_DB_USER: ecs.Secret.fromSecretsManager(dbSecret, "username"),
          SENTRY_DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, "password"),
        },
        logging: ecs.LogDrivers.awsLogs({
          logGroup,
          streamPrefix: serviceName.toLowerCase(),
        }),
        ...(healthCheckPath
          ? {
              healthCheck: {
                command: ["CMD-SHELL", `curl -sf http://localhost:9000${healthCheckPath} || exit 1`],
                interval: cdk.Duration.seconds(30),
                timeout: cdk.Duration.seconds(10),
                retries: 3,
                startPeriod: cdk.Duration.seconds(120),
              },
            }
          : {}),
      });

      if (healthCheckPath) {
        container.addPortMappings({ containerPort: 9000 });
      }

      // Grant S3 access for file storage
      fileStorageBucket.grantReadWrite(taskDef.taskRole);

      const service = new ecs.FargateService(this, `${serviceName}Service`, {
        cluster,
        taskDefinition: taskDef,
        desiredCount,
        securityGroups: [ecsSg],
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        assignPublicIp: false,
      });

      return service;
    };

    // ========================================
    // Sentry Web Service
    // ========================================
    const webService = createService(
      "SentryWeb",
      SENTRY_IMAGE,
      ["run", "web"],
      webCpu,
      webMemory,
      webDesiredCount,
      "/_health/",
    );

    // ========================================
    // Sentry Worker Service
    // ========================================
    createService("SentryWorker", SENTRY_IMAGE, ["run", "worker"], workerCpu, workerMemory, 1);

    // ========================================
    // Sentry Cron Service
    // ========================================
    createService("SentryCron", SENTRY_IMAGE, ["run", "cron"], 256, 512, 1);

    // ========================================
    // ALB
    // ========================================
    const alb = new elbv2.ApplicationLoadBalancer(this, "SentryALB", {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // HTTPS listener (with ACM cert) or HTTP listener
    let sentryUrl: string;
    let hostedZone: route53.IHostedZone | undefined;

    if (domainName && hostedZoneId) {
      hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, "HostedZone", {
        hostedZoneId,
        zoneName: domainName.split(".").slice(-2).join("."),
      });

      const certificate = new acm.Certificate(this, "SentryCert", {
        domainName,
        validation: acm.CertificateValidation.fromDns(hostedZone),
      });

      // HTTPS listener
      const httpsListener = alb.addListener("HttpsListener", {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [certificate],
      });
      httpsListener.addTargets("SentryWebTarget", {
        port: 9000,
        // Sentry's web container listens on 9000, and CDK only infers a protocol for
        // 80 and 443 — without this, synthesis throws DonTKnowDefaultProtocol and the
        // Optimized tier cannot be deployed at all.
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [webService],
        healthCheck: {
          path: "/_health/",
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(10),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 3,
        },
      });

      // HTTP → HTTPS redirect
      alb.addListener("HttpRedirect", {
        port: 80,
        defaultAction: elbv2.ListenerAction.redirect({
          protocol: "HTTPS",
          port: "443",
          permanent: true,
        }),
      });

      // Route53 alias
      new route53.ARecord(this, "SentryDnsRecord", {
        zone: hostedZone,
        recordName: domainName,
        target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(alb)),
      });

      sentryUrl = `https://${domainName}`;
    } else {
      // HTTP-only listener (no custom domain)
      const httpListener = alb.addListener("HttpListener", {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
      });
      httpListener.addTargets("SentryWebTarget", {
        port: 9000,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [webService],
        healthCheck: {
          path: "/_health/",
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(10),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 3,
        },
      });

      sentryUrl = `http://${alb.loadBalancerDnsName}`;
    }

    // ========================================
    // Sentry Migration (one-off ECS task via Custom Resource)
    // ========================================
    const migrationTaskDef = new ecs.FargateTaskDefinition(this, "MigrationTaskDef", {
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    migrationTaskDef.addContainer("MigrationContainer", {
      image: ecs.ContainerImage.fromRegistry(SENTRY_IMAGE),
      command: ["upgrade", "--noinput"],
      environment: sharedEnv,
      secrets: {
        SENTRY_SECRET_KEY: ecs.Secret.fromSecretsManager(sentrySecret, "secretKey"),
        SENTRY_DB_USER: ecs.Secret.fromSecretsManager(dbSecret, "username"),
        SENTRY_DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, "password"),
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: "migration",
      }),
    });
    fileStorageBucket.grantReadWrite(migrationTaskDef.taskRole);

    // Run migration as a Custom Resource (executes on every deploy)
    const migrationRunner = new cr.AwsCustomResource(this, "SentryMigration", {
      onCreate: {
        service: "ECS",
        action: "runTask",
        parameters: {
          cluster: cluster.clusterArn,
          taskDefinition: migrationTaskDef.taskDefinitionArn,
          launchType: "FARGATE",
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: vpc.selectSubnets({
                subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
              }).subnetIds,
              securityGroups: [ecsSg.securityGroupId],
              assignPublicIp: "DISABLED",
            },
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of(`sentry-migration-${Date.now()}`),
      },
      onUpdate: {
        service: "ECS",
        action: "runTask",
        parameters: {
          cluster: cluster.clusterArn,
          taskDefinition: migrationTaskDef.taskDefinitionArn,
          launchType: "FARGATE",
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: vpc.selectSubnets({
                subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
              }).subnetIds,
              securityGroups: [ecsSg.securityGroupId],
              assignPublicIp: "DISABLED",
            },
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of(`sentry-migration-${Date.now()}`),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ["ecs:RunTask"],
          resources: [migrationTaskDef.taskDefinitionArn],
        }),
        new iam.PolicyStatement({
          actions: ["iam:PassRole"],
          resources: [migrationTaskDef.taskRole.roleArn, migrationTaskDef.executionRole!.roleArn],
        }),
      ]),
    });

    // Migration must run after RDS and Redis are ready, before web service starts
    migrationRunner.node.addDependency(dbInstance);
    migrationRunner.node.addDependency(redisCluster);

    // Web service waits for migration
    webService.node.addDependency(migrationRunner);

    // ========================================
    // Auto-scaling (web service only)
    // ========================================
    const scaling = webService.autoScaleTaskCount({
      minCapacity: webDesiredCount,
      maxCapacity: Math.max(webDesiredCount * 3, 3),
    });
    scaling.scaleOnCpuUtilization("CpuScaling", {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(300),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    // ========================================
    // Outputs
    // ========================================
    new cdk.CfnOutput(this, "AppUrl", {
      value: sentryUrl,
      description: "Sentry web interface URL",
    });

    new cdk.CfnOutput(this, "ALBDnsName", {
      value: alb.loadBalancerDnsName,
      description: "ALB DNS name",
    });

    new cdk.CfnOutput(this, "ECSClusterName", {
      value: cluster.clusterName,
      description: "ECS cluster name",
    });

    new cdk.CfnOutput(this, "RDSEndpoint", {
      value: `${dbHost}:${dbPort}`,
      description: "RDS Postgres endpoint",
    });

    new cdk.CfnOutput(this, "RedisEndpoint", {
      value: redisEndpoint,
      description: "ElastiCache Redis endpoint",
    });

    new cdk.CfnOutput(this, "FileStorageBucket", {
      value: fileStorageBucket.bucketName,
      description: "S3 bucket for Sentry file storage",
    });

    new cdk.CfnOutput(this, "LogGroupName", {
      value: logGroup.logGroupName,
      description: "CloudWatch log group for Sentry services",
    });

    new cdk.CfnOutput(this, "CreateSuperuserCommand", {
      value: [
        `aws ecs run-task`,
        `--cluster ${cluster.clusterName}`,
        `--task-definition ${migrationTaskDef.taskDefinitionArn}`,
        `--launch-type FARGATE`,
        `--overrides '{"containerOverrides":[{"name":"MigrationContainer","command":["createuser","--superuser","--email","admin@example.com","--no-input"]}]}'`,
        `--network-configuration '{"awsvpcConfiguration":{"subnets":${JSON.stringify(
          vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
        )},"securityGroups":["${ecsSg.securityGroupId}"],"assignPublicIp":"DISABLED"}}'`,
      ].join(" \\\n  "),
      description: "Command to create Sentry superuser (update email before running)",
    });
  }
}
