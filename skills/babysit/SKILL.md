---
name: babysit
description: >
  Shepherd GitHub pull requests to merge with the babysit MCP tools. Use whenever you need to
  check a PR's CI or review status, wait for checks or a merge queue, find out why a check
  failed, rerun flaky CI, bring a branch up to date, or queue a PR to merge, including after
  you push or open a PR. Use it instead of `gh pr checks`, `gh pr view`, `gh run view`,
  `gh run watch`, or sleep/poll loops.
---

# Shepherding PRs with babysit

The babysit MCP server gives you one digest per PR and a wait that returns only when the PR
needs you. Polling GitHub yourself costs turns, tokens, and shell processes and is slower to
notice problems, so don't.

## The loop

1. `babysit_status(pr)`: read the `NEXT:` line first. It is the single thing to do now.
2. Do what NEXT says (table below).
3. `babysit_wait(pr)`: blocks until something needs you, or returns the current state after
   `max_minutes` (default 8). If it says nothing changed, call it again.
4. Repeat until NEXT is `done`.

Several PRs (e.g. one per subagent or worktree): `babysit_watch(prs)` returns when any of
them needs you, most urgent first; then `babysit_status` the ones marked `*`.

`pr` can be a number, `owner/name#number`, or a URL. If a bare number doesn't resolve, pass
`repo: "owner/name"` or the URL.

## What to do for each NEXT

| NEXT | Do |
|---|---|
| `fix_checks` | Read the log tail under each FAILING line, reproduce locally, fix, push. If it says the check also fails on the base branch, the PR probably didn't cause it: tell the user rather than working around it. |
| `rerun_flaky` | `babysit_rerun_failed(pr, only_flaky: true)`, then wait. If the same check fails again after 2 reruns, treat it as a real failure. |
| `resolve_conflicts` | Merge or rebase the base branch locally, resolve, run the relevant tests, push. `babysit_update_branch` can't resolve conflicts. |
| `address_reviews` | Fix the code or reply in the thread, then resolve the thread. Outdated threads still block Mergify until resolved. |
| `changes_requested` | Address the review, then re-request review from that reviewer. |
| `update_branch` | `babysit_update_branch(pr)`, then `git pull` locally before committing again. |
| `mark_ready` | Only if the work is actually done: `gh pr ready`. |
| `requeue` | Fix the reason it was dropped from the queue (shown in NEXT), then `babysit_enqueue(pr)`. |
| `wait_checks`, `wait_queue` | `babysit_wait(pr)`. Don't touch the PR. |
| `needs_review` | A human has to approve. Tell the user and stop; don't keep waiting. |
| `enqueue` | Only if the user asked you to land the PR: `babysit_enqueue(pr)`. Otherwise report that it's ready. |
| `done` / `closed` | Report and stop. |

## Rules

- Don't queue, merge, or force-queue (`force: true`) a PR unless the user asked you to land it.
  Never use `gh pr merge --admin` or any other way of bypassing branch protection.
- Don't post `@mergifyio` commands or rerun workflows by hand; the babysit tools do it and
  check for blockers first.
- Use `dry_run: true` on an action tool when you want to show the user what it would do.
- Keep `max_minutes` below the MCP tool timeout of your client. If a wait call times out,
  call it again with a smaller `max_minutes`.
- When you stop, tell the user the PR's state in one line: what's done, and what (if anything)
  is waiting on them.
