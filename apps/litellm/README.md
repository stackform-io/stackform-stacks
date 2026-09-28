# LiteLLM Proxy (Self-Hosted)

[LiteLLM](https://github.com/BerriAI/litellm) is an OpenAI-compatible gateway in front of 100+ model providers — Amazon Bedrock, OpenAI, Anthropic, Azure, Vertex and more — with virtual keys, per-key budgets, rate limits and spend tracking (MIT licence for the core; the `enterprise/` features need a licence). This template deploys the official image to your AWS account on managed services.

## Architecture

```
Internet
  └─ Application Load Balancer (public subnets, :80 / :443, 600 s idle timeout)
       └─ ECS Fargate service (private subnets, :4000)
            ├─ ghcr.io/berriai/litellm-database:v1.102.1 (pinned)
            ├─ RDS PostgreSQL 17 (isolated subnets, encrypted)
            └─ Amazon Bedrock (optional, via the task role)
```

- **Only the load balancer is reachable from the internet.** The tasks sit in private subnets with egress through one NAT gateway (to pull the image and reach model providers), and the database sits in isolated subnets that accept connections from the tasks only.
- **Secrets never reach the template.** The database password, the master key and the salt key are generated in Secrets Manager and injected into the container as ECS secrets. LiteLLM assembles its own connection URL from them, percent-encoding the credentials.
- **Migrations run on boot.** Each task applies LiteLLM's Prisma migrations before it listens. If they fail the task exits (`ENFORCE_PRISMA_MIGRATION_CHECK`) rather than serving on a schema it could not migrate, and a deploy that cannot start rolls back automatically.
- **Encrypted database connections.** RDS for PostgreSQL 15+ refuses unencrypted connections. LiteLLM connects with `sslmode=require`, which encrypts (without needing the RDS certificate bundle) and never falls back to plaintext.
- **Long completions are not cut off.** The load balancer's idle timeout is 600 s instead of the default 60 s, so streamed answers and slow reasoning-model responses finish.
- **No Redis.** LiteLLM only needs it to share rate-limit and cache state between many proxies; up to a handful of tasks run fine without it.

## Configuration

| Parameter              | Description                                                                      | Default        |
| ---------------------- | -------------------------------------------------------------------------------- | -------------- |
| Task CPU               | Fargate CPU units (512–2048)                                                     | `1024`         |
| Task Memory            | Fargate memory in MiB; must suit the CPU. The proxy idles at ~530 MiB            | `2048`         |
| Tasks                  | Number of LiteLLM tasks behind the load balancer (1–4)                           | `1`            |
| RDS Instance Type      | `db.t4g.micro`, `db.t4g.small` or `db.t4g.medium`                                | `db.t4g.micro` |
| RDS Multi-AZ           | Standby database in a second AZ (doubles database cost)                          | `false`        |
| Amazon Bedrock Access  | Let the proxy invoke Bedrock models in this account with its task role           | `false`        |
| Custom Domain          | Optional, e.g. `llm.example.com`. HTTPS via ACM when set with a hosted zone      | —              |
| Hosted Zone ID         | Route 53 hosted zone for the certificate validation and DNS record               | —              |
| Delete Data With Stack | Delete the database and salt key on stack deletion instead of keeping a snapshot | `false`        |

See `tool.json` for the full configuration schema.

**Use a custom domain for anything real.** Without one the proxy is served over plain HTTP on the load balancer's DNS name, and every API key — including the master key — crosses the internet unencrypted.

## Post-Deploy

1. **Get the master key.** It is the `masterKey` field of the Secrets Manager secret named in the `MasterKeySecretArn` output. In the console: Secrets Manager → that secret → _Retrieve secret value_. Or:

   ```bash
   aws secretsmanager get-secret-value --secret-id <MasterKeySecretArn> \
     --query SecretString --output text | jq -r .masterKey
   ```

   The key is used exactly as stored (it has no `sk-` prefix; this release does not need one).

2. **Open the admin UI** at the `AdminUiUrl` output (`<AppUrl>/ui`) and sign in with username `admin` and the master key as the password.
3. **Add a model** under _Models → Add Model_. Provider API keys you enter here are encrypted in the database with the salt key.
4. **Create virtual keys** for your users and applications under _Virtual Keys_, with budgets and rate limits as needed. Hand those out, never the master key.
5. **Point clients at the proxy.** Any OpenAI SDK works: base URL `<AppUrl>` (or `<AppUrl>/v1`), API key a virtual key.

Container logs are in the CloudWatch log group named in the `LogGroupName` output.

### Amazon Bedrock

With **Amazon Bedrock Access** on, add a Bedrock model in the UI without entering any AWS credentials — the proxy uses its task role, in the stack's region. The role may only call `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream`, on:

- foundation models in the stack's region, and
- cross-region (and global) inference profiles in this account and region — plus the foundation models those profiles route to in other regions, only when reached through such a profile.

Use inference-profile model IDs (e.g. `bedrock/us.anthropic.claude-…`) for models that are only offered on demand through a profile. Some third-party models need a one-time Marketplace subscription or use-case form in the Bedrock console before the first call; the proxy role cannot do that for you.

To grant Bedrock access to an existing deployment without the toggle, attach an equivalent policy to the task role (`TaskDef…TaskRole…` in IAM) — do not use `AmazonBedrockFullAccess`, which also allows managing models and provisioned throughput.

## The Salt Key — Never Change It

`LITELLM_SALT_KEY` encrypts every provider credential LiteLLM stores. If it changes, all of them become undecryptable and every model that uses one starts failing. This template therefore:

- generates it once and never rotates it;
- keeps it (the secret is **retained**) when the stack is deleted with a database snapshot, because the snapshot is useless without it;
- must not have its construct id or generation settings edited — either change makes CloudFormation generate a new value on the next update. `test/deploy/litellm-template.test.ts` pins both.

The master key is separate: you can change it (edit the secret, then force a new deployment of the ECS service) without losing stored credentials.

## Deleting

Deleting the stack removes everything it created, except — by default — a **final snapshot** of the database and the **salt key secret**, so your keys, spend history and stored provider credentials can be restored later. Both are billed (snapshot storage, $0.40/month for the secret) until you delete them. Set **Delete Data With Stack** when the data is disposable, as in a trial.

## Cost

Roughly **$105/month** in `us-east-1` at the defaults, **before model usage**:

| Resource                         | ~Monthly |
| -------------------------------- | -------- |
| Fargate task (1 vCPU, 2 GB)      | $36      |
| NAT gateway                      | $33      |
| Application Load Balancer        | $20      |
| RDS `db.t4g.micro` + 20 GB       | $14      |
| Secrets Manager, CloudWatch Logs | $2       |

Model calls are billed by their provider — Bedrock invocations to this AWS account, others to whichever provider account the stored key belongs to. NAT data processing ($0.045/GB) applies to traffic to external providers.

## Telemetry

The pinned release sends no usage telemetry (its `--telemetry` flag is accepted and never read). The one outbound call it makes on its own is fetching LiteLLM's model price map from GitHub at start-up, to keep cost tracking current; set `LITELLM_LOCAL_MODEL_COST_MAP=True` on the task to use the copy bundled in the image instead.

## Upgrading LiteLLM

The image tag is pinned in `lib/litellm-stack.ts` (`LITELLM_VERSION`). Bump it deliberately: the new version migrates your database when it boots. LiteLLM's stable releases are the plain `vX.Y.Z` tags (not `-rc` / `-dev`); check the [release notes](https://github.com/BerriAI/litellm/releases) first.
