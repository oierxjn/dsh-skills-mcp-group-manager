/**
 * Integration tests for the MCP mutation API (manager.mcp.*) of the host half.
 *
 * Guards the 0.4.0 patch-file semantics:
 *  - a mutation target must BE an MCP client entry (loader entry or a patch
 *    row whose recorded plugin name is `dsh-mcp-client`) — the id alone is
 *    not proof, and an unguarded remove/toggle would delete or override rows
 *    of unrelated plugins;
 *  - tool output values match their registered output schema (the host may
 *    validate tool results; a return value outside the schema fails calls).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { apply } from '../src/index.ts';
import { writePatchList, readPatchList } from '../src/patch.ts';
import { MCP_CLIENT_PACKAGE, toServerConfig } from '../src/status.ts';
import { valueSchema } from '../src/tool-schemas.ts';

/** Fake loader entry (the subset of the composed-tree API the plugin reads). */
function loaderEntry(id, name, config) {
  return { id, options: { name, config }, disabled: false };
}

/** Minimal fake ctx; `entries` is swapped per test. */
function fakeCtx() {
  const tools = [];
  const ctx = {
    logger: { warn() {}, error() {}, info() {} },
    tools: {
      register(def) { tools.push(def); return () => {}; },
      schemas() { return []; },
    },
    skills: {
      registerProvider() { return () => {}; },
      async list() { return []; },
      async get() { return undefined; },
    },
    agents: { list() { return []; } },
    loader: { entries() { return []; } },
    on() { return () => {}; },
    effect() { return () => {}; },
    get() { return undefined; },
  };
  return { ctx, tools };
}

/** Apply the plugin against a temp home; returns the registered tool map. */
async function withPlugin(entries, run) {
  const home = await mkdtemp(join(tmpdir(), 'msm-host-mcp-'));
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const patchFile = join(home, 'profiles', 'web', 'cordis.patch.yml');
  try {
    const { ctx, tools } = fakeCtx();
    ctx.loader.entries = () => entries;
    apply(ctx, { patchFile });
    const toolMap = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    await run({ toolMap, patchFile, home });
  } finally {
    process.env.DSH_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
}

/** Assert the error is an McpError with the given code. */
function assertErrorCode(promise, code, message) {
  return assert.rejects(promise, (error) => {
    assert.equal(error.code, code, message);
    return true;
  }, message);
}

/**
 * Mirror of the harness lossless-JSON validator (dsh-session walkJsonValue):
 * accepts null / booleans / strings, finite non-(-0) numbers, hole-free plain
 * arrays, and plain records with enumerable string keys; rejects cycles,
 * sparse arrays, exotic prototypes, and any other value. Any violated rule
 * means the harness would reject the whole tool call.
 */
function assertLossless(node, path, seen = new Set()) {
  if (node === null || typeof node === 'boolean' || typeof node === 'string') return;
  if (typeof node === 'number') {
    if (!Number.isFinite(node) || Object.is(node, -0)) {
      throw new Error(`output${path} is ${String(node)} — tool output is not lossless JSON`);
    }
    return;
  }
  if (typeof node !== 'object') {
    throw new Error(`output${path} has type ${typeof node} — tool output is not lossless JSON`);
  }
  if (seen.has(node)) throw new Error(`output${path} is cyclic — tool output is not lossless JSON`);
  seen.add(node);
  if (Array.isArray(node)) {
    if (Object.getPrototypeOf(node) !== Array.prototype || Reflect.ownKeys(node).length !== node.length + 1) {
      throw new Error(`output${path} is a sparse or non-plain array — tool output is not lossless JSON`);
    }
    node.forEach((item, index) => assertLossless(item, `${path}[${index}]`, seen));
  } else {
    const proto = Object.getPrototypeOf(node);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`output${path} is not a plain object — tool output is not lossless JSON`);
    }
    const keys = Reflect.ownKeys(node);
    for (const key of keys) {
      if (typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(node, key)) {
        throw new Error(`output${path} has a non-enumerable or symbol key — tool output is not lossless JSON`);
      }
      assertLossless(node[key], `${path}.${key}`, seen);
    }
  }
  seen.delete(node);
}

test('toServerConfig: minimal raw config → no undefined-valued keys survive (lossless-JSON safe)', () => {
  const config = toServerConfig({ serverName: 'gh', transport: 'stdio', command: 'npx' });
  assert.deepEqual(JSON.parse(JSON.stringify(config)), config, 'JSON round-trip must be lossless');
  assertLossless(config, '');
  assert.equal(config.url, undefined, 'unconfigured url reads as undefined');
  assert.equal('url' in config, false, 'unconfigured url must be absent, not present-with-undefined');
});

test('toServerConfig: fully-populated raw config → every configured key present with its value', () => {
  const raw = {
    serverName: 'web', transport: 'streamable-http', url: 'http://127.0.0.1:24440/mcp',
    command: 'node', args: ['server.js'], env: { A: '1' }, cwd: '/srv',
    headers: { 'x-a': 'b' }, toolCallTimeoutMs: 1234, failOnStartupError: true,
    reconnect: { initialDelayMs: 100 },
  };
  const config = toServerConfig(raw);
  assertLossless(config, '');
  for (const [key, value] of Object.entries(raw)) assert.deepEqual(config[key], value, `key "${key}" preserved`);
});

test('toServerConfig: empty/garbage raw config → safe defaults, no undefined values', () => {
  for (const raw of [undefined, null, {}, 'nope', 42]) {
    const config = toServerConfig(raw);
    assertLossless(config, '');
    assert.equal(config.serverName, '');
    assert.equal(config.transport, 'streamable-http');
  }
});

test('toServerConfig: non-lossless scalar values (NaN/Infinity/-0) are omitted from the projection', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0]) {
    const config = toServerConfig({ toolCallTimeoutMs: bad });
    assertLossless(config, '');
    assert.equal('toolCallTimeoutMs' in config, false, `toolCallTimeoutMs ${String(bad)} must be omitted`);
  }
  assert.equal(toServerConfig({ toolCallTimeoutMs: 1234 }).toolCallTimeoutMs, 1234, 'finite non-(-0) numbers are kept');
});

test('toServerConfig: composite values containing non-lossless content are omitted', () => {
  // js-yaml resolves `.inf`/`.nan` scalars to ±Infinity/NaN in user-authored rows.
  assert.equal('env' in toServerConfig({ env: { A: Number.POSITIVE_INFINITY } }), false, 'env with a non-finite value must be omitted');
  assert.equal('env' in toServerConfig({ env: { A: '1' } }), true, 'string-valued env is kept');
  assert.equal('headers' in toServerConfig({ headers: { h: Number.NaN } }), false, 'headers with a non-finite value must be omitted');
  const sparse = ['a'];
  sparse[2] = 'b';
  assert.equal('args' in toServerConfig({ args: sparse }), false, 'sparse args must be omitted');
  assert.equal('args' in toServerConfig({ args: ['--x'] }), true, 'plain args are kept');
  const cyclic = { initialDelayMs: 100 };
  cyclic.self = cyclic;
  assert.equal('reconnect' in toServerConfig({ reconnect: cyclic }), false, 'cyclic reconnect must be omitted');
  assert.equal('reconnect' in toServerConfig({ reconnect: { initialDelayMs: 100 } }), true, 'plain reconnect is kept');
});

test('toServerConfig: non-plain objects (Date/Map instances) are omitted from the projection', () => {
  // js-yaml resolves !!timestamp scalars to Date instances, so a user-authored
  // row can carry them just like `.inf` scalars.
  assert.equal('reconnect' in toServerConfig({ reconnect: { since: new Date('2024-01-01T00:00:00Z') } }), false, 'reconnect with a Date must be omitted');
  assert.equal('env' in toServerConfig({ env: { nested: { deeper: new Map() } } }), false, 'deeply nested non-plain object must be omitted');
  assert.equal('reconnect' in toServerConfig({ reconnect: { since: '2024-01-01T00:00:00Z' } }), true, 'string-valued reconnect is kept');
  assert.throws(() => assertLossless({ d: new Date() }, ''), 'the test helper must reject non-plain objects');
});

test('toServerConfig: args items must be strings to match the declared schema', () => {
  // A directly YAML-authored row `args: [8080]` resolves the unquoted number,
  // which survives isLossless but violates the output schema's
  // `items: { type: 'string' }` (and the validateMcpConfig contract).
  assert.equal('args' in toServerConfig({ args: [8080] }), false, 'numeric args must be omitted');
  assert.equal('args' in toServerConfig({ args: ['--x', 1] }), false, 'mixed-type args must be omitted');
  assert.deepEqual(toServerConfig({ args: ['--x', '8080'] }).args, ['--x', '8080'], 'string args are kept');
});

test('manager_mcp_list: output is lossless-JSON safe and schema-complete (issue #10)', async () => {
  const entries = [
    loaderEntry('include:gh', MCP_CLIENT_PACKAGE, { serverName: 'gh', transport: 'stdio', command: 'npx' }),
    loaderEntry('include:web', MCP_CLIENT_PACKAGE, {
      serverName: 'web', transport: 'streamable-http', url: 'http://127.0.0.1:24440/mcp', env: { A: '1' },
    }),
    // A user-authored row with `.inf` (js-yaml → Infinity) and an unquoted
    // numeric arg must not break the whole listing — the offending keys are
    // omitted from the projection instead.
    loaderEntry('include:bad', MCP_CLIENT_PACKAGE, {
      serverName: 'bad', transport: 'stdio', command: 'node',
      toolCallTimeoutMs: Number.POSITIVE_INFINITY, args: [8080],
    }),
  ];
  await withPlugin(entries, async ({ toolMap }) => {
    const value = await toolMap.manager_mcp_list.execute({});
    assertLossless(value, '');
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value, 'JSON round-trip must be lossless');
    const gh = value.servers.find((server) => server.id === 'gh');
    assert.equal(gh.command, 'npx', 'configured keys keep their values');
    assert.equal('url' in gh, false, 'unconfigured optional keys must be absent');
    const bad = value.servers.find((server) => server.id === 'bad');
    assert.ok(bad, 'the .inf-configured server is still listed');
    assert.equal('toolCallTimeoutMs' in bad, false, 'the non-lossless timeout is omitted');
    assert.equal('args' in bad, false, 'the non-string args array is omitted');
    // Second harness layer: the registered output schema uses
    // additionalProperties: false, so every returned item key must be declared
    // in the *converted* schema (valueSchema is what the registry sees).
    const itemProps = valueSchema(toolMap.manager_mcp_list.output.schema).properties.servers.items.properties;
    for (const server of value.servers) {
      for (const key of Object.keys(server)) {
        assert.ok(key in itemProps, `servers[] item key "${key}" must be declared in the output schema`);
      }
    }
  });
});

test('mcpToggle: unknown id → not-found, no patch file is created', async () => {
  await withPlugin([], async ({ toolMap, patchFile }) => {
    await assertErrorCode(toolMap.manager_mcp_toggle.execute({ id: 'ghost', enabled: false }), 'not-found');
    assert.equal(existsSync(patchFile), false, 'a rejected toggle must not write the patch file');
  });
});

test('mcpToggle: non-MCP loader entry → not-found', async () => {
  const entries = [loaderEntry('include:skills', '@deepseek-ai/dsh-skills', {})];
  await withPlugin(entries, async ({ toolMap, patchFile }) => {
    await assertErrorCode(toolMap.manager_mcp_toggle.execute({ id: 'skills', enabled: false }), 'not-found');
    assert.equal(existsSync(patchFile), false, 'a foreign entry must not get an override row');
  });
});

test('mcpToggle: bundle mcp-client entry → override row appended, schema-valid value', async () => {
  const entries = [loaderEntry('include:gh', MCP_CLIENT_PACKAGE, { serverName: 'gh', transport: 'stdio', command: 'npx' })];
  await withPlugin(entries, async ({ toolMap, patchFile }) => {
    const value = await toolMap.manager_mcp_toggle.execute({ id: 'gh', enabled: false });
    assert.deepEqual(value, { id: 'gh', enabled: false });
    const rows = await readPatchList(patchFile);
    assert.deepEqual(rows, [{ id: 'gh', name: MCP_CLIENT_PACKAGE, disabled: true }]);
  });
});

test('mcpToggle: patch row not yet hot-reloaded (HMR lag) → flag flips in place', async () => {
  await withPlugin([], async ({ toolMap, patchFile }) => {
    await writePatchList(patchFile, [{ insert: [{ id: 'srv', name: MCP_CLIENT_PACKAGE, config: { serverName: 'srv', transport: 'stdio', command: 'node' } }] }]);
    const value = await toolMap.manager_mcp_toggle.execute({ id: 'srv', enabled: false });
    assert.deepEqual(value, { id: 'srv', enabled: false });
    const rows = await readPatchList(patchFile);
    assert.equal(rows[0].insert[0].disabled, true, 'the insert item carries the disabled flag');
  });
});

test('mcpRemove: mcp-client insert row removed, foreign insert rows preserved', async () => {
  await withPlugin([], async ({ toolMap, patchFile }) => {
    await writePatchList(patchFile, [
      { insert: [{ id: 'srv', name: MCP_CLIENT_PACKAGE, config: { serverName: 'srv', transport: 'stdio', command: 'node' } }] },
      { insert: [{ id: 'other', name: '@deepseek-ai/dsh-skills', config: {} }] },
    ]);
    const value = await toolMap.manager_mcp_remove.execute({ id: 'srv' });
    assert.deepEqual(value, { id: 'srv' });
    const rows = await readPatchList(patchFile);
    assert.equal(rows.length, 1, 'only the foreign insert row remains');
    assert.deepEqual(rows[0].insert, [{ id: 'other', name: '@deepseek-ai/dsh-skills', config: {} }]);
  });
});

test('mcpRemove: foreign patch row with the same id → not-found, row preserved', async () => {
  await withPlugin([], async ({ toolMap, patchFile }) => {
    const foreign = { insert: [{ id: 'victim', name: '@deepseek-ai/dsh-skills', config: {} }] };
    await writePatchList(patchFile, [foreign]);
    await assertErrorCode(toolMap.manager_mcp_remove.execute({ id: 'victim' }), 'not-found');
    const rows = await readPatchList(patchFile);
    assert.deepEqual(rows, [foreign], 'the foreign row must survive');
  });
});

test('mcpUpdate: unknown id → not-found (no orphan override row appended)', async () => {
  await withPlugin([], async ({ toolMap, patchFile }) => {
    await assertErrorCode(
      toolMap.manager_mcp_update.execute({ id: 'ghost', serverName: 'x', transport: 'stdio', command: 'node' }),
      'not-found',
    );
    assert.equal(existsSync(patchFile), false, 'a rejected update must not write the patch file');
  });
});

test('mcpAdd/mcpUpdate/mcpRemove/mcpToggle: returned values match their output schemas', async () => {
  await withPlugin(
    [loaderEntry('include:gh', MCP_CLIENT_PACKAGE, { serverName: 'gh', transport: 'stdio', command: 'npx' })],
    async ({ toolMap, patchFile }) => {
      await writePatchList(patchFile, [{ insert: [{ id: 'srv', name: MCP_CLIENT_PACKAGE, config: { serverName: 'srv', transport: 'stdio', command: 'node' } }] }]);
      const checks = [
        ['manager_mcp_toggle', { id: 'gh', enabled: false }],
        ['manager_mcp_add', { id: 'new-srv', serverName: 'newSrv', transport: 'stdio', command: 'node' }],
        ['manager_mcp_update', { id: 'srv', serverName: 'srv', transport: 'stdio', command: 'node2' }],
        ['manager_mcp_remove', { id: 'srv' }],
      ];
      for (const [name, args] of checks) {
        const tool = toolMap[name];
        const value = await tool.execute(args);
        const schema = tool.output.schema;
        for (const key of Object.keys(value)) {
          assert.ok(schema.properties[key], `${name}: returned "${key}" is declared in the output schema`);
        }
        for (const req of schema.required ?? []) {
          assert.ok(req in value, `${name}: schema-required "${req}" present in the returned value`);
        }
      }
    },
  );
});
