import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import { gh, resolvePr, type PrRef } from './github.js';

export const CONFIG_PATH = '.agent/.babysit.json';

const mergeMethod = z.enum(['squash', 'merge', 'rebase']);
const configSchema = z.object({
  mergeQueue: z.enum(['github', 'mergify']).nullable().optional(),
  mergeMethod: mergeMethod.default('squash'),
  checks: z.object({
    ignored: z.array(z.string().min(1)).default([]),
    logLines: z.number().int().min(0).max(200).default(25),
  }).strict().default({}),
  polling: z.object({
    maxMinutes: z.number().min(0.5).max(60).default(8),
    waitSeconds: z.number().int().min(10).max(300).default(30),
    watchSeconds: z.number().int().min(15).max(300).default(45),
  }).strict().default({}),
}).strict();

export type Config = z.infer<typeof configSchema>;
export const DEFAULT_CONFIG: Config = configSchema.parse({});

export function parseConfig(source: string): Config {
  try {
    return configSchema.parse(JSON.parse(source));
  } catch (error) {
    throw new Error(`Invalid ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function repositoryRoot(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--show-toplevel'], { cwd, timeout: 10_000 }, (error, stdout) => {
      resolve(error ? undefined : stdout.trim());
    });
  });
}

type RemoteRead = (ref: PrRef) => Promise<string | undefined>;

async function readRemoteConfig(ref: PrRef): Promise<string | undefined> {
  let response: string;
  try {
    response = await gh(['api', `repos/${ref.owner}/${ref.name}/contents/${CONFIG_PATH}`]);
  } catch (error) {
    if (/\(HTTP 404\)/.test((error as Error).message)) return undefined;
    throw error;
  }
  const file = JSON.parse(response);
  if (file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string') {
    throw new Error(`Cannot read ${CONFIG_PATH} from ${ref.owner}/${ref.name}`);
  }
  return Buffer.from(file.content, 'base64').toString('utf8');
}

/** Local configuration belongs only to the repository that origin identifies. */
export async function loadConfig(
  ref: PrRef,
  options: { cwd?: string; readRemote?: RemoteRead } = {},
): Promise<Config> {
  const root = await repositoryRoot(options.cwd ?? process.cwd());
  const localRef = root ? await resolvePr(1, undefined, root).catch(() => undefined) : undefined;
  const sameRepo = localRef && `${localRef.owner}/${localRef.name}`.toLowerCase() === `${ref.owner}/${ref.name}`.toLowerCase();
  let source: string | undefined;
  if (root && sameRepo) {
    try {
      source = await readFile(join(root, CONFIG_PATH), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  } else {
    // Read the target repository's default branch, never untrusted PR content.
    source = await (options.readRemote ?? readRemoteConfig)(ref);
  }
  return source === undefined ? configSchema.parse({}) : parseConfig(source);
}

export function ignoredChecks(config: Config): Set<string> {
  return new Set([
    ...config.checks.ignored,
    ...(config.mergeQueue === 'mergify' ? ['Mergify Merge Queue', 'Mergify Merge Protections'] : []),
  ]);
}
