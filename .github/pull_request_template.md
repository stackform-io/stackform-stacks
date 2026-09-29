<!--
Title: <type>(<slug>): <summary>, e.g. fix(umami): pin postgres major version
Adding a new stack? Use the new-stack template instead: add ?template=new-stack.md to the compare URL.
See CONTRIBUTING.md.
-->

## Stack

<!-- Slug of the stack this PR changes, or "repo-wide". -->

## What changed and why

<!-- The problem, and how this solves it. Link the issue or task. -->

## Type of change

- [ ] Fix (no change to the deploy form or resources)
- [ ] New option or feature
- [ ] Upstream version bump (from `x.y.z` to `x.y.z`, with a link to the release notes)
- [ ] Breaking change (renamed or removed `configSchema` property, replaced stateful resource, changed default)
- [ ] Docs or tooling only

## Impact on existing deploys

<!--
What happens when someone updates a deploy they already have? Does any
database, volume or other stateful resource get replaced? Is there any
downtime? Write "None" if nothing changes.
-->

## Checklist

- [ ] `version` in `package.json` bumped with `npm version` (see [Versioning](../CONTRIBUTING.md#versioning))
- [ ] `preflight.json` has a variant for any new option that changes resources or IAM
- [ ] `node scripts/preflight.ts apps/<slug>` and `npm run lint` pass locally
- [ ] `tool.json` updated if form fields, cost or duration changed
- [ ] Entry point validates any new `toolConfig` value
- [ ] App `README.md` updated (configuration table, cost, upgrade notes)
- [ ] Root README table updated if the name, category or cost changed
- [ ] Deployed to a real account, and the update from the previous version works

## Evidence

<!-- Synth output, stack outputs, screenshots of the running app. -->
