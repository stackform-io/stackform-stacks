# Prefect (Self-Hosted)

[Prefect](https://www.prefect.io) is an open-source workflow orchestration server for Python data pipelines (Apache-2.0 licence). This template deploys the official Prefect server image to your AWS account, split into a web tier and a background-services process the way upstream recommends for production. Your flows still run on your own workers, which connect to this server.

## Architecture

```
Internet
  └─ Application Load Balancer (public subnets, :80 / :443)
       └─ ECS Fargate — web tier (private subnets, :4200)
            prefect server start --no-services      (API + UI, basic auth)

ECS Fargate — background services (private subnets, always one task)
  ├─ Migrate:  prefect server database upgrade -y   (runs first, then exits)
  └─ Services: prefect server services start        (scheduler, automations, event persister, …)

Both use prefecthq/prefect:3.8.6-python3.12 (pinned) and share:
  ├─ RDS PostgreSQL 17 (isolated subnets, encrypted)
  └─ ElastiCache Redis 7.1 (isolated subnets, TLS + AUTH) — events broker and lease store
```

- **Only the load balancer is reachable from the internet.** The tasks sit in private subnets with egress through one NAT gateway (to pull the image), and the database and Redis sit in isolated subnets that accept connections from the tasks only.
- **The server is password-protected.** Prefect's open-source server has no user accounts, so this template always turns on its built-in basic auth. The credential is generated in Secrets Manager. The web UI asks for it, and every worker or client must send it.
- **Secrets never reach the template.** The database password, the Redis AUTH token and the sign-in are generated in Secrets Manager and injected into the containers as ECS secrets.
- **Exactly one process migrates.** Prefect's migrations take no lock, so they run only in the `Migrate` container of the single background-services task. The web tier never migrates, however many tasks it runs. CloudFormation finishes the migration before it rolls out the web tier, both on first deploy and on every upgrade.
- **Why Redis.** With the web tier and the background services in separate processes, Prefect's in-memory events broker and concurrency-lease store no longer work, because events received by the API would never reach the process that stores them. Redis replaces both, as upstream's scaling guide requires.
- **Encrypted database connections.** RDS for PostgreSQL 15+ refuses unencrypted connections. Prefect's driver (asyncpg) connects with `PGSSLMODE=require`: the connection is encrypted but the certificate is not verified, because the image does not ship the RDS certificate authority.

## Configuration

| Parameter              | Description                                                                     | Default        |
| ---------------------- | ------------------------------------------------------------------------------- | -------------- |
| Task CPU               | Fargate CPU units for each task (256–2048)                                      | `512`          |
| Task Memory            | Fargate memory in MiB for each task; must suit the CPU                          | `1024`         |
| Web Tasks              | Number of web (API + UI) tasks behind the load balancer (1–4)                   | `1`            |
| RDS Instance Type      | `db.t4g.micro`, `db.t4g.small` or `db.t4g.medium`                               | `db.t4g.micro` |
| RDS Multi-AZ           | Standby database in a second AZ (doubles database cost)                         | `false`        |
| Custom Domain          | Optional, e.g. `prefect.example.com`. HTTPS via ACM when set with a hosted zone | —              |
| Hosted Zone ID         | Route 53 hosted zone for the certificate validation and DNS record              | —              |
| Delete Data With Stack | Delete the database on stack deletion instead of keeping a final snapshot       | `false`        |

The background services always run as exactly one task. It is the only process that migrates, and Prefect's default scheduler coordination assumes a single process.

See `tool.json` for the full configuration schema.

## Post-Deploy

1. **Get the sign-in.** Open the secret named in the `AuthSecretArn` stack output in the Secrets Manager console (or run `aws secretsmanager get-secret-value --secret-id <AuthSecretArn>`). It holds a `username` (`admin`) and a generated `password`.
2. **Open the UI** at the `AppUrl` stack output. When prompted, enter `admin:<password>`, joined by a colon.
3. **Point your workers and clients at the server.** Set these on every machine that runs `prefect worker start` or deploys flows:

   ```bash
   export PREFECT_API_URL="<ApiUrl output>"            # e.g. https://prefect.example.com/api
   export PREFECT_API_AUTH_STRING="admin:<password>"
   ```

Without a custom domain the server is served over plain HTTP. The sign-in then crosses the internet unencrypted, so set a custom domain for anything beyond a trial.

Container logs are in the CloudWatch log group named in the `LogGroupName` output, with separate `api/`, `services/` and `migrate/` streams.

## Deleting

Deleting the stack removes everything it created. By default RDS keeps a **final snapshot** of the database, so your flow run history can be restored later. It is billed as snapshot storage until you delete it. Set **Delete Data With Stack** when the data is disposable, as in a trial. Redis holds only in-flight events and is always deleted.

## Cost

Roughly **$117/month** in `us-east-1` at the defaults:

| Resource                                                 | ~Monthly |
| -------------------------------------------------------- | -------- |
| Fargate: web + background services (0.5 vCPU, 1 GB each) | $36      |
| NAT gateway                                              | $33      |
| Application Load Balancer                                | $20      |
| RDS `db.t4g.micro` + 20 GB                               | $14      |
| ElastiCache `cache.t4g.micro`                            | $12      |
| Secrets Manager, CloudWatch Logs                         | $2       |

Your workers, and the compute your flows run on, are not included.

## Upgrading Prefect

The image tag is pinned in `lib/prefect-stack.ts` (`PREFECT_VERSION`). Bump it deliberately: the `Migrate` container upgrades your database to the new version's schema before the new web tier starts. Check the [Prefect release notes](https://github.com/PrefectHQ/prefect/releases) first, and keep workers and clients on a compatible version.
