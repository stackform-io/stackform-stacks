# Uptime Kuma (Self-Hosted)

[Uptime Kuma](https://github.com/louislam/uptime-kuma) is a self-hosted monitoring tool — HTTP, TCP, DNS, ping and more, with status pages and 90+ notification channels (MIT licence). This template deploys the official image to your AWS account, with its data on a managed database rather than a local file.

> **The first person to open the dashboard becomes its admin.** Uptime Kuma has no default login: its setup page creates the admin account for whoever submits it first, and that page is public as soon as the deploy finishes. Open the `AppUrl` output and create your account straight away.

## Architecture

```
Internet
  └─ Application Load Balancer (public subnets, :80 / :443)
       └─ ECS Fargate service — exactly one task (private subnets, :3001)
            ├─ louislam/uptime-kuma:2.5.5-slim (pinned)
            └─ RDS MariaDB 11.8 (isolated subnets, encrypted, TLS required)
```

- **Only the load balancer is reachable from the internet.** The task sits in a private subnet with egress through one NAT gateway (to pull the image and to reach what it monitors), and the database sits in isolated subnets that accept connections from the task only.
- **One task, always.** Uptime Kuma schedules every monitor in-process and is not built to run twice against one database: a second copy would check everything and alert everyone twice. Updates stop the old task before starting the new one, so expect a minute or two of downtime per update.
- **Secrets never reach the template.** The database password is generated in Secrets Manager and injected into the container as an ECS secret, which Uptime Kuma reads directly.
- **Encrypted, verified database connections.** MariaDB 11.8 on RDS refuses unencrypted connections. The container writes the RDS certificate authorities (from the `aws-ssl-profiles` package already in the image) to a file at start-up and Uptime Kuma verifies the database against them.
- **No persistent disk.** Monitors, history, users, settings and status pages all live in MariaDB. The container's `/app/data` is ephemeral: the only thing lost when the task is replaced is **uploaded status-page logos** — re-upload them after an update. Docker-host monitors and the "real browser" monitor type are not available (no Docker socket on Fargate; the slim image has no Chromium).
- **Live dashboard.** The UI talks over WebSockets (Socket.IO), which the load balancer passes through as-is.

## Configuration

| Parameter              | Description                                                                    | Default        |
| ---------------------- | ------------------------------------------------------------------------------ | -------------- |
| Task CPU               | Fargate CPU units (256–2048)                                                   | `512`          |
| Task Memory            | Fargate memory in MiB; must suit the CPU                                       | `1024`         |
| RDS Instance Type      | `db.t4g.micro`, `db.t4g.small` or `db.t4g.medium`                              | `db.t4g.micro` |
| RDS Multi-AZ           | Standby database in a second AZ (doubles database cost)                        | `false`        |
| Custom Domain          | Optional, e.g. `status.example.com`. HTTPS via ACM when set with a hosted zone | —              |
| Hosted Zone ID         | Route 53 hosted zone for the certificate validation and DNS record             | —              |
| Delete Data With Stack | Delete the database on stack deletion instead of keeping a final snapshot      | `false`        |

There is deliberately no task-count setting. See `tool.json` for the full configuration schema.

## Post-Deploy

1. **Claim the admin account immediately.** Open the `AppUrl` stack output (the load balancer's DNS name over HTTP, or `https://<your domain>`) and create the admin user on the setup page. Until you do, anyone who finds the URL can.
2. **Tell it about the load balancer.** Under Settings → Reverse Proxy, set **Trust Proxy** to _Yes_ so logs and login throttling see visitors' real IPs rather than the load balancer's. Under Settings → General, set **Primary Base URL** to the `AppUrl`, so links in notifications point at your dashboard.
3. **Add monitors and notifications.**

Container logs are in the CloudWatch log group named in the `LogGroupName` output.

## Deleting

Deleting the stack removes everything it created. By default RDS keeps a **final snapshot** of the database, so your monitors and history can be restored later. It is billed as snapshot storage until you delete it. Set **Delete Data With Stack** when the data is disposable, as in a trial.

## Cost

Roughly **$97/month** in `us-east-1` at the defaults:

| Resource                                            | ~Monthly |
| --------------------------------------------------- | -------- |
| NAT gateway                                         | $33      |
| Application Load Balancer                           | $20      |
| Fargate task (0.5 vCPU, 1 GB)                       | $18      |
| RDS `db.t4g.micro` + 20 GB                          | $14      |
| Public IPv4 addresses (NAT gateway + load balancer) | $11      |
| Secrets Manager, CloudWatch Logs                    | $1–2     |

## Upgrading Uptime Kuma

The image tag is pinned in `lib/uptime-kuma-stack.ts` (`UPTIME_KUMA_VERSION`). Bump it deliberately: the new version migrates your database when it boots. Check the [Uptime Kuma release notes](https://github.com/louislam/uptime-kuma/releases) first, and keep the `-slim` suffix.
