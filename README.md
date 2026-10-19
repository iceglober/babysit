# babysit

An MCP server that lets coding agents shepherd GitHub pull requests to merge without polling.

Agents spend a lot of turns watching PRs: in one day of Claude Code and Codex sessions, 258 of 2,291 shell commands (11%) were `gh pr checks`, `gh pr view`, `gh run view`, `gh api` and sleep loops. babysit replaces that with one digest call and one blocking wait.

```
babysit_status(pr) → do what NEXT says → babysit_wait(pr) → repeat until NEXT is "done"
```

## Tools

| tool | what it does |
|---|---|
| `babysit_status` | One-call digest: the next action, failing checks with the tail of their failed log and a likely-flaky hint, unresolved review threads, conflicts, merge-queue state. |
| `babysit_wait` | Blocks until the PR needs the agent: a check fails, checks finish, a new review comment, a conflict, removal from the queue, merge or close. After `max_minutes` (default 8) it returns the current state; call again to keep waiting. |
| `babysit_watch` | The same for up to 30 PRs at once; returns when any needs attention, ordered by urgency. For sessions running many subagents. |
| `babysit_rerun_failed` | Reruns failed GitHub Actions jobs on the head commit. With `only_flaky` or `checks`, reruns only those jobs. |
| `babysit_update_branch` | `gh pr update-branch` (merge commit, or `rebase: true`). Refuses on conflicts. |
| `babysit_enqueue` | Comments `@mergifyio queue` on Mergify repos, otherwise `gh pr merge --auto`. Refuses drafts, conflicts, failing checks and unresolved threads unless `force: true`. |

The three action tools take `dry_run: true` to show the `gh` command without running it.

`pr` can be a number, `owner/name#number`, or a PR URL. A bare number uses the repo of the server's working directory, or pass `repo: "owner/name"`.

## Next actions

In priority order: `done`, `closed`, `resolve_conflicts`, `fix_checks`, `rerun_flaky`, `address_reviews`, `changes_requested`, `mark_ready`, `requeue`, `wait_queue`, `update_branch`, `wait_checks`, `needs_review`, `enqueue`.

A failing check is flagged likely flaky when its conclusion is timed-out, cancelled or failed-to-start, or its log matches an infrastructure failure (runner lost, network error, upstream 5xx or rate limit, timeout, out of memory). A failure that is also red on the base branch's head is called out as probably not caused by the PR.

## Merge queues

- **GitHub merge queue / auto-merge:** read from `mergeQueueEntry`, `autoMergeRequest` and removal events.
- **Mergify:** read from Mergify's status comment payload (queue state, ETA, unmet conditions) and the `Mergify Merge Queue` check. Mergify's own gate checks (`Mergify Merge Queue`, `Mergify Merge Protections`) are never reported as things to fix.

## Install

Needs Node 20+ and an authenticated `gh` (`gh auth status`). babysit never sees a token; everything goes through `gh`.

```sh
npm install && npm run build
```

Claude Code (all projects):

```sh
claude mcp add --scope user babysit -- node ~/repos/iceglober/babysit/dist/src/index.js
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.babysit]
command = "node"
args = ["/Users/<you>/repos/iceglober/babysit/dist/src/index.js"]
tool_timeout_sec = 900   # babysit_wait blocks for up to max_minutes
```

Keep `max_minutes` under your client's MCP tool timeout. babysit sends progress notifications while waiting, which some clients use to keep the call alive.

## Cost

One GraphQL query per PR per poll (about 1 point of the 5,000/hour budget), plus `gh run view --log-failed` once per failing run (cached). `babysit_wait` polls every 30s by default; `babysit_watch` every 45s.

## Development

```sh
npm test                                   # unit tests on synthetic PR data
BABYSIT_CWD=/path/to/repo node scripts/smoke.mjs --tools babysit_status '{"pr":123}'   # live, over real MCP stdio
```
