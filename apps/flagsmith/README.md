# Flagsmith (Self-Hosted)

[Flagsmith](https://flagsmith.com) is an open-source feature flag and remote config service (BSD-3-Clause licence). This template deploys the official image to your AWS account, decomposed onto managed services: the API and dashboard, a task processor for background work, and a one-off migration task, all on one RDS PostgreSQL database.

## Architecture

```
Internet
  └─ Application Load Balancer (public subnets, :80 / :443)
       └─ ECS Fargate web service (private subnets, :8000) — API + dashboard
ECS Fargate task-processor service (private subnets, no inbound)
ECS Fargate migration task (run once per deploy)
  all three: flagsmith/flagsmith:2.273.0 (pinned)
       └─ RDS PostgreSQL 17 (isolated subnets, encrypted)
```

- **Only the load balancer is reachable from the internet.** The tasks sit in private subnets with egress through one NAT gateway (to pull the image from Docker Hub), and the database sits in isolated subnets that accept connections from the tasks only.
- **Secrets never reach the template.** The database password and Django's `SECRET_KEY` are generated in Secrets Manager and injected into the containers as ECS secrets. Flagsmith reads its database connection as discrete variables, so nothing composes a connection URL around the password.
- **Migrations run once per deploy, before anything serves.** Every deploy starts a one-off migration task (`flagsmith migrate`). The web and task-processor containers wait until Django reports no unapplied migrations (up to 10 minutes) before they start. The first deploy migrates an empty database, so it takes a few minutes longer than later ones.
- **Background work goes to the task processor.** Audit logs, webhooks and analytics roll-ups are queued in Postgres and picked up by the task-processor service, rather than run in a thread inside each web worker. Flag analytics are stored in Postgres too; no InfluxDB or Redis is needed at this size.
- **Encrypted database connections.** RDS for PostgreSQL 15+ refuses unencrypted connections. The containers connect with libpq's `sslmode=require`, which encrypts without needing the RDS certificate authority in the image.

## Configuration

| Parameter              | Description                                                                   | Default        |
| ---------------------- | ----------------------------------------------------------------------------- | -------------- |
| Task CPU               | Fargate CPU units for the API task (256–2048)                                 | `512`          |
| Task Memory            | Fargate memory in MiB for the API task; must suit the CPU                     | `2048`         |
| Tasks                  | Number of API tasks behind the load balancer (1–4)                            | `1`            |
| RDS Instance Type      | `db.t4g.micro`, `db.t4g.small` or `db.t4g.medium`                             | `db.t4g.micro` |
| RDS Multi-AZ           | Standby database in a second AZ (doubles database cost)                       | `false`        |
| Custom Domain          | Optional, e.g. `flags.example.com`. HTTPS via ACM when set with a hosted zone | —              |
| Hosted Zone ID         | Route 53 hosted zone for the certificate validation and DNS record            | —              |
| Invite-only Sign-up    | Accept sign-ups only from people with an invite                               | `false`        |
| Delete Data With Stack | Delete the database on stack deletion instead of keeping a final snapshot     | `false`        |

The task processor runs as one fixed 0.25 vCPU / 1 GB task. See `tool.json` for the full configuration schema.

## Post-Deploy

1. **Open the dashboard** at the `AppUrl` stack output (the load balancer's DNS name over HTTP, or `https://<your domain>`).
2. **Sign up straight away.** Flagsmith creates no default account: the first person to sign up creates the first organisation and is its admin. Until someone has, anyone who can reach the URL can do it.
3. **Close registration.** Redeploy with **Invite-only Sign-up** on, and add teammates with invite links from Organisation Settings → Members.
4. **Point your SDKs at the `ApiUrl` output** (`<AppUrl>/api/v1/`) — each Flagsmith SDK takes it as its `api` / `apiUrl` option.

Flagsmith has no e-mail configured in this template, so password-reset and invite e-mails are not sent; use invite links instead. To add e-mail, set Flagsmith's `EMAIL_BACKEND` / `SENDER_EMAIL` settings (for example to Amazon SES) in `lib/flagsmith-stack.ts`.

Without a custom domain the dashboard is served over plain HTTP and its session cookie is not marked `Secure`. Use a custom domain for anything beyond a trial.

Container logs are in the CloudWatch log group named in the `LogGroupName` output, with streams prefixed `web`, `task-processor` and `migrate`.

## Deleting

Deleting the stack removes everything it created. By default RDS keeps a **final snapshot** of the database, so your flags can be restored later. It is billed as snapshot storage until you delete it. Set **Delete Data With Stack** when the data is disposable, as in a trial.

## Cost

Roughly **$110/month** in `us-east-1` at the defaults:

| Resource                                  | ~Monthly |
| ----------------------------------------- | -------- |
| NAT gateway                               | $33      |
| Application Load Balancer                 | $20      |
| API task (0.5 vCPU, 2 GB)                 | $21      |
| Task processor (0.25 vCPU, 1 GB)          | $11      |
| RDS `db.t4g.micro` + 20 GB                | $14      |
| Public IPv4 (NAT gateway + load balancer) | $11      |
| Secrets Manager, CloudWatch Logs, Lambda  | $1–2     |

The migration task runs for a few minutes per deploy and costs cents.

## Upgrading Flagsmith

The image tag is pinned in `lib/flagsmith-stack.ts` (`FLAGSMITH_VERSION`). Bump it deliberately: the next deploy migrates your database to the new release's schema before the new tasks start, while the old ones keep serving. Check the [Flagsmith release notes](https://github.com/Flagsmith/flagsmith/releases) first.
