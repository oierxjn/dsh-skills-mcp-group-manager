/**
 * Unit tests for src/probe.ts pure helpers.
 *
 * probeServer() itself is not unit-tested here: it spawns real child
 * processes / HTTP sessions. The helpers it builds its transports from ARE
 * pure and carry the subtle contract that once produced false probe failures
 * in the field (see stdioEnv below).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { stdioEnv } from '../src/probe.ts';

test('stdioEnv: undefined and empty overrides inherit the host environment', () => {
  // The MCP SDK uses `env` as the child's FULL environment; passing `{}` would
  // strip PATH and make npx-style commands unspawnable. The only way to make
  // the SDK inherit the host environment is `env: undefined`.
  assert.equal(stdioEnv(undefined), undefined, 'missing overrides → inherit');
  assert.equal(stdioEnv({}), undefined, 'empty overrides → inherit');
});

test('stdioEnv: overrides merge over the host environment', () => {
  const merged = stdioEnv({ GITHUB_TOKEN: 'ghp_x', MY_FLAG: '1' });
  assert.equal(merged.GITHUB_TOKEN, 'ghp_x');
  assert.equal(merged.MY_FLAG, '1');
  // The host environment must survive the merge — the probe child needs PATH
  // etc. to spawn anything, exactly like the real mcp-client child does.
  // Windows env keys are case-insensitive on process.env but the spread copy
  // keeps the original casing ("Path" vs "PATH"), so match case-insensitively.
  const pathKey = Object.keys(merged).find((key) => key.toUpperCase() === 'PATH');
  assert.ok(pathKey !== undefined, 'host PATH preserved');
  assert.equal(merged[pathKey], process.env.PATH);
});

test('stdioEnv: overrides win over same-named host variables', () => {
  const key = `MSM_PROBE_TEST_${Date.now()}`;
  process.env[key] = 'host-value';
  try {
    const merged = stdioEnv({ [key]: 'override-value' });
    assert.equal(merged[key], 'override-value');
  } finally {
    delete process.env[key];
  }
});
