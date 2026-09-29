# Pre-flight gate

The static pre-flight gate ([SF-441](https://app.clickup.com/t/86cbaxm8e)).
`scripts/preflight.ts` synthesises every variant of an app and runs the gate
over the CloudFormation templates. It reads templates only, never runs the
app's code, and uses Node built-ins only.

## What it checks

Each check is either **blocking**, which fails the PR, or **advisory**, which
is reported but does not fail it. Every check, with its ID and the reasoning
behind it, is in
[`lib/verification/assertions.ts`](lib/verification/assertions.ts).

- **Blocking:**
  - Synthesis produces a template with at least one resource.
  - The stack has an `AppUrl` output.
  - IAM: no administrator policies, no statement that allows every action, no
    sensitive action on every resource, and no role any principal can assume.
  - No publicly accessible databases, and every database is encrypted.
  - No ECS tasks with public IPs.
  - No secret-named container variable with a literal value.
  - No security group open to `0.0.0.0/0` on a port other than 80 or 443.
- **Advisory:** permissions that cannot be read from the template, and actions
  that could be scoped to specific resources but are not.

## Running it

```sh
# Synthesise every variant of an app and grade it (what CI runs)
node scripts/preflight.ts apps/<slug>

# Grade templates you already have
node gate/scripts/preflight-gate.ts path/to/cdk.out/
node gate/scripts/preflight-gate.ts --json path/to/cdk.out/
```

## Layout

| Path                                 | What it is                                      |
| ------------------------------------ | ----------------------------------------------- |
| `scripts/preflight-gate.ts`          | The CLI: reads templates, prints the report     |
| `lib/verification/assertions.ts`     | Every check, its ID, severity and reasoning     |
| `lib/verification/preflight.ts`      | The pre-flight checks and how a stack is graded |
| `lib/verification/template-audit.ts` | The security checks over a template's resources |

## Changing it

A PR is always graded by the gate on the branch it targets: CI runs the base
branch's copy of `gate/` and `scripts/`, so editing them in the same PR has no
effect on its own checks. Changes to the gate need a code owner's review (see
[`.github/CODEOWNERS`](../.github/CODEOWNERS)).

Fix the stack rather than loosening the gate. A check that is wrong for every
stack is a gate change, in a PR of its own.
