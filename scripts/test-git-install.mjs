import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'babysit-git-install-'));
const source = join(temp, 'source');
const cwd = join(temp, 'project');
const client = new Client({ name: 'git-install-test', version: '1' });
let stderr = '';

try {
  // Copy tracked working files, but no existing dist or node_modules directory.
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const file of files) {
    const destination = join(source, file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(repo, file), destination);
  }
  await mkdir(cwd);
  execFileSync('git', ['init', '-q'], { cwd: source });
  execFileSync('git', ['add', '.'], { cwd: source });
  execFileSync('git', [
    '-c', 'user.name=babysit test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
    'commit', '-qm', 'Git installation fixture',
  ], { cwd: source });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', `--package=git+${pathToFileURL(source).href}#${commit}`, 'babysit'],
    cwd,
    env: { ...process.env, npm_config_cache: join(temp, 'cache') },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (data) => { stderr += data.toString(); });
  await client.connect(transport, { timeout: 120_000 });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'babysit_enqueue', 'babysit_rerun_failed', 'babysit_status',
    'babysit_update_branch', 'babysit_wait', 'babysit_watch',
  ]);
  console.log('Git installation smoke test passed (6 MCP tools).');
} catch (error) {
  if (stderr) process.stderr.write(stderr);
  throw error;
} finally {
  await client.close();
  await rm(temp, { recursive: true, force: true });
}
