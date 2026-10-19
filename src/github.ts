// Everything that talks to GitHub goes through the `gh` CLI, so babysit uses the user's
// existing `gh auth login` and never handles tokens itself.

import { execFile } from 'node:child_process';

export interface PrRef {
  owner: string;
  name: string;
  number: number;
}

export class GhError extends Error {}

export function gh(args: string[], opts: { timeoutMs?: number; cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      args,
      { timeout: opts.timeoutMs ?? 60_000, maxBuffer: 64 * 1024 * 1024, cwd: opts.cwd },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message).trim().split('\n').slice(-5).join('\n');
          reject(new GhError(`gh ${args.slice(0, 3).join(' ')}: ${msg}`));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

function git(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 10_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim())));
  });
}

/** Accepts `123`, `#123`, `owner/name#123`, or a PR URL. `repo` (owner/name) fills in a bare number. */
export async function resolvePr(pr: string | number, repo?: string, cwd?: string): Promise<PrRef> {
  const s = String(pr).trim();
  const url = s.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (url) return { owner: url[1], name: url[2], number: Number(url[3]) };
  const qualified = s.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  if (qualified) return { owner: qualified[1], name: qualified[2], number: Number(qualified[3]) };
  const num = s.match(/^#?(\d+)$/);
  if (!num) throw new GhError(`can't parse PR "${s}"; use a number, owner/name#number, or a PR URL`);
  let full = repo;
  if (!full) {
    const remote = await git(['remote', 'get-url', 'origin'], cwd).catch(() => '');
    const m = remote.match(/github\.com[:/]([^/]+)\/(.+?)(\.git)?$/);
    if (!m) throw new GhError(`PR ${s} has no repo; pass repo="owner/name" or a PR URL`);
    full = `${m[1]}/${m[2]}`;
  }
  const [owner, name] = full.split('/');
  return { owner, name, number: Number(num[1]) };
}

export const PR_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  rateLimit { remaining resetAt }
  repository(owner: $owner, name: $name) {
    nameWithOwner
    pullRequest(number: $number) {
      number title url state isDraft merged
      headRefName baseRefName headRefOid
      mergeable mergeStateStatus reviewDecision
      autoMergeRequest { enabledAt }
      mergeQueueEntry { position state enqueuedAt estimatedTimeToMerge }
      timelineItems(last: 10, itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT]) {
        nodes { ... on RemovedFromMergeQueueEvent { createdAt reason } }
      }
      comments(last: 30) { nodes { author { login } body createdAt url } }
      reviewThreads(first: 100) {
        nodes {
          id isResolved isOutdated path line
          comments(first: 1) { nodes { author { login } body url createdAt } }
          last: comments(last: 1) { totalCount nodes { author { login } createdAt } }
        }
      }
      commits(last: 1) { nodes { commit {
        oid
        statusCheckRollup {
          state
          contexts(first: 100) {
            totalCount
            nodes {
              __typename
              ... on CheckRun {
                databaseId name title status conclusion detailsUrl startedAt completedAt
                isRequired(pullRequestNumber: $number)
                checkSuite { workflowRun { databaseId workflow { name } } }
              }
              ... on StatusContext {
                context state targetUrl createdAt
                isRequired(pullRequestNumber: $number)
              }
            }
          }
        }
      } } }
    }
  }
}`;

export async function fetchPr(ref: PrRef): Promise<any> {
  const out = await gh([
    'api', 'graphql',
    '-f', `query=${PR_QUERY}`,
    '-f', `owner=${ref.owner}`,
    '-f', `name=${ref.name}`,
    '-F', `number=${ref.number}`,
  ]);
  const json = JSON.parse(out);
  const pr = json?.data?.repository?.pullRequest;
  if (!pr) throw new GhError(`PR ${ref.owner}/${ref.name}#${ref.number} not found`);
  return { ...pr, repo: json.data.repository.nameWithOwner, rateLimit: json.data.rateLimit };
}

/** Check names (job names) that are currently failing on the head of `branch`. */
export async function failingOnBranch(ref: PrRef, branch: string): Promise<Set<string>> {
  const q = `query($owner: String!, $name: String!, $q: String!) {
    repository(owner: $owner, name: $name) { ref(qualifiedName: $q) { target { ... on Commit {
      statusCheckRollup { contexts(first: 100) { nodes { __typename
        ... on CheckRun { name status conclusion }
        ... on StatusContext { context state } } } } } } } } }`;
  const out = await gh(['api', 'graphql', '-f', `query=${q}`, '-f', `owner=${ref.owner}`, '-f', `name=${ref.name}`, '-f', `q=refs/heads/${branch}`]);
  const nodes = JSON.parse(out)?.data?.repository?.ref?.target?.statusCheckRollup?.contexts?.nodes ?? [];
  const failing = new Set<string>();
  for (const n of nodes) {
    if (n.__typename === 'CheckRun' && n.status === 'COMPLETED' && !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(n.conclusion)) failing.add(n.name);
    if (n.__typename === 'StatusContext' && ['FAILURE', 'ERROR'].includes(n.state)) failing.add(n.context);
  }
  return failing;
}

const logCache = new Map<string, string>();

/** Tail of the failed-step log for one job of a workflow run. Empty if unavailable. */
export async function failedLogTail(ref: PrRef, runId: number, jobName: string, lines = 40, jobUrl?: string): Promise<string> {
  const jobId = jobUrl?.match(/\/job\/(\d+)(?:$|[?#])/ )?.[1];
  const key = `${ref.owner}/${ref.name}:${runId}:${jobName}`;
  let log = logCache.get(key);
  if (log === undefined) {
    if (jobId) {
      const raw = await gh(['api', `repos/${ref.owner}/${ref.name}/actions/jobs/${jobId}/logs`], { timeoutMs: 90_000 }).catch(() => '');
      if (raw) log = raw.split('\n').map(line => `${jobName}\tJob log\t${line}`).join('\n');
    }
    if (!log) log = await gh(['run', 'view', String(runId), '--repo', `${ref.owner}/${ref.name}`, '--log-failed'], { timeoutMs: 90_000 }).catch(() => '');
    // Other jobs may still be running, so unavailable logs must remain retryable.
    if (log) logCache.set(key, log);
    if (logCache.size > 200) logCache.delete(logCache.keys().next().value!);
  }
  return failedStepLogTail(log, jobName, lines);
}

export function failedStepLogTail(log: string, jobName: string, lines: number): string {
  const rows = log.split('\n').filter((line) => line.startsWith(`${jobName}\t`)).map((line) => {
    const parts = line.split('\t');
    return { step: parts[1], text: parts.slice(2).join('\t').replace(/^\S+Z /, '').replace(/\x1b\[[0-9;]*m/g, '') };
  });
  const failureIndex = rows.findIndex((row) => row.text.includes('##[error]'));
  const failedStep = failureIndex < 0 ? undefined : rows[failureIndex]?.step;
  const terminalIndex = rows.findIndex((row, index) => index >= failureIndex && row.step === failedStep && /##\[error\]Process completed with exit code/.test(row.text));
  const endIndex = terminalIndex < 0 ? failureIndex : terminalIndex;
  const selected = failedStep === undefined ? rows : rows.slice(0, endIndex + 1).filter((row) => row.step === failedStep);
  return selected.map((row) => row.text).filter((line) => line.trim() !== '').slice(-lines).join('\n');
}
