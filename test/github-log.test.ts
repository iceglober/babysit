import assert from 'node:assert/strict';
import test from 'node:test';
import { failedStepLogTail } from '../src/github.js';

const row = (job: string, step: string, text: string) => `${job}\t${step}\t2026-10-10T00:00:00Z ${text}`;

test('failed test output survives later container and cache cleanup', () => {
  const log = [row('rest', 'Tests', 'FAIL scoped request read'), row('rest', 'Tests', '##[error]Process completed with exit code 1'), row('rest', 'Post cleanup', 'ERROR: expected database rejection'), row('rest', 'Post cleanup', 'cache saved')].join('\n');
  assert.equal(failedStepLogTail(log, 'rest', 2), 'FAIL scoped request read\n##[error]Process completed with exit code 1');
});

test('initial service failures remain visible and other jobs stay excluded', () => {
  const log = [row('other', 'Tests', '##[error]unrelated'), row('rest', 'Initialize containers', '##[error]Docker pull failed'), row('rest', 'Cleanup', 'network removed')].join('\n');
  assert.equal(failedStepLogTail(log, 'rest', 10), '##[error]Docker pull failed');
});

test('logs without error annotations retain the requested tail', () => {
  const log = [row('rest', 'Tests', 'first'), row('rest', 'Tests', 'last')].join('\n');
  assert.equal(failedStepLogTail(log, 'rest', 1), 'last');
});


test('collapsed GitHub step names stop at the failure before teardown output', () => {
  const log = [row('rest', 'UNKNOWN STEP', 'FAIL scoped request read'), row('rest', 'UNKNOWN STEP', '##[error]Process completed with exit code 1'), row('rest', 'UNKNOWN STEP', 'expected database rejection'), row('rest', 'UNKNOWN STEP', 'cache saved')].join('\n');
  assert.equal(failedStepLogTail(log, 'rest', 2), 'FAIL scoped request read\n##[error]Process completed with exit code 1');
});


test('assertion annotations retain expected and received values before the terminal error', () => {
  const log = [row('rest', 'UNKNOWN STEP', '##[error]Error: expect(locator).toHaveAttribute failed'), row('rest', 'UNKNOWN STEP', 'Expected: fluid'), row('rest', 'UNKNOWN STEP', 'Received: fixed'), row('rest', 'UNKNOWN STEP', '##[error]Process completed with exit code 1'), row('rest', 'UNKNOWN STEP', 'database cleanup')].join('\n');
  assert.equal(failedStepLogTail(log, 'rest', 4), '##[error]Error: expect(locator).toHaveAttribute failed\nExpected: fluid\nReceived: fixed\n##[error]Process completed with exit code 1');
});
