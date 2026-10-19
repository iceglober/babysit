import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CONFIG_PATH, DEFAULT_CONFIG, ignoredChecks, loadConfig, parseConfig } from '../src/config.js';

const ref = { owner: 'acme', name: 'app', number: 1 };

test('defaults have no merge queue or repository-specific ignored checks', () => {
  assert.deepEqual(parseConfig('{}'), {
    mergeMethod: 'squash',
    checks: { ignored: [], logLines: 25 },
    polling: { maxMinutes: 8, waitSeconds: 30, watchSeconds: 45 },
  });
  assert.deepEqual([...ignoredChecks(DEFAULT_CONFIG)], []);
});

test('mergeQueue supports GitHub, Mergify, omitted, and null', () => {
  assert.equal(parseConfig('{"mergeQueue":"github"}').mergeQueue, 'github');
  assert.equal(parseConfig('{"mergeQueue":"mergify"}').mergeQueue, 'mergify');
  assert.equal(parseConfig('{}').mergeQueue, undefined);
  assert.equal(parseConfig('{"mergeQueue":null}').mergeQueue, null);
});

test('partial configuration keeps unspecified defaults', () => {
  const config = parseConfig(JSON.stringify({
    mergeQueue: 'mergify', mergeMethod: 'rebase',
    checks: { ignored: ['optional'], logLines: 0 },
    polling: { maxMinutes: 2, waitSeconds: 10 },
  }));
  assert.equal(config.polling.watchSeconds, 45);
  assert.equal(config.mergeMethod, 'rebase');
  assert.equal(config.checks.logLines, 0);
  assert.deepEqual([...ignoredChecks(config)], ['optional', 'Mergify Merge Queue', 'Mergify Merge Protections']);
});

test('invalid JSON, unknown keys, wrong types, and out-of-range values fail', () => {
  for (const source of [
    '{', 'null', '[]', '{"unknown":true}', '{"mergeQueue":"auto"}',
    '{"mergeMethod":"fast-forward"}', '{"queue":{"provider":"mergify"}}',
    '{"checks":{"ignored":[""]}}', '{"checks":{"logLines":201}}',
    '{"checks":{"logLines":-1}}', '{"checks":{"logLines":"25"}}',
    '{"polling":{"maxMinutes":0}}', '{"polling":{"maxMinutes":61}}',
    '{"polling":{"waitSeconds":9}}', '{"polling":{"waitSeconds":301}}',
    '{"polling":{"watchSeconds":14}}', '{"polling":{"watchSeconds":15.5}}',
    '{"polling":{"typo":30}}',
  ]) assert.throws(() => parseConfig(source), /Invalid \.agent\/\.babysit\.json/);
});

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'babysit-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'git@github.com:acme/app.git']);
  await mkdir(join(root, '.agent'));
  return root;
}

test('loads the target repository root from a subdirectory without remote calls', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, CONFIG_PATH), '{"mergeQueue":"mergify"}');
  const config = await loadConfig(ref, {
    cwd: join(root, '.agent'),
    readRemote: async () => { throw new Error('must not read remote'); },
  });
  assert.equal(config.mergeQueue, 'mergify');
});

test('missing local configuration uses defaults, not remote configuration', async (t) => {
  const root = await fixture(t);
  assert.deepEqual(await loadConfig(ref, {
    cwd: root,
    readRemote: async () => { throw new Error('must not read remote'); },
  }), DEFAULT_CONFIG);
});

test('configuration is read again for each tool call', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, CONFIG_PATH), '{"mergeQueue":"mergify"}');
  assert.equal((await loadConfig(ref, { cwd: root })).mergeQueue, 'mergify');
  await writeFile(join(root, CONFIG_PATH), '{}');
  assert.equal((await loadConfig(ref, { cwd: root })).mergeQueue, undefined);
});

test('invalid local configuration fails instead of falling back', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, CONFIG_PATH), '{"mergeQueue":"typo"}');
  await assert.rejects(loadConfig(ref, { cwd: root }), /Invalid/);
});

test('another repository uses its own remote configuration', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, CONFIG_PATH), '{"mergeQueue":"mergify"}');
  const other = { owner: 'other', name: 'repo', number: 7 };
  const config = await loadConfig(other, {
    cwd: root,
    readRemote: async (requested) => {
      assert.deepEqual(requested, other);
      return '{"mergeMethod":"merge"}';
    },
  });
  assert.equal(config.mergeQueue, undefined);
  assert.equal(config.mergeMethod, 'merge');
});

test('outside a checkout, remote configuration or defaults apply', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'babysit-no-repo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal((await loadConfig(ref, { cwd: root, readRemote: async () => '{"mergeQueue":"mergify"}' })).mergeQueue, 'mergify');
  assert.deepEqual(await loadConfig(ref, { cwd: root, readRemote: async () => undefined }), DEFAULT_CONFIG);
});

test('remote errors and invalid configuration do not silently use defaults', async (t) => {
  const root = await fixture(t);
  const other = { owner: 'other', name: 'repo', number: 7 };
  await assert.rejects(loadConfig(other, { cwd: root, readRemote: async () => { throw new Error('HTTP 403'); } }), /HTTP 403/);
  await assert.rejects(loadConfig(other, { cwd: root, readRemote: async () => '{"checks":{"logLines":999}}' }), /Invalid/);
});
