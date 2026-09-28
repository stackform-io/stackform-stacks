# Stackform Stacks

CDK stacks maintained by Stackform for deploying open-source projects to AWS
with the **Deploy to Stackform** button.

Each directory under `apps/` is a self-contained CDK app for one project.

## Stacks

> The buttons point at the **dev** deployment (`dev.stackform.io`), which
> tracks the `develop` branch.

| Stack                                          | Project                         | Category              | Est. cost / mo | Deploy                                                                                                                                  |
| ---------------------------------------------- | ------------------------------- | --------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [Flagsmith](apps/flagsmith)                    | Feature flags and remote config | Developer Tools       | ~$110          | [![Deploy to Stackform](https://dev.stackform.io/buttons/deploy-to-stackform.svg)](https://dev.stackform.io/start/deploy?template=flagsmith)   |
| [LiteLLM Proxy](apps/litellm)                  | LLM gateway                     | AI & Machine Learning | ~$105 + usage  | [![Deploy to Stackform](https://dev.stackform.io/buttons/deploy-to-stackform.svg)](https://dev.stackform.io/start/deploy?template=litellm)     |
| [Prefect](apps/prefect)                        | Workflow orchestration          | Data Engineering      | ~$117          | [![Deploy to Stackform](https://dev.stackform.io/buttons/deploy-to-stackform.svg)](https://dev.stackform.io/start/deploy?template=prefect)     |
| [Sentry](apps/sentry)                          | Error tracking                  | Monitoring            | ~$45–300       | [![Deploy to Stackform](https://dev.stackform.io/buttons/deploy-to-stackform.svg)](https://dev.stackform.io/start/deploy?template=sentry)      |
| [Umami](apps/umami)                            | Privacy-focused web analytics   | Analytics             | ~$96           | [![Deploy to Stackform](https://dev.stackform.io/buttons/deploy-to-stackform.svg)](https://dev.stackform.io/start/deploy?template=umami)       |
| [Uptime Kuma](apps/uptime-kuma)                | Uptime monitoring               | Monitoring            | ~$97           | [![Deploy to Stackform](https://dev.stackform.io/buttons/deploy-to-stackform.svg)](https://dev.stackform.io/start/deploy?template=uptime-kuma) |

Costs are `us-east-1` estimates at the default settings; each stack's README
breaks them down.

## App layout

```
apps/<slug>/
  bin/<slug>.ts            # CDK entry point: reads and validates toolConfig
  bin/prm-attribution.ts   # AWS Partner Revenue Measurement tagging
  lib/                     # Stack definitions
  tool.json                # Stack definition: catalogue metadata and deploy form
  README.md                # Architecture, configuration, post-deploy, cost
  cdk.json
  package.json             # Version, and aws-cdk-lib pinned to a version the deploy engine can read
  package-lock.json
  tsconfig.json
```

## The stack definition (`tool.json`)

`tool.json` is what Stackform reads to list the stack in the catalogue and
render its deploy form. When someone deploys, the values from the form reach
the CDK app as the `toolConfig` context value.

| Field               | Required | Description                                                                                                                                  |
| ------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `slug`              | yes      | Unique ID, and the same as the directory name. The button uses it in `?template=<slug>`. Never rename it once published: that breaks every button that links to it. |
| `name`              | yes      | Display name, e.g. `"Umami (Self-Hosted)"`.                                                                                                  |
| `description`       | yes      | One or two sentences: what the project is, how it runs on AWS, and the rough monthly cost.                                                   |
| `cdkEntryPoint`     | yes      | Path to the entry point, e.g. `bin/umami.ts`.                                                                                                |
| `configSchema`      | yes      | JSON Schema (`type: "object"`) for the deploy form. See below.                                                                               |
| `visibility`        | yes      | `PUBLIC`, `ORGANIZATION` or `PRIVATE`. Stacks in this repo are `PUBLIC`.                                                                     |
| `category`          | yes      | Catalogue group. Reuse an existing one when it fits: `Analytics`, `AI & Machine Learning`, `Data Engineering`, `Developer Tools`, `Monitoring`. |
| `tags`              | yes      | Lowercase, kebab-case search terms. Include the slug and `self-hosted`.                                                                      |
| `estimatedCost`     | yes      | `{ "monthly": <number USD>, "description": "~$N/mo: itemised breakdown" }` at the default settings.                                          |
| `estimatedDuration` | yes      | How long a first deploy takes, e.g. `"15-25 minutes"`.                                                                                       |
| `logoUrl`           | yes      | `/images/apps/<slug>.svg` (or `.png`). The image itself lives in the platform repo's `web/public/images/apps/`.                              |
| `defaultParams`     | no       | Values the form is pre-filled with.                                                                                                          |
| `tiers`             | no       | Deployment tiers (e.g. `["STARTER", "OPTIMIZED"]`) for stacks that offer more than one architecture.                                          |
| `iconSlug`          | no       | AWS architecture icon name, used by platform tools rather than marketplace apps.                                                              |

The version shown in Stackform comes from `version` in `package.json`, not from
`tool.json`.

### `configSchema`

Each property becomes a field on the deploy form:

- `type` (`string`, `number` or `boolean`), `title` and `description` are required.
  Write the description for someone who does not know AWS well, and state
  the cost impact when there is one ("Doubles the database cost.").
- Use `enum`, or `minimum`/`maximum`, to bound every value, and give every
  property a `default` that deploys successfully.
- `x-showWhen` shows a field only when another field has a given value:
  `{ "tier": "starter" }` means an exact match, and `{ "domainName": "*" }`
  means any non-empty value.
- Only list a property under `required` when there is no safe default.

The entry point must validate every value itself, because `toolConfig` can
arrive without passing through the form. Values may arrive as strings, so
coerce them (`Number(...)`, `value === true || value === "true"`) and throw a
clear error when a value is out of range, so that the synth fails instead of
the CloudFormation deploy.

## Working on an app

```bash
cd apps/umami
npm ci
npx cdk synth
npx cdk synth -c toolConfig='{"cpu":1024,"memoryMiB":2048}'   # try non-default form values
```

## Contributing

PRs go to `develop`. Read [CONTRIBUTING.md](CONTRIBUTING.md) before you open
one: it lists what a new stack must include and how changes are reviewed.
When a stack reaches production, Stackform maintainers open a PR on the
project's own repository proposing the Deploy to Stackform button, so the
project's own maintainers can approve it.

## License

[GNU Affero General Public License v3.0](LICENSE). This covers the CDK code
and metadata in this repository only. Each deployed project keeps its own
upstream license; the stacks deploy the projects' official releases.
