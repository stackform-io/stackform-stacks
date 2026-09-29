/**
 * Validate that a PR title contains a ClickUp task ID (SF-<id>) that exists.
 *
 * Usage:
 *   node scripts/validate-pr-clickup.ts "<PR title>"
 *
 * Needs CLICKUP_API_TOKEN and CLICKUP_TEAM_ID in the environment.
 */

const BOARD_URL = "https://app.clickup.com/90151281461/v/b/6-901517460227-2";

function fail(...lines: string[]): never {
  for (const line of lines) console.error(`::error::${line}`);
  process.exit(1);
}

// First line only, so a multi-line title cannot smuggle an ID past the check.
const title = (process.argv[2] ?? "").split("\n")[0]?.trim() ?? "";
if (!title) fail("No PR title provided.");

const taskId = /SF-[A-Za-z0-9]+/.exec(title)?.[0];
if (!taskId) {
  fail("PR title must contain a ClickUp task ID in the format SF-<id>.", "Example: 'SF-abc123: Add new feature'");
}
console.log(`Found task ID: ${taskId}`);

const token = process.env.CLICKUP_API_TOKEN;
const teamId = process.env.CLICKUP_TEAM_ID;
if (!token) fail("CLICKUP_API_TOKEN is not set.");
if (!teamId) fail("CLICKUP_TEAM_ID is not set.");

const url = new URL(`https://api.clickup.com/api/v2/task/${encodeURIComponent(taskId)}`);
url.searchParams.set("custom_task_ids", "true");
url.searchParams.set("team_id", teamId);

const response = await fetch(url, { headers: { Authorization: token } });
if (!response.ok) {
  fail(`ClickUp task ${taskId} not found (HTTP ${response.status}).`, `Please ensure the task exists at ${BOARD_URL}`);
}

const task: unknown = await response.json();
const name =
  typeof task === "object" && task !== null && "name" in task && typeof task.name === "string" ? task.name : "Unknown";
console.log(`Validated ClickUp task: ${taskId} — ${name}`);
