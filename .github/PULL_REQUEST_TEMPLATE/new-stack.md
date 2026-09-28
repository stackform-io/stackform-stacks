<!--
Title: feat(<slug>): add <Project> stack
See CONTRIBUTING.md for what a new stack must have.

You don't need to open a PR on the project's own repository. When the stack
ships to production, Stackform maintainers propose the Deploy to Stackform
button upstream. See "From develop to production" in CONTRIBUTING.md.
-->

## Project

- **Name:**
- **Slug:**
- **Homepage / repository:**
- **Upstream license:**
- **Image and pinned version:**
- **Why it belongs in the catalogue:**

## Architecture

<!-- The AWS resources, what is public, where the data lives. A diagram in a code block is welcome. -->

## Cost

<!-- The itemised monthly estimate at the defaults in us-east-1. It must match tool.json. -->

## Checklist

### Files

- [ ] `apps/<slug>/` has `tool.json`, `README.md`, `bin/<slug>.ts`, `bin/prm-attribution.ts`, `lib/`, `cdk.json`, `package.json`, `package-lock.json`, `tsconfig.json`
- [ ] `package.json` starts at version `1.0.0`, and pins `aws-cdk-lib` to the same version as the other stacks

### Stack definition (`tool.json`)

- [ ] `slug` matches the directory name, and no other stack uses it
- [ ] Every `configSchema` property has `title`, `description` and `default`, and is bounded by `enum` or `minimum`/`maximum`
- [ ] `category` reuses an existing category, or the PR explains why it needs a new one
- [ ] `estimatedCost` is itemised, and `estimatedDuration` matches a real deploy
- [ ] `destroyDataOnDelete` is exposed and defaults to `false` (stateful stacks)
- [ ] `logoUrl` points to `/images/apps/<slug>.svg` (platform PR: <link>)

### Entry point and stack

- [ ] `applyPrmAttribution(app)` is called
- [ ] Every `toolConfig` value is validated, with a clear error
- [ ] Only the load balancer is public: compute in private subnets, databases in isolated subnets
- [ ] Secrets are generated in Secrets Manager; none in code, context or plain environment variables
- [ ] Storage and databases are encrypted at rest
- [ ] Image pinned to an exact version in one named constant
- [ ] HTTPS through ACM when `domainName` and `hostedZoneId` are set
- [ ] `AppUrl` output

### Docs

- [ ] App `README.md` has Architecture, Configuration, Post-Deploy, Deleting, Cost and Upgrading sections
- [ ] Default credentials, if any, and how to change them are in Post-Deploy
- [ ] Row added to the root README table (alphabetical, with deploy button)

### Tested

- [ ] `npx cdk synth` passes with no context
- [ ] `npx cdk synth` passes with non-default values (tier, custom domain, and so on)
- [ ] Deployed to a real account; the app loads at `AppUrl` and first login works
- [ ] Deleted cleanly, leaving only the expected snapshots

## Evidence

<!-- Synth output, stack outputs, screenshots of the running app. -->
