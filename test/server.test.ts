import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../src/server.js';

function check(name: string, conclusion = 'SUCCESS') {
  return {
    __typename: 'CheckRun', name, status: 'COMPLETED', conclusion,
    detailsUrl: 'https://github.com/acme/app/actions/runs/100/job/200',
    checkSuite: { workflowRun: { databaseId: 100 } },
  };
}

const raw = {
  repo: 'acme/app', number: 7, title: 'Example', url: 'https://github.com/acme/app/pull/7',
  state: 'OPEN', merged: false, isDraft: false, headRefName: 'feature', baseRefName: 'main',
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED',
  commits: { nodes: [{ commit: { oid: 'abc', statusCheckRollup: { contexts: { nodes: [check('test')] } } } }] },
};

test('MCP tools apply repository configuration without contacting GitHub', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'babysit-server-'));
  const oldCwd = process.cwd();
  const oldPath = process.env.PATH;
  const statePath = join(root, 'state.json');
  const callsPath = join(root, 'calls.jsonl');
  const configPath = join(root, '.agent/.babysit.json');
  const server = createServer();
  const client = new Client({ name: 'test', version: '1' });
  t.after(async () => {
    await client.close();
    await server.close();
    process.chdir(oldCwd);
    process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  });
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'git@github.com:acme/app.git']);
  await mkdir(join(root, '.agent'));
  await mkdir(join(root, 'bin'));
  await writeFile(join(root, 'bin/gh'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n');
const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'));
if (args[0] === 'api' && args[1] === 'graphql') {
  const repository = args.some(a => a.startsWith('q=refs/heads/'))
    ? { ref: { target: { statusCheckRollup: { contexts: { nodes: [] } } } } }
    : { nameWithOwner: state.raw.repo, pullRequest: state.raw };
  console.log(JSON.stringify({ data: { repository } }));
} else if (args[0] === 'api' && args[1].includes('/contents/')) {
  if (state.remoteError) { console.error(state.remoteError); process.exit(1); }
  console.log(JSON.stringify({ type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(state.remoteConfig || {})).toString('base64') }));
} else if (args[0] === 'api' && args[1].includes('/logs')) {
  console.log('2026-01-01T00:00:00Z first failure line\\n2026-01-01T00:00:01Z second failure line');
} else if (!['pr', 'run'].includes(args[0])) { process.exit(2); }
`, { mode: 0o755 });
  process.chdir(root);
  process.env.PATH = `${join(root, 'bin')}:${oldPath}`;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  async function setup(config: unknown, pr: unknown = raw, remote: Record<string, unknown> = {}) {
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(statePath, JSON.stringify({ raw: pr, ...remote }));
    await writeFile(callsPath, '');
  }
  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: { pr: 7, ...args } });
    const text = (result.content as { text?: string }[]).map(c => c.text ?? '').join('\n');
    const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]);
    return { result, text, calls };
  }

  await t.test('omitted or null mergeQueue uses auto-merge and configured method', async () => {
    for (const config of [{ mergeMethod: 'rebase' }, { mergeQueue: null, mergeMethod: 'rebase' }]) {
      await setup(config);
      const { result, calls } = await call('babysit_enqueue');
      assert.ok(!result.isError);
      assert.deepEqual(calls.find(c => c[0] === 'pr'), ['pr', 'merge', '7', '--repo', 'acme/app', '--auto', '--rebase']);
      assert.ok(!calls.some(c => c[1]?.includes('/contents/')));
    }
  });

  await t.test('GitHub queue does not pass a merge method', async () => {
    await setup({ mergeQueue: 'github', mergeMethod: 'rebase' });
    const { calls } = await call('babysit_enqueue');
    assert.deepEqual(calls.find(c => c[0] === 'pr'), ['pr', 'merge', '7', '--repo', 'acme/app', '--auto']);
  });

  await t.test('Mergify is explicit and dry runs do not write comments', async () => {
    await setup({ mergeQueue: 'mergify' });
    const dry = await call('babysit_enqueue', { dry_run: true });
    assert.match(dry.text, /would run: gh pr comment 7 --repo acme\/app --body @mergifyio queue/);
    assert.ok(!dry.calls.some(c => c[0] === 'pr'));
    const live = await call('babysit_enqueue');
    assert.deepEqual(live.calls.find(c => c[0] === 'pr'), ['pr', 'comment', '7', '--repo', 'acme/app', '--body', '@mergifyio queue']);
  });

  await t.test('tool merge method overrides the file without performing a dry-run mutation', async () => {
    await setup({ mergeMethod: 'rebase' });
    const { text, calls } = await call('babysit_enqueue', { method: 'merge', dry_run: true });
    assert.match(text, /--auto --merge$/);
    assert.ok(!calls.some(c => c[0] === 'pr'));
  });

  const failing = { ...raw, commits: { nodes: [{ commit: { oid: 'abc', statusCheckRollup: { contexts: { nodes: [check('test', 'FAILURE')] } } } }] } };
  await t.test('ignored checks do not fetch logs or receive reruns', async () => {
    await setup({ checks: { ignored: ['test'] } }, failing);
    const status = await call('babysit_status');
    assert.doesNotMatch(status.text, /FAILING/);
    const rerun = await call('babysit_rerun_failed');
    assert.match(rerun.text, /Nothing to rerun/);
    assert.ok(!rerun.calls.some(c => c[0] === 'run' || c[1]?.includes('/logs')));
  });

  await t.test('configured log length applies and a tool argument overrides it', async () => {
    await setup({ checks: { logLines: 1 } }, failing);
    const status = await call('babysit_status');
    assert.doesNotMatch(status.text, /first failure line/);
    assert.match(status.text, /second failure line/);
    const hidden = await call('babysit_status', { log_lines: 0 });
    assert.doesNotMatch(hidden.text, /failure line/);
  });

  await t.test('a rerun cannot include ignored failures from the same run', async () => {
    const pr = { ...raw, commits: { nodes: [{ commit: { oid: 'abc', statusCheckRollup: { contexts: { nodes: [
      check('test', 'FAILURE'), check('optional', 'FAILURE'),
    ] } } } }] } };
    await setup({ checks: { ignored: ['optional'] } }, pr);
    const { calls } = await call('babysit_rerun_failed');
    assert.deepEqual(calls.filter(c => c[0] === 'run'), [['run', 'rerun', '--job', '200', '--repo', 'acme/app']]);
  });

  await t.test('filtered checks without job IDs do not fall back to a whole-run retry', async () => {
    const pr = { ...raw, commits: { nodes: [{ commit: { oid: 'abc', statusCheckRollup: { contexts: { nodes: [
      { ...check('test', 'FAILURE'), detailsUrl: 'https://github.com/acme/app/actions/runs/100' },
    ] } } } }] } };
    await setup({ checks: { ignored: ['optional'] } }, pr);
    const { text, calls } = await call('babysit_rerun_failed');
    assert.match(text, /Cannot safely rerun selected checks without job IDs: test/);
    assert.ok(!calls.some(c => c[0] === 'run' && c[1] === 'rerun'));
  });

  await t.test('invalid configuration stops before a GitHub read or write', async () => {
    await setup({ mergeQueue: 'typo' });
    const { result, text, calls } = await call('babysit_enqueue');
    assert.equal(result.isError, true);
    assert.match(text, /Invalid \.agent\/\.babysit\.json/);
    assert.deepEqual(calls, []);
  });

  await t.test('a remote repository uses its default-branch configuration', async () => {
    await setup({ mergeQueue: 'mergify' }, { ...raw, repo: 'other/app' }, { remoteConfig: { mergeQueue: 'github' } });
    const { calls } = await call('babysit_enqueue', { repo: 'other/app' });
    assert.deepEqual(calls[0], ['api', 'repos/other/app/contents/.agent/.babysit.json']);
    assert.deepEqual(calls.find(c => c[0] === 'pr'), ['pr', 'merge', '7', '--repo', 'other/app', '--auto']);
  });

  await t.test('remote missing file uses defaults but other errors stop actions', async () => {
    for (const status of [404, 403]) {
      await setup({}, { ...raw, repo: 'other/app' }, { remoteError: `gh: Not Found (HTTP ${status})` });
      const { result, calls } = await call('babysit_enqueue', { repo: 'other/app' });
      assert.equal(!!result.isError, status === 403);
      assert.equal(calls.some(c => c[0] === 'pr'), status === 404);
    }
  });
});
