# babysit

babysit helps coding agents manage GitHub pull requests until they merge. It reports what needs attention and waits for changes.

It runs as an MCP server. MCP connects an agent to tools. babysit uses the GitHub CLI, `gh`, with your existing sign-in.

The agent follows this loop:

```text
babysit_status(pr) → do what NEXT says → babysit_wait(pr) → repeat until NEXT is "done"
```

babysit polls GitHub for the agent. The agent does not need repeated shell commands or sleep loops.

## Install

You need Node 20 or later, npm, Git, and an authenticated `gh`. Run `gh auth status` to make sure that you are signed in.

You can run babysit directly from GitHub. You do not need to clone or build it yourself:

```sh
npx -y --package=github:iceglober/babysit babysit
```

On the first run, npm downloads the source, installs its dependencies, and builds the server. Later runs can use npm's cache.

To add babysit to Claude Code for all projects, run:

```sh
claude mcp add --scope user babysit -- npx -y --package=github:iceglober/babysit babysit
```

For Codex, add this section to `~/.codex/config.toml`:

```toml
[mcp_servers.babysit]
command = "npx"
args = ["-y", "--package=github:iceglober/babysit", "babysit"]
tool_timeout_sec = 900
```

For another MCP client, use `npx` as the command with the arguments above. Start the server in the repository that you want it to watch.

The GitHub command runs code from the repository's default branch. To keep a fixed version, append `#<commit-sha>` to `github:iceglober/babysit`.

Only install code that you trust. If npm blocks install scripts under your security policy, approve the package's `prepare` script before installation.

Keep `max_minutes` below your client's tool timeout. babysit sends progress messages while it waits.

## Repository configuration

Create `.agent/.babysit.json` in the root of each repository that uses babysit. JSON keeps the configuration as data, not executable code.

This example shows all fields with their default values:

```json
{
  "mergeQueue": null,
  "mergeMethod": "squash",
  "checks": {
    "ignored": [],
    "logLines": 25
  },
  "polling": {
    "maxMinutes": 8,
    "waitSeconds": 30,
    "watchSeconds": 45
  }
}
```

All fields are optional. Without the file, babysit uses the defaults above. Invalid JSON, unknown fields, and invalid values stop the tool call.

| Field | Meaning | Allowed values |
| --- | --- | --- |
| `mergeQueue` | The service that queues the pull request | `"github"`, `"mergify"`, `null`, or omitted |
| `mergeMethod` | The merge method when GitHub uses auto-merge without a queue | `squash`, `merge`, or `rebase` |
| `checks.ignored` | Exact check names to exclude from results and actions | An array of nonempty strings |
| `checks.logLines` | The number of failed log lines to report per check | An integer from 0 to 200 |
| `polling.maxMinutes` | How long a wait or watch call runs | A number from 0.5 to 60 |
| `polling.waitSeconds` | The time between GitHub requests for `babysit_wait` | An integer from 10 to 300 |
| `polling.watchSeconds` | The time between GitHub requests for `babysit_watch` | An integer from 15 to 300 |

Tool arguments override the corresponding defaults in the configuration. For example, `poll_seconds` overrides the interval for that call.

Omitted `mergeQueue` and `null` both mean no merge queue. JSON does not support `undefined`. Omit the field to represent it.

For a watch call across repositories, babysit uses the shortest configured duration and interval. Explicit tool arguments still take priority.

Ignored checks do not block actions, appear in results, or receive rerun requests. Ignore a check only when it is safe to exclude it.

### Where babysit reads the file

If the current checkout's `origin` identifies the target repository, babysit reads its local file. This also works from a subdirectory.

For another repository, babysit reads the file from that repository's default branch through GitHub. It does not read configuration from the pull request branch.

A missing file uses defaults. Other read errors stop the call. babysit reads the configuration at the start of each tool call.

### Mergify

Mergify is optional. babysit does not select it from comments, check names, or Mergify configuration files.

For a repository that uses Mergify, set:

```json
{
  "mergeQueue": "mergify"
}
```

With this configuration, babysit reads Mergify's queue status and posts `@mergifyio queue` to request a merge.

It excludes `Mergify Merge Queue` and `Mergify Merge Protections` from normal check results.

These two checks report the state of other requirements. They are not separate test failures to fix.

With `"mergeQueue": "github"`, babysit reads GitHub's merge queue. It uses `gh pr merge --auto` to request a merge through that queue.

Without a merge queue, babysit uses GitHub auto-merge with `mergeMethod`. GitHub controls whether auto-merge is available for the repository.

## Tools

| Tool | What it does |
| --- | --- |
| `babysit_status` | Reports the next action, failed checks, failed logs, review threads, conflicts, and queue state. |
| `babysit_wait` | Waits for a change that needs attention, a merge, or a close. Returns the current state when its time limit ends. |
| `babysit_watch` | Watches up to 30 pull requests. Returns when one needs attention, with the most urgent results first. |
| `babysit_rerun_failed` | Reruns failed GitHub Actions jobs. Use `only_flaky` or `checks` to limit the selection. |
| `babysit_update_branch` | Updates the branch with `gh pr update-branch`. Uses a merge commit unless you pass `rebase: true`. Refuses conflicts. |
| `babysit_enqueue` | Requests a merge through the configured queue or GitHub auto-merge. Refuses drafts, conflicts, failed checks, and unresolved threads unless you pass `force: true`. |

The three tools that change GitHub accept `dry_run: true`. This shows the command without running it.

For `pr`, pass a number, `owner/name#number`, or a pull request URL. A bare number uses the current checkout's `origin`.

If the server runs outside the target repository, pass `repo: "owner/name"` with a bare number. A full pull request URL also works.

## Read the result

`NEXT` names the next action. babysit chooses actions in this order:

```text
done, closed, resolve_conflicts, fix_checks, rerun_flaky,
address_reviews, changes_requested, mark_ready, requeue,
wait_queue, update_branch, wait_checks, needs_review, enqueue
```

A flaky check is a failure that can pass without a code change. babysit reports this as a hint, not proof.

The hints include lost runners, network errors, upstream service errors, rate limits, timeouts, and memory limits. Cancelled jobs and jobs that fail to start also receive hints.

If a check also fails on the base branch, babysit reports that fact. The pull request is not necessarily the cause.

## GitHub requests

Each poll uses one GraphQL query per pull request. A query costs about one point of GitHub's usual 5,000-point hourly budget.

babysit also reads failed job logs and compares failed checks with the base branch. It caches available logs to avoid repeated downloads.

Each remote pull request adds one configuration request at the start of a tool call. The wait and watch intervals come from the configuration or tool arguments.

## Development

For local development, clone this repository. In its root directory, install the dependencies and run the tests:

```sh
npm install
npm test
```

`npm install` also builds the server through the `prepare` script. After source changes, run `npm run build` to update it.

The tests use synthetic pull request data and temporary local repositories. They do not change GitHub.

To test installation from Git with a fresh npm cache, run:

```sh
npm run test:install
```

This test needs network access to download dependencies. It starts the installed MCP server and makes sure that all six tools are available.

To test a live tool through MCP, build babysit and run:

```sh
BABYSIT_CWD=/path/to/repo node scripts/smoke.mjs --tools babysit_status '{"pr":123}'
```

Replace the path and pull request number with a repository that you can access. This command reads GitHub without changing the pull request.
