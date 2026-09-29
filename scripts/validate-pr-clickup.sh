#!/bin/bash
# Validates that a PR title contains a valid ClickUp task ID (SF-<id>).
# Used by the GitHub Action as a safety net for non-Claude PRs.
#
# Usage: ./validate-pr-clickup.sh "<PR title>"
# Requires: CLICKUP_API_TOKEN environment variable

set -euo pipefail

PR_TITLE=$(echo "${1:-}" | head -1)

if [ -z "$PR_TITLE" ]; then
  echo "::error::No PR title provided."
  exit 1
fi

# Extract SF-<id> from PR title (first line only to prevent multi-line bypass)
TASK_ID=$(echo "$PR_TITLE" | grep -oE 'SF-[A-Za-z0-9]+' | head -1 || true)

if [ -z "$TASK_ID" ]; then
  echo "::error::PR title must contain a ClickUp task ID in the format SF-<id>."
  echo "::error::Example: 'SF-abc123: Add new feature'"
  exit 1
fi

echo "Found task ID: ${TASK_ID}"

# Validate ClickUp API Token
if [ -z "${CLICKUP_API_TOKEN:-}" ]; then
  echo "::error::CLICKUP_API_TOKEN is not set."
  exit 1
fi

# Validate ClickUp Team ID
if [ -z "${CLICKUP_TEAM_ID:-}" ]; then
  echo "::error::CLICKUP_TEAM_ID is not set."
  exit 1
fi


RESPONSE_FILE=$(mktemp)
trap 'rm -f "$RESPONSE_FILE"' EXIT

HTTP_STATUS=$(curl -s -o "$RESPONSE_FILE" -w "%{http_code}" \
  "https://api.clickup.com/api/v2/task/${TASK_ID}?custom_task_ids=true&team_id=${CLICKUP_TEAM_ID}" \
  -H "Authorization: ${CLICKUP_API_TOKEN}")

if [ "$HTTP_STATUS" -eq 200 ]; then
  TASK_NAME=$(jq -r '.name // "Unknown"' "$RESPONSE_FILE")
  echo "Validated ClickUp task: ${TASK_ID} — ${TASK_NAME}"
  exit 0
else
  echo "::error::ClickUp task ${TASK_ID} not found (HTTP ${HTTP_STATUS})."
  echo "::error::Please ensure the task exists at https://app.clickup.com/90151281461/v/b/6-901517460227-2"
  exit 1
fi
