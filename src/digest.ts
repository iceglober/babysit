// Turns raw PR data into a digest: where the PR stands and the one thing to do next.
// Pure functions over plain data so the decision logic is testable without GitHub.

import { DEFAULT_CONFIG, ignoredChecks, type Config } from './config.js';

export type CheckStatus = 'success' | 'failure' | 'pending' | 'skipped';

export interface Check {
  name: string;
  workflow?: string;
  status: CheckStatus;
  conclusion?: string;
  title?: string;
  required: boolean;
  url?: string;
  runId?: number;
  completedAt?: string;
  flaky?: { likely: boolean; reasons: string[] };
  alsoFailingOnBase?: boolean;
  logTail?: string;
}

export interface Thread {
  id: string;
  path: string;
  line: number | null;
  outdated: boolean;
  author: string;
  body: string;
  url: string;
  replies: number;
  lastAuthor: string;
}

export interface Queue {
  provider: 'github' | 'mergify' | null;
  inQueue: boolean;
  state?: string;
  position?: number;
  eta?: string;
  waitingFor: string[];
  removed?: { at: string; reason: string };
  statusLines: string[];
}

export type ActionKind =
  | 'done'
  | 'closed'
  | 'resolve_conflicts'
  | 'fix_checks'
  | 'rerun_flaky'
  | 'address_reviews'
  | 'changes_requested'
  | 'mark_ready'
  | 'requeue'
  | 'update_branch'
  | 'wait_checks'
  | 'wait_queue'
  | 'needs_review'
  | 'enqueue';

export interface NextAction {
  kind: ActionKind;
  summary: string;
  /** babysit tool that performs it, when there is one */
  tool?: string;
}

export interface Digest {
  repo: string;
  number: number;
  title: string;
  url: string;
  head: string;
  base: string;
  sha: string | null;
  state: 'open' | 'merged' | 'closed';
  draft: boolean;
  mergeable: string;
  mergeState: string;
  reviewDecision: string | null;
  checks: { counts: Record<CheckStatus, number>; failing: Check[]; pending: Check[]; requiredPending: number };
  threads: Thread[];
  queue: Queue;
  next: NextAction;
  actionable: boolean;
  fingerprint: string;
}

export interface Extras {
  config?: Config;
  /** check name -> tail of its failed log */
  logs?: Map<string, string>;
  /** check names currently failing on the base branch head */
  baseFailing?: Set<string>;
}

const MERGIFY_QUEUE_CHECK = 'Mergify Merge Queue';

function checkRunStatus(status: string, conclusion: string | null): CheckStatus {
  if (status !== 'COMPLETED') return 'pending';
  switch (conclusion) {
    case 'SUCCESS':
      return 'success';
    case 'NEUTRAL':
    case 'SKIPPED':
    case 'STALE':
      return 'skipped';
    default:
      return 'failure'; // FAILURE, TIMED_OUT, CANCELLED, ACTION_REQUIRED, STARTUP_FAILURE
  }
}

function contextStatus(state: string): CheckStatus {
  if (state === 'SUCCESS') return 'success';
  if (state === 'PENDING' || state === 'EXPECTED') return 'pending';
  return 'failure';
}

export function allChecks(raw: any): Check[] {
  const nodes = raw.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  return nodes.filter(Boolean).map((c: any): Check =>
    c.__typename === 'CheckRun'
      ? {
          name: c.name,
          workflow: c.checkSuite?.workflowRun?.workflow?.name,
          status: checkRunStatus(c.status, c.conclusion),
          conclusion: c.conclusion ?? undefined,
          title: c.title ?? undefined,
          required: !!c.isRequired,
          url: c.detailsUrl,
          runId: c.checkSuite?.workflowRun?.databaseId,
          completedAt: c.completedAt ?? undefined,
        }
      : {
          name: c.context,
          status: contextStatus(c.state),
          conclusion: c.state,
          required: !!c.isRequired,
          url: c.targetUrl,
        },
  );
}

// Failure signatures that point at CI infrastructure rather than the change.
const INFRA_PATTERNS: [RegExp, string][] = [
  [/runner has received a shutdown signal|lost communication with the server|runner .* (lost|offline)/i, 'runner lost'],
  [/ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|getaddrinfo|network (error|timeout)/i, 'network error'],
  [/\b(502|503|504)\b.*(bad gateway|service unavailable|gateway time-?out)|rate limit exceeded|secondary rate limit/i, 'upstream service error'],
  [/exceeded the maximum execution time|timed out after|has timed out|operation was canceled/i, 'timeout'],
  [/exit code 137|JavaScript heap out of memory|out of memory|Killed\s*$/im, 'out of memory'],
];

export function flakyHints(check: Check, logTail?: string): { likely: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (check.conclusion === 'TIMED_OUT') reasons.push('timed out');
  if (check.conclusion === 'CANCELLED') reasons.push('cancelled');
  if (check.conclusion === 'STARTUP_FAILURE') reasons.push('workflow failed to start');
  for (const [re, label] of INFRA_PATTERNS) if (logTail && re.test(logTail) && !reasons.includes(label)) reasons.push(label);
  return { likely: reasons.length > 0, reasons };
}

export function parseMergify(raw: any, checks: Check[]): Queue {
  const queueCheck = checks.find((c) => c.name === MERGIFY_QUEUE_CHECK);
  const comments: any[] = raw.comments?.nodes ?? [];
  const mine = comments.filter((c) => /^mergify/i.test(c.author?.login ?? '') && c.body?.includes('Mergify Payload'));
  const last = mine[mine.length - 1];
  let payload: any = null;
  let statusLines: string[] = [];
  if (last) {
    const m = last.body.match(/-\*- Mergify Payload -\*-\s*([\s\S]*?)\s*-\*- Mergify Payload End -\*-/);
    try {
      payload = m ? JSON.parse(m[1]) : null;
    } catch {
      payload = null;
    }
    // Only the summary bullets, not the collapsed "Waiting for" checklist under <details>.
    const after = (last.body.split('# Merge Queue Status')[1] ?? '').split('<details>')[0];
    statusLines = after
      .split('\n')
      .filter((l: string) => /^- /.test(l))
      .slice(0, 5)
      .map((l: string) => l.slice(2).replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*/g, '').trim());
  }
  const waitingFor: string[] = [];
  for (const cond of payload?.required_conditions ?? []) {
    if (cond.match) continue;
    const checkNames = (cond.subconditions ?? [])
      .map((s: any) => String(s.description).match(/^check-(?:success|neutral|skipped) = (?:@[^/]+\/)?(.+)$/)?.[1])
      .filter(Boolean);
    waitingFor.push(checkNames.length ? `check ${checkNames[0]}` : String(cond.description));
  }
  const inQueue = queueCheck ? queueCheck.status === 'pending' : !!payload && !['merged', 'dequeued'].includes(payload.state);
  let removed: Queue['removed'];
  if (queueCheck && queueCheck.status === 'failure') {
    removed = { at: queueCheck.completedAt ?? '', reason: queueCheck.title || queueCheck.conclusion || 'removed from queue' };
  }
  return {
    provider: 'mergify',
    inQueue,
    state: payload?.state,
    eta: payload?.estimated_time_of_merge,
    waitingFor: inQueue ? waitingFor : [],
    removed,
    statusLines,
  };
}

export function parseQueue(raw: any, checks: Check[], config: Config = DEFAULT_CONFIG): Queue {
  if (config.mergeQueue === 'mergify') return parseMergify(raw, checks);
  const entry = config.mergeQueue === 'github' ? raw.mergeQueueEntry : undefined;
  const removals = config.mergeQueue === 'github' ? (raw.timelineItems?.nodes ?? []).filter((n: any) => n?.createdAt) : [];
  const lastRemoval = removals[removals.length - 1];
  if (entry || raw.autoMergeRequest || lastRemoval) {
    return {
      provider: 'github',
      inQueue: !!entry || !!raw.autoMergeRequest,
      state: entry?.state ?? (raw.autoMergeRequest ? 'AUTO_MERGE' : undefined),
      position: entry?.position,
      eta: entry?.estimatedTimeToMerge != null ? `${Math.round(entry.estimatedTimeToMerge / 60)} min` : undefined,
      waitingFor: [],
      removed: !entry && lastRemoval ? { at: lastRemoval.createdAt, reason: lastRemoval.reason ?? 'removed from merge queue' } : undefined,
      statusLines: [],
    };
  }
  return { provider: null, inQueue: false, waitingFor: [], statusLines: [] };
}

function threadsOf(raw: any): Thread[] {
  return (raw.reviewThreads?.nodes ?? [])
    .filter((t: any) => t && !t.isResolved)
    .map((t: any) => {
      const first = t.comments?.nodes?.[0] ?? {};
      return {
        id: t.id,
        path: t.path,
        line: t.line ?? null,
        outdated: !!t.isOutdated,
        author: first.author?.login ?? 'unknown',
        body: String(first.body ?? '').replace(/\s+/g, ' ').slice(0, 300),
        url: first.url,
        replies: Math.max(0, (t.last?.totalCount ?? 1) - 1),
        lastAuthor: t.last?.nodes?.[0]?.author?.login ?? 'unknown',
      };
    });
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function decide(d: Omit<Digest, 'next' | 'actionable' | 'fingerprint'>, config: Config = DEFAULT_CONFIG): NextAction {
  if (d.state === 'merged') return { kind: 'done', summary: 'Merged.' };
  if (d.state === 'closed') return { kind: 'closed', summary: 'Closed without merging.' };
  if (d.mergeable === 'CONFLICTING' || d.mergeState === 'DIRTY') {
    return { kind: 'resolve_conflicts', summary: `Conflicts with ${d.base}. Merge or rebase ${d.base} locally, resolve, and push.` };
  }
  const failing = d.checks.failing;
  if (failing.length) {
    const real = failing.filter((c) => !c.flaky?.likely && !c.alsoFailingOnBase);
    const flaky = failing.filter((c) => c.flaky?.likely);
    const onBase = failing.filter((c) => c.alsoFailingOnBase && !c.flaky?.likely);
    if (real.length) {
      return { kind: 'fix_checks', summary: `Fix ${plural(real.length, 'failing check')}: ${real.map((c) => c.name).join(', ')}.` };
    }
    if (flaky.length) {
      return {
        kind: 'rerun_flaky',
        summary: `${plural(flaky.length, 'failing check')} look like CI flakes (${[...new Set(flaky.flatMap((c) => c.flaky!.reasons))].join(', ')}). Rerun them.`,
        tool: 'babysit_rerun_failed',
      };
    }
    return {
      kind: 'fix_checks',
      summary: `${onBase.map((c) => c.name).join(', ')} also failing on ${d.base}; probably not caused by this PR. Fix on ${d.base} or ask before bypassing.`,
    };
  }
  if (d.threads.length) {
    const outdated = d.threads.filter((t) => t.outdated).length;
    return {
      kind: 'address_reviews',
      summary: `${plural(d.threads.length, 'unresolved review thread')}${outdated ? ` (${outdated} outdated: resolve them if already addressed)` : ''}. Fix or reply, then resolve.`,
    };
  }
  if (d.reviewDecision === 'CHANGES_REQUESTED') return { kind: 'changes_requested', summary: 'A reviewer requested changes. Address them and re-request review.' };
  if (d.draft) return { kind: 'mark_ready', summary: 'Draft. Mark ready for review when done (`gh pr ready`).' };
  if (!d.queue.inQueue && d.queue.removed) {
    return { kind: 'requeue', summary: `Removed from the merge queue: ${d.queue.removed.reason}. Fix the cause, then re-queue.`, tool: 'babysit_enqueue' };
  }
  if (d.queue.inQueue) {
    if (d.queue.state === 'AUTO_MERGE') {
      return { kind: 'wait_queue', summary: 'GitHub auto-merge is enabled. Wait for GitHub to merge the PR.', tool: 'babysit_wait' };
    }
    const what = d.queue.waitingFor.length ? ` Waiting for: ${d.queue.waitingFor.slice(0, 4).join('; ')}.` : '';
    const eta = d.queue.eta ? ` ETA ${d.queue.eta}.` : '';
    return { kind: 'wait_queue', summary: `In the merge queue${d.queue.state ? ` (${d.queue.state})` : ''}.${what}${eta}`, tool: 'babysit_wait' };
  }
  if (d.mergeState === 'BEHIND') return { kind: 'update_branch', summary: `Behind ${d.base} and the branch must be up to date to merge.`, tool: 'babysit_update_branch' };
  if (d.checks.pending.length) {
    const req = d.checks.requiredPending ? `, ${d.checks.requiredPending} required` : '';
    return { kind: 'wait_checks', summary: `${plural(d.checks.pending.length, 'check')} still running${req}.`, tool: 'babysit_wait' };
  }
  if (d.reviewDecision === 'REVIEW_REQUIRED') return { kind: 'needs_review', summary: 'Waiting on an approving review from a human.' };
  return { kind: 'enqueue', summary: config.mergeQueue ? 'Green and mergeable. Add it to the merge queue.' : 'Green and mergeable. Request GitHub auto-merge.', tool: 'babysit_enqueue' };
}

const WAITING: ActionKind[] = ['wait_checks', 'wait_queue', 'needs_review'];

export function buildDigest(raw: any, extras: Extras = {}): Digest {
  const config = extras.config ?? DEFAULT_CONFIG;
  const ignored = ignoredChecks(config);
  const checks = allChecks(raw).filter((c) => !ignored.has(c.name));
  for (const c of checks) {
    if (c.status !== 'failure') continue;
    c.logTail = extras.logs?.get(c.name);
    c.flaky = flakyHints(c, c.logTail);
    c.alsoFailingOnBase = extras.baseFailing?.has(c.name) ?? undefined;
  }
  const counts: Record<CheckStatus, number> = { success: 0, failure: 0, pending: 0, skipped: 0 };
  for (const c of checks) counts[c.status]++;
  const failing = checks.filter((c) => c.status === 'failure').sort((a, b) => Number(b.required) - Number(a.required));
  const pending = checks.filter((c) => c.status === 'pending');
  const sha = raw.commits?.nodes?.[0]?.commit?.oid ?? raw.headRefOid ?? null;
  const base = {
    repo: raw.repo,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    head: raw.headRefName,
    base: raw.baseRefName,
    sha,
    state: raw.merged ? 'merged' : raw.state === 'CLOSED' ? 'closed' : 'open',
    draft: !!raw.isDraft,
    mergeable: raw.mergeable,
    mergeState: raw.mergeStateStatus,
    reviewDecision: raw.reviewDecision ?? null,
    checks: { counts, failing, pending, requiredPending: pending.filter((c) => c.required).length },
    threads: threadsOf(raw),
    queue: parseQueue(raw, allChecks(raw), config),
  } as Omit<Digest, 'next' | 'actionable' | 'fingerprint'>;
  const next = decide(base, config);
  const fingerprint = JSON.stringify({
    s: base.state,
    m: base.mergeable,
    f: failing.map((c) => `${c.name}@${c.completedAt ?? ''}`).sort(),
    t: base.threads.map((t) => `${t.id}:${t.replies}`).sort(),
    r: base.reviewDecision,
    q: [base.queue.inQueue, base.queue.removed?.at ?? ''],
    d: base.draft,
    k: next.kind,
  });
  return { ...base, next, actionable: !WAITING.includes(next.kind), fingerprint };
}

/** Compact text an agent can act on directly. */
export function render(d: Digest, opts: { logLines?: number } = {}): string {
  const out: string[] = [];
  const c = d.checks.counts;
  out.push(`${d.repo}#${d.number} "${d.title}" (${d.head} → ${d.base}) ${d.url}`);
  out.push(`NEXT: ${d.next.kind}: ${d.next.summary}${d.next.tool ? ` [tool: ${d.next.tool}]` : ''}`);
  out.push(
    `state ${d.state}${d.draft ? ' (draft)' : ''} · mergeable ${d.mergeable} (${d.mergeState}) · review ${d.reviewDecision ?? 'none'} · checks ${c.success} ok, ${c.failure} failing, ${c.pending} running, ${c.skipped} skipped`,
  );
  if (d.queue.provider) {
    const q = d.queue;
    out.push(`queue (${q.provider}): ${q.inQueue ? `in queue${q.state ? `, ${q.state}` : ''}${q.position != null ? `, position ${q.position}` : ''}${q.eta ? `, ETA ${q.eta}` : ''}` : 'not queued'}${q.removed ? ` · last removed: ${q.removed.reason}` : ''}`);
    for (const s of q.statusLines.slice(0, 4)) out.push(`  ${s}`);
    for (const w of q.waitingFor.slice(0, 6)) out.push(`  waiting for: ${w}`);
  }
  for (const f of d.checks.failing) {
    const tags = [f.required ? 'required' : 'optional', f.conclusion?.toLowerCase(), f.flaky?.likely ? `likely flaky: ${f.flaky.reasons.join(', ')}` : '', f.alsoFailingOnBase ? `also failing on ${d.base}` : '']
      .filter(Boolean)
      .join(', ');
    out.push(`FAILING ${f.workflow ? `${f.workflow} / ` : ''}${f.name} (${tags}) ${f.url ?? ''}`);
    if (f.logTail && opts.logLines !== 0) {
      const lines = f.logTail.split('\n').slice(-(opts.logLines ?? 25));
      out.push(...lines.map((l) => `    | ${l}`));
    }
  }
  if (d.checks.pending.length) out.push(`running: ${d.checks.pending.map((p) => p.name).slice(0, 12).join(', ')}${d.checks.pending.length > 12 ? ', …' : ''}`);
  for (const t of d.threads) {
    out.push(`THREAD ${t.path}${t.line ? `:${t.line}` : ''}${t.outdated ? ' (outdated)' : ''} by ${t.author}${t.replies ? `, ${t.replies} repl${t.replies === 1 ? 'y' : 'ies'}, last by ${t.lastAuthor}` : ''}: ${t.body} ${t.url}`);
  }
  return out.join('\n');
}
