import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { type Digest, allChecks, buildDigest, render } from './digest.js';
import { GhError, type PrRef, failedLogTail, failingOnBranch, fetchPr, gh, resolvePr } from './github.js';

const INSTRUCTIONS = `babysit shepherds GitHub pull requests to merge.
Use it instead of polling with \`gh pr checks\`, \`gh run view\`, or sleep loops.
Loop: babysit_status(pr) -> do what NEXT says -> babysit_wait(pr) -> repeat, until NEXT is "done".
babysit_wait returns as soon as something needs you (a check fails, a review comment arrives,
a conflict appears, the queue drops the PR, it merges) or after max_minutes with the current state.
Failing checks come with their failed-log tail and a "likely flaky" hint; rerun flakes with
babysit_rerun_failed, fix everything else in code. Use babysit_watch to supervise several PRs at once.`;

type Extra = { signal?: AbortSignal; _meta?: { progressToken?: string | number }; sendNotification?: (n: any) => Promise<void> };

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: `error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });

async function digestFor(ref: PrRef, withLogs: boolean, logLines = 40): Promise<Digest> {
  const raw = await fetchPr(ref);
  const failing = allChecks(raw).filter((c) => c.status === 'failure' && !c.name.startsWith('Mergify'));
  if (!withLogs || failing.length === 0 || raw.merged || raw.state === 'CLOSED') return buildDigest(raw);
  const logs = new Map<string, string>();
  await Promise.all(
    failing
      .filter((c) => c.runId)
      .slice(0, 6)
      .map(async (c) => {
        const tail = await failedLogTail(ref, c.runId!, c.name, logLines, c.url).catch(() => '');
        if (tail) logs.set(c.name, tail);
      }),
  );
  const baseFailing = await failingOnBranch(ref, raw.baseRefName).catch(() => undefined);
  return buildDigest(raw, { logs, baseFailing });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

async function progress(extra: Extra, n: number, message: string) {
  const token = extra._meta?.progressToken;
  if (token === undefined || !extra.sendNotification) return;
  await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: n, message } }).catch(() => {});
}

const prArg = z.union([z.string(), z.number()]).describe('PR number, owner/name#number, or PR URL');
const repoArg = z.string().optional().describe('owner/name, when pr is a bare number and the server is not running inside that repo');
const dryRunArg = z.boolean().optional().describe('Show the gh command without running it');

const repoUsesMergify = new Map<string, boolean>();
async function usesMergify(ref: PrRef, d: Digest): Promise<boolean> {
  if (d.queue.provider === 'mergify') return true;
  if (d.queue.provider === 'github') return false;
  const key = `${ref.owner}/${ref.name}`;
  if (!repoUsesMergify.has(key)) {
    let found = false;
    for (const path of ['.mergify.yml', '.github/mergify.yml', '.mergify/config.yml']) {
      const ok = await gh(['api', `repos/${key}/contents/${path}`, '--silent']).then(() => true, () => false);
      if (ok) {
        found = true;
        break;
      }
    }
    repoUsesMergify.set(key, found);
  }
  return repoUsesMergify.get(key)!;
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'babysit', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'babysit_status',
    {
      title: 'PR status and next action',
      description:
        'One-call digest of a pull request: the single next action, failing checks with their failed-log tail and flaky hints, unresolved review threads, conflicts, and merge-queue state (GitHub or Mergify).',
      inputSchema: { pr: prArg, repo: repoArg, log_lines: z.number().int().min(0).max(200).optional().describe('Failed-log lines per failing check (default 25)') },
      annotations: { readOnlyHint: true },
    },
    async ({ pr, repo, log_lines }) => {
      try {
        const ref = await resolvePr(pr, repo);
        return text(render(await digestFor(ref, true, log_lines ?? 25), { logLines: log_lines ?? 25 }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'babysit_wait',
    {
      title: 'Wait until the PR needs you',
      description:
        'Blocks until something about the PR needs action (a check fails, checks finish, a new review comment, a conflict, removal from the merge queue, merge or close), then returns the digest. Returns the current digest after max_minutes if nothing changed; call it again to keep waiting. Use this instead of sleep/poll loops.',
      inputSchema: {
        pr: prArg,
        repo: repoArg,
        until: z.enum(['actionable', 'done']).optional().describe('"actionable" (default): return on anything needing you. "done": only on merge or close.'),
        max_minutes: z.number().min(0.5).max(60).optional().describe('Give up and return the current state after this long (default 8). Keep it under your MCP client tool timeout.'),
        poll_seconds: z.number().int().min(10).max(300).optional().describe('GitHub polling interval (default 30)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ pr, repo, until, max_minutes, poll_seconds }, extra: Extra) => {
      try {
        const ref = await resolvePr(pr, repo);
        const start = await digestFor(ref, false);
        if (start.state !== 'open') return text(render(await digestFor(ref, true)));
        const deadline = Date.now() + (max_minutes ?? 8) * 60_000;
        let n = 0;
        while (Date.now() < deadline && !extra.signal?.aborted) {
          await sleep(Math.min((poll_seconds ?? 30) * 1000, Math.max(0, deadline - Date.now())), extra.signal);
          if (extra.signal?.aborted) break;
          const d = await digestFor(ref, false);
          await progress(extra, ++n, `${d.next.kind}: ${d.next.summary}`);
          if (d.state !== 'open') return text(render(await digestFor(ref, true)));
          if (until !== 'done' && d.actionable && d.fingerprint !== start.fingerprint) {
            return text(`Changed: needs you now.\n${render(await digestFor(ref, true))}`);
          }
        }
        const d = await digestFor(ref, true);
        const mins = Math.round(((max_minutes ?? 8) * 10)) / 10;
        return text(`No new action needed after ${mins} min; call babysit_wait again to keep waiting.\n${render(d)}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'babysit_watch',
    {
      title: 'Watch several PRs',
      description:
        'Waits on several PRs at once and returns when any of them needs action (same triggers as babysit_wait), with a one-line status per PR ordered by urgency. For agents running many PRs in parallel.',
      inputSchema: {
        prs: z.array(z.union([z.string(), z.number()])).min(1).max(30).describe('PR numbers, owner/name#number, or URLs'),
        repo: repoArg,
        max_minutes: z.number().min(0.5).max(60).optional().describe('Default 8'),
        poll_seconds: z.number().int().min(15).max(300).optional().describe('Default 45'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ prs, repo, max_minutes, poll_seconds }, extra: Extra) => {
      try {
        const refs = await Promise.all(prs.map((p) => resolvePr(p, repo)));
        const snap = async () => Promise.all(refs.map((r) => digestFor(r, false).catch((e) => e as Error)));
        const start = await snap();
        const startFp = start.map((d) => (d instanceof Error ? '' : d.fingerprint));
        const urgency = (d: Digest | Error) => (d instanceof Error ? 0 : d.actionable ? 1 : 2);
        const line = (d: Digest | Error, i: number) =>
          d instanceof Error ? `${prs[i]}: error: ${d.message}` : `${d.repo}#${d.number} ${d.next.kind}: ${d.next.summary}`;
        const report = (ds: (Digest | Error)[], changed: Set<number>) =>
          ds
            .map((d, i) => ({ d, i }))
            .sort((a, b) => Number(changed.has(b.i)) - Number(changed.has(a.i)) || urgency(a.d) - urgency(b.d))
            .map(({ d, i }) => `${changed.has(i) ? '* ' : '  '}${line(d, i)}`)
            .join('\n');
        const deadline = Date.now() + (max_minutes ?? 8) * 60_000;
        let n = 0;
        while (Date.now() < deadline && !extra.signal?.aborted) {
          await sleep(Math.min((poll_seconds ?? 45) * 1000, Math.max(0, deadline - Date.now())), extra.signal);
          if (extra.signal?.aborted) break;
          const now = await snap();
          const changed = new Set(
            now.map((d, i) => (!(d instanceof Error) && (d.state !== 'open' || (d.actionable && d.fingerprint !== startFp[i])) ? i : -1)).filter((i) => i >= 0),
          );
          await progress(extra, ++n, `${changed.size} of ${refs.length} need attention`);
          if (changed.size) return text(`${changed.size} PR(s) need you (marked *). Run babysit_status on them for details.\n${report(now, changed)}`);
        }
        return text(`No PR changed in a way that needs you; call babysit_watch again to keep waiting.\n${report(await snap(), new Set())}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'babysit_rerun_failed',
    {
      title: 'Rerun failed CI jobs',
      description:
        'Reruns the failed jobs of the GitHub Actions runs behind failing checks on the PR head commit (gh run rerun --failed). By default reruns every failing Actions check; pass only_flaky to rerun just the ones babysit flags as likely flaky, or checks to name them.',
      inputSchema: {
        pr: prArg,
        repo: repoArg,
        checks: z.array(z.string()).optional().describe('Only these check names'),
        only_flaky: z.boolean().optional(),
        dry_run: dryRunArg,
      },
    },
    async ({ pr, repo, checks, only_flaky, dry_run }) => {
      try {
        const ref = await resolvePr(pr, repo);
        const d = await digestFor(ref, true);
        let targets = d.checks.failing;
        if (checks?.length) targets = targets.filter((c) => checks.includes(c.name));
        if (only_flaky) targets = targets.filter((c) => c.flaky?.likely);
        const notActions = targets.filter((c) => !c.runId).map((c) => c.name);
        const actions = targets.filter((c) => c.runId);
        if (!actions.length) return text(`Nothing to rerun.${notActions.length ? ` Not GitHub Actions (can't rerun from here): ${notActions.join(', ')}.` : ''}\n${render(d)}`);
        // Rerunning a whole run with --failed would also rerun failures the caller filtered out,
        // so when filtering, rerun the selected jobs individually (job id is in the check URL).
        const filtered = targets.length < d.checks.failing.length;
        const commands: string[][] = [];
        const repoFlag = ['--repo', `${ref.owner}/${ref.name}`];
        if (filtered) {
          for (const c of actions) {
            const job = c.url?.match(/\/job\/(\d+)/)?.[1];
            commands.push(job ? ['run', 'rerun', '--job', job, ...repoFlag] : ['run', 'rerun', String(c.runId), '--failed', ...repoFlag]);
          }
        } else {
          for (const id of new Set(actions.map((c) => c.runId!))) commands.push(['run', 'rerun', String(id), '--failed', ...repoFlag]);
        }
        const out: string[] = [];
        for (const args of commands) {
          if (dry_run) out.push(`would run: gh ${args.join(' ')}`);
          else out.push(await gh(args).then(() => `ok: gh ${args.slice(0, 4).join(' ')}`, (e) => `failed: ${(e as Error).message}`));
        }
        if (notActions.length) out.push(`not GitHub Actions, rerun them where they come from: ${notActions.join(', ')}`);
        out.push(`checks: ${targets.map((c) => c.name).join(', ')}. Next: babysit_wait.`);
        return text(out.join('\n'));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'babysit_update_branch',
    {
      title: 'Bring the PR branch up to date',
      description:
        'Updates the PR branch with its base on GitHub (gh pr update-branch): a merge commit by default, or a rebase. Refuses if the PR has conflicts, which must be resolved locally. Afterwards your local branch is behind origin; pull before committing again.',
      inputSchema: { pr: prArg, repo: repoArg, rebase: z.boolean().optional(), dry_run: dryRunArg },
    },
    async ({ pr, repo, rebase, dry_run }) => {
      try {
        const ref = await resolvePr(pr, repo);
        const d = await digestFor(ref, false);
        if (d.mergeable === 'CONFLICTING') return text(`Refusing: ${d.repo}#${d.number} conflicts with ${d.base}. Resolve locally (merge or rebase ${d.base}), then push.`);
        const args = ['pr', 'update-branch', String(ref.number), '--repo', `${ref.owner}/${ref.name}`, ...(rebase ? ['--rebase'] : [])];
        if (dry_run) return text(`would run: gh ${args.join(' ')}`);
        await gh(args);
        return text(
          `Updated ${d.head} with ${d.base} on GitHub (${rebase ? 'rebase' : 'merge commit'}). Your local branch is now behind: run \`git pull${rebase ? ' --rebase' : ''}\` before committing again. Checks will restart; next: babysit_wait.`,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'babysit_enqueue',
    {
      title: 'Add the PR to the merge queue',
      description:
        'Queues the PR for merge: comments "@mergifyio queue" on Mergify repos, otherwise gh pr merge --auto (GitHub merge queue, or auto-merge when checks pass). Refuses drafts, conflicts, failing checks, and unresolved review threads unless force is set.',
      inputSchema: {
        pr: prArg,
        repo: repoArg,
        method: z.enum(['squash', 'merge', 'rebase']).optional().describe('Merge method for non-queue auto-merge (default squash)'),
        force: z.boolean().optional().describe('Queue even though babysit sees blockers'),
        dry_run: dryRunArg,
      },
    },
    async ({ pr, repo, method, force, dry_run }) => {
      try {
        const ref = await resolvePr(pr, repo);
        const d = await digestFor(ref, false);
        if (d.state !== 'open') return text(`${d.repo}#${d.number} is ${d.state}; nothing to queue.`);
        if (d.queue.inQueue) return text(`Already queued.\n${render(d)}`);
        const blockers = [
          d.draft && 'draft',
          d.mergeable === 'CONFLICTING' && 'conflicts',
          d.checks.failing.length && `${d.checks.failing.length} failing check(s)`,
          d.threads.length && `${d.threads.length} unresolved review thread(s)`,
        ].filter(Boolean);
        if (blockers.length && !force) return text(`Not queuing: ${blockers.join(', ')}. Fix them first, or pass force: true.\n${render(d)}`);
        const full = `${ref.owner}/${ref.name}`;
        if (await usesMergify(ref, d)) {
          const args = ['pr', 'comment', String(ref.number), '--repo', full, '--body', '@mergifyio queue'];
          if (dry_run) return text(`would run: gh ${args.join(' ')}`);
          await gh(args);
          return text(`Asked Mergify to queue ${full}#${ref.number}. Next: babysit_wait (it returns if the queue drops the PR or when it merges).`);
        }
        const args = ['pr', 'merge', String(ref.number), '--repo', full, '--auto'];
        if (dry_run) return text(`would run: gh ${args.join(' ')} (adds --${method ?? 'squash'} if the repo has no merge queue)`);
        try {
          await gh(args);
        } catch (e) {
          if (!/merge method|--merge|--squash|--rebase/i.test((e as Error).message)) throw e;
          await gh([...args, `--${method ?? 'squash'}`]);
        }
        return text(`Queued ${full}#${ref.number} (merge queue or auto-merge). Next: babysit_wait.`);
      } catch (e) {
        return fail(e instanceof GhError ? e : new Error(String(e)));
      }
    },
  );

  return server;
}
