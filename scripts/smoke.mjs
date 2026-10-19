// Live smoke test over real MCP stdio: node scripts/smoke.mjs <tool> '<json args>' ...
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'smoke', version: '0' });
await client.connect(new StdioClientTransport({ command: 'node', args: [new URL('../dist/src/index.js', import.meta.url).pathname], cwd: process.env.BABYSIT_CWD }));
const info = client.getInstructions();
if (process.argv.includes('--tools')) {
  console.log('instructions:', info?.split('\n')[0]);
  console.log((await client.listTools()).tools.map((t) => t.name).join(', '));
}
const args = process.argv.slice(2).filter((a) => a !== '--tools');
for (let i = 0; i < args.length; i += 2) {
  const t0 = Date.now();
  const r = await client.callTool({ name: args[i], arguments: JSON.parse(args[i + 1]) }, undefined, { timeout: 15 * 60_000, onprogress: (p) => console.log(`  [progress] ${p.message}`) });
  console.log(`=== ${args[i]} ${args[i + 1]} (${((Date.now() - t0) / 1000).toFixed(1)}s)${r.isError ? ' ERROR' : ''}\n${r.content.map((c) => c.text).join('\n')}\n`);
}
await client.close();
