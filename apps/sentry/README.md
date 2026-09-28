# Sentry (Self-Hosted) — Stackform Template

Self-hosted Sentry error tracking deployed to your AWS account. Choose between two deployment tiers.

## Quick Deploy

[![Deploy with Stackform](https://dev.stackform.io/buttons/deploy-to-stackform.svg)](https://dev.stackform.io/start/deploy?template=sentry)

## Deployment Tiers

|                  | Starter               | Optimized                       |
| ---------------- | --------------------- | ------------------------------- |
| **Runtime**      | EC2 + Docker Compose  | ECS Fargate + RDS + ElastiCache |
| **Cost**         | ~$45/mo               | ~$150-300/mo                    |
| **HA**           | Single instance       | Multi-AZ capable                |
| **Database**     | Postgres in Docker    | Managed RDS Postgres            |
| **Cache**        | Redis in Docker       | Managed ElastiCache Redis       |
| **File Storage** | Local EBS             | S3 bucket                       |
| **HTTPS**        | Caddy + Let's Encrypt | ACM certificate + ALB           |
| **Auto-scaling** | No                    | Yes (CPU-based)                 |
| **Best for**     | Dev teams, low cost   | Production workloads            |

## Configuration

### Shared (both tiers)

| Parameter      | Description                                             | Default                                 |
| -------------- | ------------------------------------------------------- | --------------------------------------- |
| Tier           | `starter` or `optimized`                                | `starter`                               |
| Sentry Profile | `errors-only` (~15 containers) or `full` (~74 services) | `errors-only`                           |
| VPC Mode       | `new` (isolated) or `existing` (your VPC)               | `new`                                   |
| Subnet Type    | `public` or `private`                                   | Starter: `public`, Optimized: `private` |
| Custom Domain  | Optional (e.g., `sentry.example.com`)                   | —                                       |

### Starter tier only

| Parameter       | Description                  | Default     |
| --------------- | ---------------------------- | ----------- |
| Instance Type   | EC2 instance type            | `t3.xlarge` |
| Volume Size     | EBS volume (50-500 GB)       | `100`       |
| Event Retention | Days to retain events (7-90) | `30`        |
| SSH Key Pair    | Optional key for SSH access  | —           |

### Optimized tier only

| Parameter    | Description                          | Default          |
| ------------ | ------------------------------------ | ---------------- |
| Web CPU      | Fargate CPU units (256-2048)         | `512`            |
| Web Memory   | Fargate memory in MiB                | `1024`           |
| RDS Instance | Postgres instance type               | `db.t3.medium`   |
| RDS Multi-AZ | High availability (doubles RDS cost) | `false`          |
| Redis Node   | ElastiCache node type                | `cache.t3.micro` |

See `tool.json` for the full configuration schema.

---

## Post-Deploy: Starter Tier

### 1. Access Your Instance

```bash
aws ssm start-session --target <INSTANCE_ID>
```

### 2. Create Admin User

```bash
cd /opt/self-hosted
docker compose run --rm web createuser --superuser --email admin@example.com
```

### 3. Access Web Interface

- **Without custom domain**: `http://<ELASTIC_IP>:9000`
- **With custom domain**: `https://your-domain.com`

### 4. Upgrading

```bash
cd /opt/self-hosted
git fetch --tags
git checkout <NEW_VERSION>
./install.sh
docker compose up -d
```

---

## Post-Deploy: Optimized Tier

### 1. Create Admin User

Use the `CreateSuperuserCommand` from the CloudFormation stack outputs. It runs a one-off ECS task:

```bash
aws ecs run-task \
  --cluster <CLUSTER_NAME> \
  --task-definition <MIGRATION_TASK_DEF> \
  --launch-type FARGATE \
  --overrides '{"containerOverrides":[{"name":"MigrationContainer","command":["createuser","--superuser","--email","admin@example.com","--no-input"]}]}' \
  --network-configuration '<FROM_STACK_OUTPUTS>'
```

### 2. Access Web Interface

- **Without custom domain**: `http://<ALB_DNS_NAME>`
- **With custom domain**: `https://your-domain.com`

### 3. Database Migration

Runs automatically on deploy via a Custom Resource. For manual upgrades, update the Sentry image version in the stack and redeploy.

### 4. Monitoring

- **Logs**: CloudWatch log group (see `LogGroupName` output)
- **ECS**: Check service health in the ECS console
- **RDS**: Monitor via RDS Performance Insights
- **Redis**: Monitor via ElastiCache metrics

---

## Email Configuration (Both Tiers)

Add SMTP settings via the Advanced Options (env var overrides) in the deploy form:

| Env Var                | Description                    |
| ---------------------- | ------------------------------ |
| `SENTRY_MAIL_HOST`     | SMTP server hostname           |
| `SENTRY_MAIL_PORT`     | SMTP port (default: 25)        |
| `SENTRY_MAIL_USERNAME` | SMTP username                  |
| `SENTRY_MAIL_PASSWORD` | SMTP password                  |
| `SENTRY_MAIL_USE_TLS`  | Use TLS (true/false)           |
| `SENTRY_SERVER_EMAIL`  | From address for outgoing mail |

## Architecture

### Starter

```
VPC (new or existing)
  └─ EC2 Instance (Amazon Linux 2023)
       ├─ Docker Compose (Sentry self-hosted)
       │    ├─ Web, Worker, Cron services
       │    ├─ PostgreSQL, Redis, Kafka, ClickHouse
       │    └─ Symbolicator, Relay, Snuba
       ├─ Caddy reverse proxy (if custom domain)
       ├─ EBS GP3 volume (encrypted)
       ├─ Security Group (80/443)
       └─ IAM Role (SSM + SSM Parameter Store)
```

### Optimized

```
VPC (new or existing, 2 AZs)
  ├─ ALB (public subnets) → ECS Fargate web service (private subnets)
  ├─ ECS Cluster
  │    ├─ web service (Fargate) — Sentry web process + auto-scaling
  │    ├─ worker service (Fargate) — async task processor
  │    └─ cron service (Fargate, desired=1) — beat scheduler
  ├─ RDS Postgres (private subnets, optional Multi-AZ)
  ├─ ElastiCache Redis (private subnets)
  ├─ S3 Bucket (file/attachment storage)
  ├─ Secrets Manager (SECRET_KEY, DB credentials)
  ├─ ACM Certificate (if custom domain)
  └─ Route53 alias → ALB (if custom domain)
```
