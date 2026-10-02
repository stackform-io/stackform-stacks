import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as route53 from "aws-cdk-lib/aws-route53";
import type { Construct } from "constructs";

// Pinned Sentry self-hosted release
const SENTRY_RELEASE = "24.11.1";

export interface SentryEc2StackProps extends cdk.StackProps {
  instanceType: string;
  volumeSizeGb: number;
  sentryProfile: "errors-only" | "full";
  vpcMode: "new" | "existing";
  vpcId?: string;
  subnetType: "public" | "private";
  sshKeyName?: string;
  domainName?: string;
  hostedZoneId?: string;
  sentryEventRetentionDays: number;
  envVarOverrides?: Record<string, string>;
}

export class SentryEc2Stack extends cdk.Stack {
  public readonly instance: ec2.Instance;

  constructor(scope: Construct, id: string, props: SentryEc2StackProps) {
    super(scope, id, props);

    const {
      instanceType,
      volumeSizeGb,
      sentryProfile,
      vpcMode,
      vpcId,
      subnetType,
      sshKeyName,
      domainName,
      hostedZoneId,
      sentryEventRetentionDays,
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
        natGateways: subnetType === "private" ? 1 : 0,
        subnetConfiguration: [
          {
            name: "Public",
            subnetType: ec2.SubnetType.PUBLIC,
            cidrMask: 24,
          },
          ...(subnetType === "private"
            ? [
                {
                  name: "Private",
                  subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                  cidrMask: 24,
                },
              ]
            : []),
        ],
      });
    }

    // ========================================
    // Security Group
    // ========================================
    const sg = new ec2.SecurityGroup(this, "SentrySG", {
      vpc,
      description: "Security group for self-hosted Sentry",
      allowAllOutbound: true,
    });

    if (subnetType === "public") {
      sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "HTTP");
      sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS");
      // SSH not opened to 0.0.0.0/0 — use SSM Session Manager instead
    } else {
      sg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(80), "HTTP from VPC");
      sg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(443), "HTTPS from VPC");
    }

    // ========================================
    // IAM Role
    // ========================================
    const role = new iam.Role(this, "SentryInstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")],
    });

    // Allow reading and writing SSM parameters for configuration
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:GetParameters", "ssm:PutParameter"],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/sentry/*`],
      }),
    );

    // ========================================
    // UserData Script
    // ========================================
    const userData = ec2.UserData.forLinux();

    const composeProfiles =
      sentryProfile === "errors-only" ? "export COMPOSE_PROFILES=errors-only" : "# Full profile: all services";

    // Build env var override lines for .env injection
    const envOverrideLines: string[] = [];
    if (envVarOverrides && Object.keys(envVarOverrides).length > 0) {
      envOverrideLines.push("# Apply env var overrides from deploy form");
      for (const [key, value] of Object.entries(envVarOverrides)) {
        // Escape single quotes in values for safe shell injection
        const escaped = value.replace(/'/g, "'\\''");
        envOverrideLines.push(`echo '${key}=${escaped}' >> /opt/self-hosted/.env`);
      }
      envOverrideLines.push("");
    }

    // Caddy reverse proxy setup (only when domain is provided for automatic HTTPS)
    const caddySetup = domainName
      ? [
          "# Install Caddy reverse proxy for automatic HTTPS via Let's Encrypt",
          "dnf install -y 'dnf-command(copr)' || true",
          "dnf copr enable -y @caddy/caddy epel-9-x86_64 2>/dev/null || true",
          "dnf install -y caddy 2>/dev/null || {",
          "  # Fallback: install from GitHub release",
          '  CADDY_VERSION="v2.8.4"',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: bash variables, expanded on the instance
          '  curl -sL "https://github.com/caddyserver/caddy/releases/download/${CADDY_VERSION}/caddy_${CADDY_VERSION#v}_linux_amd64.tar.gz" | tar xz -C /usr/bin caddy',
          "  useradd --system --home /var/lib/caddy --shell /usr/sbin/nologin caddy || true",
          "}",
          "",
          "# Configure Caddy as reverse proxy to Sentry",
          "mkdir -p /etc/caddy",
          `cat > /etc/caddy/Caddyfile << 'CADDYEOF'`,
          `${domainName} {`,
          "  reverse_proxy localhost:9000",
          "}",
          "CADDYEOF",
          "",
          "# Start Caddy (auto-provisions Let's Encrypt certificate)",
          "systemctl enable caddy",
          "systemctl start caddy",
          "",
        ]
      : [];

    userData.addCommands(
      "#!/bin/bash",
      "",
      "# Track exit code for cfn-signal (do NOT use set -e globally)",
      "INSTALL_EXIT_CODE=0",
      "",
      "# Log all output",
      "exec > >(tee /var/log/sentry-install.log) 2>&1",
      "",
      "# Install cfn-bootstrap (required on AL2023 for cfn-signal)",
      "dnf install -y aws-cfn-bootstrap || pip3 install aws-cfn-bootstrap",
      "",
      "# Install Docker and dependencies",
      "dnf update -y",
      "dnf install -y docker git jq",
      "systemctl enable docker",
      "systemctl start docker",
      "",
      "# Install Docker Compose v2",
      'DOCKER_COMPOSE_VERSION="v2.32.1"',
      "mkdir -p /usr/local/lib/docker/cli-plugins",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: bash variable, expanded on the instance
      'curl -SL "https://github.com/docker/compose/releases/download/${DOCKER_COMPOSE_VERSION}/docker-compose-linux-x86_64" -o /usr/local/lib/docker/cli-plugins/docker-compose',
      "chmod +x /usr/local/lib/docker/cli-plugins/docker-compose",
      "",
      "# Create 16 GB swap (mandatory for <32 GB RAM instances)",
      "dd if=/dev/zero of=/swapfile bs=1M count=16384",
      "chmod 600 /swapfile",
      "mkswap /swapfile",
      "swapon /swapfile",
      'echo "/swapfile swap swap defaults 0 0" >> /etc/fstab',
      "",
      "# Kernel tuning for Kafka/ClickHouse",
      "sysctl -w vm.max_map_count=262144",
      'echo "vm.max_map_count=262144" >> /etc/sysctl.conf',
      "",
      "# Clone Sentry self-hosted",
      "cd /opt",
      `git clone https://github.com/getsentry/self-hosted.git --branch ${SENTRY_RELEASE} --depth 1`,
      "cd self-hosted",
      "",
      "# Generate SECRET_KEY and store in SSM Parameter Store",
      `SENTRY_SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))")`,
      `aws ssm put-parameter --name "/sentry/SECRET_KEY" --value "$SENTRY_SECRET_KEY" --type SecureString --overwrite --region ${cdk.Aws.REGION}`,
      'echo "SENTRY_SECRET_KEY=$SENTRY_SECRET_KEY" >> .env',
      "",
      "# Configure Sentry",
      composeProfiles,
      `export SENTRY_EVENT_RETENTION_DAYS=${sentryEventRetentionDays}`,
      `echo "SENTRY_EVENT_RETENTION_DAYS=${sentryEventRetentionDays}" >> .env`,
      "",
      ...envOverrideLines,
      "# Run Sentry installer (non-interactive)",
      "if ! ./install.sh --skip-user-creation --no-report-self-hosted-issues; then",
      '  echo "ERROR: Sentry install.sh failed"',
      "  INSTALL_EXIT_CODE=1",
      "fi",
      "",
      "# Start Sentry (only if install succeeded)",
      'if [ "$INSTALL_EXIT_CODE" -eq 0 ]; then',
      "  docker compose up -d --wait",
      "",
      "  # Health check with retries",
      "  HEALTH_OK=0",
      "  for i in $(seq 1 30); do",
      "    if curl -sf http://localhost:9000/_health/ > /dev/null 2>&1; then",
      '      echo "Sentry is healthy"',
      "      HEALTH_OK=1",
      "      break",
      "    fi",
      '    echo "Waiting for Sentry to start... ($i/30)"',
      "    sleep 10",
      "  done",
      "",
      '  if [ "$HEALTH_OK" -ne 1 ]; then',
      '    echo "ERROR: Sentry health check failed after 5 minutes"',
      "    INSTALL_EXIT_CODE=1",
      "  fi",
      "fi",
      "",
      ...caddySetup,
    );

    // ========================================
    // EC2 Instance
    // ========================================
    this.instance = new ec2.Instance(this, "SentryInstance", {
      vpc,
      instanceType: new ec2.InstanceType(instanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: sg,
      role,
      userData,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(volumeSizeGb, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: false, // Preserve Sentry data on instance termination
          }),
        },
      ],
      vpcSubnets: {
        subnetType: subnetType === "public" ? ec2.SubnetType.PUBLIC : ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      ...(sshKeyName ? { keyName: sshKeyName } : {}),
      userDataCausesReplacement: true,
    });

    // ========================================
    // CloudFormation WaitCondition (40-min timeout)
    // ========================================
    const waitHandle = new cdk.CfnWaitConditionHandle(this, "SentryWaitHandle");

    const waitCondition = new cdk.CfnWaitCondition(this, "SentryWaitCondition", {
      handle: waitHandle.ref,
      timeout: "2400", // 40 minutes
      count: 1,
    });
    waitCondition.addDependency(this.instance.node.defaultChild as cdk.CfnResource);

    // Signal CloudFormation on completion (always runs, uses tracked exit code). The
    // handle URL alone: it already names the stack and the wait condition, and cfn-signal
    // refuses it together with --stack/--resource ("Cannot specify both a
    // WaitConditionHandle URL and a logical resource id"), which left the wait condition
    // unsignalled and rolled back a healthy install at the 40-minute timeout.
    this.instance.addUserData(`# Signal CloudFormation`, `cfn-signal -e $INSTALL_EXIT_CODE '${waitHandle.ref}'`);

    // ========================================
    // Elastic IP (public subnet only)
    // ========================================
    let sentryUrl: string;

    if (subnetType === "public") {
      const eip = new ec2.CfnEIP(this, "SentryEIP");
      new ec2.CfnEIPAssociation(this, "SentryEIPAssociation", {
        instanceId: this.instance.instanceId,
        allocationId: eip.attrAllocationId,
      });

      sentryUrl = domainName ? `https://${domainName}` : `http://${eip.attrPublicIp}:9000`;

      new cdk.CfnOutput(this, "ElasticIP", {
        value: eip.attrPublicIp,
        description: "Elastic IP address",
      });
    } else {
      sentryUrl = `http://${this.instance.instancePrivateIp}:9000`;
    }

    // ========================================
    // Route 53 DNS (conditional)
    // ========================================
    if (domainName && hostedZoneId) {
      const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, "HostedZone", {
        hostedZoneId,
        zoneName: domainName.split(".").slice(-2).join("."),
      });

      if (subnetType === "public") {
        new route53.ARecord(this, "SentryDnsRecord", {
          zone: hostedZone,
          recordName: domainName,
          target: route53.RecordTarget.fromIpAddresses(this.instance.instancePublicIp),
          ttl: cdk.Duration.minutes(5),
        });
      }

      sentryUrl = `https://${domainName}`;
    }

    // ========================================
    // Outputs
    // ========================================
    new cdk.CfnOutput(this, "AppUrl", {
      value: sentryUrl,
      description: "Sentry web interface URL",
    });

    new cdk.CfnOutput(this, "InstanceId", {
      value: this.instance.instanceId,
      description: "EC2 instance ID",
    });

    new cdk.CfnOutput(this, "SSMConnectCommand", {
      value: `aws ssm start-session --target ${this.instance.instanceId}`,
      description: "SSM Session Manager connect command",
    });

    if (sshKeyName && subnetType === "public") {
      new cdk.CfnOutput(this, "SSHCommand", {
        value: `ssh -i ${sshKeyName}.pem ec2-user@<ELASTIC_IP>`,
        description: "SSH connect command (replace <ELASTIC_IP>)",
      });
    }

    new cdk.CfnOutput(this, "SentryProfile", {
      value: sentryProfile,
      description: "Sentry installation profile",
    });

    new cdk.CfnOutput(this, "SentryRelease", {
      value: SENTRY_RELEASE,
      description: "Sentry self-hosted version",
    });
  }
}
