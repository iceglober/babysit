import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildDigest, flakyHints, render } from '../src/digest.js';
import { parseConfig } from '../src/config.js';

const mergify = parseConfig('{"mergeQueue":"mergify"}');

type Over = Record<string, unknown>;

function check(name: string, status: string, conclusion: string | null, over: Over = {}) {
  return {
    __typename: 'CheckRun',
    name,
    title: null,
    status,
    conclusion,
    detailsUrl: `https://ci/${name}`,
    completedAt: status === 'COMPLETED' ? '2026-10-06T00:00:00Z' : null,
    isRequired: true,
    checkSuite: { workflowRun: { databaseId: 100, workflow: { name: 'CI' } } },
    ...over,
  };
}

function pr(over: Over = {}, checks: unknown[] = [check('test', 'COMPLETED', 'SUCCESS')]) {
  return {
    repo: 'acme/app',
    number: 7,
    title: 'Add thing',
    url: 'https://github.com/acme/app/pull/7',
    state: 'OPEN',
    merged: false,
    isDraft: false,
    headRefName: 'feat',
    baseRefName: 'main',
    headRefOid: 'abc',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    autoMergeRequest: null,
    mergeQueueEntry: null,
    timelineItems: { nodes: [] },
    comments: { nodes: [] },
    reviewThreads: { nodes: [] },
    commits: { nodes: [{ commit: { oid: 'abc', statusCheckRollup: { state: 'SUCCESS', contexts: { totalCount: checks.length, nodes: checks } } } }] },
    ...over,
  };
}

function thread(id: string, over: Over = {}) {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    path: 'src/a.ts',
    line: 3,
    comments: { nodes: [{ author: { login: 'rev' }, body: 'please rename', url: `https://c/${id}`, createdAt: 'x' }] },
    last: { totalCount: 1, nodes: [{ author: { login: 'rev' }, createdAt: 'x' }] },
    ...over,
  };
}

const MERGIFY_BODY = `<!---
DO NOT EDIT
-*- Mergify Payload -*-
{"version": 1, "state": "checking", "queue_rule_name": "main", "estimated_time_of_merge": "2026-10-06T06:25:00+00:00",
 "required_conditions": [
  {"description": "any of", "match": false, "subconditions": [
    {"description": "check-success = @github-actions/test", "match": false, "subconditions": []},
    {"description": "check-neutral = @github-actions/test", "match": false, "subconditions": []}]},
  {"description": "#review-threads-unresolved = 0", "match": true, "subconditions": []}]}
-*- Mergify Payload End -*-
-->

# Merge Queue Status

- ✅ **Entered queue** — at 06:04
- 🟠 **Checks running** · on draft #5779 · [dashboard](https://x)

<details>
<summary><strong>Waiting for</strong></summary>

- [ ] any of: [🛡 GitHub repository ruleset rule \`main\`]
</details>
`;

test('green, approved, unqueued PR should be enqueued', () => {
  const d = buildDigest(pr());
  assert.equal(d.next.kind, 'enqueue');
  assert.equal(d.next.tool, 'babysit_enqueue');
  assert.equal(d.actionable, true);
});

test('merged and closed are terminal', () => {
  assert.equal(buildDigest(pr({ merged: true, state: 'MERGED' })).next.kind, 'done');
  assert.equal(buildDigest(pr({ state: 'CLOSED' })).next.kind, 'closed');
});

test('conflicts beat everything else', () => {
  const d = buildDigest(pr({ mergeable: 'CONFLICTING' }, [check('test', 'COMPLETED', 'FAILURE')]));
  assert.equal(d.next.kind, 'resolve_conflicts');
});

test('a real failure asks for a fix and carries its log', () => {
  const logs = new Map([['test', 'FAIL src/a.test.ts\nexpected 1 to be 2']]);
  const d = buildDigest(pr({}, [check('test', 'COMPLETED', 'FAILURE')]), { logs });
  assert.equal(d.next.kind, 'fix_checks');
  assert.match(render(d), /expected 1 to be 2/);
});

test('infra failures are flagged flaky and suggest a rerun', () => {
  const logs = new Map([['test', 'Error: The runner has received a shutdown signal.']]);
  const d = buildDigest(pr({}, [check('test', 'COMPLETED', 'FAILURE')]), { logs });
  assert.equal(d.next.kind, 'rerun_flaky');
  assert.deepEqual(d.checks.failing[0].flaky, { likely: true, reasons: ['runner lost'] });
  assert.equal(flakyHints({ name: 'x', status: 'failure', required: true, conclusion: 'TIMED_OUT' }).likely, true);
});

test('a real failure wins over a flaky one', () => {
  const logs = new Map([['e2e', 'ECONNRESET'], ['unit', 'AssertionError']]);
  const d = buildDigest(pr({}, [check('e2e', 'COMPLETED', 'FAILURE'), check('unit', 'COMPLETED', 'FAILURE')]), { logs });
  assert.equal(d.next.kind, 'fix_checks');
  assert.match(d.next.summary, /unit/);
  assert.doesNotMatch(d.next.summary, /e2e/);
});

test("mergify's derived protection check is not something to fix", () => {
  const d = buildDigest(pr({}, [check('test', 'COMPLETED', 'SUCCESS'), check('Mergify Merge Protections', 'COMPLETED', 'FAILURE', { checkSuite: null })]), { config: mergify });
  assert.equal(d.checks.failing.length, 0);
  assert.equal(d.next.kind, 'enqueue');
});

test('failures also red on the base branch are called out', () => {
  const d = buildDigest(pr({}, [check('lint', 'COMPLETED', 'FAILURE')]), { baseFailing: new Set(['lint']) });
  assert.equal(d.next.kind, 'fix_checks');
  assert.match(d.next.summary, /also failing on main/);
});

test('unresolved threads, including outdated ones, block', () => {
  const d = buildDigest(pr({ reviewThreads: { nodes: [thread('t1'), thread('t2', { isOutdated: true }), thread('t3', { isResolved: true })] } }));
  assert.equal(d.next.kind, 'address_reviews');
  assert.equal(d.threads.length, 2);
  assert.match(d.next.summary, /1 outdated/);
});

test('pending checks mean wait, and waiting is not actionable', () => {
  const d = buildDigest(pr({}, [check('test', 'IN_PROGRESS', null), check('lint', 'COMPLETED', 'SUCCESS')]));
  assert.equal(d.next.kind, 'wait_checks');
  assert.equal(d.checks.requiredPending, 1);
  assert.equal(d.actionable, false);
});

test('draft, behind, and review-required', () => {
  assert.equal(buildDigest(pr({ isDraft: true })).next.kind, 'mark_ready');
  assert.equal(buildDigest(pr({ mergeStateStatus: 'BEHIND' })).next.kind, 'update_branch');
  assert.equal(buildDigest(pr({ reviewDecision: 'REVIEW_REQUIRED' })).next.kind, 'needs_review');
});

test('mergify queue: in queue, with what it waits for', () => {
  const raw = pr(
    { comments: { nodes: [{ author: { login: 'mergify' }, body: MERGIFY_BODY, createdAt: 'x', url: 'u' }] } },
    [check('test', 'IN_PROGRESS', null), check('Mergify Merge Queue', 'IN_PROGRESS', null, { checkSuite: null })],
  );
  const d = buildDigest(raw, { config: mergify });
  assert.equal(d.queue.provider, 'mergify');
  assert.equal(d.queue.inQueue, true);
  assert.equal(d.queue.state, 'checking');
  assert.deepEqual(d.queue.waitingFor, ['check test']);
  assert.equal(d.next.kind, 'wait_queue');
  assert.match(render(d), /Checks running/);
  assert.doesNotMatch(render(d), /any of/);
  // The queue's own check is not reported as a pending CI check.
  assert.equal(d.checks.pending.map((c) => c.name).includes('Mergify Merge Queue'), false);
});

test('mergify queue: dropped from queue asks for a requeue with the reason', () => {
  const raw = pr({}, [
    check('test', 'COMPLETED', 'SUCCESS'),
    check('Mergify Merge Queue', 'COMPLETED', 'FAILURE', { title: 'The pull request has been removed from the queue: checks failed on the draft', checkSuite: null }),
  ]);
  const d = buildDigest(raw, { config: mergify });
  assert.equal(d.next.kind, 'requeue');
  assert.match(d.next.summary, /checks failed on the draft/);
});

test('github merge queue entry', () => {
  const d = buildDigest(pr({ mergeQueueEntry: { position: 3, state: 'QUEUED', estimatedTimeToMerge: 600 } }), { config: parseConfig('{"mergeQueue":"github"}') });
  assert.equal(d.queue.provider, 'github');
  assert.equal(d.next.kind, 'wait_queue');
  assert.match(d.next.summary, /ETA 10 min/);
});

test('an explicit GitHub queue ignores Mergify comments without hiding its checks', () => {
  const raw = pr({
    comments: { nodes: [{ author: { login: 'mergify' }, body: MERGIFY_BODY }] },
    mergeQueueEntry: { position: 1, state: 'QUEUED' },
  }, [check('Mergify Merge Protections', 'COMPLETED', 'FAILURE', { checkSuite: null })]);
  const d = buildDigest(raw, { config: parseConfig('{"mergeQueue":"github"}') });
  assert.equal(d.queue.provider, 'github');
  assert.equal(d.checks.failing[0].name, 'Mergify Merge Protections');
  assert.equal(d.next.kind, 'fix_checks');
});

test('omitted and null mergeQueue do not select a queue from PR data', () => {
  for (const config of [parseConfig('{}'), parseConfig('{"mergeQueue":null}')]) {
    const d = buildDigest(pr({
      mergeQueueEntry: { position: 1, state: 'QUEUED' },
      comments: { nodes: [{ author: { login: 'mergify' }, body: MERGIFY_BODY }] },
    }), { config });
    assert.equal(d.queue.provider, null);
    assert.equal(d.queue.inQueue, false);
    const autoMerge = buildDigest(pr({ autoMergeRequest: { enabledAt: 'now' } }), { config });
    assert.equal(autoMerge.queue.state, 'AUTO_MERGE');
  }
});

test('ignored checks do not count, block, or change the fingerprint', () => {
  const config = parseConfig('{"checks":{"ignored":["optional"]}}');
  const clean = buildDigest(pr(), { config });
  const d = buildDigest(pr({}, [check('test', 'COMPLETED', 'SUCCESS'), check('optional', 'COMPLETED', 'FAILURE')]), { config });
  assert.deepEqual(d.checks, clean.checks);
  assert.equal(d.fingerprint, clean.fingerprint);
  assert.equal(d.next.kind, 'enqueue');
  const pending = buildDigest(pr({}, [check('optional', 'IN_PROGRESS', null)]), { config });
  assert.equal(pending.checks.pending.length, 0);
});

test('fingerprint changes on new failure or reply, not on unrelated churn', () => {
  const a = buildDigest(pr({ reviewThreads: { nodes: [thread('t1')] } }));
  const sameAgain = buildDigest(pr({ reviewThreads: { nodes: [thread('t1')] }, title: 'Renamed' }));
  const replied = buildDigest(pr({ reviewThreads: { nodes: [thread('t1', { last: { totalCount: 2, nodes: [{ author: { login: 'me' } }] } })] } }));
  assert.equal(a.fingerprint, sameAgain.fingerprint);
  assert.notEqual(a.fingerprint, replied.fingerprint);
});
