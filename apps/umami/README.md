# Umami (Self-Hosted)

[Umami](https://umami.is) is a privacy-focused, cookie-free alternative to Google Analytics (MIT licence). This template deploys the official image to your AWS account, decomposed onto managed services rather than one all-in-one container.

## Architecture

```
Internet
  └─ Application Load Balancer (public subnets, :80 / :443)
       └─ ECS Fargate service (private subnets, :3000)
            ├─ ghcr.io/umami-software/umami:3.4.0 (pinned)
            └─ RDS PostgreSQL 17 (isolated subnets, encrypted)
```

- **Only the load balancer is reachable from the internet.** The tasks sit in private subnets with egress through one NAT gateway (to pull the image), and the database sits in isolated subnets that accept connections from the tasks only.
- **Secrets never reach the template.** The database password and `APP_SECRET` are generated in Secrets Manager and injected into the container as ECS secrets. The container composes its connection URLs at start-up.
- **Migrations run on boot.** The image migrates the database before its server starts listening, so first boot takes a minute or two longer than later ones.
- **Encrypted database connections.** RDS for PostgreSQL 15+ refuses unencrypted connections. The app connects with `sslmode=no-verify` (encrypted; Node does not ship the RDS certificate authority) and `prisma migrate` with `sslmode=require`.

## Configuration

| Parameter              | Description                                                                       | Default        |
| ---------------------- | --------------------------------------------------------------------------------- | -------------- |
| Task CPU               | Fargate CPU units (256–2048)                                                      | `512`          |
| Task Memory            | Fargate memory in MiB; must suit the CPU                                          | `1024`         |
| Tasks                  | Number of Umami tasks behind the load balancer (1–4)                              | `1`            |
| RDS Instance Type      | `db.t4g.micro`, `db.t4g.small` or `db.t4g.medium`                                 | `db.t4g.micro` |
| RDS Multi-AZ           | Standby database in a second AZ (doubles database cost)                           | `false`        |
| Custom Domain          | Optional, e.g. `analytics.example.com`. HTTPS via ACM when set with a hosted zone | —              |
| Hosted Zone ID         | Route 53 hosted zone for the certificate validation and DNS record                | —              |
| Delete Data With Stack | Delete the database on stack deletion instead of keeping a final snapshot         | `false`        |

See `tool.json` for the full configuration schema.

## Post-Deploy

1. **Open the dashboard** at the `AppUrl` stack output (the load balancer's DNS name over HTTP, or `https://<your domain>`).
2. **Change the default login immediately.** Umami creates `admin` / `umami` on first boot. Sign in and change it under Settings → Profile.
3. **Add a website** under Settings → Websites, and paste its tracking snippet into your site.

Container logs are in the CloudWatch log group named in the `LogGroupName` output.

## Deleting

Deleting the stack removes everything it created. By default RDS keeps a **final snapshot** of the database, so your analytics can be restored later. It is billed as snapshot storage until you delete it. Set **Delete Data With Stack** when the data is disposable, as in a trial.

## Cost

Roughly **$96/month** in `us-east-1` at the defaults:

| Resource                             | ~Monthly |
| ------------------------------------ | -------- |
| NAT gateway                          | $33      |
| Application Load Balancer            | $20      |
| Fargate task (0.5 vCPU, 1 GB)        | $18      |
| RDS `db.t4g.micro` + 20 GB           | $14      |
| Public IPv4 (NAT + ALB, 3 addresses) | $11      |
| Secrets Manager, CloudWatch Logs     | $1–2     |

## Upgrading Umami

The image tag is pinned in `lib/umami-stack.ts` (`UMAMI_VERSION`). Bump it deliberately: the new version migrates your database when it boots. Check the [Umami release notes](https://github.com/umami-software/umami/releases) first.
